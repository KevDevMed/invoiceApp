/**
 * The smoke test, against a scripted runtime.
 *
 * Every path the real thing can take is here — pass, slow, timeout, OOM, a load
 * that never succeeds, and a load that succeeds but produces nothing — and every
 * one of them asserts that the model was unloaded afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import type {
  GenerateOptions,
  GenerateResult,
  LlmRuntime,
  LoadModelOptions,
  LoadedModel,
} from '../runtime';
import {
  clearSmokeTest,
  decodeSmokeTest,
  describeSmokeTest,
  downloadErrorOf,
  readSmokeTest,
  runSmokeTest,
  saveSmokeTest,
  SLOW_TOKENS_PER_SECOND,
  type SmokeTestRecord,
} from '../smoke-test';
import { markReady, upsertModel } from '../store';

// ---------------------------------------------------------------------------
// A runtime whose timing is scripted, so tokens-per-second is deterministic
// ---------------------------------------------------------------------------

interface ScriptOptions {
  /** Milliseconds the fake clock advances during load. */
  readonly loadMs?: number;
  /** Milliseconds the fake clock advances per token. */
  readonly msPerToken?: number;
  readonly tokens?: string[];
  readonly failLoad?: Error;
  readonly failGenerate?: Error;
  /** Hang until the abort signal fires, to exercise the timeout path. */
  readonly hangUntilAborted?: boolean;
  /** Return normally but with the abort signal already tripped. */
  readonly text?: string;
}

class ScriptedRuntime implements LlmRuntime {
  loadCalls = 0;
  unloadCalls = 0;
  generateCalls = 0;
  /** The fake clock every measurement in the record is taken from. */
  clock = 1_000_000;

  private resident: LoadedModel | null = null;

  constructor(private readonly script: ScriptOptions = {}) {}

  now = (): number => this.clock;

  current(): LoadedModel | null {
    return this.resident;
  }

  async load(options: LoadModelOptions): Promise<LoadedModel> {
    this.loadCalls += 1;
    this.clock += this.script.loadMs ?? 100;
    if (this.script.failLoad) throw this.script.failLoad;
    this.resident = {
      modelId: options.modelId,
      modelPath: options.modelPath,
      contextSize: options.contextSize ?? 512,
    };
    return this.resident;
  }

  async unload(): Promise<boolean> {
    this.unloadCalls += 1;
    const had = this.resident !== null;
    this.resident = null;
    return had;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.generateCalls += 1;
    if (this.script.failGenerate) throw this.script.failGenerate;

    if (this.script.hangUntilAborted) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { requestId: options.requestId, text: '', stopReason: 'cancelled' };
    }

    const tokens = this.script.tokens ?? ['2', ' + ', '2', ' is ', '4', '.'];
    let text = '';
    for (const token of tokens) {
      this.clock += this.script.msPerToken ?? 10;
      text += token;
      options.onToken?.(token);
    }
    return { requestId: options.requestId, text: this.script.text ?? text, stopReason: 'stop' };
  }

  async dispose(): Promise<void> {
    await this.unload();
  }
}

function run(runtime: ScriptedRuntime, overrides: Record<string, unknown> = {}) {
  return runSmokeTest({
    runtime,
    modelId: 'qwen3-1-7b-q4-k-m',
    modelPath: '/models/qwen3-1-7b-q4-k-m/Qwen3-1.7B-Q4_K_M.gguf',
    now: runtime.now,
    rss: () => 1_234_000_000,
    ...overrides,
  });
}

describe('runSmokeTest', () => {
  it('passes on a fast run, with the real numbers and the generated text', async () => {
    // 6 tokens at 10 ms each = 60 ms => 100 tokens/second.
    const runtime = new ScriptedRuntime({ loadMs: 2500, msPerToken: 10 });
    const result = await run(runtime);

    expect(result.verdict).toBe('pass');
    expect(result.loadMs).toBe(2500);
    expect(result.tokensGenerated).toBe(6);
    expect(result.generationMs).toBe(60);
    expect(result.tokensPerSecond).toBe(100);
    expect(result.timeToFirstTokenMs).toBe(10);
    expect(result.peakRssBytes).toBe(1_234_000_000);
    expect(result.text).toBe('2 + 2 is 4.');
    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.contextSize).toBe(512);
    expect(result.maxTokens).toBe(32);
    expect(runtime.unloadCalls).toBe(1);
  });

  it('is slow when tokens per second falls under the threshold', async () => {
    // 6 tokens at 500 ms each = 3000 ms => 2 tokens/second.
    const runtime = new ScriptedRuntime({ loadMs: 1000, msPerToken: 500 });
    const result = await run(runtime);

    expect(result.tokensPerSecond).toBe(2);
    expect(result.tokensPerSecond).toBeLessThan(SLOW_TOKENS_PER_SECOND);
    expect(result.verdict).toBe('slow');
    // Slow is still a working model: the text is there and there is no error.
    expect(result.text).toBe('2 + 2 is 4.');
    expect(result.error).toBeNull();
    expect(runtime.unloadCalls).toBe(1);
  });

  it('respects an overridden slow threshold', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    const result = await run(runtime, { slowTokensPerSecond: 1000 });
    expect(result.verdict).toBe('slow');
  });

  it('fails on a timeout, and still unloads', async () => {
    const runtime = new ScriptedRuntime({ hangUntilAborted: true });
    const result = await run(runtime, { timeoutMs: 20 });

    expect(result.verdict).toBe('fail');
    expect(result.failureKind).toBe('timeout');
    expect(result.error).toBe('Timed out after 20 ms.');
    expect(result.tokensPerSecond).toBeNull();
    expect(runtime.unloadCalls).toBe(1);
  });

  it('fails on an out-of-memory error, keeping the message verbatim', async () => {
    const runtime = new ScriptedRuntime({
      failGenerate: new Error('llama_decode failed: out of memory allocating KV cache'),
    });
    const result = await run(runtime);

    expect(result.verdict).toBe('fail');
    expect(result.failureKind).toBe('out_of_memory');
    expect(result.error).toBe('llama_decode failed: out of memory allocating KV cache');
    expect(runtime.unloadCalls).toBe(1);
  });

  it('fails when the model will not load at all', async () => {
    const runtime = new ScriptedRuntime({
      failLoad: new Error('Could not load model: cannot allocate 4.2 GiB'),
    });
    const result = await run(runtime);

    expect(result.verdict).toBe('fail');
    expect(result.failureKind).toBe('out_of_memory');
    expect(result.error).toMatch(/cannot allocate 4.2 GiB/);
    expect(result.tokensGenerated).toBe(0);
    expect(runtime.generateCalls).toBe(0);
    // Nothing was ever resident, so nothing had to be unloaded.
    expect(runtime.current()).toBeNull();
  });

  it('fails, never silently passes, when no tokens arrive', async () => {
    const runtime = new ScriptedRuntime({ tokens: [], text: '' });
    const result = await run(runtime);

    expect(result.verdict).toBe('fail');
    expect(result.failureKind).toBe('no_output');
    expect(result.error).toBe('The model loaded but produced no output.');
    expect(runtime.unloadCalls).toBe(1);
  });

  it('fails when tokens streamed but the final text is empty', async () => {
    const runtime = new ScriptedRuntime({ tokens: ['  ', '  '], text: '   ' });
    const result = await run(runtime);
    expect(result.verdict).toBe('fail');
    expect(result.failureKind).toBe('no_output');
  });

  it('classifies an ordinary crash as an error, not an OOM', async () => {
    const runtime = new ScriptedRuntime({ failGenerate: new Error('segmentation fault in ggml') });
    const result = await run(runtime);
    expect(result.failureKind).toBe('error');
    expect(result.error).toBe('segmentation fault in ggml');
  });

  it('unloads even when unload itself throws', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    runtime.unload = async () => {
      runtime.unloadCalls += 1;
      throw new Error('unload exploded');
    };
    const result = await run(runtime);
    expect(result.verdict).toBe('pass');
    expect(runtime.unloadCalls).toBe(1);
  });

  it('honours a caller-supplied context size and token cap', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    const result = await run(runtime, { contextSize: 2048, maxTokens: 8 });
    expect(result.contextSize).toBe(2048);
    expect(result.maxTokens).toBe(8);
  });

  it('records a null peak RSS rather than a zero when sampling fails', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    const result = await run(runtime, { rss: () => null });
    expect(result.peakRssBytes).toBeNull();
  });

  it('keeps the highest RSS sample, not the last one', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    const samples = [100, 900, 400, 200, 150, 120, 110, 105];
    let index = 0;
    const result = await run(runtime, {
      rss: () => samples[Math.min(index++, samples.length - 1)] ?? 0,
    });
    expect(result.peakRssBytes).toBe(900);
  });
});

// ---------------------------------------------------------------------------
// Persistence into the frozen schema
// ---------------------------------------------------------------------------

describe('smoke-test persistence', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    upsertModel(db, {
      id: 'qwen3-1-7b-q4-k-m',
      repo: 'unsloth/Qwen3-1.7B-GGUF',
      filename: 'Qwen3-1.7B-Q4_K_M.gguf',
    });
    markReady(db, 'qwen3-1-7b-q4-k-m', '/models/x/Qwen3-1.7B-Q4_K_M.gguf', 1_107_409_472);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips through the models.error column', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    const result = await run(runtime);

    saveSmokeTest(db, 'qwen3-1-7b-q4-k-m', result);

    const row = db
      .prepare<[string], { error: string | null }>('SELECT error FROM models WHERE id = ?')
      .get('qwen3-1-7b-q4-k-m');
    const decoded = decodeSmokeTest(row?.error ?? null);

    expect(decoded).not.toBeNull();
    expect(decoded?.verdict).toBe('pass');
    expect(decoded?.tokensPerSecond).toBe(100);
    expect(decoded?.text).toBe('2 + 2 is 4.');
  });

  it('stays inside the 4000-character budget the column is validated against', async () => {
    const runtime = new ScriptedRuntime({
      tokens: Array.from({ length: 200 }, () => 'x'.repeat(50)),
      msPerToken: 1,
    });
    const result = await run(runtime);
    saveSmokeTest(db, 'qwen3-1-7b-q4-k-m', result);

    const row = db
      .prepare<[string], { error: string | null }>('SELECT error FROM models WHERE id = ?')
      .get('qwen3-1-7b-q4-k-m');
    expect((row?.error ?? '').length).toBeLessThanOrEqual(4000);
    expect(decodeSmokeTest(row?.error ?? null)).not.toBeNull();
  });

  it('tells a stored smoke test apart from a download error', () => {
    const record: SmokeTestRecord = {
      kind: 'smokeTest',
      modelId: 'x',
      verdict: 'pass',
      loadMs: 1,
      timeToFirstTokenMs: 1,
      generationMs: 1,
      tokensGenerated: 1,
      tokensPerSecond: 12.4,
      peakRssBytes: 1,
      contextSize: 512,
      maxTokens: 32,
      text: 'hi',
      error: null,
      failureKind: null,
      ranAt: '2026-07-27T00:00:00.000Z',
    };

    expect(readSmokeTest({ error: JSON.stringify(record) })?.verdict).toBe('pass');
    expect(downloadErrorOf({ error: JSON.stringify(record) })).toBeNull();

    expect(readSmokeTest({ error: 'Checksum mismatch, the file was deleted.' })).toBeNull();
    expect(downloadErrorOf({ error: 'Checksum mismatch, the file was deleted.' })).toBe(
      'Checksum mismatch, the file was deleted.',
    );

    expect(readSmokeTest({ error: null })).toBeNull();
    expect(downloadErrorOf({ error: null })).toBeNull();
    // Some other JSON is not a smoke test.
    expect(readSmokeTest({ error: '{"kind":"somethingElse"}' })).toBeNull();
    expect(readSmokeTest({ error: '{not json' })).toBeNull();
  });

  it('clears a stored result', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    saveSmokeTest(db, 'qwen3-1-7b-q4-k-m', await run(runtime));
    clearSmokeTest(db, 'qwen3-1-7b-q4-k-m');

    const row = db
      .prepare<[string], { error: string | null }>('SELECT error FROM models WHERE id = ?')
      .get('qwen3-1-7b-q4-k-m');
    expect(row?.error).toBeNull();
  });

  it('is cleared by a re-download, because markReady nulls the column', async () => {
    const runtime = new ScriptedRuntime({ msPerToken: 10 });
    saveSmokeTest(db, 'qwen3-1-7b-q4-k-m', await run(runtime));
    markReady(db, 'qwen3-1-7b-q4-k-m', '/models/x/Qwen3-1.7B-Q4_K_M.gguf', 1_107_409_472);

    const row = db
      .prepare<[string], { error: string | null }>('SELECT error FROM models WHERE id = ?')
      .get('qwen3-1-7b-q4-k-m');
    expect(row?.error).toBeNull();
  });
});

describe('describeSmokeTest', () => {
  it('labels each verdict', () => {
    expect(describeSmokeTest(null)).toBe('untested');
    expect(
      describeSmokeTest({ verdict: 'pass', tokensPerSecond: 12.4 } as SmokeTestRecord),
    ).toBe('tested · 12.4 tok/s');
    expect(describeSmokeTest({ verdict: 'slow', tokensPerSecond: 2 } as SmokeTestRecord)).toBe(
      'slow · 2 tok/s',
    );
    expect(describeSmokeTest({ verdict: 'fail' } as SmokeTestRecord)).toBe(
      'failed on this machine',
    );
  });
});
