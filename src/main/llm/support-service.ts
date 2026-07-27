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

export class SupportService {
  private hardware: HardwareProfile | null = null;
  private hardwarePromise: Promise<HardwareProfile> | null = null;
  private readonly cache = new Map<string, VariantSupport>();

  constructor(private readonly deps: SupportServiceDeps = {}) {}

  /**
   * The detected machine. Cached for the life of the process — RAM and GPUs do
   * not change while the app runs, and the llama probe is expensive.
   */
  async systemInfo(refresh = false): Promise<HardwareProfile> {
    if (refresh) {
      this.hardware = null;
      this.hardwarePromise = null;
      this.cache.clear();
    }
    if (this.hardware) return this.hardware;
    this.hardwarePromise ??= (this.deps.detectHardware ?? detectHardware)();
    this.hardware = await this.hardwarePromise;
    return this.hardware;
  }

  cacheKey(repo: string, filename: string, contextSize: number): string {
    return `${repo}/${filename}@${contextSize}`;
  }

  cached(repo: string, filename: string, contextSize: number): VariantSupport | null {
    return this.cache.get(this.cacheKey(repo, filename, contextSize)) ?? null;
  }

  /** Every verdict computed so far, for the renderer's initial paint. */
  all(): VariantSupport[] {
    return [...this.cache.values()];
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

    if (!request.refresh) {
      const hit = this.cache.get(key);
      // A previous failure is worth retrying; a previous answer is not worth
      // three megabytes of range requests.
      if (hit && hit.error === null) return hit;
    }

    const result = await this.compute(request, contextSize);
    this.cache.set(key, result);
    return result;
  }

  private async compute(request: CheckRequest, contextSize: number): Promise<VariantSupport> {
    let url: string;
    try {
      url = downloadUrl(request.repo, request.filename);
    } catch (error) {
      return greyFor(request, contextSize, messageOf(error), request.sizeBytes ?? null);
    }

    const token = this.deps.token?.() ?? null;
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;

    const profile = await this.systemInfo();

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
