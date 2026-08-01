/**
 * The renderer half of the multiplexed `llm:catalog` channel.
 *
 * The frozen contract declares `llm:catalog` as `{refresh?: boolean}` in and
 * `{entries}` out. Main widens both — see `src/main/llm/extra-channels.ts` — so
 * that system info, the compatibility verdict, the Hugging Face lookup and the
 * smoke test have a way across. Every cast needed to express that lives here and
 * nowhere else; the rest of the renderer sees ordinary typed functions.
 *
 * The view types below mirror the main-process ones by hand. The renderer cannot
 * import from `src/main` (different tsconfig project, different bundle), and
 * duplicating four interfaces is cheaper than a shared module in a frozen
 * directory.
 */

import type { IpcRequest, IpcResponse } from '../../../shared/ipc-contract';
import type { ModelRecord } from '../../../shared/types';

/**
 * A model row as main actually sends it.
 *
 * `ModelRecord` is declared in the frozen contract, and responses are not
 * re-validated on the way out, so the columns migration 002 added arrive
 * alongside it. `smokeTest` is the test result — it used to be squeezed into
 * `error`, which meant a passing test could render as a failed download — and
 * `verifiedSha256` is null for weights this machine never hashed.
 */
export interface LocalModel extends ModelRecord {
  readonly smokeTest?: string | null;
  readonly verifiedSha256?: string | null;
}

export type SupportVerdict = 'RED' | 'YELLOW' | 'GREEN' | 'LOADING' | 'GREY';

export interface KvCacheView {
  readonly architecture: string;
  readonly blockCount: number;
  readonly headCountKv: number;
  readonly keyLength: number;
  readonly valueLength: number;
  readonly contextLength: number;
  readonly maxContextLength: number;
  readonly slidingWindow: number | null;
  readonly bytesPerToken: number;
  readonly kvCacheBytes: number;
}

export interface SupportBreakdownView {
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
  readonly kvCache: KvCacheView | null;
  readonly reason: string;
}

export interface VariantSupportView {
  readonly repo: string;
  readonly filename: string;
  readonly sizeBytes: number | null;
  readonly contextSize: number;
  readonly breakdown: SupportBreakdownView;
  readonly architecture: string | null;
  readonly maxContextLength: number | null;
  readonly checkedAt: string;
  readonly error: string | null;
}

export interface GpuDeviceView {
  readonly name: string;
  readonly totalMemoryBytes: number | null;
}

export interface SystemInfoView {
  readonly platform: string;
  readonly arch: string;
  readonly isAppleSilicon: boolean;
  readonly hasUnifiedMemory: boolean;
  readonly cpuModel: string | null;
  readonly cpuCores: number | null;
  readonly totalRamBytes: number | null;
  readonly freeRamBytes: number | null;
  readonly gpus: readonly GpuDeviceView[];
  readonly totalVramBytes: number | null;
  readonly vramSource: 'node-llama-cpp' | 'electron' | 'unknown';
  readonly gpuBackend: string | null;
  readonly detectionError: string | null;
  readonly summary: string;
}

export interface HfVariantView {
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly downloadUrl: string;
  readonly isSplit: boolean;
}

export interface HfRepoView {
  readonly repo: string;
  readonly gated: boolean;
  readonly isPrivate: boolean;
  readonly license: string | null;
  readonly lastModified: string | null;
  readonly variants: readonly HfVariantView[];
  readonly skippedSplitFiles: readonly string[];
}

/**
 * One row of "models that run on this machine".
 *
 * `support` is null only for a file the run did not have a header-check budget
 * for; its verdict is GREY and the row can still be checked individually.
 */
export interface DiscoveredVariantView {
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly license: string | null;
  readonly gated: boolean;
  readonly isPrivate: boolean;
  readonly downloads: number | null;
  readonly likes: number | null;
  readonly verdict: SupportVerdict;
  readonly support: VariantSupportView | null;
  readonly reason: string;
}

export interface DiscoveryView {
  readonly query: string;
  readonly contextSize: number | null;
  readonly usableMemoryBytes: number | null;
  readonly models: readonly DiscoveredVariantView[];
  readonly reposFound: number;
  readonly reposInspected: number;
  readonly variantsFound: number;
  readonly variantsTooBig: number;
  readonly variantsDeduplicated: number;
  readonly variantsProjectors: number;
  readonly variantsChecked: number;
  readonly variantsUnchecked: number;
  readonly warnings: readonly string[];
  readonly checkedAt: string;
}

export type SmokeTestVerdict = 'pass' | 'slow' | 'fail';

export interface SmokeTestView {
  readonly kind: 'smokeTest';
  readonly modelId: string;
  readonly verdict: SmokeTestVerdict;
  readonly loadMs: number;
  readonly timeToFirstTokenMs: number | null;
  readonly generationMs: number;
  readonly tokensGenerated: number;
  readonly tokensPerSecond: number | null;
  readonly peakRssBytes: number | null;
  readonly contextSize: number;
  readonly maxTokens: number;
  readonly text: string;
  readonly error: string | null;
  readonly failureKind: 'timeout' | 'out_of_memory' | 'no_output' | 'error' | null;
  readonly ranAt: string;
}

type CatalogResponse = IpcResponse<'llm:catalog'>;

interface CatalogOpResponse extends CatalogResponse {
  readonly systemInfo?: SystemInfoView;
  readonly support?: VariantSupportView;
  readonly hf?: HfRepoView;
  readonly discovery?: DiscoveryView;
  readonly smokeTest?: SmokeTestView;
}

/**
 * The single cast. `llm:catalog`'s declared request type has no `op`, and its
 * declared response type has only `entries`; main validates the wider payload
 * and returns the wider result.
 */
async function invokeOp(payload: Record<string, unknown>): Promise<CatalogOpResponse> {
  const response = await window.api.invoke(
    'llm:catalog',
    payload as unknown as IpcRequest<'llm:catalog'>,
  );
  return response as CatalogOpResponse;
}

export async function fetchCatalog(): Promise<CatalogResponse['entries']> {
  return (await invokeOp({ op: 'catalog' })).entries;
}

/**
 * The detected machine. `refresh` asks main to probe the hardware again rather
 * than hand back the reading it cached for the life of the process — which is
 * what `Re-check` promises and, until now, could not ask for.
 */
export async function fetchSystemInfo(refresh = false): Promise<SystemInfoView> {
  const response = await invokeOp({ op: 'systemInfo', refresh });
  if (!response.systemInfo) throw new Error('Main returned no system information.');
  return response.systemInfo;
}

export interface CheckSupportArgs {
  readonly repo: string;
  readonly filename: string;
  readonly sizeBytes?: number | null;
  readonly ctxSize?: number;
  readonly refresh?: boolean;
}

export async function checkSupport(args: CheckSupportArgs): Promise<VariantSupportView> {
  const response = await invokeOp({ op: 'checkSupport', ...args });
  if (!response.support) throw new Error('Main returned no compatibility verdict.');
  return response.support;
}

export async function lookupHfRepo(repo: string): Promise<HfRepoView> {
  const response = await invokeOp({ op: 'hfLookup', repo });
  if (!response.hf) throw new Error('Main returned no repository information.');
  return response.hf;
}

export interface DiscoverArgs {
  readonly query?: string;
  readonly ctxSize?: number;
  readonly maxRepos?: number;
  readonly maxVariantsPerRepo?: number;
  readonly maxChecks?: number;
  /** Bypass main's per-variant verdict cache for every check the sweep runs. */
  readonly refresh?: boolean;
}

export async function discoverModels(args: DiscoverArgs = {}): Promise<DiscoveryView> {
  const response = await invokeOp({ op: 'discover', ...args });
  if (!response.discovery) throw new Error('Main returned no discovery result.');
  return response.discovery;
}

export async function runSmokeTest(modelId: string): Promise<SmokeTestView> {
  const response = await invokeOp({ op: 'smokeTest', modelId });
  if (!response.smokeTest) throw new Error('Main returned no smoke-test result.');
  return response.smokeTest;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Key a verdict by the thing it is about. Same shape as the cache key in main. */
export function variantKey(repo: string, filename: string): string {
  return `${repo}/${filename}`;
}

/** Decode the smoke-test record stored against a model, if it has one. */
export function readSmokeTest(record: Pick<LocalModel, 'smokeTest'> | null): SmokeTestView | null {
  const raw = record?.smokeTest;
  if (typeof raw !== 'string' || raw.length === 0 || !raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SmokeTestView>;
    return parsed.kind === 'smokeTest' ? (parsed as SmokeTestView) : null;
  } catch {
    return null;
  }
}

export function describeSmokeTest(record: SmokeTestView | null): string {
  if (record === null) return 'untested';
  switch (record.verdict) {
    case 'pass':
      return `tested · ${record.tokensPerSecond ?? 0} tok/s`;
    case 'slow':
      return `slow · ${record.tokensPerSecond ?? 0} tok/s`;
    case 'fail':
      return 'failed on this machine';
  }
}

export interface VerdictPresentation {
  readonly label: string;
  readonly badge: 'success' | 'warning' | 'error' | 'neutral' | 'info';
}

/** Chip text and colour for a verdict. The wording is the user-facing promise. */
export function presentVerdict(
  verdict: SupportVerdict,
  platform: string | null,
): VerdictPresentation {
  const machine = platform === 'darwin' ? 'Mac' : 'machine';
  switch (verdict) {
    case 'GREEN':
      return { label: `Runs on your ${machine}`, badge: 'success' };
    case 'YELLOW':
      return { label: 'Will run, partly on CPU', badge: 'warning' };
    case 'RED':
      return { label: 'Not enough memory', badge: 'error' };
    case 'LOADING':
      return { label: 'Checking…', badge: 'info' };
    case 'GREY':
      return { label: 'Not checked', badge: 'neutral' };
  }
}
