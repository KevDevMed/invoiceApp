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

/**
 * INV-4: a verdict is a statement about one machine reading, and the cache has
 * to say which. Everything here is about the window in which a check issued
 * against the old reading lands after the new one has been adopted.
 */
describe('the machine reading a cached verdict belongs to', () => {
  /** A machine too small for the 8 GB file below, so its verdict is RED. */
  const TINY_4GB: HardwareProfile = {
    ...APPLE_16GB,
    cpuModel: 'Apple M1',
    totalRamBytes: 4_294_967_296,
    gpus: [{ name: 'Apple M1', totalMemoryBytes: 4_294_967_296 }],
    totalVramBytes: 4_294_967_296,
  };

  /** A third distinct reading, so a sequence can move 16 GB -> 12 GB -> 4 GB. */
  const MID_12GB: HardwareProfile = {
    ...APPLE_16GB,
    cpuModel: 'Apple M1 Pro',
    totalRamBytes: 12_884_901_888,
    gpus: [{ name: 'Apple M1 Pro', totalMemoryBytes: 12_884_901_888 }],
    totalVramBytes: 12_884_901_888,
  };

  const BIG_FILE = 8_000_000_000;

  /** Let every pending microtask chain settle before poking the service again. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** A value that only becomes available when the test opens the gate. */
  function gate<T>(value: T) {
    let open!: () => void;
    const arrived = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      open,
      run: async (): Promise<T> => {
        await arrived;
        return value;
      },
    };
  }

  /** A header read that only resolves when the test says so. */
  function gatedHeader() {
    const gates: Array<() => void> = [];
    const readHeader = vi.fn(async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return HEADER;
    });
    return {
      readHeader,
      /** Settle first, so a read that has not reached its gate yet is caught too. */
      release: async (): Promise<void> => {
        await flush();
        gates.splice(0).forEach((open) => open());
        await flush();
      },
      /** Newest read first, so an older one is the last to write. */
      releaseNewestFirst: async (): Promise<void> => {
        await flush();
        for (const open of gates.splice(0).reverse()) {
          open();
          await flush();
        }
      },
    };
  }

  it('does not serve a verdict computed against a superseded reading', async () => {
    const { readHeader, release } = gatedHeader();
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockResolvedValue(TINY_4GB);
    const instance = new SupportService({ detectHardware: detect, readHeader, headSize: async () => BIG_FILE });

    // A: issued against the 16 GB reading, still reading the header.
    const inFlight = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    await instance.systemInfo(true); // the machine is now the 4 GB one
    await release();
    expect((await inFlight).breakdown.verdict).toBe('GREEN');

    // A's answer was about a machine that no longer applies, so it is not in
    // the cache to be served and the next polite ask pays for a real check.
    expect(instance.cached(REQUEST.repo, REQUEST.filename, 8192)).toBeNull();
    expect(instance.all()).toHaveLength(0);

    const fresh = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    await release();
    expect((await fresh).breakdown.verdict).toBe('RED');
    expect(readHeader).toHaveBeenCalledTimes(2);
  });

  it('keeps a verdict that lands after a re-probe of the same machine', async () => {
    const { readHeader, release } = gatedHeader();
    // Same machine, re-measured: `freeRamBytes` moved, nothing the verdict reads did.
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockResolvedValue({ ...APPLE_16GB, freeRamBytes: 1_000_000_000 });
    const instance = new SupportService({ detectHardware: detect, readHeader, headSize: async () => 1 });

    const inFlight = instance.check({ ...REQUEST, sizeBytes: 1 });
    await instance.systemInfo(true);
    await release();
    await inFlight;

    // The stamp is what the verdict was computed from, not a probe counter, so
    // a re-measurement that changed nothing relevant does not throw the answer
    // away — which is the difference between `Re-check` costing one header read
    // per row and costing none.
    expect(instance.all()).toHaveLength(1);
    await instance.check({ ...REQUEST, sizeBytes: 1 });
    expect(readHeader).toHaveBeenCalledOnce();
  });

  it('does not let an older probe overwrite a newer machine reading', async () => {
    let slow: (() => void) | null = null;
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      // Probe 1: issued first, resolves last.
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          slow = resolve;
        });
        return APPLE_16GB;
      })
      // Probe 2: issued second, resolves immediately.
      .mockResolvedValue(TINY_4GB);
    const instance = new SupportService({ detectHardware: detect, readHeader: async () => HEADER, headSize: async () => 1 });

    const first = instance.systemInfo(true);
    const second = instance.systemInfo(true);
    expect(await second).toMatchObject({ totalRamBytes: TINY_4GB.totalRamBytes });

    slow!();
    // The late probe describes the older machine, so it is neither adopted nor
    // handed back: its caller gets the reading the app actually believes.
    expect(await first).toMatchObject({ totalRamBytes: TINY_4GB.totalRamBytes });
    expect(await instance.systemInfo()).toMatchObject({ totalRamBytes: TINY_4GB.totalRamBytes });
  });

  it('cannot serve the stale non-RED verdict from the reproduction sequence', async () => {
    const { readHeader, release, releaseNewestFirst } = gatedHeader();
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockResolvedValue(TINY_4GB);
    const instance = new SupportService({ detectHardware: detect, readHeader, headSize: async () => BIG_FILE });

    // 1. Check A starts against H0, its header read still in flight.
    const checkA = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    // 2. `Re-check`: probe gives H1, and check B returns RED against it.
    await instance.systemInfo(true);
    const checkB = instance.check({ ...REQUEST, sizeBytes: BIG_FILE, refresh: true });
    // 3. Both complete, A last — the whole point of the sequence. The renderer
    //    discards A on its generation guard; main must not keep it either.
    await releaseNewestFirst();
    expect((await checkB).breakdown.verdict).toBe('RED');
    expect((await checkA).breakdown.verdict).toBe('GREEN');

    // 4. The discovery sweep asks politely — no `refresh`.
    const sweep = instance.checkMany([{ ...REQUEST, sizeBytes: BIG_FILE }]);
    await release();
    const [served] = await sweep;

    // 5. RED, so `startDownload` raises the confirmation.
    expect(served!.breakdown.verdict).toBe('RED');
    // B's answer was current, so the sweep was served it rather than paying for
    // a fourth header read: A's stale entry is absent, not merely outvoted.
    expect(readHeader).toHaveBeenCalledTimes(2);
  });

  /**
   * A probe that fails does not make the machine settled. Everything below is
   * about the window a failed or superseded probe opens over an older probe that
   * is still out — the case a single `pending` slot could not represent.
   */
  it('joins an older probe still in flight after a newer probe threw', async () => {
    const slow = gate(TINY_4GB);
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockImplementationOnce(slow.run)
      .mockImplementationOnce(async () => {
        throw new Error('llama probe crashed');
      });
    const instance = new SupportService({
      detectHardware: detect,
      readHeader: async () => HEADER,
      headSize: async () => BIG_FILE,
    });

    await instance.systemInfo(); // the app believes the 16 GB machine
    const reProbe = instance.systemInfo(true); // out, and about to say 4 GB
    // A second `Re-check` whose probe blows up. `useModels.refreshSystem`
    // swallows this and carries straight on to the checks, so a stale answer
    // here is an accepted stale answer, not a visible failure.
    await instance.systemInfo(true).catch(() => null);
    await flush();

    const verdict = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    slow.open();
    await reProbe;

    // Against 16 GB this file is GREEN and `startDownload` would not confirm.
    expect((await verdict).breakdown.verdict).toBe('RED');
  });

  it('does not open a duplicate probe when a failed one empties the slot', async () => {
    const slow = gate(APPLE_16GB);
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockImplementationOnce(slow.run)
      .mockImplementationOnce(async () => {
        throw new Error('llama probe crashed');
      })
      .mockResolvedValue(TINY_4GB);
    const instance = new SupportService({
      detectHardware: detect,
      readHeader: async () => HEADER,
      headSize: async () => BIG_FILE,
    });

    const first = instance.check({ ...REQUEST, sizeBytes: BIG_FILE }); // opens probe 1
    await instance.systemInfo(true).catch(() => null); // probe 2 throws
    await flush();
    const second = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    slow.open();
    await Promise.all([first, second]);

    // Probe 1 was still out, so there was nothing to detect a third time.
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it('carries a check across three readings without founding it on the first', async () => {
    const slow = gate(MID_12GB);
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockImplementationOnce(slow.run)
      .mockImplementationOnce(async () => {
        throw new Error('llama probe crashed');
      })
      .mockResolvedValue(TINY_4GB);
    const instance = new SupportService({
      detectHardware: detect,
      readHeader: async () => HEADER,
      headSize: async () => BIG_FILE,
    });

    await instance.check({ ...REQUEST, sizeBytes: BIG_FILE }); // 16 GB, cached
    const toMid = instance.systemInfo(true);
    await instance.systemInfo(true).catch(() => null); // throws over the top of it
    await flush();

    const pending = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    slow.open();
    await toMid;
    const landed = await pending;

    // Identify the reading by the number the verdict was computed from, not by
    // its colour: only the 12 GB probe was ever going to be adopted here.
    expect(landed.breakdown.totalVramBytes).toBe(MID_12GB.totalVramBytes);

    await instance.systemInfo(true); // third reading: 4 GB
    expect(instance.cached(REQUEST.repo, REQUEST.filename, 8192)).toBeNull();
    expect(instance.all()).toHaveLength(0);
  });

  it('serves nothing from `cached` or `all` while a re-probe is out', async () => {
    const header = gate(HEADER);
    const probe = gate(TINY_4GB);
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockImplementationOnce(probe.run);
    const instance = new SupportService({
      detectHardware: detect,
      readHeader: header.run,
      headSize: async () => BIG_FILE,
    });

    const inFlight = instance.check({ ...REQUEST, sizeBytes: BIG_FILE }); // against 16 GB
    await flush();
    const reProbe = instance.systemInfo(true); // drops the cache; 16 GB still adopted
    await flush();
    header.open();
    await inFlight; // re-populates a 16 GB-stamped entry inside that window

    expect(instance.cached(REQUEST.repo, REQUEST.filename, 8192)).toBeNull();
    expect(instance.all()).toHaveLength(0);

    probe.open();
    await reProbe;
  });

  it('does not surface a grey answer written mid-refresh by a check that threw', async () => {
    const header = gate(null);
    const probe = gate(TINY_4GB);
    const detect = vi
      .fn<() => Promise<HardwareProfile>>()
      .mockResolvedValueOnce(APPLE_16GB)
      .mockImplementationOnce(probe.run);
    const instance = new SupportService({
      detectHardware: detect,
      readHeader: async () => {
        await header.run();
        throw new Error('connection reset');
      },
      headSize: async () => BIG_FILE,
    });

    const inFlight = instance.check({ ...REQUEST, sizeBytes: BIG_FILE });
    await flush();
    const reProbe = instance.systemInfo(true);
    await flush();
    header.open();
    expect((await inFlight).breakdown.verdict).toBe('GREY');

    // A GREY entry is still an entry, and it is stamped with the reading being
    // replaced — the renderer's initial paint must not be handed it.
    expect(instance.cached(REQUEST.repo, REQUEST.filename, 8192)).toBeNull();
    expect(instance.all()).toHaveLength(0);

    probe.open();
    await reProbe;
  });
});

describe('checkMany', () => {
  it('runs at most `concurrency` range reads at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const readHeader = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return HEADER;
    });
    const { instance } = service({ readHeader });

    const requests = Array.from({ length: 9 }, (_, index) => ({
      repo: 'a/b',
      filename: `m-${index}.gguf`,
      sizeBytes: 800_000_000,
    }));
    const results = await instance.checkMany(requests, { concurrency: 3 });

    expect(peak).toBe(3);
    expect(results).toHaveLength(9);
    // Results are in request order, not completion order.
    expect(results.map((result) => result.filename)).toEqual(
      requests.map((request) => request.filename),
    );
  });

  it('turns one failing check into a grey row rather than failing the batch', async () => {
    const readHeader = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error('connection reset');
      return HEADER;
    });
    const { instance } = service({ readHeader });

    const results = await instance.checkMany([
      { repo: 'a/b', filename: 'good.gguf', sizeBytes: 800_000_000 },
      { repo: 'a/b', filename: 'bad.gguf', sizeBytes: 800_000_000 },
    ]);

    expect(results[0]!.breakdown.verdict).not.toBe('GREY');
    expect(results[1]!.breakdown.verdict).toBe('GREY');
    expect(results[1]!.error).toContain('connection reset');
  });
});

describe('budget', () => {
  it('reports the same usable memory the verdict is computed against', async () => {
    const { instance } = service();
    const budget = await instance.budget();

    expect(budget.hasDiscreteGpu).toBe(false);
    // Unified memory: RAM is the VRAM pool, counted once, less the reserve.
    expect(budget.usableTotalMemoryBytes).toBe(17_179_869_184 - 2_288_490_189);
  });
});
