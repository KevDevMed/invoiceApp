/**
 * The contract lets a renderer ask for a 1,048,576-token context. These are the
 * numbers that stop that request from reaching `model.createContext` unchanged.
 */

import { describe, expect, it } from 'vitest';

import { RESERVE_BYTES, type CompatibilityHardware, type GgufMetadataMap } from '../compatibility';
import { clampContextSize, MIN_CONTEXT_SIZE } from '../context-clamp';

/** 16 layers, 8 KV heads, 64/64 → 16 * 8 * 128 * 2 = 32,768 bytes per token. */
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

const BYTES_PER_TOKEN = 16 * 8 * (64 + 64) * 2;

/** Unified-memory machine, so `totalRamBytes` is the whole budget. */
function machineWith(ramBytes: number): CompatibilityHardware {
  return { totalRamBytes: ramBytes, gpus: [] };
}

describe('clampContextSize', () => {
  it("clamps a 1M request to the model's own maximum when memory is plentiful", () => {
    const clamp = clampContextSize({
      requested: 1_048_576,
      meta: SMALL,
      modelSizeBytes: 800_000_000,
      // Enough that the memory ceiling is far above the model's 32,768.
      hardware: machineWith(RESERVE_BYTES + 800_000_000 + BYTES_PER_TOKEN * 1_000_000),
      fallbackMax: 4096,
    });

    expect(clamp.clamped).toBe(true);
    expect(clamp.contextSize).toBe(32_768);
    expect(clamp.requestedContextSize).toBe(1_048_576);
    expect(clamp.modelMaxContextSize).toBe(32_768);
    // The reason is user-facing and has to name the limit that bit.
    expect(clamp.reason).toContain("the model's maximum context of 32768 tokens");
  });

  it('clamps to what memory can hold when that is tighter than the model maximum', () => {
    // 8 GB machine: usable = 8 GiB - RESERVE, minus the weights, over 32,768 B/token.
    const totalRam = 8 * 1024 ** 3;
    const modelSizeBytes = 6_000_000_000;
    const usable = totalRam - RESERVE_BYTES;
    const expected = Math.floor((usable - modelSizeBytes) / BYTES_PER_TOKEN);

    const clamp = clampContextSize({
      requested: 1_048_576,
      meta: SMALL,
      modelSizeBytes,
      hardware: machineWith(totalRam),
      fallbackMax: 4096,
    });

    expect(clamp.clamped).toBe(true);
    expect(clamp.memoryMaxContextSize).toBe(expected);
    expect(clamp.contextSize).toBe(expected);
    expect(expected).toBeLessThan(32_768);
    expect(clamp.reason).toContain("this machine's memory");
  });

  it('leaves a modest request alone and reports no clamp', () => {
    const clamp = clampContextSize({
      requested: 4096,
      meta: SMALL,
      modelSizeBytes: 800_000_000,
      hardware: machineWith(32 * 1024 ** 3),
      fallbackMax: 4096,
    });

    expect(clamp.clamped).toBe(false);
    expect(clamp.contextSize).toBe(4096);
    expect(clamp.reason).toBeNull();
  });

  it('falls back to the caller-supplied maximum when the metadata cannot be read', () => {
    const clamp = clampContextSize({
      requested: 1_048_576,
      meta: null,
      modelSizeBytes: 800_000_000,
      hardware: machineWith(32 * 1024 ** 3),
      fallbackMax: 8192,
    });

    expect(clamp.contextSize).toBe(8192);
    expect(clamp.clamped).toBe(true);
    expect(clamp.modelMaxContextSize).toBeNull();
    expect(clamp.reason).toContain('metadata could not be read');
  });

  it('falls back the same way when the metadata is too thin to size the cache', () => {
    const clamp = clampContextSize({
      requested: 262_144,
      meta: { 'general.architecture': 'llama' },
      modelSizeBytes: 800_000_000,
      hardware: machineWith(32 * 1024 ** 3),
      fallbackMax: 4096,
    });

    expect(clamp.contextSize).toBe(4096);
    expect(clamp.clamped).toBe(true);
  });

  it('never clamps below a usable floor, even on a machine with no room', () => {
    const clamp = clampContextSize({
      requested: 1_048_576,
      meta: SMALL,
      modelSizeBytes: 40_000_000_000,
      hardware: machineWith(RESERVE_BYTES + 1),
      fallbackMax: 4096,
    });

    expect(clamp.contextSize).toBe(MIN_CONTEXT_SIZE);
    expect(clamp.clamped).toBe(true);
  });

  it('treats undetectable hardware as "the model maximum" rather than refusing', () => {
    const clamp = clampContextSize({
      requested: 1_048_576,
      meta: SMALL,
      modelSizeBytes: 800_000_000,
      hardware: { totalRamBytes: null, gpus: [] },
      fallbackMax: 4096,
    });

    expect(clamp.contextSize).toBe(32_768);
    expect(clamp.memoryMaxContextSize).toBeNull();
  });
});
