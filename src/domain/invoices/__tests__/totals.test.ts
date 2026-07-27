import { describe, expect, it } from 'vitest';

import { InvalidLineItemError, computeLineAmountCents } from '../../money-lines';
import { computeTotals } from '../totals';

describe('computeLineAmountCents', () => {
  it('computes quantity_milli * unit_price_cents / 1000 exactly', () => {
    expect(computeLineAmountCents(1000, 12345)).toBe(12345); // 1 unit
    expect(computeLineAmountCents(2500, 1999)).toBe(4998); // 2.5 * 19.99 = 49.975 -> 49.98
  });

  it('rounds halves up (away from zero)', () => {
    expect(computeLineAmountCents(1500, 1)).toBe(2); // 1.5 cents -> 2
    expect(computeLineAmountCents(500, 1)).toBe(1); // 0.5 -> 1
    expect(computeLineAmountCents(499, 1)).toBe(0); // 0.499 -> 0
    expect(computeLineAmountCents(501, 1)).toBe(1); // 0.501 -> 1
    expect(computeLineAmountCents(500, -1)).toBe(-1); // -0.5 -> -1 (away from zero)
  });

  it('allows negative unit prices (credits) but keeps exact math', () => {
    expect(computeLineAmountCents(2000, -1550)).toBe(-3100);
  });

  it('rejects zero and negative quantities with the typed error', () => {
    expect(() => computeLineAmountCents(0, 100)).toThrow(InvalidLineItemError);
    expect(() => computeLineAmountCents(-1000, 100)).toThrow(InvalidLineItemError);
  });

  it('rejects non-integer inputs', () => {
    expect(() => computeLineAmountCents(1000.5, 100)).toThrow(InvalidLineItemError);
    expect(() => computeLineAmountCents(1000, 100.25)).toThrow(InvalidLineItemError);
  });
});

describe('computeTotals', () => {
  it('sums rounded line amounts into the subtotal (printed lines add up)', () => {
    const totals = computeTotals(
      [
        { quantityMilli: 1500, unitPriceCents: 1 }, // 1.5 cents -> 2
        { quantityMilli: 1500, unitPriceCents: 1 },
      ],
      0,
    );
    // Each line rounds to 2 first; the subtotal is 4, not round(3.0)=3.
    expect(totals.lineAmountsCents).toEqual([2, 2]);
    expect(totals.subtotalCents).toBe(4);
    expect(totals.totalCents).toBe(4);
  });

  it('applies 0 bps tax as exactly zero', () => {
    const totals = computeTotals([{ quantityMilli: 1000, unitPriceCents: 9999 }], 0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(9999);
  });

  it('applies 875 bps with half-up rounding', () => {
    // 10000 * 875 / 10000 = 875 exactly
    expect(computeTotals([{ quantityMilli: 1000, unitPriceCents: 10000 }], 875).taxCents).toBe(875);
    // 999 * 875 / 10000 = 87.4125 -> 87
    expect(computeTotals([{ quantityMilli: 1000, unitPriceCents: 999 }], 875).taxCents).toBe(87);
    // 40 * 875 / 10000 = 3.5 -> 4 (half up)
    expect(computeTotals([{ quantityMilli: 1000, unitPriceCents: 40 }], 875).taxCents).toBe(4);
  });

  it('handles large values without precision loss', () => {
    // 1,000,000 units at $999,999.99: product exceeds 2^53 before scaling,
    // so float math would drift. BigInt path must stay exact.
    const totals = computeTotals([{ quantityMilli: 1_000_000_000, unitPriceCents: 99_999_999 }], 0);
    expect(totals.subtotalCents).toBe(99_999_999_000_000);
    expect(totals.totalCents).toBe(99_999_999_000_000);
  });

  it('rejects negative tax rates and bad quantities', () => {
    expect(() => computeTotals([{ quantityMilli: 1000, unitPriceCents: 100 }], -1)).toThrow(
      InvalidLineItemError,
    );
    expect(() => computeTotals([{ quantityMilli: 0, unitPriceCents: 100 }], 0)).toThrow(
      InvalidLineItemError,
    );
  });

  it('returns all zeros for an empty item list', () => {
    expect(computeTotals([], 875)).toEqual({
      lineAmountsCents: [],
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });
});
