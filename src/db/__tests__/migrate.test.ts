import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../client';
import { appliedMigrations, migrate, MIGRATIONS } from '../migrate';

const NOW = '2026-07-27T10:00:00.000Z';

function seedClient(db: Db, id = 'client-1'): string {
  db.prepare(
    `INSERT INTO clients (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'Acme Corp', 'billing@acme.test', NOW, NOW);
  return id;
}

function seedInvoice(db: Db, id: string, clientId: string, status = 'draft'): string {
  db.prepare(
    `INSERT INTO invoices
       (id, number, client_id, status, issue_date, due_date, currency, tax_rate_bps,
        subtotal_cents, tax_cents, total_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `INV-${id}`, clientId, status, '2026-07-01', '2026-07-31', 'USD', 825, 0, 0, 0, NOW, NOW);
  return id;
}

describe('migrate', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('applies every migration to a fresh in-memory database', () => {
    const result = migrate(db);

    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(result.alreadyApplied).toEqual([]);
    expect(appliedMigrations(db)).toEqual(['001_init', '002_model_diagnostics']);
  });

  it('creates every table and index the schema promises', () => {
    migrate(db);

    const names = db
      .prepare<[], { name: string; type: string }>(
        "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      )
      .all();

    const tables = names.filter((r) => r.type === 'table').map((r) => r.name).sort();
    expect(tables).toEqual([
      '_migrations',
      'chat_messages',
      'chat_threads',
      'clients',
      'invoice_items',
      'invoices',
      'models',
      'settings',
    ]);

    const indexes = names.filter((r) => r.type === 'index').map((r) => r.name);
    for (const expected of [
      'idx_invoices_client_id',
      'idx_invoices_status',
      'idx_invoices_issue_date',
      'idx_invoice_items_invoice_position',
      'idx_chat_messages_thread_created',
    ]) {
      expect(indexes).toContain(expected);
    }
  });

  it('is idempotent on re-run', () => {
    migrate(db);
    seedClient(db);

    const second = migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['001_init', '002_model_diagnostics']);

    const third = migrate(db);
    expect(third.applied).toEqual([]);

    // Data survives a re-run.
    expect(
      db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM clients').get()?.c,
    ).toBe(1);
    expect(appliedMigrations(db)).toEqual(['001_init', '002_model_diagnostics']);
  });

  it('enforces the invoice status CHECK constraint', () => {
    migrate(db);
    const clientId = seedClient(db);

    expect(() => seedInvoice(db, 'inv-bad', clientId, 'archived')).toThrow(/CHECK constraint/i);

    for (const status of ['draft', 'sent', 'paid', 'overdue', 'void']) {
      expect(() => seedInvoice(db, `inv-${status}`, clientId, status)).not.toThrow();
    }
  });

  it('enforces the chat message role CHECK constraint', () => {
    migrate(db);
    db.prepare('INSERT INTO chat_threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(
      'thread-1',
      NOW,
      NOW,
    );

    expect(() =>
      db
        .prepare('INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('msg-bad', 'thread-1', 'robot', 'hi', NOW),
    ).toThrow(/CHECK constraint/i);
  });

  it('cascades invoice_items when the parent invoice is deleted', () => {
    migrate(db);
    const clientId = seedClient(db);
    seedInvoice(db, 'inv-1', clientId);

    const insertItem = db.prepare(
      `INSERT INTO invoice_items
         (id, invoice_id, position, description, quantity_milli, unit_price_cents, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertItem.run('item-1', 'inv-1', 0, 'Consulting', 3000, 1999, 5997);
    insertItem.run('item-2', 'inv-1', 1, 'Hosting', 1000, 1500, 1500);

    expect(db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM invoice_items').get()?.c).toBe(2);

    db.prepare('DELETE FROM invoices WHERE id = ?').run('inv-1');

    expect(db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM invoice_items').get()?.c).toBe(0);
  });

  it('cascades chat_messages when the parent thread is deleted', () => {
    migrate(db);
    db.prepare('INSERT INTO chat_threads (id, created_at, updated_at) VALUES (?, ?, ?)').run(
      'thread-1',
      NOW,
      NOW,
    );
    db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('msg-1', 'thread-1', 'user', 'hello', NOW);

    db.prepare('DELETE FROM chat_threads WHERE id = ?').run('thread-1');

    expect(db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM chat_messages').get()?.c).toBe(0);
  });

  it('rejects an invoice pointing at a nonexistent client (foreign_keys = ON)', () => {
    migrate(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => seedInvoice(db, 'inv-orphan', 'no-such-client')).toThrow(/FOREIGN KEY constraint/i);
  });

  it('enforces the unique invoice number', () => {
    migrate(db);
    const clientId = seedClient(db);
    seedInvoice(db, 'inv-1', clientId);

    expect(() =>
      db
        .prepare(
          `INSERT INTO invoices
             (id, number, client_id, status, issue_date, due_date, currency, tax_rate_bps,
              subtotal_cents, tax_cents, total_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('inv-2', 'INV-inv-1', clientId, 'draft', '2026-07-01', '2026-07-31', 'USD', 0, 0, 0, 0, NOW, NOW),
    ).toThrow(/UNIQUE constraint/i);
  });

  it('leaves no floating-point columns in the money schema', () => {
    migrate(db);

    for (const table of ['invoices', 'invoice_items']) {
      const columns = db
        .prepare<[], { name: string; type: string }>(`PRAGMA table_info(${table})`)
        .all();
      for (const column of columns) {
        expect(column.type.toUpperCase()).not.toMatch(/REAL|FLOAT|DOUBLE/);
      }
    }
  });
});

describe('migrate against a file-backed database', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'invoiceapp-test-'));
    file = path.join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('turns on WAL and survives reopening', () => {
    const first = openDatabase(file);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    migrate(first);
    seedClient(first, 'persisted');
    first.close();

    const second = openDatabase(file);
    const result = migrate(second);
    expect(result.applied).toEqual([]);
    expect(
      second.prepare<[string], { id: string }>('SELECT id FROM clients WHERE id = ?').get('persisted'),
    ).toEqual({ id: 'persisted' });
    second.close();
  });
});
