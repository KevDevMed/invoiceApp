/**
 * The Outstanding tile's currency breakdown: the proportion bar and the pager
 * under it.
 *
 * The design draws a bar whose segments are shares of one converted total and
 * pages a list of `{code, amount}` entries three at a time. This app has no
 * exchange rate — three module headers next door say so — so the two halves are
 * denominated differently on purpose:
 *
 *   - **The bar is share by invoice count.** A count is the only quantity that
 *     is comparable across currencies without a rate. A bar whose widths were
 *     raw cents would draw ¥7,120,000 as sixty times £120,000 and call it a
 *     proportion.
 *   - **The pager lists each currency's own total in its own currency.** Never
 *     a converted number, and never a sum of two currencies.
 *
 * The bar and the pager do not list the same set. The bar keeps every currency,
 * because a proportion picture with a slice missing is not a proportion. The
 * pager drops the tile's *lead* currency: the tile already prints that money as
 * its headline figure, and `£124,333` above `GBP 124,333` is the same number
 * twice in one box. `pagerEntries` is that list; `segments` is the bar's.
 *
 * Segments are ordered by count descending, because the opacity ramp
 * (`max(0.5, 1 - i*0.07)`) fades down the list and only reads as a ranking if
 * the thing it fades is the thing the widths show. Ties break on the currency
 * code alphabetically — the only remaining currency-neutral key. Breaking them
 * on `cents` would rank ¥7,120,000 above £120,000 by comparing raw minor units
 * across currencies, which is the exact comparison the two rules above exist to
 * refuse; it would leak into the segment order, the opacity ramp *and* the
 * pager order while every visible number stayed honest.
 *
 * Pure module — no React. The vitest project is `environment: 'node'`.
 */

import type { Invoice } from '../../../shared/types';

/** One currency's slice of the bar, and its entry in the pager. */
export interface CurrencySegment {
  readonly currency: string;
  /** That currency's own total, in its own integer minor units. */
  readonly cents: number;
  readonly count: number;
  /** Share of the invoice *count*, in `[0, 1]`. Never a share of value. */
  readonly share: number;
  /** The design's fade down the sorted list, floored at 0.5. */
  readonly opacity: number;
  /**
   * `121,400` — this currency's own total, rounded to whole units and printed
   * *without* a symbol, because the pager prints the code beside it. `$` is
   * ambiguous across USD/CAD/AUD, and `CAD $18,640` says the same thing twice.
   */
  readonly amount: string;
}

export interface CurrencyBreakdown {
  /** Every currency, count-descending. What the bar draws. */
  readonly segments: readonly CurrencySegment[];
  /**
   * `segments` minus the lead currency, same order — what the pager lists. The
   * headline figure is already the lead's own total, so repeating it here would
   * print one currency twice in one tile.
   *
   * Falls back to the whole of `segments` when no lead was given or the lead is
   * not in the bucket: an empty pager under a bar with several slices would be
   * a worse lie than a repeated figure.
   */
  readonly pagerEntries: readonly CurrencySegment[];
  readonly currencyCount: number;
  /**
   * Whether there is anything to break down. A single-currency workspace draws
   * no bar and no pager: a one-segment bar at 100% is a decoration that claims
   * to be a comparison.
   */
  readonly hasBreakdown: boolean;
}

/** How many pager entries are on screen at once. The design's `per = 3`. */
export const CURRENCY_PAGE_SIZE = 3;

/**
 * The opacity of the segment at `index`. Straight from the design; the floor
 * keeps the last of eight currencies visible rather than fading it to nothing.
 */
export function segmentOpacity(index: number): number {
  return Math.max(0.5, 1 - index * 0.07);
}

/** Integer minor units as whole major units, grouped, with no currency symbol. */
function formatUnits(cents: number): string {
  const units = Math.round(cents / 100);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(units);
}

/**
 * The breakdown of a bucket of invoices — the Outstanding tile passes it every
 * open receivable.
 *
 * An empty bucket gives an empty breakdown rather than a zero-width bar.
 *
 * `leadCurrency` is the currency the tile's headline figure is printed in —
 * `summariseTotals(sumByCurrency(bucket)).leadCurrency`, the largest by cents.
 * It is dropped from `pagerEntries` and kept in `segments`.
 */
export function buildCurrencyBreakdown(
  invoices: readonly Invoice[],
  leadCurrency: string | null = null,
): CurrencyBreakdown {
  const byCurrency = new Map<string, { cents: number; count: number }>();
  for (const invoice of invoices) {
    const entry = byCurrency.get(invoice.currency) ?? { cents: 0, count: 0 };
    entry.cents += invoice.totalCents;
    entry.count += 1;
    byCurrency.set(invoice.currency, entry);
  }

  const total = invoices.length;
  const segments = [...byCurrency]
    .map(([currency, entry]) => ({ currency, cents: entry.cents, count: entry.count }))
    .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency))
    .map((entry, index) => ({
      currency: entry.currency,
      cents: entry.cents,
      count: entry.count,
      share: total === 0 ? 0 : entry.count / total,
      opacity: segmentOpacity(index),
      amount: formatUnits(entry.cents),
    }));

  const rest = segments.filter((segment) => segment.currency !== leadCurrency);

  return {
    segments,
    pagerEntries: rest.length === 0 ? segments : rest,
    currencyCount: segments.length,
    hasBreakdown: segments.length > 1,
  };
}

/**
 * The first index of the last page.
 *
 * Pages tile the list — starts are multiples of `CURRENCY_PAGE_SIZE` — so the
 * last one is allowed to be short. Backing the window up to keep it full, which
 * `length - CURRENCY_PAGE_SIZE` did, re-showed entries the previous page had
 * already shown.
 */
export function maxPageIndex(length: number): number {
  if (length <= 0) return 0;
  return Math.floor((length - 1) / CURRENCY_PAGE_SIZE) * CURRENCY_PAGE_SIZE;
}

/**
 * `index` snapped down onto a page start and clamped into range.
 *
 * The index is React state that outlives a filter change, so it can arrive both
 * out of range and off a page boundary; an off-boundary window is exactly the
 * overlap this module now refuses.
 */
export function clampPageIndex(length: number, index: number): number {
  if (!Number.isFinite(index)) return 0;
  const bounded = Math.min(Math.max(Math.trunc(index), 0), maxPageIndex(length));
  return Math.floor(bounded / CURRENCY_PAGE_SIZE) * CURRENCY_PAGE_SIZE;
}

export interface CurrencyPage {
  /** The clamped first index — what the caller should store back. */
  readonly index: number;
  readonly entries: readonly CurrencySegment[];
  readonly canPrevious: boolean;
  readonly canNext: boolean;
}

/**
 * The up-to-three-up window at `index`, snapped to a page start, with both edge
 * flags. `entries` is short on the last page rather than overlapping the one
 * before it.
 */
export function currencyPageAt(
  entries: readonly CurrencySegment[],
  index: number,
): CurrencyPage {
  const clamped = clampPageIndex(entries.length, index);
  return {
    index: clamped,
    entries: entries.slice(clamped, clamped + CURRENCY_PAGE_SIZE),
    canPrevious: clamped > 0,
    canNext: clamped + CURRENCY_PAGE_SIZE < entries.length,
  };
}

/**
 * The index a prev/next press lands on. `direction` is -1 or 1 and the step is
 * a whole page, not one entry — the design's `step(-per)` / `step(+per)`.
 */
export function stepCurrencyPage(
  entries: readonly CurrencySegment[],
  index: number,
  direction: number,
): number {
  const from = clampPageIndex(entries.length, index);
  return clampPageIndex(entries.length, from + direction * CURRENCY_PAGE_SIZE);
}
