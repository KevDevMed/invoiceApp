/**
 * The verdict is the piece most likely to be subtly wrong, so every number here
 * was computed by hand from the algorithm and is asserted exactly. If one of
 * these fails, the arithmetic changed — not the test.
 */

import { describe, expect, it } from 'vitest';

import {
  BYTES_PER_ELEMENT,
  DEFAULT_VERDICT_CONTEXT_SIZE,
  ModelMetadataError,
  RESERVE_BYTES,
  checkModelSupport,
  estimateKvCache,
  type CompatibilityHardware,
  type GgufMetadataMap,
} from '../compatibility';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small dense-ish model with grouped-query attention. 16 layers, 8 KV heads, 64/64. */
const SMALL: GgufMetadataMap = {
  'general.architecture': 'llama',
  'llama.block_count': 16,
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
  'llama.attention.key_length': 64,
  'llama.attention.value_length': 64,
  'llama.embedding_length': 2048,
  'llama.context_length': 32_768,
};
const SMALL_SIZE_BYTES = 800_000_000;

/** A 70B-class model. 80 layers, 8 KV heads, 128/128. */
const LARGE: GgufMetadataMap = {
  'general.architecture': 'llama',
  'llama.block_count': 80,
  'llama.attention.head_count': 64,
  'llama.attention.head_count_kv': 8,
  'llama.attention.key_length': 128,
  'llama.attention.value_length': 128,
  'llama.embedding_length': 8192,
  'llama.context_length': 131_072,
};
const LARGE_SIZE_BYTES = 40_000_000_000;

/** Sliding-window attention, to exercise the averaging branch. */
const SLIDING: GgufMetadataMap = {
  'general.architecture': 'gemma2',
  'gemma2.block_count': 26,
  'gemma2.attention.head_count': 8,
  'gemma2.attention.head_count_kv': 4,
  'gemma2.attention.key_length': 256,
  'gemma2.attention.value_length': 256,
  'gemma2.embedding_length': 2304,
  'gemma2.context_length': 8192,
  'gemma2.attention.sliding_window': 4096,
};

/** No key/value length: the head-dimension fallback must fire. */
const FALLBACK: GgufMetadataMap = {
  'general.architecture': 'llama',
  'llama.block_count': 4,
  'llama.attention.head_count': 8,
  'llama.embedding_length': 1024,
  'llama.context_length': 2048,
};

/** 16 GB Apple Silicon: unified memory, so no discrete GPU is reported. */
const APPLE_16GB: CompatibilityHardware = { totalRamBytes: 17_179_869_184, gpus: [] };
/** 8 GB laptop, no GPU at all. */
const CPU_8GB: CompatibilityHardware = { totalRamBytes: 8_589_934_592, gpus: [] };
/** Workstation: 64 GB RAM plus a 24 GB discrete card. */
const WORKSTATION: CompatibilityHardware = {
  totalRamBytes: 68_719_476_736,
  gpus: [{ name: 'NVIDIA GeForce RTX 4090', totalMemoryBytes: 25_769_803_776 }],
};

describe('constants', () => {
  it('matches Atomic-Chat exactly', () => {
    expect(BYTES_PER_ELEMENT).toBe(2);
    expect(RESERVE_BYTES).toBe(2_288_490_189);
    expect(DEFAULT_VERDICT_CONTEXT_SIZE).toBe(8192);
  });
});

describe('estimateKvCache', () => {
  it('sizes the small model at 8192 tokens', () => {
    const estimate = estimateKvCache(SMALL, 8192);
    // 16 layers × 8 kv heads × (64 + 64) × 2 bytes = 32768 bytes per token.
    expect(estimate.bytesPerToken).toBe(32_768);
    expect(estimate.contextLength).toBe(8192);
    expect(estimate.fullCostBytes).toBe(268_435_456);
    expect(estimate.slidingCostBytes).toBeNull();
    expect(estimate.kvCacheBytes).toBe(268_435_456);
    expect(estimate.usedHeadDimensionFallback).toBe(false);
  });

  it('sizes the large model at 8192 tokens', () => {
    const estimate = estimateKvCache(LARGE, 8192);
    // 80 × 8 × 256 × 2 = 327680 bytes per token.
    expect(estimate.bytesPerToken).toBe(327_680);
    expect(estimate.kvCacheBytes).toBe(2_684_354_560);
  });

  it('clamps the requested context to the model maximum', () => {
    const estimate = estimateKvCache(SMALL, 1_000_000);
    expect(estimate.contextLength).toBe(32_768);
    expect(estimate.maxContextLength).toBe(32_768);
    expect(estimate.kvCacheBytes).toBe(32_768 * 32_768);
  });

  it('uses the full window when no context size is given', () => {
    expect(estimateKvCache(SMALL).contextLength).toBe(32_768);
  });

  it('prefers head_count_kv but falls back to head_count', () => {
    const noKv: GgufMetadataMap = { ...SMALL };
    delete (noKv as Record<string, unknown>)['llama.attention.head_count_kv'];

    expect(estimateKvCache(SMALL, 8192).headCountKv).toBe(8);
    expect(estimateKvCache(noKv, 8192).headCountKv).toBe(32);
    // Four times the KV heads is four times the cache.
    expect(estimateKvCache(noKv, 8192).kvCacheBytes).toBe(268_435_456 * 4);
  });

  it('averages the full and windowed costs for a sliding-window model', () => {
    const estimate = estimateKvCache(SLIDING, 8192);
    // 26 × 4 × 512 × 2 = 106496 bytes per token.
    expect(estimate.bytesPerToken).toBe(106_496);
    expect(estimate.slidingWindow).toBe(4096);
    expect(estimate.fullCostBytes).toBe(872_415_232);
    expect(estimate.slidingCostBytes).toBe(436_207_616);
    // (872415232 + 436207616) / 2
    expect(estimate.kvCacheBytes).toBe(654_311_424);
    // Strictly cheaper than the same model without a window.
    expect(estimate.kvCacheBytes).toBeLessThan(estimate.fullCostBytes);
  });

  it('ignores a sliding window of zero', () => {
    const estimate = estimateKvCache({ ...SLIDING, 'gemma2.attention.sliding_window': 0 }, 8192);
    expect(estimate.slidingWindow).toBeNull();
    expect(estimate.kvCacheBytes).toBe(872_415_232);
  });

  it('derives the head dimension from embedding_length / head_count', () => {
    const estimate = estimateKvCache(FALLBACK, 8192);
    expect(estimate.usedHeadDimensionFallback).toBe(true);
    expect(estimate.keyLength).toBe(128);
    expect(estimate.valueLength).toBe(128);
    // 4 × 8 × 256 × 2 = 16384; context clamped to 2048.
    expect(estimate.bytesPerToken).toBe(16_384);
    expect(estimate.contextLength).toBe(2048);
    expect(estimate.kvCacheBytes).toBe(33_554_432);
  });

  it('uses integer division for the head dimension', () => {
    const estimate = estimateKvCache(
      { ...FALLBACK, 'llama.embedding_length': 1000, 'llama.attention.head_count': 7 },
      2048,
    );
    // floor(1000 / 7) === 142, not 142.857…
    expect(estimate.keyLength).toBe(142);
    expect(estimate.bytesPerToken).toBe(4 * 7 * 284 * 2);
  });

  it.each([
    ['MISSING_ARCHITECTURE', (meta: Record<string, unknown>) => delete meta['general.architecture']],
    ['MISSING_BLOCK_COUNT', (meta: Record<string, unknown>) => delete meta['llama.block_count']],
    ['MISSING_CONTEXT_LENGTH', (meta: Record<string, unknown>) => delete meta['llama.context_length']],
  ])('throws %s rather than guessing', (code, mutate) => {
    const meta: Record<string, unknown> = { ...SMALL };
    mutate(meta);
    expect(() => estimateKvCache(meta as GgufMetadataMap, 8192)).toThrowError(ModelMetadataError);
    try {
      estimateKvCache(meta as GgufMetadataMap, 8192);
    } catch (error) {
      expect((error as ModelMetadataError).code).toBe(code);
    }
  });

  it('throws MISSING_HEAD_COUNT when both head counts are absent', () => {
    const meta: Record<string, unknown> = { ...SMALL };
    delete meta['llama.attention.head_count'];
    delete meta['llama.attention.head_count_kv'];
    expect(() => estimateKvCache(meta as GgufMetadataMap, 8192)).toThrowError(/head_count/);
  });

  it('throws MISSING_HEAD_COUNT when head_count_kv is zero and there is no fallback', () => {
    const meta: Record<string, unknown> = { ...SMALL, 'llama.attention.head_count_kv': 0 };
    delete meta['llama.attention.head_count'];
    try {
      estimateKvCache(meta as GgufMetadataMap, 8192);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ModelMetadataError).code).toBe('MISSING_HEAD_COUNT');
    }
  });

  it('throws MISSING_HEAD_DIMENSION when the fallback cannot be computed', () => {
    const meta: Record<string, unknown> = { ...FALLBACK, 'llama.embedding_length': 0 };
    try {
      estimateKvCache(meta as GgufMetadataMap, 8192);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ModelMetadataError).code).toBe('MISSING_HEAD_DIMENSION');
    }
  });

  it('rejects a zero block count', () => {
    try {
      estimateKvCache({ ...SMALL, 'llama.block_count': 0 }, 8192);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ModelMetadataError).code).toBe('MISSING_BLOCK_COUNT');
    }
  });
});

describe('checkModelSupport', () => {
  it('is GREEN for the small model on 16 GB Apple Silicon', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: APPLE_16GB,
    });

    expect(report.verdict).toBe('GREEN');
    expect(report.hasDiscreteGpu).toBe(false);
    // Unified memory: RAM is the VRAM pool and is not counted twice.
    expect(report.totalSystemMemoryBytes).toBe(0);
    expect(report.totalVramBytes).toBe(17_179_869_184);
    expect(report.kvCacheBytes).toBe(268_435_456);
    expect(report.totalRequiredBytes).toBe(1_068_435_456);
    // 17179869184 - 2288490189
    expect(report.usableVramBytes).toBe(14_891_378_995);
    expect(report.usableTotalMemoryBytes).toBe(14_891_378_995);
  });

  it('is GREEN for the small model on an 8 GB CPU-only laptop', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: CPU_8GB,
    });

    expect(report.verdict).toBe('GREEN');
    // 8589934592 - 2288490189
    expect(report.usableVramBytes).toBe(6_301_444_403);
    expect(report.usableTotalMemoryBytes).toBe(6_301_444_403);
  });

  it('is RED for the large model on 16 GB Apple Silicon', () => {
    const report = checkModelSupport({
      meta: LARGE,
      modelSizeBytes: LARGE_SIZE_BYTES,
      hardware: APPLE_16GB,
    });

    expect(report.verdict).toBe('RED');
    expect(report.kvCacheBytes).toBe(2_684_354_560);
    expect(report.totalRequiredBytes).toBe(42_684_354_560);
    expect(report.usableTotalMemoryBytes).toBe(14_891_378_995);
    expect(report.reason).toContain('only');
  });

  it('is RED for the large model on the 8 GB laptop', () => {
    expect(
      checkModelSupport({ meta: LARGE, modelSizeBytes: LARGE_SIZE_BYTES, hardware: CPU_8GB }).verdict,
    ).toBe('RED');
  });

  it('is YELLOW for the large model on 64 GB RAM + a 24 GB discrete GPU', () => {
    const report = checkModelSupport({
      meta: LARGE,
      modelSizeBytes: LARGE_SIZE_BYTES,
      hardware: WORKSTATION,
    });

    expect(report.verdict).toBe('YELLOW');
    expect(report.hasDiscreteGpu).toBe(true);
    // Discrete GPU: RAM and VRAM are separate pools and both count.
    expect(report.totalSystemMemoryBytes).toBe(68_719_476_736);
    expect(report.totalVramBytes).toBe(25_769_803_776);
    // 25769803776 - 2288490189
    expect(report.usableVramBytes).toBe(23_481_313_587);
    // (68719476736 - 2288490189) + 23481313587
    expect(report.usableTotalMemoryBytes).toBe(89_912_300_134);
    expect(report.totalRequiredBytes).toBe(42_684_354_560);
    expect(report.totalRequiredBytes).toBeGreaterThan(report.usableVramBytes);
    expect(report.totalRequiredBytes).toBeLessThanOrEqual(report.usableTotalMemoryBytes);
  });

  it('is GREEN for the small model on the workstation, because it fits in VRAM alone', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: WORKSTATION,
    });
    expect(report.verdict).toBe('GREEN');
    expect(report.totalRequiredBytes).toBeLessThanOrEqual(report.usableVramBytes);
  });

  it('sums VRAM across multiple discrete GPUs', () => {
    const report = checkModelSupport({
      meta: LARGE,
      modelSizeBytes: LARGE_SIZE_BYTES,
      hardware: {
        totalRamBytes: 68_719_476_736,
        gpus: [
          { name: 'A', totalMemoryBytes: 25_769_803_776 },
          { name: 'B', totalMemoryBytes: 25_769_803_776 },
        ],
      },
    });
    expect(report.totalVramBytes).toBe(51_539_607_552);
    expect(report.usableVramBytes).toBe(49_251_117_363);
    // 42684354560 <= 49251117363, so it fits entirely in VRAM.
    expect(report.verdict).toBe('GREEN');
  });

  it('folds the sliding-window model into the verdict with the averaged cache', () => {
    const report = checkModelSupport({
      meta: SLIDING,
      modelSizeBytes: 5_000_000_000,
      hardware: APPLE_16GB,
    });
    expect(report.kvCacheBytes).toBe(654_311_424);
    expect(report.totalRequiredBytes).toBe(5_654_311_424);
    expect(report.verdict).toBe('GREEN');
  });

  it('clamps usable VRAM at zero rather than going negative', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: { totalRamBytes: 1_000_000_000, gpus: [] },
    });
    expect(report.usableVramBytes).toBe(0);
    expect(report.usableTotalMemoryBytes).toBe(0);
    expect(report.verdict).toBe('RED');
  });

  it('does not subtract the reserve twice when system memory is below it', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: {
        totalRamBytes: 2_000_000_000,
        gpus: [{ name: 'small card', totalMemoryBytes: 8_589_934_592 }],
      },
    });
    // 2 GB of RAM is under the reserve, so it contributes nothing at all.
    expect(report.usableTotalMemoryBytes).toBe(report.usableVramBytes);
    expect(report.usableVramBytes).toBe(8_589_934_592 - RESERVE_BYTES);
  });

  it('is GREY, never a colour, when RAM could not be detected', () => {
    const report = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: { totalRamBytes: null, gpus: [] },
    });
    expect(report.verdict).toBe('GREY');
    expect(report.kvCache).toBeNull();
    expect(report.reason).toMatch(/detection failed/i);
  });

  it('is GREY when the metadata is too thin to size the cache', () => {
    const report = checkModelSupport({
      meta: { 'general.architecture': 'llama' },
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: APPLE_16GB,
    });
    expect(report.verdict).toBe('GREY');
    expect(report.reason).toMatch(/block_count/);
  });

  it('reports the context it actually used, clamped to the model maximum', () => {
    const report = checkModelSupport({
      meta: SLIDING,
      modelSizeBytes: 1_000_000,
      hardware: APPLE_16GB,
      ctxSize: 65_536,
    });
    expect(report.contextSize).toBe(8192);
  });

  it('grows the requirement with the context size', () => {
    const small = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: APPLE_16GB,
      ctxSize: 4096,
    });
    const large = checkModelSupport({
      meta: SMALL,
      modelSizeBytes: SMALL_SIZE_BYTES,
      hardware: APPLE_16GB,
      ctxSize: 32_768,
    });
    expect(small.kvCacheBytes).toBe(134_217_728);
    expect(large.kvCacheBytes).toBe(1_073_741_824);
    expect(large.totalRequiredBytes - small.totalRequiredBytes).toBe(939_524_096);
  });
});
