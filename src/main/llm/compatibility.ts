/**
 * "Will this model run on this machine?" — computed before a single byte of
 * weights is downloaded.
 *
 * The algorithm is a direct port of Atomic-Chat's (Jan's) `is_model_supported`
 * and `estimate_kv_cache_internal` from
 * `src-tauri/plugins/tauri-plugin-llamacpp/src/gguf/`. The constants are theirs,
 * not ours: `BYTES_PER_ELEMENT = 2` (fp16 KV cache) and `RESERVE_BYTES` (the
 * headroom left for the OS, the app and llama.cpp's own allocations). Every
 * division that is integer division in the original is `Math.floor` here.
 *
 * This module is pure. It takes a metadata map and a hardware profile and
 * returns numbers — no I/O, no Electron, no native addon — which is what makes
 * it testable against hand-computed fixtures.
 */

/** Matches Atomic-Chat's verdict enum exactly, including the two non-numeric states. */
export type SupportVerdict = 'RED' | 'YELLOW' | 'GREEN' | 'LOADING' | 'GREY';

/** GGUF metadata, flattened to the scalar values we care about. */
export type GgufMetadataMap = Readonly<Record<string, string | number | boolean>>;

/** fp16 KV cache: two bytes per element. */
export const BYTES_PER_ELEMENT = 2;

/** ~2.13 GiB held back for the OS, the app and llama.cpp overhead. Atomic-Chat's exact constant. */
export const RESERVE_BYTES = 2_288_490_189;

/** The context size a verdict is computed against unless the caller says otherwise. */
export const DEFAULT_VERDICT_CONTEXT_SIZE = 8192;

export type MetadataErrorCode =
  | 'MISSING_ARCHITECTURE'
  | 'MISSING_BLOCK_COUNT'
  | 'MISSING_HEAD_COUNT'
  | 'MISSING_HEAD_DIMENSION'
  | 'MISSING_CONTEXT_LENGTH';

/**
 * Raised when the GGUF header does not carry enough to size the KV cache.
 *
 * Deliberately fatal rather than guessed: a made-up head count produces a
 * confident, wrong verdict, and a wrong verdict is worse than no verdict.
 */
export class ModelMetadataError extends Error {
  constructor(
    message: string,
    readonly code: MetadataErrorCode,
  ) {
    super(message);
    this.name = 'ModelMetadataError';
  }
}

export interface KvCacheEstimate {
  readonly architecture: string;
  readonly blockCount: number;
  /** Heads used for the cache: `head_count_kv` when present, else `head_count`. */
  readonly headCountKv: number;
  readonly keyLength: number;
  readonly valueLength: number;
  /** Context the estimate was computed for, already clamped to the model's maximum. */
  readonly contextLength: number;
  readonly maxContextLength: number;
  readonly slidingWindow: number | null;
  /** Bytes of KV cache one token costs. */
  readonly bytesPerToken: number;
  readonly fullCostBytes: number;
  readonly slidingCostBytes: number | null;
  /** The number the verdict adds to the model size. */
  readonly kvCacheBytes: number;
  /** True when key/value length were derived from `embedding_length / head_count`. */
  readonly usedHeadDimensionFallback: boolean;
}

function numberAt(meta: GgufMetadataMap, key: string): number | null {
  const raw = meta[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

/**
 * Size the fp16 KV cache for a model at a given context length.
 *
 * `ctxSize` is clamped to the model's own `context_length`; passing `undefined`
 * means "the model's full window".
 */
export function estimateKvCache(meta: GgufMetadataMap, ctxSize?: number): KvCacheEstimate {
  const architecture = meta['general.architecture'];
  if (typeof architecture !== 'string' || architecture.length === 0) {
    throw new ModelMetadataError(
      'GGUF metadata has no "general.architecture" key, so the KV cache cannot be sized.',
      'MISSING_ARCHITECTURE',
    );
  }

  const blockCount = numberAt(meta, `${architecture}.block_count`);
  if (blockCount === null || blockCount <= 0) {
    throw new ModelMetadataError(
      `GGUF metadata has no usable "${architecture}.block_count".`,
      'MISSING_BLOCK_COUNT',
    );
  }

  const headCount = numberAt(meta, `${architecture}.attention.head_count`);
  const headCountKvRaw = numberAt(meta, `${architecture}.attention.head_count_kv`);
  // `head_count_kv` is the right number for grouped-query attention; `head_count`
  // is the correct fallback for architectures that do not declare it.
  const headCountKv = headCountKvRaw ?? headCount;
  if (headCountKv === null || headCountKv <= 0) {
    throw new ModelMetadataError(
      `GGUF metadata has no usable "${architecture}.attention.head_count_kv" or "${architecture}.attention.head_count".`,
      'MISSING_HEAD_COUNT',
    );
  }

  let keyLength = numberAt(meta, `${architecture}.attention.key_length`) ?? 0;
  let valueLength = numberAt(meta, `${architecture}.attention.value_length`) ?? 0;
  let usedHeadDimensionFallback = false;

  if (keyLength === 0 || valueLength === 0) {
    usedHeadDimensionFallback = true;
    const embeddingLength = numberAt(meta, `${architecture}.embedding_length`) ?? 0;
    const totalHeads = headCount ?? headCountKv;
    // Integer division, exactly as in the original.
    const headDimension = totalHeads > 0 ? Math.floor(embeddingLength / totalHeads) : 0;
    keyLength = headDimension;
    valueLength = headDimension;
    if (keyLength === 0 || valueLength === 0) {
      throw new ModelMetadataError(
        `Cannot derive a head dimension for "${architecture}": no key/value length and no usable embedding_length / head_count.`,
        'MISSING_HEAD_DIMENSION',
      );
    }
  }

  const maxContextLength = numberAt(meta, `${architecture}.context_length`);
  if (maxContextLength === null || maxContextLength <= 0) {
    throw new ModelMetadataError(
      `GGUF metadata has no usable "${architecture}.context_length".`,
      'MISSING_CONTEXT_LENGTH',
    );
  }

  const contextLength = ctxSize ? Math.min(ctxSize, maxContextLength) : maxContextLength;

  const slidingWindowRaw = numberAt(meta, `${architecture}.attention.sliding_window`) ?? 0;
  const slidingWindow = slidingWindowRaw > 0 ? slidingWindowRaw : null;

  const bytesPerToken = blockCount * headCountKv * (keyLength + valueLength) * BYTES_PER_ELEMENT;
  const fullCostBytes = contextLength * bytesPerToken;
  const slidingCostBytes = slidingWindow === null ? null : slidingWindow * bytesPerToken;
  // Sliding-window models keep a full cache for some layers and a windowed one
  // for the rest; the original averages the two costs.
  const kvCacheBytes =
    slidingCostBytes === null
      ? fullCostBytes
      : Math.floor((fullCostBytes + slidingCostBytes) / 2);

  return {
    architecture,
    blockCount,
    headCountKv,
    keyLength,
    valueLength,
    contextLength,
    maxContextLength,
    slidingWindow,
    bytesPerToken,
    fullCostBytes,
    slidingCostBytes,
    kvCacheBytes,
    usedHeadDimensionFallback,
  };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** A GPU device with a *known* VRAM figure. Devices with unknown VRAM must not appear here. */
export interface CompatibilityGpu {
  readonly name: string;
  readonly totalMemoryBytes: number;
}

export interface CompatibilityHardware {
  /** Total system RAM in bytes, or null when detection failed. */
  readonly totalRamBytes: number | null;
  /**
   * Discrete GPUs with a known VRAM figure.
   *
   * Unified-memory machines (Apple Silicon) report an empty list on purpose:
   * their RAM *is* their VRAM, and counting it twice inflates the budget.
   */
  readonly gpus: readonly CompatibilityGpu[];
}

export interface SupportBreakdown {
  readonly verdict: SupportVerdict;
  readonly modelSizeBytes: number;
  readonly kvCacheBytes: number;
  readonly totalRequiredBytes: number;
  readonly totalSystemMemoryBytes: number;
  readonly totalVramBytes: number;
  readonly usableVramBytes: number;
  readonly usableTotalMemoryBytes: number;
  readonly reserveBytes: number;
  readonly hasDiscreteGpu: boolean;
  readonly contextSize: number;
  /** Present when the KV cache could be sized; null on a GREY verdict. */
  readonly kvCache: KvCacheEstimate | null;
  /** Plain-language explanation, safe to show verbatim in the UI. */
  readonly reason: string;
}

export interface SupportQuery {
  readonly meta: GgufMetadataMap;
  readonly modelSizeBytes: number;
  readonly hardware: CompatibilityHardware;
  readonly ctxSize?: number;
}

export interface MemoryBudget {
  readonly hasDiscreteGpu: boolean;
  readonly totalSystemMemoryBytes: number;
  readonly totalVramBytes: number;
  readonly usableVramBytes: number;
  readonly usableTotalMemoryBytes: number;
}

/**
 * What this machine can actually give a model, after `RESERVE_BYTES`.
 *
 * Split out of the verdict so the load path can size a context against the same
 * numbers the verdict was computed from, rather than a second opinion.
 */
export function memoryBudget(hardware: CompatibilityHardware): MemoryBudget {
  const totalRam = hardware.totalRamBytes ?? 0;
  const hasDiscreteGpu = hardware.gpus.length > 0;

  // On a unified-memory machine there is no discrete GPU, so system RAM is not
  // counted separately — it is already the VRAM pool.
  const totalSystemMemoryBytes = hasDiscreteGpu ? totalRam : 0;
  const totalVramBytes = hasDiscreteGpu
    ? hardware.gpus.reduce((sum, gpu) => sum + gpu.totalMemoryBytes, 0)
    : totalRam;

  const usableVramBytes = Math.max(0, totalVramBytes - RESERVE_BYTES);
  const usableTotalMemoryBytes =
    (totalSystemMemoryBytes > RESERVE_BYTES ? totalSystemMemoryBytes - RESERVE_BYTES : 0) +
    usableVramBytes;

  return {
    hasDiscreteGpu,
    totalSystemMemoryBytes,
    totalVramBytes,
    usableVramBytes,
    usableTotalMemoryBytes,
  };
}

function greyBreakdown(
  modelSizeBytes: number,
  contextSize: number,
  reason: string,
): SupportBreakdown {
  return {
    verdict: 'GREY',
    modelSizeBytes,
    kvCacheBytes: 0,
    totalRequiredBytes: modelSizeBytes,
    totalSystemMemoryBytes: 0,
    totalVramBytes: 0,
    usableVramBytes: 0,
    usableTotalMemoryBytes: 0,
    reserveBytes: RESERVE_BYTES,
    hasDiscreteGpu: false,
    contextSize,
    kvCache: null,
    reason,
  };
}

/**
 * The verdict, with every number that produced it.
 *
 * GREY means "cannot be computed" — unknown RAM, or metadata too thin to size
 * the cache. It is never downgraded to a colour, because a fabricated green is
 * the one outcome that costs the user a 4 GB download *and* their trust.
 */
export function checkModelSupport(query: SupportQuery): SupportBreakdown {
  const contextSize = query.ctxSize ?? DEFAULT_VERDICT_CONTEXT_SIZE;

  if (query.hardware.totalRamBytes === null || query.hardware.totalRamBytes <= 0) {
    return greyBreakdown(
      query.modelSizeBytes,
      contextSize,
      'Hardware detection failed on this machine, so no verdict can be computed.',
    );
  }

  let kvCache: KvCacheEstimate;
  try {
    kvCache = estimateKvCache(query.meta, contextSize);
  } catch (error) {
    const message = error instanceof ModelMetadataError ? error.message : String(error);
    return greyBreakdown(query.modelSizeBytes, contextSize, message);
  }

  const totalRequiredBytes = query.modelSizeBytes + kvCache.kvCacheBytes;
  const { hasDiscreteGpu, totalSystemMemoryBytes, totalVramBytes, usableVramBytes, usableTotalMemoryBytes } =
    memoryBudget(query.hardware);

  const shared = {
    modelSizeBytes: query.modelSizeBytes,
    kvCacheBytes: kvCache.kvCacheBytes,
    totalRequiredBytes,
    totalSystemMemoryBytes,
    totalVramBytes,
    usableVramBytes,
    usableTotalMemoryBytes,
    reserveBytes: RESERVE_BYTES,
    hasDiscreteGpu,
    contextSize: kvCache.contextLength,
    kvCache,
  };

  if (totalRequiredBytes > usableTotalMemoryBytes) {
    return {
      ...shared,
      verdict: 'RED',
      reason: `Needs ${formatGb(totalRequiredBytes)} (${formatGb(query.modelSizeBytes)} of weights plus ${formatGb(kvCache.kvCacheBytes)} of KV cache at ${kvCache.contextLength} tokens) but only ${formatGb(usableTotalMemoryBytes)} is usable on this machine.`,
    };
  }

  if (totalRequiredBytes <= usableVramBytes) {
    return {
      ...shared,
      verdict: 'GREEN',
      reason: `Needs ${formatGb(totalRequiredBytes)} and ${formatGb(usableVramBytes)} of ${hasDiscreteGpu ? 'VRAM' : 'memory'} is usable, so it fits entirely${hasDiscreteGpu ? ' in VRAM' : ''}.`,
    };
  }

  return {
    ...shared,
    verdict: 'YELLOW',
    reason: `Needs ${formatGb(totalRequiredBytes)}, which is more than the ${formatGb(usableVramBytes)} of usable VRAM but within the ${formatGb(usableTotalMemoryBytes)} of total usable memory. It will run split across CPU and GPU, and be slower.`,
  };
}

function formatGb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}
