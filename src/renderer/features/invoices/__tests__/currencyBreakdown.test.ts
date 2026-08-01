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

  it('breaks a count tie on money, then on the code, so the order is stable', () => {
    const breakdown = buildCurrencyBreakdown([
      ...bucket('AAA', 2, 100),
      ...bucket('BBB', 2, 900),
      ...bucket('CCC', 2, 900),
    ]);
    expect(breakdown.segments.map((segment) => segment.currency)).toEqual([
      'BBB',
      'CCC',
      'AAA',
    ]);
  });
});

describe('the pager', () => {
  const segments = buildCurrencyBreakdown(EIGHT).segments;

  it('shows exactly three codes', () => {
    expect(CURRENCY_PAGE_SIZE).toBe(3);
    expect(currencyPageAt(segments, 0).entries.map((entry) => entry.currency)).toEqual([
      'USD',
      'EUR',
      'GBP',
    ]);
  });

  it('steps a whole page, not one entry', () => {
    expect(stepCurrencyPage(segments, 0, 1)).toBe(3);
    expect(stepCurrencyPage(segments, 3, 1)).toBe(5);
    expect(stepCurrencyPage(segments, 5, -1)).toBe(2);
  });

  it('clamps at both ends', () => {
    expect(maxPageIndex(segments.length)).toBe(5);
    expect(stepCurrencyPage(segments, 0, -1)).toBe(0);
    expect(stepCurrencyPage(segments, 5, 1)).toBe(5);
    expect(clampPageIndex(segments.length, 99)).toBe(5);
    expect(clampPageIndex(segments.length, -99)).toBe(0);
    expect(clampPageIndex(segments.length, Number.NaN)).toBe(0);
  });

  it('always fills the window at the far end rather than showing one entry', () => {
    expect(currencyPageAt(segments, 99).entries.map((entry) => entry.currency)).toEqual([
      'CHF',
      'SEK',
      'JPY',
    ]);
  });

  it('reports the clamped index back so the caller cannot drift out of range', () => {
    expect(currencyPageAt(segments, 99).index).toBe(5);
    expect(currencyPageAt(segments, -4).index).toBe(0);
  });

  it('dims the button that has nowhere to go', () => {
    expect(currencyPageAt(segments, 0).canPrevious).toBe(false);
    expect(currencyPageAt(segments, 0).canNext).toBe(true);
    expect(currencyPageAt(segments, 5).canPrevious).toBe(true);
    expect(currencyPageAt(segments, 5).canNext).toBe(false);
  });

  it('disables both ends when everything fits on one page', () => {
    const short = buildCurrencyBreakdown([
      ...bucket('USD', 3),
      ...bucket('EUR', 2),
      ...bucket('GBP', 1),
    ]).segments;
    const page = currencyPageAt(short, 0);
    expect(page.entries).toHaveLength(3);
    expect(page.canPrevious).toBe(false);
    expect(page.canNext).toBe(false);
    expect(maxPageIndex(short.length)).toBe(0);
  });

  it('walks the whole list without ever skipping a currency', () => {
    const seen: string[] = [];
    let index = 0;
    for (;;) {
      const page = currencyPageAt(segments, index);
      seen.push(...page.entries.map((entry) => entry.currency));
      if (!page.canNext) break;
      index = stepCurrencyPage(segments, index, 1);
    }
    expect(new Set(seen).size).toBe(segments.length);
  });
});
