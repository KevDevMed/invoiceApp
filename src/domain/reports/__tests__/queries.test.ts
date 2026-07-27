import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { SETTINGS_KEYS } from '../../../shared/types';
import { createClient } from '../../clients/repository';
import { createInvoice } from '../../invoices/repository';
import { byClient, outstanding, revenueByPeriod, summary } from '../queries';

const AS_OF = '2026-03-01';

let db: Db;
let alphaId: string;
let betaId: string;

function seedInvoice(
  clientId: string,
  status: 'draft' | 'sent' | 'paid' | 'void',
  issueDate: string,
  dueDate: string,
  totalCents: number,
  number: string,
): void {
  // qty 1.000 at totalCents keeps persisted total == totalCents (tax 0)
  createInvoice(db, {
    clientId,
    number,
    status,
    issueDate,
    dueDate,
    taxRateBps: 0,
    items: [{ description: 'Work', quantityMilli: 1000, unitPriceCents: totalCents }],
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    SETTINGS_KEYS.defaultCurrency,
    'EUR',
  );
  alphaId = createClient(db, { name: 'Alpha Corp' }).id;
  betaId = createClient(db, { name: 'Beta LLC' }).id;

  seedInvoice(alphaId, 'paid', '2026-01-15', '2026-02-15', 10_000, 'A-1');
  seedInvoice(alphaId, 'sent', '2026-02-10', '2026-03-10', 5_000, 'A-2'); // not yet due at AS_OF
  seedInvoice(betaId, 'sent', '2026-01-20', '2026-02-01', 20_000, 'B-1'); // derived overdue
  seedInvoice(betaId, 'draft', '2026-02-20', '2026-03-20', 7_000, 'B-2');
  seedInvoice(alphaId, 'void', '2026-01-10', '2026-02-10', 99_900, 'A-VOID'); // excluded everywhere
});

describe('summary', () => {
  it('reports exact cents per status with the derived-overdue rule', () => {
    const result = summary(db, {}, AS_OF);
    expect(result).toEqual({
      currency: 'EUR',
      invoiceCount: 4, // void excluded
      draftCents: 7_000,
      sentCents: 5_000, // sent, due 2026-03-10 >= AS_OF
      paidCents: 10_000,
      overdueCents: 20_000, // status 'sent' but due 2026-02-01 < AS_OF
      outstandingCents: 25_000,
    });
  });

  it('applies the issue-date range filter', () => {
    const result = summary(db, { from: '2026-02-01' }, AS_OF);
    expect(result.invoiceCount).toBe(2);
    expect(result.draftCents).toBe(7_000);
    expect(result.sentCents).toBe(5_000);
    expect(result.paidCents).toBe(0);
    expect(result.overdueCents).toBe(0);
  });
});

describe('revenueByPeriod', () => {
  it('groups by month with invoiced and paid cents per bucket', () => {
    const result = revenueByPeriod(db, 'month');
    expect(result.currency).toBe('EUR');
    expect(result.period).toBe('month');
    expect(result.buckets).toEqual([
      { bucket: '2026-01-01', invoiceCount: 2, totalCents: 30_000, paidCents: 10_000 },
      { bucket: '2026-02-01', invoiceCount: 2, totalCents: 12_000, paidCents: 0 },
    ]);
  });

  it('groups by ISO week (Monday start) for short ranges', () => {
    const result = revenueByPeriod(db, 'week', { from: '2026-01-01', to: '2026-01-31' });
    // 2026-01-15 is a Thursday -> week of Mon 2026-01-12
    // 2026-01-20 is a Tuesday  -> week of Mon 2026-01-19
    expect(result.buckets).toEqual([
      { bucket: '2026-01-12', invoiceCount: 1, totalCents: 10_000, paidCents: 10_000 },
      { bucket: '2026-01-19', invoiceCount: 1, totalCents: 20_000, paidCents: 0 },
    ]);
  });
});

describe('byClient', () => {
  it('ranks clients by invoiced total with exact paid/outstanding cents', () => {
    const result = byClient(db);
    expect(result.currency).toBe('EUR');
    expect(result.rows).toEqual([
      {
        clientId: betaId,
        clientName: 'Beta LLC',
        invoiceCount: 2,
        totalCents: 27_000,
        paidCents: 0,
        outstandingCents: 20_000, // draft is not outstanding
      },
      {
        clientId: alphaId,
        clientName: 'Alpha Corp',
        invoiceCount: 2,
        totalCents: 15_000,
        paidCents: 10_000,
        outstandingCents: 5_000,
      },
    ]);
  });

  it('honours the limit', () => {
    expect(byClient(db, {}, 1).rows.map((r) => r.clientName)).toEqual(['Beta LLC']);
  });
});

describe('outstanding', () => {
  it('lists unpaid invoices worst-overdue first without mutating rows', () => {
    const result = outstanding(db, AS_OF);
    expect(result.asOf).toBe(AS_OF);
    expect(result.totalOutstandingCents).toBe(25_000);
    expect(result.rows).toEqual([
      {
        invoiceId: expect.any(String),
        number: 'B-1',
        clientId: betaId,
        clientName: 'Beta LLC',
        dueDate: '2026-02-01',
        daysOverdue: 28, // 2026-02-01 -> 2026-03-01
        totalCents: 20_000,
      },
      {
        invoiceId: expect.any(String),
        number: 'A-2',
        clientId: alphaId,
        clientName: 'Alpha Corp',
        dueDate: '2026-03-10',
        daysOverdue: 0, // due in the future, clamped to zero
        totalCents: 5_000,
      },
    ]);

    // derived, not stored: the overdue invoice's row still says 'sent'
    const stored = db
      .prepare<[string], { status: string }>('SELECT status FROM invoices WHERE number = ?')
      .get('B-1');
    expect(stored?.status).toBe('sent');
  });
});
