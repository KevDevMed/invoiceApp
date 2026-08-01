import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import {
  DEFAULT_SORT,
  SORT_LABELS,
  buildListRows,
  footerSummary,
  issuedLabel,
  monogram,
  nextSortState,
  sortRows,
  sortSentence,
  statusPhrase,
  toneOf,
} from '../listRows';
import type { SortDirection, SortState } from '../listRows';
import { COLUMNS, SORTABLE_COLUMNS } from '../listColumns';
import type { ListColumnKind, SortColumnKey } from '../listColumns';

/** Terse constructor so a test reads as `by('total', 'desc')`. */
function by(column: SortColumnKey, direction: SortDirection): SortState {
  return { column, direction };
}

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


describe('SORT_LABELS', () => {
  it('gives every column kind exactly two choices', () => {
    const kinds: readonly ListColumnKind[] = ['num', 'date', 'status', 'text'];
    for (const kind of kinds) {
      expect(SORT_LABELS[kind], kind).toHaveLength(2);
    }
  });

  it('carries the design labels verbatim, with their true directions', () => {
    expect(SORT_LABELS.num).toEqual([
      { label: 'Largest first', direction: 'desc' },
      { label: 'Smallest first', direction: 'asc' },
    ]);
    expect(SORT_LABELS.date).toEqual([
      { label: 'Newest first', direction: 'desc' },
      { label: 'Oldest first', direction: 'asc' },
    ]);
    expect(SORT_LABELS.status).toEqual([
      { label: 'Most overdue first', direction: 'asc' },
      { label: 'Furthest due first', direction: 'desc' },
    ]);
    expect(SORT_LABELS.text).toEqual([
      { label: 'A → Z', direction: 'asc' },
      { label: 'Z → A', direction: 'desc' },
    ]);
  });

  it('never assumes the first option is ascending', () => {
    // The trap the design warns about: three of the four kinds lead with a
    // direction that is not `asc`.
    expect(SORT_LABELS.num[0]?.direction).toBe('desc');
    expect(SORT_LABELS.date[0]?.direction).toBe('desc');
    expect(SORT_LABELS.status[0]?.direction).toBe('asc');
    expect(SORT_LABELS.text[0]?.direction).toBe('asc');
  });

  it('offers each direction exactly once per kind', () => {
    for (const choices of Object.values(SORT_LABELS)) {
      expect(new Set(choices.map((choice) => choice.direction)).size).toBe(2);
    }
  });
});

describe('the arrow never contradicts the label', () => {
  // The whole point of pairing a label with a direction: sorting by a label
  // whose words mean "biggest at the top" must actually put the biggest row
  // first, whichever way the arrow ends up pointing.
  const probe = buildListRows({
    invoices: [
      makeInvoice({ id: 'small', number: 'INV-0001', clientId: 'c2', dueDate: '2026-09-01', issueDate: '2026-05-01', totalCents: 100 }),
      makeInvoice({ id: 'big', number: 'INV-0002', clientId: 'c1', dueDate: '2026-06-01', issueDate: '2026-08-01', totalCents: 900 }),
    ],
    clientNames: NAMES,
    today: TODAY,
  });

  const first = (sort: SortState): string | undefined => sortRows(probe, sort)[0]?.id;

  it('puts the largest total first for "Largest first" and the smallest for "Smallest first"', () => {
    const [largest, smallest] = SORT_LABELS.num;
    expect(largest?.label).toBe('Largest first');
    expect(first(by('total', largest?.direction ?? 'asc'))).toBe('big');
    expect(first(by('total', smallest?.direction ?? 'asc'))).toBe('small');
  });

  it('puts the newest issue date first for "Newest first" and the oldest for "Oldest first"', () => {
    const [newest, oldest] = SORT_LABELS.date;
    expect(first(by('issued', newest?.direction ?? 'asc'))).toBe('big');
    expect(first(by('issued', oldest?.direction ?? 'asc'))).toBe('small');
  });

  it('puts the soonest due date first for "Most overdue first" and the latest for "Furthest due first"', () => {
    const [mostOverdue, furthest] = SORT_LABELS.status;
    expect(first(by('status', mostOverdue?.direction ?? 'asc'))).toBe('big');
    expect(first(by('status', furthest?.direction ?? 'asc'))).toBe('small');
  });

  it('runs A→Z for "A → Z" and Z→A for "Z → A"', () => {
    const [az, za] = SORT_LABELS.text;
    // 'Halloway & Finch LLP' (big) sorts before 'Northwind' (small).
    expect(first(by('client', az?.direction ?? 'asc'))).toBe('big');
    expect(first(by('client', za?.direction ?? 'asc'))).toBe('small');
  });
});

describe('nextSortState', () => {
  it('takes the column and the direction the chosen label carries', () => {
    expect(nextSortState(DEFAULT_SORT, 'total', 'desc')).toEqual(by('total', 'desc'));
    expect(nextSortState(by('total', 'desc'), 'total', 'asc')).toEqual(by('total', 'asc'));
  });

  it('returns the same object when nothing moved', () => {
    const current = by('issued', 'desc');
    expect(nextSortState(current, 'issued', 'desc')).toBe(current);
  });

  it('reaches every column and direction the column table offers', () => {
    for (const column of SORTABLE_COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(nextSortState(DEFAULT_SORT, column, direction)).toEqual(by(column, direction));
      }
    }
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

  it('defaults to STATUS & DUE ascending — the order the work happens in', () => {
    expect(DEFAULT_SORT).toEqual(by('status', 'asc'));
    expect(sortRows(rows, DEFAULT_SORT).map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on the invoice number so the order never shifts under the cursor', () => {
    // `b` and `c` share a due date; INV-0001 sorts before INV-0002 either way.
    expect(sortRows(rows, by('status', 'asc')).slice(0, 2).map((row) => row.id)).toEqual([
      'b',
      'c',
    ]);
    expect(sortRows(rows, by('status', 'desc')).slice(1).map((row) => row.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('sorts by every column, both ways', () => {
    expect(sortRows(rows, by('status', 'desc')).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, by('total', 'desc')).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, by('total', 'asc')).map((row) => row.id)).toEqual(['a', 'c', 'b']);
    expect(sortRows(rows, by('client', 'asc')).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, by('client', 'desc')).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, by('issued', 'desc')).map((row) => row.id)).toEqual(['a', 'c', 'b']);
    expect(sortRows(rows, by('issued', 'asc')).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, by('invoice', 'asc')).map((row) => row.id)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, by('invoice', 'desc')).map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate its input', () => {
    const before = rows.map((row) => row.id);
    sortRows(rows, by('total', 'desc'));
    expect(rows.map((row) => row.id)).toEqual(before);
  });

  it('names every column and direction it accepts', () => {
    for (const column of SORTABLE_COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(footerSummary(1, 1, 25, by(column, direction))).toMatch(
          /^Showing 1 of 1 · sorted by .+/,
        );
      }
    }
  });

  it('handles a single row and an empty list', () => {
    expect(sortRows([], DEFAULT_SORT)).toEqual([]);
    expect(sortRows(rows.slice(0, 1), by('client', 'asc')).map((row) => row.id)).toEqual(['a']);
  });
});

describe('sortRows — STATUS & DUE sinks settled invoices', () => {
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

  const order = (sort: SortState): string[] => sortRows(mixed, sort).map((row) => row.id);

  it('sorts a paid invoice below an overdue one even though it is far older', () => {
    const ids = order(by('status', 'asc'));
    expect(ids.indexOf('overdue')).toBeLessThan(ids.indexOf('paid-2024'));
    expect(ids[0]).toBe('overdue');
  });

  it('puts a void invoice in the settled block, not the unsettled one', () => {
    const ids = order(by('status', 'asc'));
    expect(ids.indexOf('void-2024')).toBeGreaterThan(ids.indexOf('later'));
  });

  it('keeps drafts in the unsettled block — unsent work is still in play', () => {
    const ids = order(by('status', 'asc'));
    expect(ids.indexOf('draft')).toBeLessThan(ids.indexOf('paid-2024'));
  });

  it('still runs due date ascending inside the unsettled block', () => {
    expect(order(by('status', 'asc')).slice(0, 5)).toEqual([
      'overdue',
      'overdue-2',
      'due-soon',
      'draft',
      'later',
    ]);
  });

  it('still runs due date ascending inside the settled block', () => {
    expect(order(by('status', 'asc')).slice(5)).toEqual([
      'paid-2024',
      'void-2024',
      'paid-2025',
    ]);
  });

  it('sinks settled rows on the column’s other direction too', () => {
    // "Furthest due first" is still a queue of work; a settled invoice has no
    // place in one, whichever end of it you read from.
    const ids = order(by('status', 'desc'));
    expect(ids.slice(0, 5)).toEqual(['later', 'draft', 'due-soon', 'overdue-2', 'overdue']);
    expect(ids.slice(5)).toEqual(['paid-2025', 'void-2024', 'paid-2024']);
  });

  it('leaves every other column literal — settled rows are not sunk', () => {
    // Largest first: every invoice is 100_000 cents, so the tie-break on the
    // number decides, and the settled rows keep their natural places.
    expect(order(by('total', 'desc'))).toEqual([
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
    expect(order(by('issued', 'desc'))[0]).toBe('paid-2024');
    expect(order(by('client', 'asc'))[0]).toBe('paid-2024');
  });

  it('orders an all-settled list by due date rather than emptying or reversing it', () => {
    const settled = mixed.filter((row) => row.state === 'paid' || row.state === 'void');
    expect(sortRows(settled, by('status', 'asc')).map((row) => row.id)).toEqual([
      'paid-2024',
      'void-2024',
      'paid-2025',
    ]);
  });
});

describe('footerSummary', () => {
  it('reads as the design has it', () => {
    expect(footerSummary(66, 1, 10, DEFAULT_SORT)).toBe(
      'Showing 1-10 of 66 · sorted by due date · open first',
    );
  });

  it('clamps a page past the end rather than printing an impossible range', () => {
    expect(footerSummary(66, 99, 10, DEFAULT_SORT)).toBe(
      'Showing 61-66 of 66 · sorted by due date · open first',
    );
  });

  it('says so when nothing matches', () => {
    expect(footerSummary(0, 1, 25, DEFAULT_SORT)).toBe(
      'Showing 0 of 0 · sorted by due date · open first',
    );
  });

  it('names each order in words', () => {
    expect(sortSentence(by('status', 'asc'))).toBe('due date · open first');
    expect(sortSentence(by('status', 'desc'))).toBe('due date, furthest first · open first');
    expect(sortSentence(by('client', 'asc'))).toBe('client A–Z');
    expect(sortSentence(by('client', 'desc'))).toBe('client Z–A');
    expect(sortSentence(by('invoice', 'asc'))).toBe('invoice number A–Z');
    expect(sortSentence(by('issued', 'desc'))).toBe('issue date, newest first');
    expect(sortSentence(by('total', 'desc'))).toBe('total, largest first');
    expect(footerSummary(5, 1, 25, by('total', 'asc'))).toBe(
      'Showing 1-5 of 5 · sorted by total, smallest first',
    );
  });

  it('keeps the settled-last clause on both STATUS & DUE orders, and only there', () => {
    // The caption is the only thing that explains why a 2024 paid invoice sits
    // below a 2026 one; an order that does not sink them must not claim to.
    for (const column of SORTABLE_COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        expect(sortSentence(by(column, direction)).includes('open first')).toBe(
          column === 'status',
        );
      }
    }
  });

  it('has a sentence for every sortable column in the column table', () => {
    const sortable = COLUMNS.filter((column) => column.sortable).map((column) => column.key);
    expect([...SORTABLE_COLUMNS]).toEqual(sortable);
  });
});
