import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { SETTINGS_KEYS } from '../../../shared/types';
import { createClient } from '../../clients/repository';
import { InvalidLineItemError } from '../../money-lines';
import {
  DuplicateInvoiceNumberError,
  InvoiceNotFoundError,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
} from '../repository';
import { computeTotals } from '../totals';

let db: Db;
let clientId: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  clientId = createClient(db, { name: 'Fixture Client', email: 'fixture@example.com' }).id;
});

const ITEMS = [
  { description: 'Design', quantityMilli: 2500, unitPriceCents: 12000 }, // 2.5 * 120.00
  { description: 'Development', quantityMilli: 10_000, unitPriceCents: 9500 },
];

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return createInvoice(db, {
    clientId,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    taxRateBps: 875,
    items: ITEMS,
    ...overrides,
  });
}

describe('createInvoice', () => {
  it('round-trips exactly, with items in order and the joined client', () => {
    const created = makeInvoice({ notes: 'Thanks!' });
    const fetched = getInvoice(db, created.id);
    expect(fetched).toEqual(created);
    expect(fetched?.items.map((i) => i.description)).toEqual(['Design', 'Development']);
    expect(fetched?.items.map((i) => i.position)).toEqual([0, 1]);
    expect(fetched?.client?.name).toBe('Fixture Client');
    expect(fetched?.status).toBe('draft');
    expect(fetched?.notes).toBe('Thanks!');
  });

  it('persists totals equal to the recomputed totals', () => {
    const created = makeInvoice();
    const expected = computeTotals(ITEMS, 875);
    expect(created.subtotalCents).toBe(expected.subtotalCents); // 30000 + 95000
    expect(created.subtotalCents).toBe(125_000);
    expect(created.taxCents).toBe(expected.taxCents); // 125000 * 875 / 10000 = 10937.5 -> 10938
    expect(created.taxCents).toBe(10_938);
    expect(created.totalCents).toBe(135_938);
    expect(created.items.map((i) => i.amountCents)).toEqual([...expected.lineAmountsCents]);
  });

  it('allocates sequential numbers and applies settings defaults', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SETTINGS_KEYS.defaultCurrency,
      'EUR',
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      SETTINGS_KEYS.defaultTaxRateBps,
      '700',
    );
    const first = createInvoice(db, {
      clientId,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      items: [{ description: 'A', quantityMilli: 1000, unitPriceCents: 1000 }],
    });
    const second = makeInvoice();
    expect(first.number).toBe('INV-0001');
    expect(second.number).toBe('INV-0002');
    expect(first.currency).toBe('EUR');
    expect(first.taxRateBps).toBe(700);
    expect(first.taxCents).toBe(70);
  });

  it('rejects a caller-supplied duplicate number with the typed error', () => {
    makeInvoice({ number: 'INV-0042' });
    expect(() => makeInvoice({ number: 'INV-0042' })).toThrow(DuplicateInvoiceNumberError);
  });
});

describe('updateInvoice', () => {
  it('replaces the item set atomically and re-persists recomputed totals', () => {
    const created = makeInvoice();
    const updated = updateInvoice(db, created.id, {
      items: [{ description: 'Flat fee', quantityMilli: 1000, unitPriceCents: 50_000 }],
      taxRateBps: 0,
    });
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.description).toBe('Flat fee');
    expect(updated.subtotalCents).toBe(50_000);
    expect(updated.taxCents).toBe(0);
    expect(updated.totalCents).toBe(50_000);
    // no orphaned rows from the old set
    const rows = db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?',
      )
      .get(created.id);
    expect(rows?.n).toBe(1);
  });

  it('rolls the whole update back when a later item is invalid', () => {
    const created = makeInvoice();
    expect(() =>
      updateInvoice(db, created.id, {
        items: [
          { description: 'Fine', quantityMilli: 1000, unitPriceCents: 100 },
          { description: 'Broken', quantityMilli: 0, unitPriceCents: 100 }, // rejected mid-insert
        ],
      }),
    ).toThrow(InvalidLineItemError);

    // the failed write left nothing behind: same items, same totals
    const after = getInvoice(db, created.id);
    expect(after?.items.map((i) => i.description)).toEqual(['Design', 'Development']);
    expect(after?.totalCents).toBe(created.totalCents);
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it('recomputes totals when only the tax rate changes', () => {
    const created = makeInvoice();
    const updated = updateInvoice(db, created.id, { taxRateBps: 0 });
    expect(updated.subtotalCents).toBe(created.subtotalCents);
    expect(updated.taxCents).toBe(0);
    expect(updated.totalCents).toBe(created.subtotalCents);
    expect(updated.items).toHaveLength(2); // untouched item set survives
  });

  it('throws the typed error for an unknown invoice', () => {
    expect(() => updateInvoice(db, 'nope', { notes: 'x' })).toThrow(InvoiceNotFoundError);
  });
});

describe('deleteInvoice', () => {
  it('deletes and cascades the items', () => {
    const created = makeInvoice();
    expect(deleteInvoice(db, created.id)).toEqual({ id: created.id, deleted: true });
    expect(getInvoice(db, created.id)).toBeNull();
    const orphans = db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM invoice_items WHERE invoice_id = ?',
      )
      .get(created.id);
    expect(orphans?.n).toBe(0);
  });
});

describe('setInvoiceStatus', () => {
  it('stamps paid_at when marking paid and clears it on the way back', () => {
    const created = makeInvoice();
    const paid = setInvoiceStatus(db, created.id, 'paid');
    expect(paid.status).toBe('paid');
    expect(paid.paidAt).not.toBeNull();

    const reopened = setInvoiceStatus(db, created.id, 'sent');
    expect(reopened.status).toBe('sent');
    expect(reopened.paidAt).toBeNull();
  });
});

describe('listInvoices', () => {
  it('filters by status, client, date range, and search; paginates with a real total', () => {
    const other = createClient(db, { name: 'Zed Industries' }).id;
    makeInvoice({ number: 'INV-0001', status: 'sent', issueDate: '2026-01-10' });
    makeInvoice({ number: 'INV-0002', status: 'paid', issueDate: '2026-02-10' });
    createInvoice(db, {
      clientId: other,
      number: 'ZED-0001',
      status: 'sent',
      issueDate: '2026-03-05',
      dueDate: '2026-04-05',
      items: [{ description: 'X', quantityMilli: 1000, unitPriceCents: 100 }],
    });

    expect(listInvoices(db).total).toBe(3);
    expect(listInvoices(db, { status: 'sent' }).total).toBe(2);
    expect(listInvoices(db, { clientId: other }).items.map((i) => i.number)).toEqual(['ZED-0001']);
    expect(
      listInvoices(db, { issuedBetween: { from: '2026-02-01', to: '2026-02-28' } }).items.map(
        (i) => i.number,
      ),
    ).toEqual(['INV-0002']);
    // search hits invoice number and client name
    expect(listInvoices(db, { search: 'ZED-' }).total).toBe(1);
    expect(listInvoices(db, { search: 'zed indus' }).total).toBe(1);

    const page = listInvoices(db, { limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    // newest issue date first
    expect(listInvoices(db).items.map((i) => i.number)).toEqual([
      'ZED-0001',
      'INV-0002',
      'INV-0001',
    ]);
  });
});
