/**
 * Feature-local formatting helpers. All currency display funnels through the
 * shared integer-cents formatter — no floats, no ad-hoc string math.
 */

import { formatMoney } from '../../../shared/money';
import type { Invoice, InvoiceStatus } from '../../../shared/types';

export function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Derived, never stored: sent and past due as of today. */
export function isEffectivelyOverdue(invoice: Pick<Invoice, 'status' | 'dueDate'>): boolean {
  return invoice.status === 'sent' && invoice.dueDate < todayIso();
}

export const STATUS_OPTIONS: InvoiceStatus[] = ['draft', 'sent', 'paid', 'overdue', 'void'];
