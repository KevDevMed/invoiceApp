/**
 * Line-amount and invoice-totals arithmetic for the domain layer.
 *
 * Thin, validating layer over `src/shared/money.ts`: the shared module owns the
 * integer/BigInt math, this module owns the domain rules (a line must have a
 * strictly positive quantity, tax rates are non-negative) and the typed error
 * every repository throws when those rules are violated.
 */

import { lineAmountCents, sumCents, taxCentsFromBps } from '../shared/money';

/** Base class for every typed domain error. `code` is stable and machine-readable. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidLineItemError extends DomainError {
  constructor(message: string) {
    super('INVALID_LINE_ITEM', message);
    this.name = 'InvalidLineItemError';
  }
}

export interface LineInput {
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

export interface LineTotals {
  readonly lineAmountsCents: readonly number[];
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

/**
 * amount_cents for one line: round-half-up of quantity_milli * unit_price_cents / 1000.
 * Quantities must be strictly positive integers; unit prices may be negative
 * (credits and adjustments are legal money).
 */
export function computeLineAmountCents(quantityMilli: number, unitPriceCents: number): number {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli <= 0) {
    throw new InvalidLineItemError(
      `quantityMilli must be a positive integer, received ${String(quantityMilli)}`,
    );
  }
  if (!Number.isSafeInteger(unitPriceCents)) {
    throw new InvalidLineItemError(
      `unitPriceCents must be an integer, received ${String(unitPriceCents)}`,
    );
  }
  return lineAmountCents(quantityMilli, unitPriceCents);
}

/**
 * Full invoice arithmetic: per-line amounts rounded to cents first, summed into
 * the subtotal, tax as round-half-up of subtotal * rate_bps / 10000.
 */
export function computeLineTotals(items: readonly LineInput[], taxRateBps: number): LineTotals {
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0) {
    throw new InvalidLineItemError(
      `taxRateBps must be a non-negative integer, received ${String(taxRateBps)}`,
    );
  }
  const lineAmountsCents = items.map((item) =>
    computeLineAmountCents(item.quantityMilli, item.unitPriceCents),
  );
  const subtotalCents = sumCents(lineAmountsCents);
  const taxCents = taxCentsFromBps(subtotalCents, taxRateBps);
  return {
    lineAmountsCents,
    subtotalCents,
    taxCents,
    totalCents: sumCents([subtotalCents, taxCents]),
  };
}
