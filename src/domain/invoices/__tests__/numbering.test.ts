import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { SETTINGS_KEYS } from '../../../shared/types';
import { invoiceNumberPrefix, nextInvoiceNumber } from '../numbering';

let db: Db;

function seedClient(): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clients (id, name, created_at, updated_at) VALUES (?, 'Test Client', ?, ?)`,
  ).run(id, new Date().toISOString(), new Date().toISOString());
  return id;
}

function insertInvoice(number: string, clientId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO invoices (
       id, number, client_id, status, issue_date, due_date, created_at, updated_at
     ) VALUES (?, ?, ?, 'draft', '2026-01-01', '2026-02-01', ?, ?)`,
  ).run(randomUUID(), number, clientId, now, now);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

describe('invoiceNumberPrefix', () => {
  it('falls back to INV- when no setting exists', () => {
    expect(invoiceNumberPrefix(db)).toBe('INV-');
  });

  it('reads the configured prefix from settings', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SETTINGS_KEYS.invoiceNumberPrefix,
      'ACME-',
    );
    expect(invoiceNumberPrefix(db)).toBe('ACME-');
  });
});

describe('nextInvoiceNumber', () => {
  it('starts at <prefix>0001 and allocates sequentially', () => {
    const clientId = seedClient();
    expect(nextInvoiceNumber(db)).toBe('INV-0001');
    insertInvoice('INV-0001', clientId);
    expect(nextInvoiceNumber(db)).toBe('INV-0002');
    insertInvoice('INV-0002', clientId);
    expect(nextInvoiceNumber(db)).toBe('INV-0003');
  });

  it('uses the settings prefix', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SETTINGS_KEYS.invoiceNumberPrefix,
      'ACME-',
    );
    const clientId = seedClient();
    insertInvoice('ACME-0007', clientId);
    expect(nextInvoiceNumber(db)).toBe('ACME-0008');
  });

  it('ignores other prefixes and non-numeric suffixes', () => {
    const clientId = seedClient();
    insertInvoice('OLD-9000', clientId);
    insertInvoice('INV-DRAFT', clientId);
    insertInvoice('INV-0002', clientId);
    expect(nextInvoiceNumber(db)).toBe('INV-0003');
  });

  it('grows past the 4-digit pad without truncating', () => {
    const clientId = seedClient();
    insertInvoice('INV-9999', clientId);
    expect(nextInvoiceNumber(db)).toBe('INV-10000');
  });

  it('never hands out a duplicate when allocating repeatedly inside one transaction', () => {
    const clientId = seedClient();
    const allocated: string[] = [];
    const run = db.transaction(() => {
      for (let i = 0; i < 25; i += 1) {
        const number = nextInvoiceNumber(db);
        insertInvoice(number, clientId); // same-connection scan sees the uncommitted row
        allocated.push(number);
      }
    });
    run();
    expect(new Set(allocated).size).toBe(25);
    expect(allocated[0]).toBe('INV-0001');
    expect(allocated[24]).toBe('INV-0025');
  });
});
