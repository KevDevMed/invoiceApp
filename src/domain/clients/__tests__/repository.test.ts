import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { createInvoice } from '../../invoices/repository';
import {
  ClientHasInvoicesError,
  ClientNotFoundError,
  createClient,
  deleteClient,
  getClient,
  listClients,
  updateClient,
} from '../repository';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

describe('createClient / getClient', () => {
  it('round-trips every field', () => {
    const created = createClient(db, {
      name: 'Acme GmbH',
      email: 'billing@acme.example',
      phone: '+49 30 1234',
      addressLine1: 'Torstr. 1',
      addressLine2: null,
      city: 'Berlin',
      region: null,
      postalCode: '10119',
      country: 'DE',
      taxId: 'DE123456789',
      notes: 'Net 30',
    });
    const fetched = getClient(db, created.id);
    expect(fetched).toEqual(created);
    expect(fetched?.email).toBe('billing@acme.example');
    expect(fetched?.taxId).toBe('DE123456789');
  });

  it('returns null for an unknown id', () => {
    expect(getClient(db, 'nope')).toBeNull();
  });
});

describe('listClients', () => {
  it('searches name and email, case-insensitively via LIKE, with paging', () => {
    createClient(db, { name: 'Alpha Corp', email: 'ap@alpha.example' });
    createClient(db, { name: 'Beta LLC', email: 'billing@beta.example' });
    createClient(db, { name: 'Gamma Inc', email: 'gamma@corp.example' });

    expect(listClients(db).total).toBe(3);
    expect(listClients(db, { search: 'beta' }).items.map((c) => c.name)).toEqual(['Beta LLC']);
    // matches Gamma by email and Alpha by name
    expect(listClients(db, { search: 'corp' }).total).toBe(2);

    const page = listClients(db, { limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });

  it('treats LIKE wildcards in the search literally', () => {
    createClient(db, { name: '100% Cotton Co' });
    createClient(db, { name: 'Percentless' });
    expect(listClients(db, { search: '100%' }).total).toBe(1);
    expect(listClients(db, { search: '%' }).total).toBe(1);
  });
});

describe('updateClient', () => {
  it('applies a partial patch and preserves untouched fields', () => {
    const created = createClient(db, { name: 'Original', email: 'keep@me.example' });
    const updated = updateClient(db, created.id, { name: 'Renamed', city: 'Lisbon' });
    expect(updated.name).toBe('Renamed');
    expect(updated.city).toBe('Lisbon');
    expect(updated.email).toBe('keep@me.example');
    expect(getClient(db, created.id)?.name).toBe('Renamed');
  });

  it('throws the typed error for an unknown id', () => {
    expect(() => updateClient(db, 'nope', { name: 'X' })).toThrow(ClientNotFoundError);
  });
});

describe('deleteClient', () => {
  it('deletes a client with no invoices', () => {
    const client = createClient(db, { name: 'Deletable' });
    expect(deleteClient(db, client.id)).toEqual({ id: client.id, deleted: true });
    expect(getClient(db, client.id)).toBeNull();
  });

  it('reports deleted: false for an unknown id', () => {
    expect(deleteClient(db, 'nope')).toEqual({ id: 'nope', deleted: false });
  });

  it('refuses to delete a client that has invoices, with the typed error', () => {
    const client = createClient(db, { name: 'Invoiced' });
    createInvoice(db, {
      clientId: client.id,
      issueDate: '2026-01-01',
      dueDate: '2026-02-01',
      items: [{ description: 'Work', quantityMilli: 1000, unitPriceCents: 5000 }],
    });

    let caught: unknown;
    try {
      deleteClient(db, client.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClientHasInvoicesError);
    expect((caught as ClientHasInvoicesError).code).toBe('CLIENT_HAS_INVOICES');
    // the refusal left the client in place
    expect(getClient(db, client.id)?.name).toBe('Invoiced');
  });
});
