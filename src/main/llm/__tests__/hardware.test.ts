/**
 * Hardware detection, with every source injected.
 *
 * The point of these tests is the two shapes that reach the verdict formula:
 * unified memory (RAM *is* VRAM, so no discrete GPU is reported) and a discrete
 * card (two separate pools). Plus the rule that a failure yields "unknown",
 * never a number.
 */

import { describe, expect, it, vi } from 'vitest';

import { checkModelSupport, type GgufMetadataMap } from '../compatibility';
import {
  describeHardware,
  detectHardware,
  toCompatibilityHardware,
  type HardwareDeps,
} from '../hardware';

const META: GgufMetadataMap = {
  'general.architecture': 'llama',
  'llama.block_count': 16,
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
  'llama.attention.key_length': 64,
  'llama.attention.value_length': 64,
  'llama.embedding_length': 2048,
  'llama.context_length': 32_768,
};

function baseDeps(overrides: Partial<HardwareDeps> = {}): HardwareDeps {
  return {
    totalmem: () => 17_179_869_184,
    freemem: () => 8_000_000_000,
    cpus: () => Array.from({ length: 10 }, () => ({ model: 'Apple M2 Pro' })),
    platform: () => 'darwin',
    arch: () => 'arm64',
    llamaProbe: async () => null,
    electronGpuInfo: async () => null,
    ...overrides,
  };
}

describe('detectHardware', () => {
  it('reads RAM and CPU from os', async () => {
    const profile = await detectHardware(baseDeps());
    expect(profile.totalRamBytes).toBe(17_179_869_184);
    expect(profile.freeRamBytes).toBe(8_000_000_000);
    expect(profile.cpuCores).toBe(10);
    expect(profile.cpuModel).toBe('Apple M2 Pro');
    expect(profile.isAppleSilicon).toBe(true);
    expect(profile.hasUnifiedMemory).toBe(true);
  });

  it('reads VRAM and device names from node-llama-cpp', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        totalmem: () => 68_719_476_736,
        llamaProbe: async () => ({
          gpu: 'cuda',
          getVramState: async () => ({
            total: 25_769_803_776,
            used: 1_000_000,
            free: 24_000_000_000,
            unifiedSize: 0,
          }),
          getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4090'],
        }),
      }),
    );

    expect(profile.vramSource).toBe('node-llama-cpp');
    expect(profile.gpuBackend).toBe('cuda');
    expect(profile.hasUnifiedMemory).toBe(false);
    expect(profile.gpus).toEqual([
      { name: 'NVIDIA GeForce RTX 4090', totalMemoryBytes: 25_769_803_776 },
    ]);
    expect(profile.totalVramBytes).toBe(25_769_803_776);
    expect(profile.detectionError).toBeNull();
  });

  it('treats a non-zero unifiedSize as unified memory even off Apple Silicon', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'arm64',
        llamaProbe: async () => ({
          gpu: 'vulkan',
          getVramState: async () => ({
            total: 8_000_000_000,
            used: 0,
            free: 8_000_000_000,
            unifiedSize: 8_000_000_000,
          }),
          getGpuDeviceNames: async () => ['Mali-G710'],
        }),
      }),
    );

    expect(profile.isAppleSilicon).toBe(false);
    expect(profile.hasUnifiedMemory).toBe(true);
    // Folded for the formula: unified machines contribute no discrete GPU.
    expect(toCompatibilityHardware(profile).gpus).toEqual([]);
  });

  it('reports "no GPU" as a real answer when the backend loads but finds nothing', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        llamaProbe: async () => ({
          gpu: false,
          getVramState: async () => ({ total: 0, used: 0, free: 0, unifiedSize: 0 }),
          getGpuDeviceNames: async () => [],
        }),
      }),
    );

    expect(profile.gpuBackend).toBeNull();
    expect(profile.gpus).toEqual([]);
    expect(profile.totalVramBytes).toBeNull();
    expect(profile.vramSource).toBe('node-llama-cpp');
  });

  it('attributes the pooled VRAM figure to one device rather than splitting it', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        llamaProbe: async () => ({
          gpu: 'cuda',
          getVramState: async () => ({
            total: 20_000_000_000,
            used: 0,
            free: 20_000_000_000,
            unifiedSize: 0,
          }),
          getGpuDeviceNames: async () => ['GPU A', 'GPU B'],
        }),
      }),
    );

    expect(profile.gpus).toEqual([
      { name: 'GPU A', totalMemoryBytes: 20_000_000_000 },
      { name: 'GPU B', totalMemoryBytes: null },
    ]);
    // The sum is the pool, not the pool doubled.
    expect(profile.totalVramBytes).toBe(20_000_000_000);
  });

  it('falls back to Electron for device names, and says VRAM is unknown', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'win32',
        arch: () => 'x64',
        llamaProbe: async () => {
          throw new Error('no compatible backend');
        },
        electronGpuInfo: async () => ({
          gpuDevice: [{ deviceString: 'Intel(R) Iris(R) Xe Graphics' }, { deviceString: '  ' }],
        }),
      }),
    );

    expect(profile.vramSource).toBe('electron');
    expect(profile.gpus).toEqual([{ name: 'Intel(R) Iris(R) Xe Graphics', totalMemoryBytes: null }]);
    expect(profile.totalVramBytes).toBeNull();
    expect(profile.detectionError).toMatch(/no compatible backend/);
    expect(profile.detectionError).toMatch(/VRAM is unknown/);
  });

  it('never fabricates a VRAM number when everything fails', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        llamaProbe: async () => {
          throw new Error('addon exploded');
        },
        electronGpuInfo: async () => {
          throw new Error('electron unavailable');
        },
      }),
    );

    expect(profile.vramSource).toBe('unknown');
    expect(profile.totalVramBytes).toBeNull();
    expect(profile.gpus).toEqual([]);
    expect(profile.detectionError).toMatch(/addon exploded/);
    expect(profile.detectionError).toMatch(/electron unavailable/);
  });

  it('survives os throwing, leaving RAM null rather than zero', async () => {
    const profile = await detectHardware(
      baseDeps({
        totalmem: () => {
          throw new Error('nope');
        },
        cpus: () => {
          throw new Error('also nope');
        },
      }),
    );

    expect(profile.totalRamBytes).toBeNull();
    expect(profile.cpuCores).toBeNull();
    expect(profile.cpuModel).toBeNull();
    expect(profile.detectionError).toMatch(/total RAM: nope/);
  });

  it('does not consult Electron when node-llama-cpp already answered', async () => {
    const electronGpuInfo = vi.fn(async () => ({ gpuDevice: [{ deviceString: 'should not be used' }] }));
    await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        llamaProbe: async () => ({
          gpu: 'cuda',
          getVramState: async () => ({ total: 1, used: 0, free: 1, unifiedSize: 0 }),
          getGpuDeviceNames: async () => ['GPU'],
        }),
        electronGpuInfo,
      }),
    );
    expect(electronGpuInfo).not.toHaveBeenCalled();
  });
});

describe('toCompatibilityHardware', () => {
  it('folds a unified-memory machine into RAM-as-VRAM', async () => {
    const profile = await detectHardware(
      baseDeps({
        llamaProbe: async () => ({
          gpu: 'metal',
          getVramState: async () => ({
            total: 17_179_869_184,
            used: 0,
            free: 17_179_869_184,
            unifiedSize: 17_179_869_184,
          }),
          getGpuDeviceNames: async () => ['Apple M2 Pro'],
        }),
      }),
    );

    const folded = toCompatibilityHardware(profile);
    expect(folded).toEqual({ totalRamBytes: 17_179_869_184, gpus: [] });

    const report = checkModelSupport({
      meta: META,
      modelSizeBytes: 800_000_000,
      hardware: folded,
    });
    // RAM counted once, as the VRAM pool.
    expect(report.totalSystemMemoryBytes).toBe(0);
    expect(report.totalVramBytes).toBe(17_179_869_184);
    expect(report.verdict).toBe('GREEN');
  });

  it('folds a discrete GPU into two separate pools', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'linux',
        arch: () => 'x64',
        totalmem: () => 68_719_476_736,
        llamaProbe: async () => ({
          gpu: 'cuda',
          getVramState: async () => ({
            total: 25_769_803_776,
            used: 0,
            free: 25_769_803_776,
            unifiedSize: 0,
          }),
          getGpuDeviceNames: async () => ['RTX 4090'],
        }),
      }),
    );

    const report = checkModelSupport({
      meta: META,
      modelSizeBytes: 800_000_000,
      hardware: toCompatibilityHardware(profile),
    });
    expect(report.hasDiscreteGpu).toBe(true);
    expect(report.totalSystemMemoryBytes).toBe(68_719_476_736);
    expect(report.totalVramBytes).toBe(25_769_803_776);
  });

  it('drops a GPU whose VRAM is unknown from the arithmetic but keeps it on screen', async () => {
    const profile = await detectHardware(
      baseDeps({
        platform: () => 'win32',
        arch: () => 'x64',
        totalmem: () => 8_589_934_592,
        llamaProbe: async () => null,
        electronGpuInfo: async () => ({ gpuDevice: [{ deviceString: 'Some iGPU' }] }),
      }),
    );

    expect(profile.gpus).toHaveLength(1);
    const folded = toCompatibilityHardware(profile);
    expect(folded.gpus).toEqual([]);

    const report = checkModelSupport({
      meta: META,
      modelSizeBytes: 800_000_000,
      hardware: folded,
    });
    // No discrete-GPU path: the machine is judged on its RAM alone.
    expect(report.hasDiscreteGpu).toBe(false);
    expect(report.totalVramBytes).toBe(8_589_934_592);
  });

  it('passes a null RAM figure straight through, so the verdict goes GREY', async () => {
    const profile = await detectHardware(
      baseDeps({
        totalmem: () => {
          throw new Error('nope');
        },
      }),
    );
    const report = checkModelSupport({
      meta: META,
      modelSizeBytes: 800_000_000,
      hardware: toCompatibilityHardware(profile),
    });
    expect(report.verdict).toBe('GREY');
  });
});

describe('describeHardware', () => {
  it('summarises a unified-memory machine', async () => {
    const summary = describeHardware(await detectHardware(baseDeps()));
    expect(summary).toContain('darwin/arm64');
    expect(summary).toContain('Apple M2 Pro × 10');
    expect(summary).toContain('16.0 GiB RAM');
    expect(summary).toContain('unified memory');
  });

  it('says "VRAM unknown" rather than a number when it is', async () => {
    const summary = describeHardware(
      await detectHardware(
        baseDeps({
          platform: () => 'win32',
          arch: () => 'x64',
          electronGpuInfo: async () => ({ gpuDevice: [{ deviceString: 'iGPU' }] }),
        }),
      ),
    );
    expect(summary).toContain('VRAM unknown');
  });

  it('says "no GPU" when there is none', async () => {
    const summary = describeHardware(
      await detectHardware(baseDeps({ platform: () => 'linux', arch: () => 'x64' })),
    );
    expect(summary).toContain('no GPU');
  });
});
