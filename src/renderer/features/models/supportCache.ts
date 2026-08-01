/**
 * Versioning for the compatibility-verdict cache.
 *
 * `support` is written by three independent async producers — the lazy
 * per-variant check, the Hub sweep, and `Re-check` — and nothing about the order
 * they resolve in is under anyone's control. Without a version, whichever
 * resolves last wins even when its data is the oldest, and a verdict computed
 * against a machine reading that has since been thrown away can come back to
 * life. That matters more here than anywhere else on the page: a stale non-RED
 * verdict on a model that is actually RED means the download confirmation — the
 * only guard this page has — never appears.
 *
 * So every verdict is stamped with the **generation** of the machine reading it
 * was computed against. `Re-check` bumps the generation; a producer captures it
 * when it starts and its result is discarded outright if the generation moved
 * while it was in flight. The pieces that can be decided without React live
 * here, where `environment: 'node'` can test them.
 */

import type { DiscoveredVariantView, VariantSupportView } from './llmExtra';
import { variantKey } from './llmExtra';

/**
 * What a discovery result does to the verdict cache.
 *
 * Three outcomes per discovered file, and the old code collapsed them into two:
 *   - `apply`    — it carried a real verdict, so cache it;
 *   - `answered` — the same keys, which no longer need a lazy check;
 *   - `clear`    — it carried no usable verdict, so whatever the cache held for
 *                  that key is unfounded and goes.
 *
 * The bug was the missing third case: a result with `support === null` or a
 * failed check left the previous verdict in place *and* marked the key as
 * requested, so nothing ever looked at it again and a verdict from an older
 * machine reading survived indefinitely.
 */
export interface DiscoveryFold {
  /** Verdicts to write, by `repo/filename`. */
  readonly apply: Readonly<Record<string, VariantSupportView>>;
  /** Keys whose cached verdict is unfounded and must go. */
  readonly clear: readonly string[];
  /** Keys that now have an answer and need no lazy check. */
  readonly answered: readonly string[];
}

/**
 * Split a sweep's results into those three buckets.
 *
 * `isFresh` reports whether a key was already checked — or is being checked —
 * under the *current* generation. Such a key is not cleared: it is founded on
 * the same machine reading this sweep was, so dropping it would throw away a
 * good answer to fix a staleness problem it does not have. Main budgets its
 * header reads, so a curated row that checked itself on mount and then turns up
 * in a search main had no budget left for is the ordinary case, not the corner.
 */
export function foldDiscoveryVerdicts(
  models: readonly DiscoveredVariantView[],
  isFresh: (key: string) => boolean,
): DiscoveryFold {
  const apply: Record<string, VariantSupportView> = {};
  const clear: string[] = [];
  const answered: string[] = [];

  for (const model of models) {
    const key = variantKey(model.repo, model.filename);
    const support = model.support;
    if (support !== null && support.error === null) {
      apply[key] = support;
      answered.push(key);
      continue;
    }
    if (!isFresh(key) && !clear.includes(key)) clear.push(key);
  }

  return { apply, clear, answered };
}

/** Apply a fold to the cache. A key that was written is never also cleared. */
export function applyDiscoveryFold(
  current: Readonly<Record<string, VariantSupportView>>,
  fold: DiscoveryFold,
): Record<string, VariantSupportView> {
  const next: Record<string, VariantSupportView> = { ...current, ...fold.apply };
  for (const key of fold.clear) {
    if (!(key in fold.apply)) delete next[key];
  }
  return next;
}

/** Whether the fold changes anything, so an unchanged cache keeps its identity. */
export function foldIsEmpty(fold: DiscoveryFold): boolean {
  return Object.keys(fold.apply).length === 0 && fold.clear.length === 0;
}
