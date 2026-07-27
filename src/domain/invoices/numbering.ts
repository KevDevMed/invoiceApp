/**
 * Invoice number allocation.
 *
 * Numbers are `<prefix><zero-padded sequence>` — e.g. `INV-0001` — where the
 * prefix comes from the `invoice.numberPrefix` settings row. Allocation scans
 * the highest existing sequence for the prefix on the same connection, so a
 * caller that computes and inserts inside one transaction sees its own
 * uncommitted inserts and never hands out the same number twice. The
 * `invoices.number` UNIQUE constraint is the final guard; `isNumberCollision`
 * lets the repository detect it and retry.
 */

import type { Db } from '../../db/client';
import { SETTINGS_KEYS } from '../../shared/types';

export const DEFAULT_NUMBER_PREFIX = 'INV-';
const MIN_SEQUENCE_DIGITS = 4;

/** The configured invoice number prefix, falling back to `INV-`. */
export function invoiceNumberPrefix(db: Db): string {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEYS.invoiceNumberPrefix);
  const prefix = row?.value;
  return prefix !== undefined && prefix !== '' ? prefix : DEFAULT_NUMBER_PREFIX;
}

/**
 * Next free number for `prefix`: one past the highest numeric suffix currently
 * in `invoices`, zero-padded to at least 4 digits (wider once the sequence
 * outgrows them — the pad never truncates).
 */
export function nextInvoiceNumber(db: Db, prefix: string = invoiceNumberPrefix(db)): string {
  const rows = db
    .prepare<[number, string], { number: string }>(
      'SELECT number FROM invoices WHERE substr(number, 1, ?) = ?',
    )
    .all(prefix.length, prefix);

  let max = 0;
  for (const row of rows) {
    const suffix = row.number.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number.parseInt(suffix, 10);
    if (Number.isSafeInteger(value) && value > max) max = value;
  }

  const next = max + 1;
  return `${prefix}${String(next).padStart(MIN_SEQUENCE_DIGITS, '0')}`;
}

/** Whether an insert failure is the UNIQUE constraint on `invoices.number`. */
export function isNumberCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    error.message.includes('invoices.number')
  );
}
