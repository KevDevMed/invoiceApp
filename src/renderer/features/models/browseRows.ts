/**
 * The one list behind `Browse all models`.
 *
 * Design 1a collapses three acquisition surfaces — the curated catalog, the
 * "what runs here" sweep and the paste-a-repo box — into a single ordered list
 * with a single search field. That merge is pure data work: three sources in,
 * one deduplicated, best-fit-first row model out, plus the counts the footer
 * line prints and the decision about whether what was typed is a repo or a
 * search term.
 *
 * The verdict rules are not restated here. `fitsMachine` and `countByFit` in
 * `modelRows.ts` own them, and this module calls them, so "does YELLOW count as
 * a fit" has exactly one answer in the codebase.
 */

import type { DiscoveryView, HfRepoView, SupportVerdict } from './llmExtra';
import { variantKey } from './llmExtra';
import type { CatalogEntryView } from './useModels';
import { modelDisplayName, modelFormat, type ModelFormat } from './modelCopy';
import { countByFit, fitsMachine } from './modelRows';

/** Where a row came from. Only `search` earns the neutral `Hugging Face` pill. */
export type BrowseSource = 'catalog' | 'lookup' | 'search';

export interface BrowseRow {
  /** `repo/filename` — the same key the verdict cache and the busy flag use. */
  readonly key: string;
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
  readonly verdict: SupportVerdict;
  readonly source: BrowseSource;
  readonly format: ModelFormat;
  readonly displayName: string;
}

export interface BrowseInput {
  readonly catalog: readonly CatalogEntryView[];
  /** Result of pasting a repo id or link, if there is one. */
  readonly hfRepo: HfRepoView | null;
  /** Result of the last Hub sweep, if there is one. */
  readonly discovery: DiscoveryView | null;
  readonly verdictOf: (repo: string, filename: string) => SupportVerdict;
}

/**
 * Best fit first, and within a fit bucket the order the sources were consulted.
 *
 * GREY and LOADING sort between YELLOW and RED on purpose: "we have not looked"
 * is a better bet than "we looked and it does not fit", and on a page where the
 * catalog checks itself lazily an unchecked row must not sink below a known-bad
 * one while it is still being read.
 */
function verdictRank(verdict: SupportVerdict): number {
  switch (verdict) {
    case 'GREEN':
      return 0;
    case 'YELLOW':
      return 1;
    case 'LOADING':
      return 2;
    case 'GREY':
      return 3;
    case 'RED':
      return 4;
  }
}

/** One deduplicated file, before a verdict is attached to it. */
export interface MergedVariant {
  readonly key: string;
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
  readonly source: BrowseSource;
}

/** Everything the merge needs; the verdict lookup is deliberately not part of it. */
export type MergeInput = Omit<BrowseInput, 'verdictOf'>;

/**
 * Merge the three sources into one deduplicated list.
 *
 * A pasted repo is consulted first because it is the most explicit request the
 * user can make, then the curated catalog, then the sweep. Duplicates keep the
 * first row seen — but a key that is in the catalog takes the **catalog's**
 * metadata whichever source reached it first, because arrival order is an
 * accident and the curated `description`, `quant` and `sizeBytes` are the ones a
 * person checked. Labelling a row `catalog` while it carried a lookup's fields
 * was the bug: the pill said curated and the text was not.
 */
export function mergeBrowseVariants(input: MergeInput): MergedVariant[] {
  const catalogByKey = new Map(
    input.catalog.map((entry) => [variantKey(entry.repo, entry.filename), entry] as const),
  );

  const variants: MergedVariant[] = [];
  const seen = new Set<string>();

  const push = (
    repo: string,
    filename: string,
    quant: string | null,
    sizeBytes: number | null,
    description: string | null,
    source: BrowseSource,
  ): void => {
    const key = variantKey(repo, filename);
    if (seen.has(key)) return;
    seen.add(key);
    const curated = catalogByKey.get(key);
    variants.push(
      curated
        ? {
            key,
            repo: curated.repo,
            filename: curated.filename,
            quant: curated.quant,
            sizeBytes: curated.sizeBytes,
            description: curated.description,
            source: 'catalog',
          }
        : { key, repo, filename, quant, sizeBytes, description, source },
    );
  };

  if (input.hfRepo) {
    for (const variant of input.hfRepo.variants) {
      push(
        input.hfRepo.repo,
        variant.filename,
        variant.quant,
        variant.sizeBytes,
        null,
        'lookup',
      );
    }
  }

  for (const entry of input.catalog) {
    push(entry.repo, entry.filename, entry.quant, entry.sizeBytes, entry.description, 'catalog');
  }

  if (input.discovery) {
    for (const model of input.discovery.models) {
      push(model.repo, model.filename, model.quant, model.sizeBytes, model.reason, 'search');
    }
  }

  return variants;
}

/** What one variant needs to be re-checked against a fresh machine reading. */
export interface SupportTarget {
  readonly repo: string;
  readonly filename: string;
  readonly sizeBytes: number | null;
}

/**
 * Every variant currently on the page, which is exactly what `Re-check` has to
 * ask about again after it throws the cached verdicts away.
 *
 * The catalog alone would not do it: a pasted repo and a Hub sweep both put rows
 * on screen, and a row whose verdict was invalidated but never recomputed would
 * sit at `GREY` forever with no way back short of a reload.
 */
export function recheckTargets(input: MergeInput): SupportTarget[] {
  return mergeBrowseVariants(input).map((variant) => ({
    repo: variant.repo,
    filename: variant.filename,
    sizeBytes: variant.sizeBytes,
  }));
}

/** Attach a verdict to every merged variant and order the list best fit first. */
export function buildBrowseRows(input: BrowseInput): BrowseRow[] {
  const rows: BrowseRow[] = mergeBrowseVariants(input).map((variant) => ({
    ...variant,
    verdict: input.verdictOf(variant.repo, variant.filename),
    format: modelFormat(variant.repo, variant.filename),
    displayName: modelDisplayName(variant.repo, variant.filename),
  }));

  // Stable: Array.prototype.sort has been required to be stable since ES2019,
  // so equal-verdict rows keep the source order above.
  return rows.sort((left, right) => verdictRank(left.verdict) - verdictRank(right.verdict));
}

export interface BrowseVisibility {
  readonly rows: readonly BrowseRow[];
  readonly showing: number;
  /** Hidden because the verdict says the memory is not there. */
  readonly hiddenTooBig: number;
  /** Hidden because nothing has read the header yet. */
  readonly hiddenUnchecked: number;
}

/** Apply `Only what runs here` and tally what it took away. */
export function visibleBrowseRows(
  rows: readonly BrowseRow[],
  onlyFits: boolean,
): BrowseVisibility {
  if (!onlyFits) {
    return { rows, showing: rows.length, hiddenTooBig: 0, hiddenUnchecked: 0 };
  }
  const visible = rows.filter((row) => fitsMachine(row.verdict));
  const hidden = countByFit(
    rows.filter((row) => !fitsMachine(row.verdict)).map((row) => row.verdict),
  );
  return {
    rows: visible,
    showing: visible.length,
    hiddenTooBig: hidden.tooBig,
    hiddenUnchecked: hidden.unknown,
  };
}

/**
 * The footer line, which never claims a list is complete when it is not.
 *
 * `Showing 14 — 8 hidden because they need more memory than this Mac has.` is
 * the design's wording; unchecked rows get their own clause rather than being
 * folded into the memory reason, which would be untrue of them.
 */
export function browseFooterSentence(
  visibility: BrowseVisibility,
  platform: string | null,
): string {
  const machine = platform === 'darwin' ? 'Mac' : 'machine';
  const clauses: string[] = [];
  if (visibility.hiddenTooBig > 0) {
    clauses.push(
      `${visibility.hiddenTooBig} hidden because they need more memory than this ${machine} has`,
    );
  }
  if (visibility.hiddenUnchecked > 0) {
    clauses.push(`${visibility.hiddenUnchecked} not checked yet`);
  }
  const showing = `Showing ${visibility.showing}`;
  return clauses.length === 0 ? `${showing}.` : `${showing} — ${clauses.join(', and ')}.`;
}

export type ModelQuery =
  | { readonly kind: 'empty' }
  | { readonly kind: 'repo'; readonly repo: string }
  | { readonly kind: 'search'; readonly term: string };

const REPO_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * Decide what one field means.
 *
 * 1a has a single input where the old page had two, so the choice between
 * "search the Hub" and "look this repo up" has to be made from the text. A
 * `huggingface.co` URL or a bare `owner/name` is a lookup; anything else — a
 * phrase, a single word, a slash inside a sentence — is a search.
 */
export function parseModelQuery(raw: string): ModelQuery {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty' };

  const url = /^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/(.+)$/i.exec(trimmed);
  if (url) {
    const path = (url[1] ?? '').split(/[?#]/)[0] ?? '';
    const segments = path.split('/').filter((segment) => segment.length > 0);
    // `/models/owner/name` and `/owner/name` are both live Hub URLs.
    const start = segments[0]?.toLowerCase() === 'models' ? 1 : 0;
    const owner = segments[start];
    const name = segments[start + 1];
    if (owner && name) return { kind: 'repo', repo: `${owner}/${name}` };
    return { kind: 'search', term: trimmed };
  }

  if (REPO_ID.test(trimmed)) return { kind: 'repo', repo: trimmed };
  return { kind: 'search', term: trimmed };
}
