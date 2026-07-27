/**
 * Integer-only money math.
 *
 * Invariants enforced across the whole app:
 *   - amounts are INTEGER cents           (1234 === $12.34)
 *   - quantities are INTEGER milli-units  (1500 === 1.5 units, 3 decimal places)
 *   - tax rates are INTEGER basis points  (825 === 8.25%)
 *
 * No `number` division or multiplication happens on money here: every scaling
 * step goes through BigInt so 0.1 + 0.2 and 19.99 * 3 are exact.
 */

export const CENTS_PER_UNIT = 100;
export const MILLI_PER_UNIT = 1000;
export const BPS_PER_UNIT = 10000;

const CENTS_PER_UNIT_BIG = BigInt(CENTS_PER_UNIT);
const MILLI_PER_UNIT_BIG = BigInt(MILLI_PER_UNIT);
const BPS_PER_UNIT_BIG = BigInt(BPS_PER_UNIT);

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${name} must be a safe integer, received ${String(value)}`);
  }
}

function toSafeNumber(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`${name} overflowed the safe integer range`);
  }
  return Number(value);
}

/**
 * Divide two BigInts, rounding halves away from zero (the rounding rule
 * invoices are normally audited against). Never touches floating point.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Parse a decimal string into a scaled integer, rounding halves away from zero. */
function parseScaled(input: string, scale: bigint, label: string): bigint {
  if (typeof input !== 'string') throw new MoneyError(`${label} must be a string`);
  const trimmed = input.trim().replace(/[\s,_]/g, '');
  const match = DECIMAL_RE.exec(trimmed);
  if (!match) throw new MoneyError(`${label} is not a valid decimal: ${JSON.stringify(input)}`);
  const [, sign, intPart, fracPart] = match;
  if (!intPart && !fracPart) {
    throw new MoneyError(`${label} is not a valid decimal: ${JSON.stringify(input)}`);
  }
  const whole = BigInt(intPart || '0') * scale;
  let fraction = 0n;
  if (fracPart) {
    // Scale the fractional digits up to `scale`, rounding any excess digits.
    fraction = divRoundHalfUp(BigInt(fracPart) * scale, 10n ** BigInt(fracPart.length));
  }
  const magnitude = whole + fraction;
  return sign === '-' ? -magnitude : magnitude;
}

function formatScaled(value: number, scale: bigint, decimals: number): string {
  assertInteger(value, 'value');
  const big = BigInt(value);
  const negative = big < 0n;
  const magnitude = negative ? -big : big;
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const fractionText = fraction.toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}${decimals > 0 ? `.${fractionText}` : ''}`;
}

/** `"19.99"` -> `1999`. Extra decimal places are rounded, not truncated. */
export function parseAmountToCents(input: string): number {
  return toSafeNumber(parseScaled(input, CENTS_PER_UNIT_BIG, 'amount'), 'amount');
}

/** `1999` -> `"19.99"`. Plain machine-readable form, no grouping or symbol. */
export function formatCents(cents: number): string {
  return formatScaled(cents, CENTS_PER_UNIT_BIG, 2);
}

/** `"1.5"` -> `1500`. Quantities carry 3 decimal places. */
export function parseQuantityToMilli(input: string): number {
  return toSafeNumber(parseScaled(input, MILLI_PER_UNIT_BIG, 'quantity'), 'quantity');
}

/** `1500` -> `"1.5"` (trailing zeros trimmed, integers stay bare). */
export function formatMilli(milli: number): string {
  const raw = formatScaled(milli, MILLI_PER_UNIT_BIG, 3);
  return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** `"8.25"` -> `825` basis points. */
export function parsePercentToBps(input: string): number {
  return toSafeNumber(parseScaled(input, 100n, 'tax rate'), 'tax rate');
}

/** `825` -> `"8.25"`. */
export function formatBpsAsPercent(bps: number): string {
  return formatScaled(bps, 100n, 2);
}

/** quantity(milli) x unitPrice(cents) -> line amount in cents. */
export function lineAmountCents(quantityMilli: number, unitPriceCents: number): number {
  assertInteger(quantityMilli, 'quantityMilli');
  assertInteger(unitPriceCents, 'unitPriceCents');
  const product = BigInt(quantityMilli) * BigInt(unitPriceCents);
  return toSafeNumber(divRoundHalfUp(product, MILLI_PER_UNIT_BIG), 'lineAmountCents');
}

/** subtotal(cents) x rate(bps) -> tax in cents. */
export function taxCentsFromBps(subtotalCents: number, taxRateBps: number): number {
  assertInteger(subtotalCents, 'subtotalCents');
  assertInteger(taxRateBps, 'taxRateBps');
  if (taxRateBps < 0) throw new MoneyError('taxRateBps must not be negative');
  const product = BigInt(subtotalCents) * BigInt(taxRateBps);
  return toSafeNumber(divRoundHalfUp(product, BPS_PER_UNIT_BIG), 'taxCents');
}

/** Exact sum of integer cents. */
export function sumCents(values: readonly number[]): number {
  let total = 0n;
  for (const value of values) {
    assertInteger(value, 'cents value');
    total += BigInt(value);
  }
  return toSafeNumber(total, 'sumCents');
}

export interface TotalsInput {
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

export interface InvoiceTotals {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly lineAmountsCents: readonly number[];
}

/**
 * Canonical invoice arithmetic. Line amounts are rounded to cents first, then
 * summed — matching what a printed invoice shows, so the printed lines always
 * add up to the printed subtotal.
 */
export function computeInvoiceTotals(
  items: readonly TotalsInput[],
  taxRateBps: number,
): InvoiceTotals {
  const lineAmountsCents = items.map((item) =>
    lineAmountCents(item.quantityMilli, item.unitPriceCents),
  );
  const subtotalCents = sumCents(lineAmountsCents);
  const taxCents = taxCentsFromBps(subtotalCents, taxRateBps);
  return {
    subtotalCents,
    taxCents,
    totalCents: sumCents([subtotalCents, taxCents]),
    lineAmountsCents,
  };
}

/** Human-facing display. Formatting is presentational only — never fed back into math. */
export function formatMoney(cents: number, currency: string, locale?: string): string {
  assertInteger(cents, 'cents');
  const plain = formatCents(cents);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(plain));
  } catch {
    return `${currency} ${plain}`;
  }
}
