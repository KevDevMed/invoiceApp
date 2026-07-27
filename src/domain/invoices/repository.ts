/**
 * Invoice repository.
 *
 * Every write recomputes totals server-side from the raw item inputs and
 * persists them — the renderer's numbers are display-only. All multi-row writes
 * run inside one transaction; a failure anywhere rolls the whole write back.
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../../db/client';
import type {
  Invoice,
  InvoiceInput,
  InvoiceItem,
  InvoiceItemInput,
  InvoiceStatus,
  InvoiceWithItems,
} from '../../shared/types';
import { SETTINGS_KEYS } from '../../shared/types';
import { getClient, ClientNotFoundError } from '../clients/repository';
import { DomainError } from '../money-lines';
import { computeLineAmountCents } from '../money-lines';
import { invoiceNumberPrefix, isNumberCollision, nextInvoiceNumber } from './numbering';
import { computeTotals } from './totals';

export class InvoiceNotFoundError extends DomainError {
  constructor(id: string) {
    super('INVOICE_NOT_FOUND', `Invoice not found: ${id}`);
    this.name = 'InvoiceNotFoundError';
  }
}

export class DuplicateInvoiceNumberError extends DomainError {
  constructor(number: string) {
    super('DUPLICATE_INVOICE_NUMBER', `Invoice number already in use: ${number}`);
    this.name = 'DuplicateInvoiceNumberError';
  }
}

export class EmptyInvoiceError extends DomainError {
  constructor() {
    super('EMPTY_INVOICE', 'An invoice needs at least one line item.');
    this.name = 'EmptyInvoiceError';
  }
}

interface InvoiceRow {
  id: string;
  number: string;
  client_id: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string;
  currency: string;
  tax_rate_bps: number;
  notes: string | null;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  quantity_milli: number;
  unit_price_cents: number;
  amount_cents: number;
}

function mapInvoiceRow(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    status: row.status,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    currency: row.currency,
    taxRateBps: row.tax_rate_bps,
    notes: row.notes,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItemRow(row: ItemRow): InvoiceItem {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    position: row.position,
    description: row.description,
    quantityMilli: row.quantity_milli,
    unitPriceCents: row.unit_price_cents,
    amountCents: row.amount_cents,
  };
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
}

function settingValue(db: Db, key: string): string | null {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function defaultCurrency(db: Db): string {
  const value = settingValue(db, SETTINGS_KEYS.defaultCurrency);
  return value && /^[A-Z]{3}$/.test(value) ? value : 'USD';
}

function defaultTaxRateBps(db: Db): number {
  const value = Number.parseInt(settingValue(db, SETTINGS_KEYS.defaultTaxRateBps) ?? '', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface ListInvoicesFilter {
  readonly search?: string;
  readonly status?: InvoiceStatus;
  readonly clientId?: string;
  readonly issuedBetween?: { readonly from?: string; readonly to?: string };
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListInvoicesResult {
  readonly items: Invoice[];
  readonly total: number;
}

export function listInvoices(db: Db, filter: ListInvoicesFilter = {}): ListInvoicesResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.status) {
    clauses.push('i.status = ?');
    params.push(filter.status);
  }
  if (filter.clientId) {
    clauses.push('i.client_id = ?');
    params.push(filter.clientId);
  }
  if (filter.issuedBetween?.from) {
    clauses.push('i.issue_date >= ?');
    params.push(filter.issuedBetween.from);
  }
  if (filter.issuedBetween?.to) {
    clauses.push('i.issue_date <= ?');
    params.push(filter.issuedBetween.to);
  }
  const search = filter.search?.trim();
  if (search) {
    clauses.push(`(i.number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
    params.push(likePattern(search), likePattern(search));
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const from = `FROM invoices i JOIN clients c ON c.id = i.client_id ${where}`;

  const total = db
    .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n ${from}`)
    .get(...params);
  const rows = db
    .prepare<unknown[], InvoiceRow>(
      `SELECT i.* ${from} ORDER BY i.issue_date DESC, i.created_at DESC, i.id LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 100, filter.offset ?? 0);

  return { items: rows.map(mapInvoiceRow), total: total?.n ?? 0 };
}

export function listItems(db: Db, invoiceId: string): InvoiceItem[] {
  return db
    .prepare<[string], ItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position, id',
    )
    .all(invoiceId)
    .map(mapItemRow);
}

export function getInvoice(db: Db, id: string): InvoiceWithItems | null {
  const row = db.prepare<[string], InvoiceRow>('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...mapInvoiceRow(row),
    items: listItems(db, id),
    client: getClient(db, row.client_id),
  };
}

const NUMBER_ALLOCATION_ATTEMPTS = 5;

function insertItems(db: Db, invoiceId: string, items: readonly InvoiceItemInput[]): void {
  const insert = db.prepare(
    `INSERT INTO invoice_items (
       id, invoice_id, position, description, quantity_milli, unit_price_cents, amount_cents
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  items.forEach((item, index) => {
    // Per-line validation happens here, inside the transaction, so a bad line
    // after good ones rolls the whole item set back.
    const amountCents = computeLineAmountCents(item.quantityMilli, item.unitPriceCents);
    insert.run(
      randomUUID(),
      invoiceId,
      item.position ?? index,
      item.description,
      item.quantityMilli,
      item.unitPriceCents,
      amountCents,
    );
  });
}

export function createInvoice(db: Db, input: InvoiceInput): InvoiceWithItems {
  if (input.items.length === 0) throw new EmptyInvoiceError();

  const create = db.transaction((number: string): string => {
    if (!getClient(db, input.clientId)) throw new ClientNotFoundError(input.clientId);

    const id = randomUUID();
    const now = new Date().toISOString();
    const taxRateBps = input.taxRateBps ?? defaultTaxRateBps(db);
    const totals = computeTotals(input.items, taxRateBps);
    const status = input.status ?? 'draft';

    db.prepare(
      `INSERT INTO invoices (
         id, number, client_id, status, issue_date, due_date, currency,
         tax_rate_bps, notes, subtotal_cents, tax_cents, total_cents,
         paid_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      number,
      input.clientId,
      status,
      input.issueDate,
      input.dueDate,
      input.currency ?? defaultCurrency(db),
      taxRateBps,
      input.notes ?? null,
      totals.subtotalCents,
      totals.taxCents,
      totals.totalCents,
      status === 'paid' ? now : null,
      now,
      now,
    );
    insertItems(db, id, input.items);
    return id;
  });

  // A caller-supplied number collides once and fails; an allocated number is
  // recomputed and retried, so concurrent-ish creates never crash on UNIQUE.
  const prefix = input.number === undefined ? invoiceNumberPrefix(db) : undefined;
  for (let attempt = 0; ; attempt += 1) {
    const number = input.number ?? nextInvoiceNumber(db, prefix);
    try {
      const id = create(number);
      const created = getInvoice(db, id);
      if (!created) throw new InvoiceNotFoundError(id);
      return created;
    } catch (error) {
      if (!isNumberCollision(error)) throw error;
      if (input.number !== undefined) throw new DuplicateInvoiceNumberError(input.number);
      if (attempt + 1 >= NUMBER_ALLOCATION_ATTEMPTS) throw error;
    }
  }
}

export function updateInvoice(db: Db, id: string, patch: Partial<InvoiceInput>): InvoiceWithItems {
  const run = db.transaction((): void => {
    const existing = getInvoice(db, id);
    if (!existing) throw new InvoiceNotFoundError(id);
    if (patch.items && patch.items.length === 0) throw new EmptyInvoiceError();

    const clientId = patch.clientId ?? existing.clientId;
    if (patch.clientId && !getClient(db, patch.clientId)) {
      throw new ClientNotFoundError(patch.clientId);
    }

    const number = patch.number ?? existing.number;
    const status = patch.status ?? existing.status;
    const taxRateBps = patch.taxRateBps ?? existing.taxRateBps;
    const now = new Date().toISOString();

    // Replace the item set atomically when new items were supplied; otherwise
    // keep the stored set but still recompute totals from it.
    let itemInputs: InvoiceItemInput[];
    if (patch.items) {
      db.prepare<[string]>('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
      insertItems(db, id, patch.items);
      itemInputs = [...patch.items];
    } else {
      itemInputs = existing.items.map((item) => ({
        description: item.description,
        quantityMilli: item.quantityMilli,
        unitPriceCents: item.unitPriceCents,
        position: item.position,
      }));
    }
    const totals = computeTotals(itemInputs, taxRateBps);

    db.prepare(
      `UPDATE invoices SET
         number = ?, client_id = ?, status = ?, issue_date = ?, due_date = ?,
         currency = ?, tax_rate_bps = ?, notes = ?, subtotal_cents = ?,
         tax_cents = ?, total_cents = ?, paid_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      number,
      clientId,
      status,
      patch.issueDate ?? existing.issueDate,
      patch.dueDate ?? existing.dueDate,
      patch.currency ?? existing.currency,
      taxRateBps,
      patch.notes !== undefined ? patch.notes : existing.notes,
      totals.subtotalCents,
      totals.taxCents,
      totals.totalCents,
      status === 'paid' ? (existing.paidAt ?? now) : null,
      now,
      id,
    );
  });

  try {
    run();
  } catch (error) {
    if (isNumberCollision(error) && patch.number !== undefined) {
      throw new DuplicateInvoiceNumberError(patch.number);
    }
    throw error;
  }

  const updated = getInvoice(db, id);
  if (!updated) throw new InvoiceNotFoundError(id);
  return updated;
}

export interface DeleteInvoiceResult {
  readonly id: string;
  readonly deleted: boolean;
}

/** Delete an invoice. Items cascade via the schema's ON DELETE CASCADE. */
export function deleteInvoice(db: Db, id: string): DeleteInvoiceResult {
  const result = db.prepare<[string]>('DELETE FROM invoices WHERE id = ?').run(id);
  return { id, deleted: result.changes > 0 };
}

export function setInvoiceStatus(db: Db, id: string, status: InvoiceStatus): Invoice {
  const run = db.transaction((): void => {
    const row = db
      .prepare<[string], InvoiceRow>('SELECT * FROM invoices WHERE id = ?')
      .get(id);
    if (!row) throw new InvoiceNotFoundError(id);
    const now = new Date().toISOString();
    const paidAt = status === 'paid' ? (row.paid_at ?? now) : null;
    db.prepare('UPDATE invoices SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?').run(
      status,
      paidAt,
      now,
      id,
    );
  });
  run();

  const row = db.prepare<[string], InvoiceRow>('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) throw new InvoiceNotFoundError(id);
  return mapInvoiceRow(row);
}
