import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import {
  CURRENCY_PAGE_SIZE,
  buildCurrencyBreakdown,
  clampPageIndex,
  currencyPageAt,
  maxPageIndex,
  segmentOpacity,
  stepCurrencyPage,
} from '../currencyBreakdown';
import type { CurrencySegment } from '../currencyBreakdown';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-05-26',
    dueDate: '2026-06-25',
    currency: 'USD',
    taxRateBps: 0,
    notes: null,
    subtotalCents: 100_000,
    taxCents: 0,
    totalCents: 100_000,
    paidAt: null,
    createdAt: '2026-05-26T09:00:00.000Z',
    updatedAt: '2026-05-26T09:00:00.000Z',
    ...overrides,
  };
}

/** `n` invoices in `currency`, each worth `cents`. */
function bucket(currency: string, n: number, cents = 100_000): Invoice[] {
  return Array.from({ length: n }, (_, index) =>
    makeInvoice({ id: `${currency}-${String(index)}`, currency, totalCents: cents }),
  );
}

/** The design's eight-currency fixture, by count rather than by value. */
const EIGHT = [
  ...bucket('USD', 8),
  ...bucket('EUR', 7),
  ...bucket('GBP', 6),
  ...bucket('CAD', 5),
  ...bucket('AUD', 4),
  ...bucket('CHF', 3),
  ...bucket('SEK', 2),
  ...bucket('JPY', 1),
];

describe('segmentOpacity', () => {
  it('fades down the sorted list by 0.07 a step', () => {
    expect(segmentOpacity(0)).toBeCloseTo(1);
    expect(segmentOpacity(1)).toBeCloseTo(0.93);
    expect(segmentOpacity(2)).toBeCloseTo(0.86);
  });

  it('floors at 0.5 past index 7 rather than fading to nothing', () => {
    expect(segmentOpacity(7)).toBeCloseTo(0.51);
    expect(segmentOpacity(8)).toBe(0.5);
    expect(segmentOpacity(40)).toBe(0.5);
  });
});

describe('buildCurrencyBreakdown', () => {
  it('gives nothing to draw for an empty bucket', () => {
    const breakdown = buildCurrencyBreakdown([]);
    expect(breakdown.segments).toEqual([]);
    expect(breakdown.currencyCount).toBe(0);
    expect(breakdown.hasBreakdown).toBe(false);
  });

  it('suppresses the bar and the pager in a single-currency workspace', () => {
    // A one-segment bar at 100% is a decoration claiming to be a comparison.
    const breakdown = buildCurrencyBreakdown(bucket('USD', 12));
    expect(breakdown.currencyCount).toBe(1);
    expect(breakdown.hasBreakdown).toBe(false);
    expect(breakdown.segments[0]?.share).toBe(1);
  });

  it('shares by invoice count, and the shares sum to 1', () => {
    const breakdown = buildCurrencyBreakdown(EIGHT);
    const total = breakdown.segments.reduce((sum, segment) => sum + segment.share, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(breakdown.segments.map((segment) => segment.currency)).toEqual([
      'USD',
      'EUR',
      'GBP',
      'CAD',
      'AUD',
      'CHF',
      'SEK',
      'JPY',
    ]);
    expect(breakdown.segments[0]?.share).toBeCloseTo(8 / 36);
  });

  it('shares by count and not by value — a big number is not a big share', () => {
    // One JPY invoice worth sixty times a GBP one is still one invoice.
    const breakdown = buildCurrencyBreakdown([
      ...bucket('GBP', 3, 100_000),
      ...bucket('JPY', 1, 600_000_000),
    ]);
    const [first, second] = breakdown.segments;
    expect(first?.currency).toBe('GBP');
    expect(first?.share).toBeCloseTo(0.75);
    expect(second?.currency).toBe('JPY');
    expect(second?.share).toBeCloseTo(0.25);
  });

  it('ramps opacity down the sorted list', () => {
    const breakdown = buildCurrencyBreakdown(EIGHT);
    expect(breakdown.segments.map((segment) => segment.opacity)).toEqual([
      segmentOpacity(0),
      segmentOpacity(1),
      segmentOpacity(2),
      segmentOpacity(3),
      segmentOpacity(4),
      segmentOpacity(5),
      segmentOpacity(6),
      segmentOpacity(7),
    ]);
    // Monotonic, which is the only reason the fade reads as a ranking.
    const opacities = breakdown.segments.map((segment) => segment.opacity);
    for (let index = 1; index < opacities.length; index += 1) {
      expect(opacities[index]).toBeLessThanOrEqual(opacities[index - 1] ?? 1);
    }
  });

  it('keeps every currency in its own money and never sums two', () => {
    const breakdown = buildCurrencyBreakdown([
      ...bucket('USD', 2, 100_000),
      ...bucket('EUR', 1, 500_000),
    ]);
    expect(breakdown.segments.map((segment) => [segment.currency, segment.cents])).toEqual([
      ['USD', 200_000],
      ['EUR', 500_000],
    ]);
    // No symbol: the code beside it is what names the currency.
    expect(breakdown.segments[0]?.amount).toBe('2,000');
    expect(breakdown.segments[1]?.amount).toBe('5,000');
  });

  it('breaks a count tie on the code alone, never on raw cents', () => {
    // Regression: the tie-break used to be `b.cents - a.cents`, which compares
    // raw minor units *across currencies* — the one comparison this module's
    // header refuses — and then decided segment order, the opacity ramp and the
    // pager order from it. `AAA` holds a hundredth of what the others hold in
    // its own units and must still lead on the code.
    const breakdown = buildCurrencyBreakdown([
      ...bucket('AAA', 2, 100),
      ...bucket('BBB', 2, 900),
      ...bucket('CCC', 2, 900),
    ]);
    expect(breakdown.segments.map((segment) => segment.currency)).toEqual([
      'AAA',
      'BBB',
      'CCC',
    ]);
  });

  it('ignores a huge minor-unit total when the counts tie', () => {
    // ¥7,120,000 against £120,000: sixty times the raw cents, same count. The
    // order must not notice.
    const breakdown = buildCurrencyBreakdown([
      ...bucket('JPY', 3, 712_000_000),
      ...bucket('GBP', 3, 12_000_000),
    ]);
    expect(breakdown.segments.map((segment) => segment.currency)).toEqual(['GBP', 'JPY']);
    // The opacity ramp is positional, so it inherits the same fix: GBP leads.
    expect(breakdown.segments[0]?.opacity).toBe(segmentOpacity(0));
    expect(breakdown.segments[1]?.opacity).toBe(segmentOpacity(1));
  });
});

describe('the pager list', () => {
  it('leaves the headline currency out of the pager and keeps it in the bar', () => {
    // The tile prints USD as its own big figure; `USD 8,000` under it would be
    // the same money twice in one box. The bar still needs every slice.
    const breakdown = buildCurrencyBreakdown(EIGHT, 'USD');
    expect(breakdown.segments.map((segment) => segment.currency)).toContain('USD');
    expect(breakdown.pagerEntries.map((segment) => segment.currency)).toEqual([
      'EUR',
      'GBP',
      'CAD',
      'AUD',
      'CHF',
      'SEK',
      'JPY',
    ]);
  });

  it('drops a lead that is not the first segment', () => {
    // The bar sorts by count; the lead is the largest by cents. They differ.
    const breakdown = buildCurrencyBreakdown(EIGHT, 'CAD');
    expect(breakdown.segments).toHaveLength(8);
    expect(breakdown.pagerEntries.map((segment) => segment.currency)).toEqual([
      'USD',
      'EUR',
      'GBP',
      'AUD',
      'CHF',
      'SEK',
      'JPY',
    ]);
  });

  it('falls back to every segment when the lead is not in the bucket', () => {
    // Should be impossible — both derive from one bucket — but an empty pager
    // under a four-slice bar would be a worse lie than a repeated figure.
    const breakdown = buildCurrencyBreakdown(EIGHT, 'NZD');
    expect(breakdown.pagerEntries).toEqual(breakdown.segments);
    expect(buildCurrencyBreakdown(EIGHT).pagerEntries).toEqual(breakdown.segments);
  });

  it('falls back rather than emptying when the lead is the only currency', () => {
    const breakdown = buildCurrencyBreakdown(bucket('USD', 4), 'USD');
    expect(breakdown.pagerEntries.map((segment) => segment.currency)).toEqual(['USD']);
    // Neither bar nor pager is drawn at all here — this only guards the shape.
    expect(breakdown.hasBreakdown).toBe(false);
  });

  it('draws neither bar nor pager for one currency', () => {
    expect(buildCurrencyBreakdown(bucket('GBP', 9), 'GBP').hasBreakdown).toBe(false);
    expect(buildCurrencyBreakdown([]).pagerEntries).toEqual([]);
  });

  it('leaves one entry and no arrows for two currencies', () => {
    const breakdown = buildCurrencyBreakdown(
      [...bucket('GBP', 3), ...bucket('EUR', 2)],
      'GBP',
    );
    expect(breakdown.hasBreakdown).toBe(true);
    expect(breakdown.pagerEntries.map((segment) => segment.currency)).toEqual(['EUR']);
    const page = currencyPageAt(breakdown.pagerEntries, 0);
    expect(page.canPrevious).toBe(false);
    expect(page.canNext).toBe(false);
  });
});

describe('the pager', () => {
  const entries = buildCurrencyBreakdown(EIGHT, 'USD').pagerEntries;

  /** The codes on every page, walking forward from 0 until `canNext` is false. */
  function walkForward(list: readonly CurrencySegment[]): string[][] {
    const pages: string[][] = [];
    let index = 0;
    for (;;) {
      const page = currencyPageAt(list, index);
      pages.push(page.entries.map((entry) => entry.currency));
      if (!page.canNext) break;
      index = stepCurrencyPage(list, index, 1);
    }
    return pages;
  }

  it('shows at most three codes', () => {
    expect(CURRENCY_PAGE_SIZE).toBe(3);
    expect(currencyPageAt(entries, 0).entries.map((entry) => entry.currency)).toEqual([
      'EUR',
      'GBP',
      'CAD',
    ]);
  });

  it('steps a whole page and lands on a page start', () => {
    // Was `stepCurrencyPage(segments, 3, 1) === 5` — the old clamp backed the
    // last window up to keep it full, which re-showed two of page 2's entries.
    expect(stepCurrencyPage(entries, 0, 1)).toBe(3);
    expect(stepCurrencyPage(entries, 3, 1)).toBe(6);
    expect(stepCurrencyPage(entries, 6, -1)).toBe(3);
  });

  it('clamps at both ends, and the last page start is a multiple of the size', () => {
    // 7 entries: pages start at 0, 3, 6 — not at 4.
    expect(maxPageIndex(entries.length)).toBe(6);
    expect(stepCurrencyPage(entries, 0, -1)).toBe(0);
    expect(stepCurrencyPage(entries, 6, 1)).toBe(6);
    expect(clampPageIndex(entries.length, 99)).toBe(6);
    expect(clampPageIndex(entries.length, -99)).toBe(0);
    expect(clampPageIndex(entries.length, Number.NaN)).toBe(0);
    expect(maxPageIndex(0)).toBe(0);
  });

  it('lets the last page be short rather than overlapping the one before it', () => {
    expect(currencyPageAt(entries, 99).entries.map((entry) => entry.currency)).toEqual([
      'JPY',
    ]);
  });

  it('snaps a stored index that is not a page start down onto one', () => {
    // The index is React state that survives a filter change, so it arrives
    // stale and off-boundary; an off-boundary window is the overlap itself.
    expect(clampPageIndex(entries.length, 1)).toBe(0);
    expect(clampPageIndex(entries.length, 4)).toBe(3);
    expect(currencyPageAt(entries, 4).index).toBe(3);
    expect(currencyPageAt(entries, 4).entries.map((entry) => entry.currency)).toEqual([
      'AUD',
      'CHF',
      'SEK',
    ]);
  });

  it('reports the clamped index back so the caller cannot drift out of range', () => {
    expect(currencyPageAt(entries, 99).index).toBe(6);
    expect(currencyPageAt(entries, -4).index).toBe(0);
  });

  it('dims the button that has nowhere to go', () => {
    expect(currencyPageAt(entries, 0).canPrevious).toBe(false);
    expect(currencyPageAt(entries, 0).canNext).toBe(true);
    expect(currencyPageAt(entries, 6).canPrevious).toBe(true);
    expect(currencyPageAt(entries, 6).canNext).toBe(false);
  });

  it('disables both ends when everything fits on one page', () => {
    // The seeded workspace: four currencies, lead dropped, three left.
    const short = buildCurrencyBreakdown(
      [...bucket('GBP', 4), ...bucket('EUR', 3), ...bucket('USD', 2), ...bucket('CAD', 1)],
      'GBP',
    ).pagerEntries;
    const page = currencyPageAt(short, 0);
    expect(page.entries.map((entry) => entry.currency)).toEqual(['EUR', 'USD', 'CAD']);
    expect(page.canPrevious).toBe(false);
    expect(page.canNext).toBe(false);
    expect(maxPageIndex(short.length)).toBe(0);
  });

  it('pages six entries as [0,1,2] [3,4,5] with nothing on two pages', () => {
    expect(walkForward(entries.slice(0, 6))).toEqual([
      ['EUR', 'GBP', 'CAD'],
      ['AUD', 'CHF', 'SEK'],
    ]);
  });

  it('pages four entries as [0,1,2] [3] — short last page, still no repeat', () => {
    expect(walkForward(entries.slice(0, 4))).toEqual([['EUR', 'GBP', 'CAD'], ['AUD']]);
  });

  it('shows each entry exactly once walking forward and again walking back', () => {
    const forward = walkForward(entries).flat();
    expect(forward).toEqual(entries.map((entry) => entry.currency));
    expect(new Set(forward).size).toBe(forward.length);

    const backward: string[] = [];
    let index = maxPageIndex(entries.length);
    for (;;) {
      const page = currencyPageAt(entries, index);
      backward.unshift(...page.entries.map((entry) => entry.currency));
      if (!page.canPrevious) break;
      index = stepCurrencyPage(entries, index, -1);
    }
    expect(backward).toEqual(forward);
    expect(new Set(backward).size).toBe(backward.length);
  });
});
