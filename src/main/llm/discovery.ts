/**
 * "Show me models that run on this machine."
 *
 * The catalog answers "which of these six?" and the repo lookup answers "does
 * this one repo fit?". Neither answers the question a user actually starts with,
 * which is what they can run at all. This module does, in four stages:
 *
 *   1. Search the Hub for GGUF repos               — one request.
 *   2. List each repo's files with `?blobs=true`   — one cheap JSON request each.
 *   3. Drop projectors, then every file bigger than this machine's usable
 *      memory — free, no network.
 *   4. Read the GGUF header of what survives and size the KV cache — 4 MB each.
 *
 * Stage 3 is the load-bearing one. A header check costs a 4 MB range read, so
 * checking every quant of every hit would be hundreds of megabytes to tell the
 * user what a subtraction already told us. The prefilter is deliberately
 * generous — it compares weights alone against the *total* usable budget, with
 * no KV cache — so it can only remove models the real verdict would have called
 * RED anyway.
 *
 * Every cap is counted and reported. A result that quietly checked 10 of 60
 * candidates and said nothing would read as "this is everything", and it is not.
 *
 * Pure orchestration: search, lookup and the support service are all injected,
 * so the tests never open a socket.
 */

import type { SupportVerdict } from './compatibility';
import { lookupRepo, searchRepos, type HfRepoInfo, type HfSearchHit } from './hf';
import type { CheckRequest, SupportService, VariantSupport } from './support-service';

/** Repos taken from the search results. Beyond this the header checks dominate. */
export const DEFAULT_MAX_REPOS = 12;
/** Quants kept per repo. More than a couple of quants of one model is noise. */
export const DEFAULT_MAX_VARIANTS_PER_REPO = 2;
/** Hard ceiling on header checks, i.e. on 4 MB range reads, for one discovery run. */
export const DEFAULT_MAX_CHECKS = 24;
/** Repo listings in flight at once. */
export const DEFAULT_LOOKUP_CONCURRENCY = 4;

export interface DiscoveredVariant {
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
  /** Null only when the run hit its check ceiling before reaching this row. */
  readonly support: VariantSupport | null;
  /** Plain-language line for the row, whether or not a header was read. */
  readonly reason: string;
}

export interface DiscoveryResult {
  readonly query: string;
  readonly contextSize: number | null;
  /** Weights-plus-cache budget the prefilter used, or null when RAM is unknown. */
  readonly usableMemoryBytes: number | null;
  readonly models: readonly DiscoveredVariant[];
  readonly reposFound: number;
  readonly reposInspected: number;
  readonly variantsFound: number;
  /** Dropped by the size prefilter — weights alone exceed usable memory. */
  readonly variantsTooBig: number;
  /** Dropped because the repo already had `maxVariantsPerRepo` better candidates. */
  readonly variantsDeduplicated: number;
  /** `mmproj-*` files: multimodal projectors, never loadable as a model. */
  readonly variantsProjectors: number;
  readonly variantsChecked: number;
  /** Survived the prefilter but was past the check ceiling. Verdict is GREY. */
  readonly variantsUnchecked: number;
  /** Repo listings that failed, and any cap that actually bit. Shown verbatim. */
  readonly warnings: readonly string[];
  readonly checkedAt: string;
}

export interface DiscoveryOptions {
  readonly query?: string;
  readonly ctxSize?: number;
  readonly maxRepos?: number;
  readonly maxVariantsPerRepo?: number;
  readonly maxChecks?: number;
  readonly refresh?: boolean;
}

export interface DiscoveryDeps {
  readonly support: Pick<SupportService, 'budget' | 'checkMany'>;
  readonly search?: (query: string, limit: number) => Promise<HfSearchHit[]>;
  readonly lookup?: (repo: string) => Promise<HfRepoInfo>;
}

/** Best fit first: a model that runs beats one that might, beats one that will not. */
const VERDICT_ORDER: Record<SupportVerdict, number> = {
  GREEN: 0,
  YELLOW: 1,
  GREY: 2,
  LOADING: 3,
  RED: 4,
};

export function compareByFit(left: DiscoveredVariant, right: DiscoveredVariant): number {
  const byVerdict = VERDICT_ORDER[left.verdict] - VERDICT_ORDER[right.verdict];
  if (byVerdict !== 0) return byVerdict;
  // Within one verdict, the biggest model that still fits is the most capable
  // one the machine can have, which is what the user came for.
  const bySize = (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
  if (bySize !== 0) return bySize;
  return left.filename.localeCompare(right.filename);
}

/**
 * Multimodal projectors ship as `.gguf` alongside the weights they belong to —
 * `mmproj-F16.gguf` is in most of `unsloth`'s repos. They are not models: they
 * cannot be loaded on their own, and one is small enough to pass the size
 * prefilter and be offered as if it were a 1 GB model that fits.
 */
const PROJECTOR_PATTERN = /(?:^|[-_.])mmproj(?:[-_.]|$)/i;

export function isProjectorFile(filename: string): boolean {
  return PROJECTOR_PATTERN.test(filename.replace(/\.gguf$/i, ''));
}

interface Candidate {
  readonly hit: HfSearchHit;
  readonly info: HfRepoInfo;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List each repo, `concurrency` at a time, keeping failures as warnings.
 *
 * A gated or deleted repo in the middle of a search result is ordinary, not
 * exceptional: it costs that row and nothing else.
 */
async function listRepos(
  hits: readonly HfSearchHit[],
  lookup: (repo: string) => Promise<HfRepoInfo>,
  warnings: string[],
): Promise<Array<{ hit: HfSearchHit; info: HfRepoInfo }>> {
  const found = new Array<{ hit: HfSearchHit; info: HfRepoInfo } | null>(hits.length).fill(null);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= hits.length) return;
      const hit = hits[index]!;
      try {
        found[index] = { hit, info: await lookup(hit.repo) };
      } catch (error) {
        warnings.push(`${hit.repo}: ${messageOf(error)}`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DEFAULT_LOOKUP_CONCURRENCY, hits.length) }, () => worker()),
  );
  return found.filter((entry): entry is { hit: HfSearchHit; info: HfRepoInfo } => entry !== null);
}

export async function discoverModels(
  deps: DiscoveryDeps,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const query = (options.query ?? '').trim();
  const maxRepos = clamp(options.maxRepos, DEFAULT_MAX_REPOS, 30);
  const maxVariantsPerRepo = clamp(options.maxVariantsPerRepo, DEFAULT_MAX_VARIANTS_PER_REPO, 10);
  const maxChecks = clamp(options.maxChecks, DEFAULT_MAX_CHECKS, 60);
  const warnings: string[] = [];

  const search = deps.search ?? ((text, limit) => searchRepos(text, { limit }));
  const lookup = deps.lookup ?? ((repo) => lookupRepo(repo));

  const budget = await deps.support.budget();
  // Zero means detection failed. Every verdict will be GREY, so a prefilter here
  // would silently throw away the whole list on the strength of a number we do
  // not have.
  const usableMemoryBytes = budget.usableTotalMemoryBytes > 0 ? budget.usableTotalMemoryBytes : null;

  const allHits = await search(query, maxRepos);
  const hits = allHits.slice(0, maxRepos);
  if (allHits.length > hits.length) {
    warnings.push(
      `Hugging Face returned ${allHits.length} repos; only the top ${hits.length} by downloads were inspected.`,
    );
  }

  const listed = await listRepos(hits, lookup, warnings);

  let variantsFound = 0;
  let variantsTooBig = 0;
  let variantsDeduplicated = 0;
  let variantsProjectors = 0;
  const candidates: Candidate[] = [];

  for (const { hit, info } of listed) {
    const runnable = info.variants.filter((variant) => !isProjectorFile(variant.filename));
    variantsFound += runnable.length;
    variantsProjectors += info.variants.length - runnable.length;

    const affordable = runnable.filter((variant) => {
      if (usableMemoryBytes === null) return true;
      // Unknown size cannot be prefiltered; the header check will HEAD it.
      if (variant.sizeBytes === null) return true;
      if (variant.sizeBytes <= usableMemoryBytes) return true;
      variantsTooBig += 1;
      return false;
    });

    // Biggest first: within one repo the larger quant is the better model, and
    // it has already been proven to fit.
    const ranked = [...affordable].sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0));
    const kept = ranked.slice(0, maxVariantsPerRepo);
    variantsDeduplicated += ranked.length - kept.length;

    for (const variant of kept) {
      candidates.push({
        hit,
        info,
        filename: variant.filename,
        quant: variant.quant,
        sizeBytes: variant.sizeBytes,
        sha256: variant.sha256,
      });
    }
  }

  // Check the most promising first, so the ceiling — when it bites — cuts the
  // tail rather than an arbitrary slice.
  candidates.sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0));

  const toCheck = candidates.slice(0, maxChecks);
  const unchecked = candidates.slice(maxChecks);
  if (unchecked.length > 0) {
    warnings.push(
      `${unchecked.length} more file${unchecked.length === 1 ? '' : 's'} fit on paper but were not verified: this run checks at most ${maxChecks} headers. Open one to check it individually.`,
    );
  }

  const requests: CheckRequest[] = toCheck.map((candidate) => ({
    repo: candidate.hit.repo,
    filename: candidate.filename,
    sizeBytes: candidate.sizeBytes,
    ctxSize: options.ctxSize,
    refresh: options.refresh,
  }));

  const supports = await deps.support.checkMany(requests);

  const models: DiscoveredVariant[] = toCheck.map((candidate, index) => {
    const support = supports[index] ?? null;
    return {
      ...describe(candidate),
      verdict: support?.breakdown.verdict ?? 'GREY',
      support,
      reason: support?.breakdown.reason ?? 'Not checked.',
    };
  });

  for (const candidate of unchecked) {
    models.push({
      ...describe(candidate),
      verdict: 'GREY',
      support: null,
      reason: 'Not checked: this run reached its limit on header reads.',
    });
  }

  models.sort(compareByFit);

  return {
    query,
    contextSize: options.ctxSize ?? null,
    usableMemoryBytes,
    models,
    reposFound: allHits.length,
    reposInspected: listed.length,
    variantsFound,
    variantsTooBig,
    variantsDeduplicated,
    variantsProjectors,
    variantsChecked: toCheck.length,
    variantsUnchecked: unchecked.length,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

function describe(candidate: Candidate): Omit<DiscoveredVariant, 'verdict' | 'support' | 'reason'> {
  return {
    repo: candidate.hit.repo,
    filename: candidate.filename,
    quant: candidate.quant,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    license: candidate.info.license,
    gated: candidate.info.gated || candidate.hit.gated,
    isPrivate: candidate.info.isPrivate || candidate.hit.isPrivate,
    downloads: candidate.hit.downloads,
    likes: candidate.hit.likes,
  };
}
