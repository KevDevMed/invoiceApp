/**
 * The verdict-before-download orchestration: caching, the HEAD-only path, and
 * the rule that any failure becomes GREY rather than a colour.
 */

import { describe, expect, it, vi } from 'vitest';

import { GgufError, type GgufHeader } from '../gguf';
import type { HardwareProfile } from '../hardware';
import { SupportService } from '../support-service';

const METADATA = {
  'general.architecture': 'llama',
  'llama.block_count': 16,
  'llama.attention.head_count': 32,
  'llama.attention.head_count_kv': 8,
  'llama.attention.key_length': 64,
  'llama.attention.value_length': 64,
  'llama.embedding_length': 2048,
  'llama.context_length': 32_768,
};

const HEADER: GgufHeader = {
  version: 3,
  tensorCount: 100,
  metadataKvCount: 8,
  architecture: 'llama',
  metadata: METADATA,
  stoppedEarly: false,
};

const APPLE_16GB: HardwareProfile = {
  platform: 'darwin',
  arch: 'arm64',
  isAppleSilicon: true,
  hasUnifiedMemory: true,
  cpuModel: 'Apple M2 Pro',
  cpuCores: 10,
  totalRamBytes: 17_179_869_184,
  freeRamBytes: 8_000_000_000,
  gpus: [{ name: 'Apple M2 Pro', totalMemoryBytes: 17_179_869_184 }],
  totalVramBytes: 17_179_869_184,
  vramSource: 'node-llama-cpp',
  gpuBackend: 'metal',
  detectionError: null,
};

function service(overrides: Record<string, unknown> = {}) {
  const readHeader = vi.fn(async () => HEADER);
  const headSize = vi.fn(async () => 800_000_000);
  const detect = vi.fn(async () => APPLE_16GB);
  const instance = new SupportService({
    detectHardware: detect,
    readHeader,
    headSize,
    ...overrides,
  });
  return { instance, readHeader, headSize, detect };
}

const REQUEST = { repo: 'Qwen/Qwen3-1.7B-GGUF', filename: 'Qwen3-1.7B-Q4_K_M.gguf' };

describe('SupportService', () => {
  it('computes a verdict from the header and the machine', async () => {
    const { instance } = service();
    const result = await instance.check({ ...REQUEST, sizeBytes: 800_000_000 });

    expect(result.breakdown.verdict).toBe('GREEN');
    expect(result.breakdown.kvCacheBytes).toBe(268_435_456);
    expect(result.architecture).toBe('llama');
    expect(result.maxContextLength).toBe(32_768);
    expect(result.contextSize).toBe(8192);
    expect(result.error).toBeNull();
  });

  it('skips the HEAD request when the size is already known', async () => {
    const { instance, headSize } = service();
    await instance.check({ ...REQUEST, sizeBytes: 800_000_000 });
    expect(headSize).not.toHaveBeenCalled();
  });

  it('asks for the size with HEAD when it is not known', async () => {
    const { instance, headSize } = service();
    const result = await instance.check(REQUEST);
    expect(headSize).toHaveBeenCalledOnce();
    expect(result.sizeBytes).toBe(800_000_000);
  });

  it('caches per repo, filename and context size', async () => {
    const { instance, readHeader } = service();
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    expect(readHeader).toHaveBeenCalledOnce();

    // A different context size is a different question.
    await instance.check({ ...REQUEST, sizeBytes: 1, ctxSize: 32_768 });
    expect(readHeader).toHaveBeenCalledTimes(2);
    expect(instance.all()).toHaveLength(2);
  });

  it('re-checks when asked to refresh', async () => {
    const { instance, readHeader } = service();
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    await instance.check({ ...REQUEST, sizeBytes: 1, refresh: true });
    expect(readHeader).toHaveBeenCalledTimes(2);
  });

  it('detects the hardware once and reuses it', async () => {
    const { instance, detect } = service();
    await instance.systemInfo();
    await instance.systemInfo();
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    expect(detect).toHaveBeenCalledOnce();
  });

  it('re-detects and drops cached verdicts on an explicit refresh', async () => {
    const { instance, detect } = service();
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    await instance.systemInfo(true);
    expect(instance.all()).toHaveLength(0);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('is GREY, with the reason, when the header cannot be read', async () => {
    const { instance } = service({
      readHeader: async () => {
        throw new GgufError('GGUF header is truncated', 'TRUNCATED');
      },
    });
    const result = await instance.check({ ...REQUEST, sizeBytes: 1 });

    expect(result.breakdown.verdict).toBe('GREY');
    expect(result.error).toMatch(/Could not read the model header/);
    expect(result.breakdown.reason).toMatch(/truncated/);
  });

  it('is GREY when the network is unreachable', async () => {
    const { instance } = service({
      readHeader: async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
    });
    const result = await instance.check({ ...REQUEST, sizeBytes: 1 });
    expect(result.breakdown.verdict).toBe('GREY');
    expect(result.error).toMatch(/Could not reach Hugging Face/);
  });

  it('retries a failed check instead of caching the failure', async () => {
    const readHeader = vi
      .fn<() => Promise<GgufHeader>>()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue(HEADER);
    const { instance } = service({ readHeader });

    expect((await instance.check({ ...REQUEST, sizeBytes: 1 })).breakdown.verdict).toBe('GREY');
    expect((await instance.check({ ...REQUEST, sizeBytes: 1 })).breakdown.verdict).toBe('GREEN');
  });

  it('is GREY when the file size is unknowable', async () => {
    const { instance } = service({ headSize: async () => null });
    const result = await instance.check(REQUEST);
    expect(result.breakdown.verdict).toBe('GREY');
    expect(result.error).toMatch(/did not report the file size/);
  });

  it('is GREY, without touching the network, for a filename the path allow-list refuses', async () => {
    const { instance, readHeader } = service();
    const result = await instance.check({ repo: 'a/b', filename: '../escape.gguf' });
    expect(result.breakdown.verdict).toBe('GREY');
    expect(readHeader).not.toHaveBeenCalled();
  });

  it('passes the configured token through as a bearer header', async () => {
    const readHeader = vi.fn(async (_url: string, _options: { headers?: Record<string, string> }) => HEADER);
    const instance = new SupportService({
      detectHardware: async () => APPLE_16GB,
      readHeader,
      headSize: async () => 1,
      token: () => 'hf_secret',
    });

    await instance.check({ ...REQUEST, sizeBytes: 1 });
    expect(readHeader.mock.calls[0]?.[1]).toEqual({ headers: { authorization: 'Bearer hf_secret' } });
  });

  it('is GREY for every model when hardware detection failed', async () => {
    const { instance } = service({
      detectHardware: async () => ({ ...APPLE_16GB, totalRamBytes: null, detectionError: 'nope' }),
    });
    const result = await instance.check({ ...REQUEST, sizeBytes: 800_000_000 });
    expect(result.breakdown.verdict).toBe('GREY');
    expect(result.breakdown.reason).toMatch(/detection failed/);
  });
});
