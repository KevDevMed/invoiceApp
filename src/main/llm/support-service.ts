/**
 * Verdict-before-download, orchestrated.
 *
 * Detect the hardware once, read each variant's GGUF header over HTTP Range,
 * size the KV cache, and cache the answer per (repo, filename, context size).
 * Nothing here downloads weights.
 *
 * A failure — no network, a gated repo, a header we cannot parse — comes back as
 * a GREY verdict carrying the reason, never as a colour. The UI is expected to
 * say "could not check" and let the user download anyway if they insist.
 *
 * Every cached verdict is stamped with the machine reading it was computed
 * against, and an entry whose stamp is not the current reading is treated as
 * absent. A verdict is a statement about *this machine*, so the moment the
 * machine is re-measured every answer founded on the old measurement is
 * unfounded — including the ones still in flight, which land after the
 * re-measurement and would otherwise be cached as if they were current. The
 * renderer fences its own copy by generation (`features/models/supportCache.ts`)
 * but cannot reach into this process, so the fence has to exist on both sides:
 * a stale non-RED verdict served from here is the download confirmation not
 * appearing for a model that does not fit.
 */

import {
  checkModelSupport,
  DEFAULT_VERDICT_CONTEXT_SIZE,
  memoryBudget,
  type MemoryBudget,
  type SupportBreakdown,
} from './compatibility';
import { downloadUrl } from './catalog';
import { GgufError, headFileSize, readRemoteGgufHeader, type GgufHeader } from './gguf';
import { detectHardware, toCompatibilityHardware, type HardwareProfile } from './hardware';

export interface VariantSupport {
  readonly repo: string;
  readonly filename: string;
  readonly sizeBytes: number | null;
  readonly contextSize: number;
  readonly breakdown: SupportBreakdown;
  readonly architecture: string | null;
  /** Model's own maximum context, straight from the header. */
  readonly maxContextLength: number | null;
  readonly checkedAt: string;
  /** Set when the check could not be completed; `breakdown.verdict` is GREY. */
  readonly error: string | null;
}

export interface SupportServiceDeps {
  readonly detectHardware?: () => Promise<HardwareProfile>;
  readonly readHeader?: (
    url: string,
    options: { headers?: Record<string, string> },
  ) => Promise<GgufHeader>;
  readonly headSize?: (
    url: string,
    options: { headers?: Record<string, string> },
  ) => Promise<number | null>;
  /** Hugging Face token for gated repos, read fresh each call. */
  readonly token?: () => string | null;
}

/** Range reads in flight at once during a batch check. */
export const DEFAULT_CHECK_CONCURRENCY = 4;

export interface CheckRequest {
  readonly repo: string;
  readonly filename: string;
  readonly sizeBytes?: number | null;
  readonly ctxSize?: number;
  readonly refresh?: boolean;
}

function greyFor(request: CheckRequest, contextSize: number, reason: string, sizeBytes: number | null): VariantSupport {
  return {
    repo: request.repo,
    filename: request.filename,
    sizeBytes,
    contextSize,
    breakdown: {
      verdict: 'GREY',
      modelSizeBytes: sizeBytes ?? 0,
      kvCacheBytes: 0,
      totalRequiredBytes: sizeBytes ?? 0,
      totalSystemMemoryBytes: 0,
      totalVramBytes: 0,
      usableVramBytes: 0,
      usableTotalMemoryBytes: 0,
      reserveBytes: 0,
      hasDiscreteGpu: false,
      contextSize,
      kvCache: null,
      reason,
    },
    architecture: null,
    maxContextLength: null,
    checkedAt: new Date().toISOString(),
    error: reason,
  };
}

/**
 * The identity of a machine reading, as far as a verdict is concerned.
 *
 * `checkModelSupport` sees the machine only through `toCompatibilityHardware`,
 * so two profiles with the same projection produce the same verdict for the same
 * file and there is nothing to invalidate between them. Fingerprinting the
 * projection rather than counting probes is what lets `Re-check` on an unchanged
 * machine keep its cache instead of paying for every header again.
 *
 * `freeRamBytes` is deliberately not in here: it moves constantly, is not part of
 * the projection, and stamping it would expire the whole cache every few seconds.
 */
export function profileStamp(profile: HardwareProfile): string {
  const hardware = toCompatibilityHardware(profile);
  return JSON.stringify({
    totalRamBytes: hardware.totalRamBytes,
    gpus: hardware.gpus.map((gpu) => [gpu.name, gpu.totalMemoryBytes]),
  });
}

/** A probe that has been accepted as the current reading. */
interface AdoptedProfile {
  /** Issue order, not completion order. */
  readonly id: number;
  readonly profile: HardwareProfile;
  readonly stamp: string;
}

interface CacheEntry {
  /** The reading this verdict was computed against. */
  readonly stamp: string;
  readonly value: VariantSupport;
}

export class SupportService {
  private adopted: AdoptedProfile | null = null;
  /**
   * Every probe issued and not yet settled, keyed by issue order.
   *
   * A single `pending` slot is not enough: probes overlap, and one settling —
   * especially one *failing* — used to empty the slot while an older probe was
   * still out, so the next caller was handed the previous reading instead of
   * joining the probe that was about to replace it. Insertion order is issue
   * order, so the last entry is always the newest probe in flight.
   */
  private readonly inFlight = new Map<number, Promise<AdoptedProfile>>();
  /** Refresh probes issued and not yet settled. */
  private refreshing = 0;
  private probes = 0;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: SupportServiceDeps = {}) {}

  /**
   * The detected machine. Cached for the life of the process — RAM and GPUs do
   * not change while the app runs, and the llama probe is expensive.
   *
   * `refresh` re-probes. Overlapping probes are ordered by when they were
   * *issued*: a probe that started earlier and finished later describes the older
   * machine, so it is not adopted, and its caller is handed the newer reading
   * rather than the one it happens to be holding.
   */
  async systemInfo(refresh = false): Promise<HardwareProfile> {
    // Dropping the cache eagerly is not what makes the fence safe — the stamps
    // are — but there is no point keeping verdicts about a reading being
    // replaced, and it keeps `all()` honest for the renderer's next paint.
    if (refresh) this.cache.clear();
    return (await this.profile(refresh)).profile;
  }

  private async profile(refresh: boolean): Promise<AdoptedProfile> {
    // Any probe already out is by definition no older than this call, so a
    // non-refresh caller joins it rather than settling for the previous reading.
    // It has to be *any* probe, not the most recently issued one: a probe that
    // throws or is superseded still leaves an older one running, and a caller
    // handed `adopted` while that one is out gets a verdict computed against a
    // reading the app is in the middle of replacing.
    if (!refresh) {
      const joined = this.newestInFlight();
      if (joined) return joined;
      if (this.adopted) return this.adopted;
    }

    const id = (this.probes += 1);
    const detect = this.deps.detectHardware ?? detectHardware;
    const run = (async (): Promise<AdoptedProfile> => {
      const detected = await detect();
      if (this.adopted === null || this.adopted.id < id) {
        this.adopted = { id, profile: detected, stamp: profileStamp(detected) };
      }
      // Late or not, the answer is the reading the app currently believes.
      return this.adopted;
    })();

    this.inFlight.set(id, run);
    if (refresh) this.refreshing += 1;
    try {
      return await run;
    } finally {
      this.inFlight.delete(id);
      if (refresh) this.refreshing -= 1;
    }
  }

  /** The newest probe still out, or nothing when the reading is settled. */
  private newestInFlight(): Promise<AdoptedProfile> | null {
    let newest: Promise<AdoptedProfile> | null = null;
    // Insertion order is issue order, so the last one wins.
    for (const run of this.inFlight.values()) newest = run;
    return newest;
  }

  cacheKey(repo: string, filename: string, contextSize: number): string {
    return `${repo}/${filename}@${contextSize}`;
  }

  cached(repo: string, filename: string, contextSize: number): VariantSupport | null {
    if (this.refreshing > 0) return null;
    return this.entryFor(this.cacheKey(repo, filename, contextSize))?.value ?? null;
  }

  /**
   * A cached entry, or nothing at all when it belongs to a superseded reading.
   *
   * Only the stamp is checked here, because `check` calls this *after* settling
   * its own reading and stamps whatever it writes with the same one. The
   * synchronous readers below need the extra refresh-window guard that `check`
   * gets for free by having waited.
   */
  private entryFor(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    // Nothing has been measured yet, so nothing can be current.
    if (this.adopted === null || entry.stamp !== this.adopted.stamp) return null;
    return entry;
  }

  /**
   * Every verdict computed against the current reading, for the initial paint.
   *
   * Empty while a re-probe is out: `systemInfo(true)` has already dropped the
   * cache, but `adopted` is still the reading being replaced, so a check issued
   * before the refresh can land in that window and re-populate an entry whose
   * stamp matches the reading nobody is going to believe a moment later. An
   * asynchronous caller never sees this — it joins the probe first — but these
   * two are synchronous, and the invariant is that the cache cannot hand out a
   * verdict founded on a reading under replacement.
   */
  all(): VariantSupport[] {
    if (this.refreshing > 0) return [];
    const stamp = this.adopted?.stamp ?? null;
    if (stamp === null) return [];
    return [...this.cache.values()].filter((entry) => entry.stamp === stamp).map((entry) => entry.value);
  }

  /** Drop cached verdicts, e.g. after the hardware panel is refreshed. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * What this machine can give a model, from the same numbers the verdict uses.
   *
   * Discovery leans on this to throw out models whose weights alone exceed the
   * budget before spending a range request on their header.
   */
  async budget(): Promise<MemoryBudget> {
    return memoryBudget(toCompatibilityHardware(await this.systemInfo()));
  }

  /**
   * Check a batch, at most `concurrency` in flight.
   *
   * Each check is a 4 MB range read, so an unbounded fan-out over a search
   * result is tens of requests and hundreds of megabytes at once. Results come
   * back in request order regardless of completion order, and a check that
   * throws becomes a GREY entry rather than failing the batch — one unreachable
   * repo must not blank the other nine.
   */
  async checkMany(
    requests: readonly CheckRequest[],
    options: { concurrency?: number } = {},
  ): Promise<VariantSupport[]> {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CHECK_CONCURRENCY, 8));
    const results = new Array<VariantSupport>(requests.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= requests.length) return;
        const request = requests[index]!;
        try {
          results[index] = await this.check(request);
        } catch (error) {
          results[index] = greyFor(
            request,
            request.ctxSize ?? DEFAULT_VERDICT_CONTEXT_SIZE,
            messageOf(error),
            request.sizeBytes ?? null,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()),
    );
    return results;
  }

  async check(request: CheckRequest): Promise<VariantSupport> {
    const contextSize = request.ctxSize ?? DEFAULT_VERDICT_CONTEXT_SIZE;
    const key = this.cacheKey(request.repo, request.filename, contextSize);

    // The reading is settled before the cache is consulted, because both the
    // hit test and the stamp on whatever is written next are about *this*
    // reading and they have to be the same one.
    const reading = await this.profile(false);

    if (!request.refresh) {
      const hit = this.entryFor(key);
      // A previous failure is worth retrying; a previous answer is not worth
      // three megabytes of range requests.
      if (hit && hit.value.error === null) return hit.value;
    }

    const result = await this.compute(request, contextSize, reading.profile);

    // The machine was re-measured while this check was out: the answer is about
    // a reading nobody believes any more, so it is returned to its caller (who
    // fences it) but never cached. This is the INV-4 hole — main used to write
    // it, and a later polite ask was served a verdict from the old machine.
    if (this.adopted === null || this.adopted.stamp === reading.stamp) {
      this.cache.set(key, { stamp: reading.stamp, value: result });
    }
    return result;
  }

  private async compute(
    request: CheckRequest,
    contextSize: number,
    profile: HardwareProfile,
  ): Promise<VariantSupport> {
    let url: string;
    try {
      url = downloadUrl(request.repo, request.filename);
    } catch (error) {
      return greyFor(request, contextSize, messageOf(error), request.sizeBytes ?? null);
    }

    const token = this.deps.token?.() ?? null;
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;

    let sizeBytes = request.sizeBytes ?? null;
    let header: GgufHeader;
    try {
      if (sizeBytes === null || sizeBytes <= 0) {
        sizeBytes = await (this.deps.headSize ?? ((target, options) => headFileSize(target, options)))(
          url,
          { headers },
        );
      }
      header = await (this.deps.readHeader ??
        ((target, options) => readRemoteGgufHeader(target, options)))(url, { headers });
    } catch (error) {
      const reason =
        error instanceof GgufError
          ? `Could not read the model header: ${error.message}`
          : `Could not reach Hugging Face: ${messageOf(error)}`;
      return greyFor(request, contextSize, reason, sizeBytes);
    }

    if (sizeBytes === null || sizeBytes <= 0) {
      return greyFor(
        request,
        contextSize,
        'Hugging Face did not report the file size, so the memory requirement cannot be computed.',
        null,
      );
    }

    const breakdown = checkModelSupport({
      meta: header.metadata,
      modelSizeBytes: sizeBytes,
      hardware: toCompatibilityHardware(profile),
      ctxSize: contextSize,
    });

    const architecture = header.architecture;
    const maxContextLength = breakdown.kvCache?.maxContextLength ?? null;

    return {
      repo: request.repo,
      filename: request.filename,
      sizeBytes,
      contextSize: breakdown.contextSize,
      breakdown,
      architecture,
      maxContextLength,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
