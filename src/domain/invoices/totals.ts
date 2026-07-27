/**
 * Server-side invoice totals.
 *
 * Every write path recomputes these from the raw item inputs — persisted totals
 * are never trusted from the renderer. The arithmetic itself lives in
 * `src/domain/money-lines.ts` (which delegates to the shared integer money
 * helpers); this module shapes it for the invoice repository.
 */

import { computeLineTotals } from '../money-lines';

export interface TotalsItemInput {
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

export interface InvoiceTotals {
  /** One entry per input item, in input order. */
  readonly lineAmountsCents: readonly number[];
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

/**
 * Compute persisted invoice totals. Throws `InvalidLineItemError` on a
 * non-positive quantity, a non-integer price, or a negative tax rate.
 */
export function computeTotals(
  items: readonly TotalsItemInput[],
  taxRateBps: number,
): InvoiceTotals {
  return computeLineTotals(items, taxRateBps);
}
