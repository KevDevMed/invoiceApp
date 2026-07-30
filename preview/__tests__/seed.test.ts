/**
 * Seeding: idempotence, determinism, and the properties the demo data exists to
 * demonstrate — enough rows to page through, enough variety for every inline
 * filter field to have matching and non-matching rows.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/client';
import { migrate } from '../../src/db/migrate';
import { computeTotals } from '../../src/domain/invoices/totals';
import { listItems, listInvoices } from '../../src/domain/invoices/repository';
import { summary } from '../../src/domain/reports/queries';
import { SETTINGS_KEYS } from '../../src/shared/types';
import { isEmpty, reset, seed, stampsFor } from '../seed';

/** A fixed "today" so the generated dates do not depend on the wall clock. */
const REFERENCE = new Date('2026-07-27T12:00:00.000Z');
const REFERENCE_DAY = REFERENCE.toISOString().slice(0, 10);
const MS_PER_DAY = 86_400_000;

/** Whole days between a stored calendar day and the reference date. */
function daysBefore(day: string): number {
  return Math.round((Date.parse(`${REFERENCE_DAY}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / MS_PER_DAY);
}

interface StampRow {
  readonly number: string;
  readonly status: string;
  readonly issueDate: string;
  readonly created: string;
  readonly updated: string;
  readonly paid: string | null;
}

/**
 * The three timestamps as calendar days. Sliced in SQL rather than parsed,
 * because `calendarDateOf` in the renderer is a `slice(0, 10)` too — comparing
 * anything else would be comparing something the list never shows.
 */
function stampRows(db: Db): StampRow[] {
  return db
    .prepare<[], StampRow>(
      `SELECT number, status, issue_date AS issueDate, substr(created_at, 1, 10) AS created,
              substr(updated_at, 1, 10) AS updated, substr(paid_at, 1, 10) AS paid
         FROM invoices ORDER BY number`,
    )
    .all()
    .map((row) => ({ ...row, paid: row.paid ?? null }));
}

/** What the seed is contracted to produce. Change these when the seed changes. */
const EXPECTED_CLIENTS = 10;
const EXPECTED_INVOICES = 66;
const EXPECTED_STATUS_COUNTS: Readonly<Record<string, number>> = {
  paid: 32,
  sent: 16,
  draft: 10,
  overdue: 4,
  void: 4,
};

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

/**
 * Everything about the seeded data except the one value that is allowed to
 * differ between two runs: the row id. The timestamps are in here on purpose —
 * they are derived from the reference date now, not from the wall clock, and a
 * seed that went back to stamping them with `new Date()` has to fail a test
 * rather than quietly make every draft say it was edited today.
 */
interface Fingerprint {
  readonly clients: readonly string[];
  readonly invoices: ReadonlyArray<Record<string, unknown>>;
  readonly items: ReadonlyArray<Record<string, unknown>>;
}

function fingerprint(db: Db): Fingerprint {
  return {
    clients: db
      .prepare<[], { name: string; email: string | null }>(
        'SELECT name, email FROM clients ORDER BY name',
      )
      .all()
      .map((row) => `${row.name}|${row.email ?? ''}`),
    invoices: db
      .prepare<[], Record<string, unknown>>(
        `SELECT i.number, c.name AS client, i.status, i.issue_date, i.due_date, i.currency,
                i.tax_rate_bps, i.subtotal_cents, i.tax_cents, i.total_cents,
                i.created_at, i.updated_at, i.paid_at
         FROM invoices i JOIN clients c ON c.id = i.client_id
         ORDER BY i.number`,
      )
      .all(),
    items: db
      .prepare<[], Record<string, unknown>>(
        `SELECT i.number, it.position, it.description, it.quantity_milli,
                it.unit_price_cents, it.amount_cents
         FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
         ORDER BY i.number, it.position`,
      )
      .all(),
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

  it('is deterministic — two fresh databases get byte-identical demo data', () => {
    const first = freshDb();
    const second = freshDb();
    seed(first, REFERENCE);
    seed(second, REFERENCE);

    const left = fingerprint(first);
    const right = fingerprint(second);
    expect(left.invoices).toHaveLength(EXPECTED_INVOICES);
    expect(left).toEqual(right);

    first.close();
    second.close();
  });

  it('reset wipes the demo data so the next seed refills it', () => {
    const db = freshDb();
    seed(db, REFERENCE);
    const seeded = counts(db);
    const before = fingerprint(db);

    reset(db);
    expect(counts(db)).toEqual({ clients: 0, invoices: 0, items: 0, settings: 0 });
    expect(isEmpty(db)).toBe(true);

    seed(db, REFERENCE);
    expect(counts(db)).toEqual(seeded);
    expect(fingerprint(db)).toEqual(before);

    db.close();
  });

  it('seeds exactly the advertised number of clients and invoices', () => {
    const db = freshDb();
    const result = seed(db, REFERENCE);

    expect(result).toEqual({
      seeded: true,
      clients: EXPECTED_CLIENTS,
      invoices: EXPECTED_INVOICES,
    });
    const { clients, invoices } = counts(db);
    expect(clients).toBe(EXPECTED_CLIENTS);
    expect(invoices).toBe(EXPECTED_INVOICES);

    // Seven pages at the default page size of ten — pagination is provable.
    expect(Math.ceil(invoices / 10)).toBe(7);

    db.close();
  });

  it('allocates a unique invoice number to every invoice', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    const numbers = db
      .prepare<[], { number: string }>('SELECT number FROM invoices')
      .all()
      .map((row) => row.number);
    expect(numbers).toHaveLength(EXPECTED_INVOICES);
    expect(new Set(numbers).size).toBe(EXPECTED_INVOICES);
    expect(numbers.every((number) => /^INV-\d{4}$/.test(number))).toBe(true);

    db.close();
  });

  it('spreads statuses exactly as the filter tests expect', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    const byStatus = Object.fromEntries(
      db
        .prepare<[], { status: string; n: number }>(
          'SELECT status, COUNT(*) AS n FROM invoices GROUP BY status',
        )
        .all()
        .map((row) => [row.status, row.n]),
    );
    expect(byStatus).toEqual(EXPECTED_STATUS_COUNTS);

    // One status has to be narrow enough that filtering by it shrinks a page of
    // ten, and one has to be wide enough that filtering by it still paginates.
    expect(EXPECTED_STATUS_COUNTS.void).toBeLessThan(10);
    expect(EXPECTED_STATUS_COUNTS.paid).toBeGreaterThan(10);

    db.close();
  });

  it('gives every filter field both matching and non-matching rows', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    // Client: every client is invoiced, and no client holds the whole list.
    const perClient = db
      .prepare<[], { name: string; n: number }>(
        `SELECT c.name, COUNT(i.id) AS n FROM clients c
         LEFT JOIN invoices i ON i.client_id = c.id GROUP BY c.id ORDER BY n`,
      )
      .all();
    expect(perClient).toHaveLength(EXPECTED_CLIENTS);
    expect(perClient[0]?.n ?? 0).toBeGreaterThan(0);
    expect(perClient.at(-1)?.n ?? 0).toBeLessThan(EXPECTED_INVOICES / 2);

    // Currency: several, each with enough rows to be worth filtering by.
    const currencies = db
      .prepare<[], { currency: string; n: number }>(
        'SELECT currency, COUNT(*) AS n FROM invoices GROUP BY currency ORDER BY n DESC',
      )
      .all();
    expect(currencies.length).toBeGreaterThanOrEqual(3);
    expect(currencies.every((row) => row.n >= 5)).toBe(true);

    // Amount: a wide enough range that a threshold token splits the list.
    const amounts = db
      .prepare<[], { lo: number; hi: number; mid: number }>(
        `SELECT MIN(total_cents) AS lo, MAX(total_cents) AS hi,
                COUNT(CASE WHEN total_cents >= 2000000 THEN 1 END) AS mid FROM invoices`,
      )
      .get();
    expect(amounts?.lo ?? 0).toBeLessThan(100_000); // something under $1,000
    expect(amounts?.hi ?? 0).toBeGreaterThan(2_000_000); // something over $20,000
    expect(amounts?.mid ?? 0).toBeGreaterThan(0);
    expect(amounts?.mid ?? 0).toBeLessThan(EXPECTED_INVOICES);

    // Issue date: spread over more than a year of months, so a date range and
    // the revenue chart both have something to work with.
    const months = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(DISTINCT strftime('%Y-%m', issue_date)) AS n FROM invoices",
      )
      .get();
    expect(months?.n ?? 0).toBeGreaterThanOrEqual(12);

    db.close();
  });

  it('produces the shape the preview is meant to show off', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    // At least two genuinely overdue: sent, with a due date already past.
    const asOf = REFERENCE.toISOString().slice(0, 10);
    const overdue = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM invoices WHERE status = 'sent' AND due_date < ?",
      )
      .get(asOf);
    expect(overdue?.n ?? 0).toBeGreaterThanOrEqual(2);
    expect(summary(db, {}, asOf).overdueCents).toBeGreaterThan(0);

    // …and some sent invoices that are not yet due, so "sent" is not a synonym
    // for "late" on the list screen.
    const current = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM invoices WHERE status = 'sent' AND due_date >= ?",
      )
      .get(asOf);
    expect(current?.n ?? 0).toBeGreaterThan(0);

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
    // Reverse-charge customers are invoiced at 0%.
    expect(
      db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE tax_rate_bps = 0')
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

  it('stamps every row from its own dates, and keeps the three of them coherent', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    for (const row of stampRows(db)) {
      // Raised on the day it was issued.
      expect(row.created, row.number).toBe(row.issueDate);
      // Nothing moved before it existed, and nothing moved in the future.
      expect(row.updated >= row.created, `${row.number} updated`).toBe(true);
      expect(row.updated <= REFERENCE_DAY, `${row.number} updated`).toBe(true);

      if (row.status !== 'paid') {
        expect(row.paid, row.number).toBeNull();
        continue;
      }
      expect(row.paid, row.number).not.toBeNull();
      expect(row.paid! >= row.issueDate, `${row.number} paid`).toBe(true);
      expect(row.paid! <= REFERENCE_DAY, `${row.number} paid`).toBe(true);
      // Payment is the last thing that happens to a paid invoice.
      expect(row.updated, row.number).toBe(row.paid);
    }

    db.close();
  });

  it('spreads the timings each group prints, instead of repeating one date', () => {
    const db = freshDb();
    seed(db, REFERENCE);
    const rows = stampRows(db);

    /*
      The list's second line is a relative time — `edited 25 Jul`, `paid 24 Jul`
      — so the fixture is only worth screenshotting if those differ down a
      group. A seed that stamped `updated_at` at seed time would print the same
      sentence on all ten drafts, which is the regression this guards.
    */
    const drafts = rows.filter((row) => row.status === 'draft').map((row) => daysBefore(row.updated));
    expect(drafts).toHaveLength(EXPECTED_STATUS_COUNTS.draft ?? 0);
    expect(new Set(drafts).size).toBe(drafts.length);
    expect(Math.min(...drafts)).toBeLessThanOrEqual(1); // one edited today or yesterday
    expect(Math.max(...drafts)).toBeGreaterThanOrEqual(120); // and one gone stale

    const paid = rows
      .filter((row) => row.status === 'paid')
      .map((row) => daysBefore(row.paid ?? row.updated));
    expect(paid).toHaveLength(EXPECTED_STATUS_COUNTS.paid ?? 0);
    expect(new Set(paid).size).toBeGreaterThanOrEqual(paid.length - 4);
    expect(Math.min(...paid)).toBeLessThanOrEqual(7); // settled this week
    expect(Math.max(...paid)).toBeGreaterThanOrEqual(200); // and settled last year

    const voided = rows.filter((row) => row.status === 'void').map((row) => daysBefore(row.updated));
    expect(new Set(voided).size).toBe(voided.length);

    db.close();
  });

  it('stampsFor clamps a wish that would land before issue or after today', () => {
    const base = { client: 0, netDays: 30, items: [] } as const;

    // Paid on terms the invoice is not old enough for: paid early, today, not
    // in the future.
    const early = stampsFor({ ...base, status: 'paid', issuedDaysAgo: 4 }, REFERENCE);
    expect(early.paidAt?.slice(0, 10)).toBe(REFERENCE_DAY);
    expect(early.updatedAt).toBe(early.paidAt);

    // Paid on terms, the ordinary case.
    const onTerms = stampsFor(
      { ...base, status: 'paid', issuedDaysAgo: 100, paidAfterDays: 37 },
      REFERENCE,
    );
    expect(daysBefore(onTerms.paidAt?.slice(0, 10) ?? '')).toBe(63);

    // Edited longer ago than the invoice has existed: edited on the day it was
    // raised, never before it.
    const draft = stampsFor(
      { ...base, status: 'draft', issuedDaysAgo: 6, editedDaysAgo: 40 },
      REFERENCE,
    );
    expect(draft.updatedAt.slice(0, 10)).toBe(draft.createdAt.slice(0, 10));
    expect(draft.paidAt).toBeNull();

    // A state whose row prints a due date keeps the day it was raised.
    const sent = stampsFor({ ...base, status: 'sent', issuedDaysAgo: 20 }, REFERENCE);
    expect(sent.updatedAt).toBe(sent.createdAt);
    expect(sent.paidAt).toBeNull();
  });

  it('stores totals the real domain arithmetic produces, not hand-written ones', () => {
    const db = freshDb();
    seed(db, REFERENCE);

    const { items: rows } = listInvoices(db, { limit: 500, offset: 0 });
    expect(rows).toHaveLength(EXPECTED_INVOICES);

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
