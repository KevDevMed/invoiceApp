/**
 * The single answer design 1a opens with.
 *
 * The hero says "here is the best model for this Mac" and offers one button, so
 * something has to pick it. The app has never computed that: the old page listed
 * everything and left the choice to the reader.
 *
 * The pick is drawn from the **curated catalog only**. Search results are ranked
 * by main against memory alone, and the hero is a recommendation rather than a
 * ranking — the curated list is the one whose entries were checked by a person
 * for licence, tool-calling and general usefulness.
 *
 * Pure by construction: a catalog array and a verdict lookup in, one entry out.
 * No IPC, so the hero can be re-derived on every render without spending a
 * request, and the ordering is total, so it cannot flicker between two refreshes
 * that carry the same verdicts.
 */

import type { SupportVerdict } from './llmExtra';
import type { CatalogEntryView } from './useModels';
import { modelFormat, type ModelFormat } from './modelCopy';

/** A verdict the hero is allowed to stand behind. */
export type RecommendableVerdict = 'GREEN' | 'YELLOW';

export interface Recommendation {
  readonly entry: CatalogEntryView;
  readonly verdict: RecommendableVerdict;
  readonly format: ModelFormat;
}

function isRecommendable(verdict: SupportVerdict): verdict is RecommendableVerdict {
  return verdict === 'GREEN' || verdict === 'YELLOW';
}

interface Ranked {
  readonly entry: CatalogEntryView;
  readonly verdict: RecommendableVerdict;
  readonly format: ModelFormat;
}

/**
 * Pick the one model to put in the hero, or nothing.
 *
 * Null is a real answer and it has two causes, both of which the page has to
 * render differently from "here is your model": the catalog is still loading or
 * unreadable, and no verdict has come back yet (everything is `GREY`/`LOADING`);
 * or every verdict came back `RED`. `RED` is never recommended — the page keeps
 * downloading one possible behind a confirmation, but it will not *suggest* a
 * model it expects to fail.
 *
 * Ranking, in order:
 *   1. `GREEN` before `YELLOW` — a comfortable fit beats a tight one, always.
 *   2. MLX before GGUF — the same weights through the Mac's GPU are roughly
 *      twice as fast, so when both fit the choice is free.
 *   3. Larger before smaller — among builds that fit, more parameters is more
 *      capable, and the whole point of measuring the machine was to find the
 *      biggest thing it can hold.
 *   4. Id ascending — the deterministic backstop. Two identically-sized builds
 *      must not swap places between refreshes and make the hero flicker.
 */
export function recommendModel(
  catalog: readonly CatalogEntryView[],
  verdictOf: (repo: string, filename: string) => SupportVerdict,
): Recommendation | null {
  const candidates: Ranked[] = [];
  for (const entry of catalog) {
    const verdict = verdictOf(entry.repo, entry.filename);
    if (!isRecommendable(verdict)) continue;
    candidates.push({ entry, verdict, format: modelFormat(entry.repo, entry.filename) });
  }
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    if (left.verdict !== right.verdict) return left.verdict === 'GREEN' ? -1 : 1;
    if (left.format !== right.format) return left.format === 'MLX' ? -1 : 1;
    const size = (right.entry.sizeBytes ?? 0) - (left.entry.sizeBytes ?? 0);
    if (size !== 0) return size;
    return left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0;
  });

  return candidates[0] ?? null;
}
