import { describe, expect, it } from 'vitest';

import {
  computeInvoiceTotals,
  divRoundHalfUp,
  formatBpsAsPercent,
  formatCents,
  formatMilli,
  formatMoney,
  lineAmountCents,
  MoneyError,
  parseAmountToCents,
  parsePercentToBps,
  parseQuantityToMilli,
  sumCents,
  taxCentsFromBps,
} from '../money';

describe('divRoundHalfUp', () => {
  it('rounds halves away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 2n)).toBe(2n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
  });

  it('rejects division by zero', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(MoneyError);
  });
});

describe('parseAmountToCents', () => {
  it('parses plain decimals', () => {
    expect(parseAmountToCents('0')).toBe(0);
    expect(parseAmountToCents('1')).toBe(100);
    expect(parseAmountToCents('19.99')).toBe(1999);
    expect(parseAmountToCents('.5')).toBe(50);
    expect(parseAmountToCents('1.')).toBe(100);
    expect(parseAmountToCents('-4.20')).toBe(-420);
    expect(parseAmountToCents(' 1,234.50 ')).toBe(123450);
  });

  it('rounds excess decimal places instead of truncating', () => {
    expect(parseAmountToCents('1.005')).toBe(101);
    expect(parseAmountToCents('1.004')).toBe(100);
    expect(parseAmountToCents('-1.005')).toBe(-101);
  });

  it('rejects garbage', () => {
    expect(() => parseAmountToCents('abc')).toThrow(MoneyError);
    expect(() => parseAmountToCents('')).toThrow(MoneyError);
    expect(() => parseAmountToCents('1.2.3')).toThrow(MoneyError);
  });
});

describe('classic float failures stay exact', () => {
  it('0.1 + 0.2 === 0.3', () => {
    // The float version of this is 0.30000000000000004.
    expect(0.1 + 0.2).not.toBe(0.3);

    const a = parseAmountToCents('0.10');
    const b = parseAmountToCents('0.20');
    expect(sumCents([a, b])).toBe(30);
    expect(formatCents(sumCents([a, b]))).toBe('0.30');
  });

  it('19.99 x 3 === 59.97, with no lost cent on the way in', () => {
    // The naive float route to cents loses a cent: 19.99 * 100 is
    // 1998.9999999999998, so truncating gives $19.98 per line and $59.94
    // across three of them.
    expect(19.99 * 100).not.toBe(1999);
    expect(Math.trunc(19.99 * 100)).toBe(1998);

    const unitPriceCents = parseAmountToCents('19.99');
    expect(unitPriceCents).toBe(1999);

    const amount = lineAmountCents(parseQuantityToMilli('3'), unitPriceCents);
    expect(amount).toBe(5997);
    expect(formatCents(amount)).toBe('59.97');
  });

  it('1.1 x 3 === 3.30', () => {
    // The float version of this is 3.3000000000000003.
    expect(1.1 * 3).not.toBe(3.3);
    expect(lineAmountCents(parseQuantityToMilli('3'), parseAmountToCents('1.10'))).toBe(330);
  });

  it('sums 0.01 a hundred times to exactly 1.00', () => {
    const penny = parseAmountToCents('0.01');
    expect(sumCents(Array.from({ length: 100 }, () => penny))).toBe(100);
  });
});

describe('formatCents', () => {
  it('always renders two decimal places', () => {
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(1999)).toBe('19.99');
    expect(formatCents(-1999)).toBe('-19.99');
    expect(formatCents(100000000)).toBe('1000000.00');
  });

  it('round-trips through parseAmountToCents', () => {
    for (const cents of [0, 1, 99, 100, 12345, -6789]) {
      expect(parseAmountToCents(formatCents(cents))).toBe(cents);
    }
  });
});

describe('quantities in milli-units', () => {
  it('parses three decimal places', () => {
    expect(parseQuantityToMilli('1')).toBe(1000);
    expect(parseQuantityToMilli('1.5')).toBe(1500);
    expect(parseQuantityToMilli('0.125')).toBe(125);
    expect(parseQuantityToMilli('2.0005')).toBe(2001);
  });

  it('formats without trailing zeros', () => {
    expect(formatMilli(1000)).toBe('1');
    expect(formatMilli(1500)).toBe('1.5');
    expect(formatMilli(125)).toBe('0.125');
    expect(formatMilli(1250)).toBe('1.25');
    expect(formatMilli(-1500)).toBe('-1.5');
  });
});

describe('lineAmountCents', () => {
  it('multiplies milli-quantity by unit price', () => {
    expect(lineAmountCents(1000, 1999)).toBe(1999);
    expect(lineAmountCents(2500, 400)).toBe(1000);
    expect(lineAmountCents(0, 1999)).toBe(0);
  });

  it('rounds halves away from zero', () => {
    // 0.5 units at $0.01 => 0.5 cents => 1 cent
    expect(lineAmountCents(500, 1)).toBe(1);
    // 0.333 units at $0.01 => 0.333 cents => 0 cents
    expect(lineAmountCents(333, 1)).toBe(0);
  });

  it('stays exact for large invoices', () => {
    // 1000 units at $9,999.99
    expect(lineAmountCents(1_000_000, 999999)).toBe(999999000);
  });

  it('rejects non-integer inputs', () => {
    expect(() => lineAmountCents(1.5, 100)).toThrow(MoneyError);
    expect(() => lineAmountCents(1000, 10.5)).toThrow(MoneyError);
  });
});

describe('taxCentsFromBps', () => {
  it('applies basis points exactly', () => {
    expect(taxCentsFromBps(10000, 0)).toBe(0);
    expect(taxCentsFromBps(10000, 2000)).toBe(2000);
    expect(taxCentsFromBps(1999, 825)).toBe(165); // 164.9175 -> 165
    expect(taxCentsFromBps(100, 750)).toBe(8); // 7.5 -> 8
    expect(taxCentsFromBps(100, 250)).toBe(3); // 2.5 -> 3
  });

  it('rejects negative rates', () => {
    expect(() => taxCentsFromBps(100, -1)).toThrow(MoneyError);
  });
});

describe('percent <-> bps', () => {
  it('parses and formats', () => {
    expect(parsePercentToBps('8.25')).toBe(825);
    expect(parsePercentToBps('20')).toBe(2000);
    expect(parsePercentToBps('0')).toBe(0);
    expect(formatBpsAsPercent(825)).toBe('8.25');
    expect(formatBpsAsPercent(2000)).toBe('20.00');
  });
});

describe('computeInvoiceTotals', () => {
  it('rounds each line before summing', () => {
    const totals = computeInvoiceTotals(
      [
        { quantityMilli: 3000, unitPriceCents: 1999 }, // 59.97
        { quantityMilli: 1500, unitPriceCents: 1000 }, // 15.00
        { quantityMilli: 333, unitPriceCents: 300 }, // 0.999 -> 1.00
      ],
      825,
    );

    expect(totals.lineAmountsCents).toEqual([5997, 1500, 100]);
    expect(totals.subtotalCents).toBe(7597);
    expect(totals.taxCents).toBe(627); // 626.7525 -> 627
    expect(totals.totalCents).toBe(8224);
  });

  it('is zero for an empty invoice', () => {
    expect(computeInvoiceTotals([], 825)).toEqual({
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
      lineAmountsCents: [],
    });
  });

  it('keeps subtotal + tax === total for many randomised-looking cases', () => {
    for (let quantity = 1; quantity <= 40; quantity += 1) {
      for (const price of [1, 7, 99, 1999, 123456]) {
        for (const bps of [0, 1, 825, 1999, 10000]) {
          const totals = computeInvoiceTotals(
            [{ quantityMilli: quantity * 1000, unitPriceCents: price }],
            bps,
          );
          expect(totals.subtotalCents + totals.taxCents).toBe(totals.totalCents);
          expect(Number.isSafeInteger(totals.totalCents)).toBe(true);
        }
      }
    }
  });
});

describe('formatMoney', () => {
  it('renders a currency string', () => {
    expect(formatMoney(1999, 'USD', 'en-US')).toBe('$19.99');
    expect(formatMoney(0, 'USD', 'en-US')).toBe('$0.00');
  });

  it('falls back to a plain string for unknown currency codes', () => {
    expect(formatMoney(1999, 'NOTACURRENCY', 'en-US')).toBe('NOTACURRENCY 19.99');
  });
});
