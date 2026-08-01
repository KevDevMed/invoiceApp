import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  buildListRows,
  footerSummary,
  issuedLabel,
  monogram,
  sortRows,
  statusPhrase,
  toneOf,
} from '../listRows';
import type { SortKey } from '../listRows';

const TODAY = '2026-07-29';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-06-11',
    dueDate: '2026-06-25',
    currency: 'USD',
    taxRateBps: 0,
    notes: null,
    subtotalCents: 100_000,
    taxCents: 0,
    totalCents: 100_000,
    paidAt: null,
    createdAt: '2026-05-26T09:00:00.000Z',
    updatedAt: '2026-05-26T09:00:00.000Z',
    ...overrides,
  };
}

const NAMES = new Map([
  ['c1', 'Halloway & Finch LLP'],
  ['c2', 'Northwind'],
]);

describe('monogram', () => {
  it('takes one letter from each of the first two words', () => {
    expect(monogram('Halloway & Finch LLP')).toBe('H&');
    expect(monogram('Northwind Analytics')).toBe('NA');
  });

  it('takes two letters from a single-word name', () => {
    expect(monogram('Acme')).toBe('AC');
    expect(monogram('Northwind')).toBe('NO');
  });

  it('handles a one-character name', () => {
    expect(monogram('X')).toBe('X');
  });

  it('ignores surrounding and repeated whitespace', () => {
    expect(monogram('   Northwind   Analytics  ')).toBe('NA');
  });

  it('gives a placeholder rather than an empty box', () => {
    expect(monogram('')).toBe('?');
    expect(monogram('   ')).toBe('?');
  });

  it('passes caseless scripts through instead of mangling them', () => {
    // CJK has no case; two code points, not two UTF-16 units.
    expect(monogram('北京科技')).toBe('北京');
    expect(monogram('東京 商事')).toBe('東商');
    expect(monogram('Пекин Тех')).toBe('ПТ');
  });

  it('splits on code points, so an astral character is one initial', () => {
    expect(monogram('𝕏 Corp')).toBe('𝕏C');
    expect(Array.from(monogram('𝕏Corp'))).toHaveLength(2);
  });
});

describe('toneOf', () => {
  it('maps each state onto one of the four tones the design paints', () => {
    expect(toneOf('overdue')).toBe('error');
    expect(toneOf('due-soon')).toBe('accent');
    expect(toneOf('paid')).toBe('success');
    expect(toneOf('later')).toBe('neutral');
    expect(toneOf('draft')).toBe('neutral');
    expect(toneOf('void')).toBe('neutral');
  });
});

describe('statusPhrase', () => {
  it('says how late an overdue invoice is, and on which day it was due', () => {
    const invoice = makeInvoice({ dueDate: '2026-07-11' });
    expect(statusPhrase(invoice, 'overdue', TODAY)).toEqual({
      label: 'Overdue 18 days',
      date: '11 Jul',
    });
  });

  it('uses the singular for a single day late', () => {
    const invoice = makeInvoice({ dueDate: '2026-07-28' });
    expect(statusPhrase(invoice, 'overdue', TODAY).label).toBe('Overdue 1 day');
  });

  it('never invents a negative day count for a flagged-but-unexpired invoice', () => {
    const invoice = makeInvoice({ status: 'overdue', dueDate: '2026-12-01' });
    expect(statusPhrase(invoice, 'overdue', TODAY).label).toBe('Marked overdue');
  });

  it('counts down to a due date', () => {
    expect(statusPhrase(makeInvoice({ dueDate: '2026-08-02' }), 'due-soon', TODAY)).toEqual({
      label: 'Due in 4 days',
      date: '2 Aug',
    });
  });

  it('says today and tomorrow rather than 0 and 1 days', () => {
    expect(statusPhrase(makeInvoice({ dueDate: TODAY }), 'due-soon', TODAY).label).toBe(
      'Due today',
    );
    expect(
      statusPhrase(makeInvoice({ dueDate: '2026-07-30' }), 'due-soon', TODAY).label,
    ).toBe('Due tomorrow');
  });

  it('gives a far-off invoice its date and no second copy of it', () => {
    expect(statusPhrase(makeInvoice({ dueDate: '2026-09-30' }), 'later', TODAY)).toEqual({
      label: 'Due 30 Sep',
      date: null,
    });
  });

  it('says a draft was never sent', () => {
    expect(statusPhrase(makeInvoice({ status: 'draft' }), 'draft', TODAY)).toEqual({
      label: 'Draft · not sent',
      date: null,
    });
  });

  it('says when an invoice was paid', () => {
    const invoice = makeInvoice({ status: 'paid', paidAt: '2026-07-24T22:00:00.000Z' });
    expect(statusPhrase(invoice, 'paid', TODAY)).toEqual({ label: 'Paid 24 Jul', date: null });
  });

  it('falls back to a bare Paid when the timestamp is missing', () => {
    const invoice = makeInvoice({ status: 'paid', paidAt: null });
    expect(statusPhrase(invoice, 'paid', TODAY).label).toBe('Paid');
  });

  it('says when an invoice was voided', () => {
    const invoice = makeInvoice({ status: 'void', updatedAt: '2026-07-02T09:00:00.000Z' });
    expect(statusPhrase(invoice, 'void', TODAY).label).toBe('Void 2 Jul');
  });
});

describe('issuedLabel', () => {
  it('always carries the year — an issue date is a fact, not a countdown', () => {
    expect(issuedLabel('2026-06-11')).toBe('11 Jun 2026');
    expect(issuedLabel('2025-01-04')).toBe('4 Jan 2025');
  });
});

describe('buildListRows', () => {
  it('builds one flat row per invoice, in input order', () => {
    const rows = buildListRows({
      invoices: [makeInvoice({ id: 'a' }), makeInvoice({ id: 'b', clientId: 'c2' })],
      clientNames: NAMES,
      today: TODAY,
    });
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(rows.map((row) => row.clientName)).toEqual(['Halloway & Finch LLP', 'Northwind']);
    expect(rows.map((row) => row.monogram)).toEqual(['H&', 'NO']);
  });

  it('handles the empty list', () => {
    expect(buildListRows({ invoices: [], clientNames: NAMES, today: TODAY })).toEqual([]);
  });

  it('falls back to the client id when the name has not loaded', () => {
    const rows = buildListRows({
      invoices: [makeInvoice({ clientId: 'unknown' })],
      clientNames: new Map(),
      today: TODAY,
    });
    expect(rows[0]?.clientName).toBe('unknown');
  });

  it('shows each invoice in its own currency — there is no exchange rate', () => {
    const rows = buildListRows({
      invoices: [
        makeInvoice({ id: 'a', currency: 'USD', totalCents: 5_021_490 }),
        makeInvoice({ id: 'b', currency: 'GBP', totalCents: 3_889_231 }),
      ],
      clientNames: NAMES,
      today: TODAY,
    });
    expect(rows[0]?.amount).toBe('$50,214.90');
    expect(rows[1]?.amount).toBe('£38,892.31');
  });

  it('hollows the dot for a draft only', () => {
    const rows = buildListRows({
      invoices: [makeInvoice({ id: 'a', status: 'draft' }), makeInvoice({ id: 'b' })],
      clientNames: NAMES,
      today: TODAY,
    });
    expect(rows.map((row) => row.isDotHollow)).toEqual([true, false]);
  });

  it('dims money that is not in play', () => {
    const rows = buildListRows({
      invoices: [
        makeInvoice({ id: 'paid', status: 'paid' }),
        makeInvoice({ id: 'void', status: 'void' }),
        makeInvoice({ id: 'draft', status: 'draft' }),
        makeInvoice({ id: 'overdue' }),
      ],
      clientNames: NAMES,
      today: TODAY,
    });
    expect(rows.map((row) => row.isMuted)).toEqual([true, true, true, false]);
  });
});

describe('sortRows', () => {
  const rows = buildListRows({
    invoices: [
      makeInvoice({ id: 'a', number: 'INV-0003', clientId: 'c2', dueDate: '2026-09-01', issueDate: '2026-08-01', totalCents: 500 }),
      makeInvoice({ id: 'b', number: 'INV-0001', clientId: 'c1', dueDate: '2026-06-25', issueDate: '2026-05-01', totalCents: 900 }),
      makeInvoice({ id: 'c', number: 'INV-0002', clientId: 'c1', dueDate: '2026-06-25', issueDate: '2026-07-01', totalCents: 700 }),
    ],
    clientNames: NAMES,
    today: TODAY,
  });

  it('defaults to due date ascending — the order the work happens in', () => {
    expect(DEFAULT_SORT).toBe('due-asc');
    expect(sortRows(rows, 'due-asc').map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on the invoice number so the order never shifts under the cursor', () => {
    // `b` and `c` share a due date; INV-0001 sorts before INV-0002 either way.
    expect(sortRows(rows, 'due-asc').slice(0, 2).map((row) => row.id)).toEqual(['b', 'c']);
    expect(sortRows(rows, 'due-desc').slice(1).map((row) => row.id)).toEqual(['b', 'c']);
  });

  it('sorts the other three ways', () => {
    expect(sortRows(rows, 'due-desc').map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 'total-desc').map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 'client-asc').map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 'issued-desc').map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate its input', () => {
    const before = rows.map((row) => row.id);
    sortRows(rows, 'total-desc');
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it('offers a label for every sort key it accepts', () => {
    const keys = SORT_OPTIONS.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(footerSummary(1, 1, 25, key)).toMatch(/^Showing 1 of 1 · sorted by .+/);
    }
  });

  it('handles a single row and an empty list', () => {
    expect(sortRows([], 'due-asc')).toEqual([]);
    expect(sortRows(rows.slice(0, 1), 'client-asc').map((row) => row.id)).toEqual(['a']);
  });
});

describe('sortRows — the default sinks settled invoices', () => {
  // Today is 2026-07-29. The settled pair is *older* than everything else, so
  // a pure due-date ascending sort would open the screen on collected money.
  const mixed = buildListRows({
    invoices: [
      makeInvoice({
        id: 'paid-2024',
        number: 'INV-0001',
        status: 'paid',
        dueDate: '2024-01-05',
        paidAt: '2024-01-04T09:00:00.000Z',
      }),
      makeInvoice({ id: 'void-2024', number: 'INV-0002', status: 'void', dueDate: '2024-02-05' }),
      makeInvoice({
        id: 'paid-2025',
        number: 'INV-0003',
        status: 'paid',
        dueDate: '2025-03-05',
        paidAt: '2025-03-04T09:00:00.000Z',
      }),
      makeInvoice({ id: 'overdue', number: 'INV-0004', status: 'sent', dueDate: '2026-05-20' }),
      makeInvoice({ id: 'overdue-2', number: 'INV-0005', status: 'sent', dueDate: '2026-07-01' }),
      makeInvoice({ id: 'due-soon', number: 'INV-0006', status: 'sent', dueDate: '2026-08-02' }),
      makeInvoice({ id: 'draft', number: 'INV-0007', status: 'draft', dueDate: '2026-08-20' }),
      makeInvoice({ id: 'later', number: 'INV-0008', status: 'sent', dueDate: '2026-12-01' }),
    ],
    clientNames: NAMES,
    today: TODAY,
  });

  const order = (key: SortKey): string[] => sortRows(mixed, key).map((row) => row.id);

  it('sorts a paid invoice below an overdue one even though it is far older', () => {
    const ids = order('due-asc');
    expect(ids.indexOf('overdue')).toBeLessThan(ids.indexOf('paid-2024'));
    expect(ids[0]).toBe('overdue');
  });

  it('puts a void invoice in the settled block, not the unsettled one', () => {
    const ids = order('due-asc');
    expect(ids.indexOf('void-2024')).toBeGreaterThan(ids.indexOf('later'));
  });

  it('keeps drafts in the unsettled block — unsent work is still in play', () => {
    const ids = order('due-asc');
    expect(ids.indexOf('draft')).toBeLessThan(ids.indexOf('paid-2024'));
  });

  it('still runs due date ascending inside the unsettled block', () => {
    expect(order('due-asc').slice(0, 5)).toEqual([
      'overdue',
      'overdue-2',
      'due-soon',
      'draft',
      'later',
    ]);
  });

  it('still runs due date ascending inside the settled block', () => {
    expect(order('due-asc').slice(5)).toEqual(['paid-2024', 'void-2024', 'paid-2025']);
  });

  it('leaves an explicitly chosen sort literal — settled rows are not sunk', () => {
    // Largest first: every invoice is 100_000 cents, so the tie-break on the
    // number decides, and the settled rows keep their natural places.
    expect(order('total-desc')).toEqual([
      'paid-2024',
      'void-2024',
      'paid-2025',
      'overdue',
      'overdue-2',
      'due-soon',
      'draft',
      'later',
    ]);
    // Newest issued: same issue date throughout, so again the number decides.
    expect(order('issued-desc')[0]).toBe('paid-2024');
    // And due date descending is a choice too, so it stays literal.
    expect(order('due-desc')[0]).toBe('later');
    expect(order('due-desc').at(-1)).toBe('paid-2024');
  });

  it('orders an all-settled list by due date rather than emptying or reversing it', () => {
    const settled = mixed.filter((row) => row.state === 'paid' || row.state === 'void');
    expect(sortRows(settled, 'due-asc').map((row) => row.id)).toEqual([
      'paid-2024',
      'void-2024',
      'paid-2025',
    ]);
  });
});

describe('footerSummary', () => {
  it('reads as the design has it', () => {
    expect(footerSummary(66, 1, 10, 'due-asc')).toBe(
      'Showing 1-10 of 66 · sorted by due date · open first',
    );
  });

  it('clamps a page past the end rather than printing an impossible range', () => {
    expect(footerSummary(66, 99, 10, 'due-asc')).toBe(
      'Showing 61-66 of 66 · sorted by due date · open first',
    );
  });

  it('says so when nothing matches', () => {
    expect(footerSummary(0, 1, 25, 'due-asc')).toBe('Showing 0 of 0 · sorted by due date · open first');
  });

  it('names each order in words', () => {
    const sentences: Record<SortKey, string> = {
      'due-asc': 'due date · open first',
      'due-desc': 'due date, latest first',
      'total-desc': 'total, largest first',
      'client-asc': 'client',
      'issued-desc': 'issue date, newest first',
    };
    for (const [key, sentence] of Object.entries(sentences)) {
      expect(footerSummary(5, 1, 25, key as SortKey)).toBe(
        `Showing 1-5 of 5 · sorted by ${sentence}`,
      );
    }
  });
});
