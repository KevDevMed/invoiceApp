/**
 * "Test it on my machine" — a real load and a real generation, not a prediction.
 *
 * The compatibility verdict is arithmetic on a header; this is the thing that
 * proves the arithmetic. It loads the downloaded weights with a small context,
 * generates from a fixed prompt with a low token cap, and reports how long each
 * part took. A crash, an out-of-memory or a timeout is a `fail` carrying the
 * verbatim error — there is no path through this file that reports `pass`
 * without tokens having actually arrived.
 *
 * The model is unloaded in a `finally`, always, including on timeout.
 *
 * Persistence: `models.smoke_test`, its own column since migration 002.
 * `models.error` means "the download failed" and nothing else.
 */

import type { Db } from '../../db/client';
import type { LlmRuntime } from './runtime';
import { clearSmokeTestRecord } from './store';

/** Below this, a model is technically working but painful to use. */
export const SLOW_TOKENS_PER_SECOND = 5;

/**
 * The fixed prompt. The `/no_think` suffix matters: Qwen3 reasons by default and
 * node-llama-cpp does not stream thought segments through `onTextChunk`, so a
 * reasoning model burns the whole budget invisibly and the test reports a
 * timeout with zero tokens. Measured on this machine: without it, 180 s and no
 * output; with it, an answer in about 25 s. Models that do not know the switch
 * simply read it as three more characters of prompt.
 */
export const SMOKE_TEST_PROMPT = 'What is 2 + 2? Answer in one short sentence. /no_think';
export const SMOKE_TEST_CONTEXT_SIZE = 512;
export const SMOKE_TEST_MAX_TOKENS = 32;
export const SMOKE_TEST_TIMEOUT_MS = 180_000;

/** Keeps the serialised record comfortably inside the stored 4000-char budget. */
const MAX_STORED_TEXT_CHARS = 600;
const MAX_STORED_ERROR_CHARS = 1200;

export type SmokeTestVerdict = 'pass' | 'slow' | 'fail';
export type SmokeTestFailureKind = 'timeout' | 'out_of_memory' | 'no_output' | 'error';

export interface SmokeTestRecord {
  /** Kept so an already-stored record still decodes, and as a sanity check. */
  readonly kind: 'smokeTest';
  readonly modelId: string;
  readonly verdict: SmokeTestVerdict;
  readonly loadMs: number;
  /** Time from the start of generation to the first token, or null if none arrived. */
  readonly timeToFirstTokenMs: number | null;
  readonly generationMs: number;
  /** Streamed text chunks. One per token for every model in the catalog. */
  readonly tokensGenerated: number;
  readonly tokensPerSecond: number | null;
  readonly peakRssBytes: number | null;
  readonly contextSize: number;
  readonly maxTokens: number;
  /** What the model actually said, so the user can see it spoke. */
  readonly text: string;
  readonly error: string | null;
  readonly failureKind: SmokeTestFailureKind | null;
  readonly ranAt: string;
}

export interface SmokeTestOptions {
  readonly runtime: LlmRuntime;
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextSize?: number;
  readonly maxTokens?: number;
  readonly prompt?: string;
  readonly timeoutMs?: number;
  readonly gpuLayers?: number;
  /** Monotonic clock, injectable for deterministic tests. */
  readonly now?: () => number;
  /** Resident set size sampler. Injectable for the same reason. */
  readonly rss?: () => number | null;
  /** Slow threshold, exposed so a test does not have to generate slowly. */
  readonly slowTokensPerSecond?: number;
}

function defaultRss(): number | null {
  try {
    return process.memoryUsage().rss;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(error: unknown): SmokeTestFailureKind {
  const text = messageOf(error).toLowerCase();
  if (text.includes('out of memory') || text.includes('oom') || text.includes('cannot allocate')) {
    return 'out_of_memory';
  }
  return 'error';
}

/**
 * Load, generate, measure, unload.
 *
 * Resolves with a record in every case, including failure — the caller persists
 * it either way, because "we tried and it crashed" is exactly the thing the user
 * needs recorded next to the model.
 */
export async function runSmokeTest(options: SmokeTestOptions): Promise<SmokeTestRecord> {
  const now = options.now ?? (() => Date.now());
  const sampleRss = options.rss ?? defaultRss;
  const contextSize = options.contextSize ?? SMOKE_TEST_CONTEXT_SIZE;
  const maxTokens = options.maxTokens ?? SMOKE_TEST_MAX_TOKENS;
  const timeoutMs = options.timeoutMs ?? SMOKE_TEST_TIMEOUT_MS;
  const slowThreshold = options.slowTokensPerSecond ?? SLOW_TOKENS_PER_SECOND;
  const ranAt = new Date().toISOString();

  let peakRssBytes: number | null = sampleRss();
  const observeRss = (): void => {
    const sample = sampleRss();
    if (sample === null) return;
    peakRssBytes = peakRssBytes === null ? sample : Math.max(peakRssBytes, sample);
  };

  const base = {
    kind: 'smokeTest' as const,
    modelId: options.modelId,
    contextSize,
    maxTokens,
    ranAt,
  };

  let loadMs = 0;
  const startedAt = now();

  try {
    await options.runtime.load({
      modelId: options.modelId,
      modelPath: options.modelPath,
      contextSize,
      gpuLayers: options.gpuLayers,
    });
    loadMs = now() - startedAt;
    observeRss();
  } catch (error) {
    // Never reached the generation stage, so there is nothing to unload.
    return {
      ...base,
      verdict: 'fail',
      loadMs: now() - startedAt,
      timeToFirstTokenMs: null,
      generationMs: 0,
      tokensGenerated: 0,
      tokensPerSecond: null,
      peakRssBytes,
      text: '',
      error: messageOf(error).slice(0, MAX_STORED_ERROR_CHARS),
      failureKind: classify(error),
    };
  }

  const controller = new AbortController();
  // A plain object rather than `let` flags: these are written from callbacks, and
  // TypeScript's narrowing of closure-assigned `let` would read them as constants.
  const state = { timedOut: false, tokensGenerated: 0, firstTokenAt: null as number | null };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);

  const generationStartedAt = now();

  try {
    const result = await options.runtime.generate({
      requestId: `smoke-${options.modelId}`,
      messages: [{ role: 'user', content: options.prompt ?? SMOKE_TEST_PROMPT }],
      temperature: 0,
      maxTokens,
      signal: controller.signal,
      onToken: (token) => {
        if (token.length === 0) return;
        if (state.firstTokenAt === null) state.firstTokenAt = now();
        state.tokensGenerated += 1;
        observeRss();
      },
    });

    const generationMs = now() - generationStartedAt;
    observeRss();

    if (state.timedOut) {
      return {
        ...base,
        verdict: 'fail',
        loadMs,
        timeToFirstTokenMs: state.firstTokenAt === null ? null : state.firstTokenAt - generationStartedAt,
        generationMs,
        tokensGenerated: state.tokensGenerated,
        tokensPerSecond: null,
        peakRssBytes,
        text: result.text.slice(0, MAX_STORED_TEXT_CHARS),
        error: `Timed out after ${timeoutMs} ms.`,
        failureKind: 'timeout',
      };
    }

    if (state.tokensGenerated === 0 || result.text.trim().length === 0) {
      return {
        ...base,
        verdict: 'fail',
        loadMs,
        timeToFirstTokenMs: null,
        generationMs,
        tokensGenerated: state.tokensGenerated,
        tokensPerSecond: null,
        peakRssBytes,
        text: result.text.slice(0, MAX_STORED_TEXT_CHARS),
        error: 'The model loaded but produced no output.',
        failureKind: 'no_output',
      };
    }

    const tokensPerSecond =
      generationMs > 0 ? (state.tokensGenerated * 1000) / generationMs : null;

    return {
      ...base,
      verdict:
        tokensPerSecond !== null && tokensPerSecond < slowThreshold ? 'slow' : 'pass',
      loadMs,
      timeToFirstTokenMs: state.firstTokenAt === null ? null : state.firstTokenAt - generationStartedAt,
      generationMs,
      tokensGenerated: state.tokensGenerated,
      tokensPerSecond: tokensPerSecond === null ? null : Math.round(tokensPerSecond * 100) / 100,
      peakRssBytes,
      text: result.text.slice(0, MAX_STORED_TEXT_CHARS),
      error: null,
      failureKind: null,
    };
  } catch (error) {
    const generationMs = now() - generationStartedAt;
    observeRss();
    return {
      ...base,
      verdict: 'fail',
      loadMs,
      timeToFirstTokenMs: state.firstTokenAt === null ? null : state.firstTokenAt - generationStartedAt,
      generationMs,
      tokensGenerated: state.tokensGenerated,
      tokensPerSecond: null,
      peakRssBytes,
      text: '',
      error: state.timedOut
        ? `Timed out after ${timeoutMs} ms.`
        : messageOf(error).slice(0, MAX_STORED_ERROR_CHARS),
      failureKind: state.timedOut ? 'timeout' : classify(error),
    };
  } finally {
    clearTimeout(timer);
    // Unconditional: a model left resident after a failed test is the worst of
    // both worlds — memory held, nothing usable.
    await options.runtime.unload().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function encodeSmokeTest(record: SmokeTestRecord): string {
  return JSON.stringify(record);
}

/** Parse a stored `models.smoke_test` value back into a record, or null if there is none. */
export function decodeSmokeTest(value: string | null): SmokeTestRecord | null {
  if (value === null || value.length === 0 || !value.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SmokeTestRecord>;
    return parsed && parsed.kind === 'smokeTest' ? (parsed as SmokeTestRecord) : null;
  } catch {
    return null;
  }
}

export function saveSmokeTest(db: Db, modelId: string, record: SmokeTestRecord): void {
  db.prepare('UPDATE models SET smoke_test = ?, updated_at = ? WHERE id = ?').run(
    encodeSmokeTest(record).slice(0, 4000),
    new Date().toISOString(),
    modelId,
  );
}

/** Drop a stored result — used when the weights are re-downloaded and the old run no longer applies. */
export function clearSmokeTest(db: Db, modelId: string): void {
  clearSmokeTestRecord(db, modelId);
}

/** Short label for the model picker and the model card, e.g. `tested · 12.4 tok/s`. */
export function describeSmokeTest(record: SmokeTestRecord | null): string {
  if (record === null) return 'untested';
  switch (record.verdict) {
    case 'pass':
      return `tested · ${record.tokensPerSecond ?? 0} tok/s`;
    case 'slow':
      return `slow · ${record.tokensPerSecond ?? 0} tok/s`;
    case 'fail':
      return 'failed on this machine';
  }
}
