/**
 * Client repository. Pure DB-facing functions — every function takes the
 * `Database` instance so tests can run against `:memory:`.
 */

import { randomUUID } from 'node:crypto';

import type { Db } from '../../db/client';
import type { Client, ClientInput } from '../../shared/types';
import { DomainError } from '../money-lines';

export class ClientNotFoundError extends DomainError {
  constructor(id: string) {
    super('CLIENT_NOT_FOUND', `Client not found: ${id}`);
    this.name = 'ClientNotFoundError';
  }
}

export class ClientHasInvoicesError extends DomainError {
  constructor(id: string, invoiceCount: number) {
    super(
      'CLIENT_HAS_INVOICES',
      `Client ${id} has ${invoiceCount} invoice(s) and cannot be deleted. Delete or reassign the invoices first.`,
    );
    this.name = 'ClientHasInvoicesError';
  }
}

interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
    taxId: row.tax_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escape LIKE wildcards so user search text is matched literally. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, '\\$&')}%`;
}

export interface ListClientsFilter {
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListClientsResult {
  readonly items: Client[];
  readonly total: number;
}

export function listClients(db: Db, filter: ListClientsFilter = {}): ListClientsResult {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;
  const search = filter.search?.trim();

  const where = search ? `WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'` : '';
  const params = search ? [likePattern(search), likePattern(search)] : [];

  const total = db
    .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM clients ${where}`)
    .get(...params);
  const rows = db
    .prepare<unknown[], ClientRow>(
      `SELECT * FROM clients ${where} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return { items: rows.map(mapRow), total: total?.n ?? 0 };
}

export function getClient(db: Db, id: string): Client | null {
  const row = db.prepare<[string], ClientRow>('SELECT * FROM clients WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

export function createClient(db: Db, input: ClientInput): Client {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clients (
       id, name, email, phone, address_line1, address_line2, city, region,
       postal_code, country, tax_id, notes, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.email ?? null,
    input.phone ?? null,
    input.addressLine1 ?? null,
    input.addressLine2 ?? null,
    input.city ?? null,
    input.region ?? null,
    input.postalCode ?? null,
    input.country ?? null,
    input.taxId ?? null,
    input.notes ?? null,
    now,
    now,
  );
  const created = getClient(db, id);
  if (!created) throw new ClientNotFoundError(id);
  return created;
}

export function updateClient(db: Db, id: string, patch: Partial<ClientInput>): Client {
  const existing = getClient(db, id);
  if (!existing) throw new ClientNotFoundError(id);

  const next: Client = {
    ...existing,
    name: patch.name ?? existing.name,
    email: patch.email !== undefined ? patch.email : existing.email,
    phone: patch.phone !== undefined ? patch.phone : existing.phone,
    addressLine1: patch.addressLine1 !== undefined ? patch.addressLine1 : existing.addressLine1,
    addressLine2: patch.addressLine2 !== undefined ? patch.addressLine2 : existing.addressLine2,
    city: patch.city !== undefined ? patch.city : existing.city,
    region: patch.region !== undefined ? patch.region : existing.region,
    postalCode: patch.postalCode !== undefined ? patch.postalCode : existing.postalCode,
    country: patch.country !== undefined ? patch.country : existing.country,
    taxId: patch.taxId !== undefined ? patch.taxId : existing.taxId,
    notes: patch.notes !== undefined ? patch.notes : existing.notes,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE clients SET
       name = ?, email = ?, phone = ?, address_line1 = ?, address_line2 = ?,
       city = ?, region = ?, postal_code = ?, country = ?, tax_id = ?, notes = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.email,
    next.phone,
    next.addressLine1,
    next.addressLine2,
    next.city,
    next.region,
    next.postalCode,
    next.country,
    next.taxId,
    next.notes,
    next.updatedAt,
    id,
  );
  return next;
}

export interface DeleteClientResult {
  readonly id: string;
  readonly deleted: boolean;
}

/**
 * Delete a client. A client that still owns invoices is never deleted — the
 * caller gets `ClientHasInvoicesError` (a typed refusal), not a foreign-key
 * crash from SQLite.
 */
export function deleteClient(db: Db, id: string): DeleteClientResult {
  const run = db.transaction((): DeleteClientResult => {
    const invoices = db
      .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE client_id = ?')
      .get(id);
    if (invoices && invoices.n > 0) {
      throw new ClientHasInvoicesError(id, invoices.n);
    }
    const result = db.prepare<[string]>('DELETE FROM clients WHERE id = ?').run(id);
    return { id, deleted: result.changes > 0 };
  });
  return run();
}
