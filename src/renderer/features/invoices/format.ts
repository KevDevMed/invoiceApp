/**
 * Feature-local formatting helpers. All currency display funnels through the
 * shared integer-cents formatter — no floats, no ad-hoc string math.
 */

import { formatMoney } from '../../../shared/money';
import type { Invoice, InvoiceStatus } from '../../../shared/types';

export function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

/**
 * Today as a `yyyy-mm-dd` calendar date in the *user's* zone.
 *
 * Deliberately not `toISOString()`, which is UTC: at 19:00 on 27 July in
 * America/Los_Angeles that returns `2026-07-28`, so an invoice due 27 July
 * reads as a day overdue while it is still the 27th for the person looking at
 * it. `dueDate` and `issueDate` are calendar dates with no zone (`IsoDate`),
 * so the only correct thing to compare them against is the local calendar day.
 */
export function todayIso(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Derived, never stored: sent and past due as of today. */
export function isEffectivelyOverdue(invoice: Pick<Invoice, 'status' | 'dueDate'>): boolean {
  return invoice.status === 'sent' && invoice.dueDate < todayIso();
}

export const STATUS_OPTIONS: InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'void'];
