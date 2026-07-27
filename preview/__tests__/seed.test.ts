/**
 * Seeding: idempotence, and the properties the demo data exists to demonstrate.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/client';
import { migrate } from '../../src/db/migrate';
import { computeTotals } from '../../src/domain/invoices/totals';
import { listItems, listInvoices } from '../../src/domain/invoices/repository';
import { summary } from '../../src/domain/reports/queries';
import { SETTINGS_KEYS } from '../../src/shared/types';
import { isEmpty, reset, seed } from '../seed';

/** A fixed "today" so the generated dates do not depend on the wall clock. */
const REFERENCE = new Date('2026-07-27T12:00:00.000Z');

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function counts(db: Db): { clients: number; invoices: number; items: number; settings: number } {
  const one = (sql: string): number =>
    db.prepare<[], { n: number }>(sql).get()?.n ?? -1;
  return {
    clients: one('SELECT COUNT(*) AS n FROM clients'),
    invoices: one('SELECT COUNT(*) AS n FROM invoices'),
    items: one('SELECT COUNT(*) AS n FROM invoice_items'),
    settings: one('SELECT COUNT(*) AS n FROM settings'),
  };
}

describe('seed', () => {
  it('is idempotent — running it twice does not double the data', () => {
    const db = freshDb();
    expect(isEmpty(db)).toBe(true);

    const first = seed(db, REFERENCE);
    expect(first.seeded).toBe(true);
    const afterFirst = counts(db);

    const second = seed(db, REFERENCE);
    expect(second.seeded).toBe(false);
    expect(counts(db)).toEqual(afterFirst);

    // A third time, for the same reason.
    seed(db, REFERENCE);
    expect(counts(db)).toEqual(afterFirst);

    db.close();
  });

  it('reset wipes the demo data so the next seed refills it', () => {
    const db = freshDb();
    seed(db, REFERENCE);
    const seeded = counts(db);

    reset(db);
    expect(counts(db)).toEqual({ clients: 0, invoices: 0, items: 0, settings: 0 });
    expect(isEmpty(db)).toBe(true);

    seed(db, REFERENCE);
    expect(counts(db)).toEqual(seeded);

    db.close();
  });

  it('produces the shape the preview is meant to show off', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    const { clients, invoices } = counts(db);
    expect(clients).toBeGreaterThanOrEqual(4);
    expect(clients).toBeLessThanOrEqual(6);
    expect(invoices).toBeGreaterThanOrEqual(10);
    expect(invoices).toBeLessThanOrEqual(15);

    const statuses = new Set(
      db
        .prepare<[], { status: string }>('SELECT DISTINCT status FROM invoices')
        .all()
        .map((row) => row.status),
    );
    expect(statuses).toEqual(new Set(['draft', 'sent', 'paid']));

    // At least two genuinely overdue: sent, with a due date already past.
    const asOf = REFERENCE.toISOString().slice(0, 10);
    const overdue = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM invoices WHERE status = 'sent' AND due_date < ?",
      )
      .get(asOf);
    expect(overdue?.n ?? 0).toBeGreaterThanOrEqual(2);
    expect(summary(db, {}, asOf).overdueCents).toBeGreaterThan(0);

    // Issue dates spread over roughly eight months, so the charts have shape.
    const span = db
      .prepare<[], { first: string; last: string }>(
        'SELECT MIN(issue_date) AS first, MAX(issue_date) AS last FROM invoices',
      )
      .get();
    const months =
      (new Date(`${span?.last}T00:00:00Z`).getTime() -
        new Date(`${span?.first}T00:00:00Z`).getTime()) /
      (86_400_000 * 30.44);
    expect(months).toBeGreaterThan(7);

    // Every invoice has several line items.
    const minItems = db
      .prepare<[], { n: number }>(
        'SELECT MIN(c) AS n FROM (SELECT COUNT(*) AS c FROM invoice_items GROUP BY invoice_id)',
      )
      .get();
    expect(minItems?.n ?? 0).toBeGreaterThanOrEqual(2);

    // The awkward money the seed exists to exercise.
    const fractional = db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM invoice_items WHERE quantity_milli % 1000 != 0',
      )
      .get();
    expect(fractional?.n ?? 0).toBeGreaterThan(0);

    const nineteenNinetyNine = db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM invoice_items WHERE unit_price_cents = 1999',
      )
      .get();
    expect(nineteenNinetyNine?.n ?? 0).toBeGreaterThan(0);

    expect(
      db
        .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
        .get(SETTINGS_KEYS.defaultTaxRateBps)?.value,
    ).toBe('825');
    expect(
      db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE tax_rate_bps = 825')
        .get()?.n ?? 0,
    ).toBeGreaterThan(0);

    // Business settings are filled in, not blank.
    for (const key of [SETTINGS_KEYS.businessName, SETTINGS_KEYS.businessAddress]) {
      const value = db
        .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
        .get(key)?.value;
      expect(value, key).toBeTruthy();
    }

    db.close();
  });

  it('stores totals the real domain arithmetic produces, not hand-written ones', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    const { items: rows } = listInvoices(db, { limit: 500, offset: 0 });
    expect(rows.length).toBeGreaterThan(0);

    for (const invoice of rows) {
      const lineItems = listItems(db, invoice.id);
      const expected = computeTotals(lineItems, invoice.taxRateBps);
      expect({
        subtotalCents: invoice.subtotalCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
      }).toEqual({
        subtotalCents: expected.subtotalCents,
        taxCents: expected.taxCents,
        totalCents: expected.totalCents,
      });
    }

    db.close();
  });
});
