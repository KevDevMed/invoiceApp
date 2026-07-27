/**
 * How large a context this machine will actually agree to allocate.
 *
 * The IPC contract accepts a `contextSize` up to 1,048,576 and is frozen, so the
 * bound has to live here. A million-token context on an 8 GB laptop is not a
 * slow load, it is llama.cpp allocating a KV cache the machine cannot hold —
 * `model.createContext` either throws deep inside the native addon or the OS
 * kills the process.
 *
 * The ceiling is the smaller of two real numbers, never a magic constant:
 *
 *   1. the model's own `context_length`, straight from its GGUF header, and
 *   2. what is left of the usable memory budget after the weights, divided by
 *      the KV cache cost of one token.
 *
 * When the metadata cannot be read (no local header, an architecture missing the
 * keys) the request is clamped to `fallbackMax` instead — a caller-supplied
 * figure such as the catalog's `defaultContextSize`, which is a fact about the
 * model rather than a guess about the machine.
 */

import {
  estimateKvCache,
  memoryBudget,
  type CompatibilityHardware,
  type GgufMetadataMap,
} from './compatibility';

/** The contract's own floor. Never clamp below a context that cannot hold a prompt. */
export const MIN_CONTEXT_SIZE = 256;

export interface ContextClampInput {
  readonly requested: number;
  /** Flattened GGUF metadata for the model, or null when it could not be read. */
  readonly meta: GgufMetadataMap | null;
  /** Size of the weights on disk, which the KV cache has to share memory with. */
  readonly modelSizeBytes: number | null;
  readonly hardware: CompatibilityHardware;
  /** Used when the metadata is unusable. */
  readonly fallbackMax: number;
}

export interface ContextClamp {
  /** The context size to actually load with. */
  readonly contextSize: number;
  readonly requestedContextSize: number;
  readonly clamped: boolean;
  /** Plain-language explanation, safe to show verbatim. Null when nothing was clamped. */
  readonly reason: string | null;
  /** The model's own maximum, when its metadata was readable. */
  readonly modelMaxContextSize: number | null;
  /** What memory allowed, when it could be computed. */
  readonly memoryMaxContextSize: number | null;
}

function floorToMinimum(value: number): number {
  return Math.max(MIN_CONTEXT_SIZE, Math.floor(value));
}

/**
 * Bound a requested context to what the model and the machine can carry.
 *
 * Never throws: an unreadable header or an undetectable machine falls back to
 * `fallbackMax`, because refusing to load is a worse answer than loading small.
 */
export function clampContextSize(input: ContextClampInput): ContextClamp {
  const requested = Math.max(MIN_CONTEXT_SIZE, Math.floor(input.requested));

  let modelMax: number | null = null;
  let memoryMax: number | null = null;

  if (input.meta !== null) {
    try {
      const kv = estimateKvCache(input.meta);
      modelMax = kv.maxContextLength;

      const budget = memoryBudget(input.hardware);
      if (budget.usableTotalMemoryBytes > 0 && kv.bytesPerToken > 0) {
        const forCache = budget.usableTotalMemoryBytes - (input.modelSizeBytes ?? 0);
        memoryMax = forCache > 0 ? Math.floor(forCache / kv.bytesPerToken) : MIN_CONTEXT_SIZE;
      }
    } catch {
      // Metadata too thin to size the cache — `fallbackMax` below is the answer.
      modelMax = null;
      memoryMax = null;
    }
  }

  const candidates: Array<{ limit: number; why: string }> = [];
  if (modelMax !== null) {
    candidates.push({ limit: modelMax, why: `the model's maximum context of ${modelMax} tokens` });
  }
  if (memoryMax !== null) {
    candidates.push({
      limit: memoryMax,
      why: `what this machine's memory can hold (${memoryMax} tokens of KV cache alongside the weights)`,
    });
  }
  if (candidates.length === 0) {
    candidates.push({ limit: input.fallbackMax, why: `the model's default of ${input.fallbackMax} tokens (its metadata could not be read)` });
  }

  const tightest = candidates.reduce((left, right) => (right.limit < left.limit ? right : left));
  const ceiling = floorToMinimum(tightest.limit);

  if (requested <= ceiling) {
    return {
      contextSize: requested,
      requestedContextSize: requested,
      clamped: false,
      reason: null,
      modelMaxContextSize: modelMax,
      memoryMaxContextSize: memoryMax,
    };
  }

  return {
    contextSize: ceiling,
    requestedContextSize: requested,
    clamped: true,
    reason: `Context reduced from ${requested} to ${ceiling} tokens: limited by ${tightest.why}.`,
    modelMaxContextSize: modelMax,
    memoryMaxContextSize: memoryMax,
  };
}
