import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { INVOICE_STATUSES } from '../../../../shared/types';
import {
  GROUP_ORDER,
  adjacentRowId,
  buildInvoiceGroups,
  countSegments,
  flattenGroups,
  formatCurrencyTotals,
  formatMoneyRounded,
  groupHeaderLabel,
  groupOf,
  isOpenState,
  matchesSegment,
  outstandingTotals,
  overdueTotals,
  relativeTiming,
  rowPosition,
  rowStateOf,
  shortDate,
  sumByCurrency,
} from '../listGrouping';
import type { ListSegment, RowState } from '../listGrouping';

const TODAY = '2026-07-29';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-05-26',
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
  ['c2', 'Northwind Analytics'],
]);

describe('shortDate', () => {
  it('drops the year when it is the year on screen', () => {
    expect(shortDate('2026-08-18', TODAY)).toBe('18 Aug');
  });

  it('keeps the year when it is a different one', () => {
    expect(shortDate('2027-01-04', TODAY)).toBe('4 Jan 2027');
  });

  it('strips the leading zero off the day', () => {
    expect(shortDate('2026-07-09', TODAY)).toBe('9 Jul');
  });

  it('returns anything unparseable unchanged rather than guessing', () => {
    expect(shortDate('not-a-date', TODAY)).toBe('not-a-date');
  });
});

describe('rowStateOf', () => {
  it('reads a sent invoice past its due date as overdue, without a stored flag', () => {
    expect(rowStateOf(makeInvoice({ status: 'sent', dueDate: '2026-06-25' }), TODAY)).toBe('overdue');
  });

  it('puts an invoice due within the week in its own group', () => {
    expect(rowStateOf(makeInvoice({ dueDate: '2026-07-31' }), TODAY)).toBe('due-soon');
    expect(rowStateOf(makeInvoice({ dueDate: '2026-08-05' }), TODAY)).toBe('due-soon');
  });

  it('treats the eighth day out as later', () => {
    expect(rowStateOf(makeInvoice({ dueDate: '2026-08-06' }), TODAY)).toBe('later');
  });

  it('reads today as due soon, not overdue', () => {
    expect(rowStateOf(makeInvoice({ dueDate: TODAY }), TODAY)).toBe('due-soon');
  });

  it('keeps settled and unissued statuses out of the clock entirely', () => {
    const past = { dueDate: '2026-01-01' };
    expect(rowStateOf(makeInvoice({ ...past, status: 'paid' }), TODAY)).toBe('paid');
    expect(rowStateOf(makeInvoice({ ...past, status: 'draft' }), TODAY)).toBe('draft');
    expect(rowStateOf(makeInvoice({ ...past, status: 'void' }), TODAY)).toBe('void');
  });

  it('covers every status in INVOICE_STATUSES', () => {
    for (const status of INVOICE_STATUSES) {
      const state = rowStateOf(makeInvoice({ status }), TODAY);
      expect(GROUP_ORDER).toContain(groupOf(state));
    }
  });
});

describe('relativeTiming', () => {
  it('counts the days late rather than naming the status', () => {
    const invoice = makeInvoice({ dueDate: '2026-06-25' });
    expect(relativeTiming(invoice, 'overdue', TODAY)).toBe('34 days late');
  });

  it('singularises one day', () => {
    expect(relativeTiming(makeInvoice({ dueDate: '2026-07-28' }), 'overdue', TODAY)).toBe('1 day late');
    expect(relativeTiming(makeInvoice({ dueDate: '2026-07-30' }), 'due-soon', TODAY)).toBe('due tomorrow');
  });

  it('says today rather than "in 0 days"', () => {
    expect(relativeTiming(makeInvoice({ dueDate: TODAY }), 'due-soon', TODAY)).toBe('due today');
  });

  it('counts forward for the rest of the week', () => {
    expect(relativeTiming(makeInvoice({ dueDate: '2026-07-31' }), 'due-soon', TODAY)).toBe('due in 2 days');
  });

  it('dates anything further out', () => {
    expect(relativeTiming(makeInvoice({ dueDate: '2026-08-18' }), 'later', TODAY)).toBe('due 18 Aug');
  });

  it('dates a draft by when it was last edited', () => {
    const invoice = makeInvoice({ status: 'draft', updatedAt: '2026-07-25T18:00:00.000Z' });
    expect(relativeTiming(invoice, 'draft', TODAY)).toBe('edited 25 Jul');
  });

  it('dates a paid invoice by when the money arrived', () => {
    const invoice = makeInvoice({ status: 'paid', paidAt: '2026-07-24T10:00:00.000Z' });
    expect(relativeTiming(invoice, 'paid', TODAY)).toBe('paid 24 Jul');
  });

  it('says only "paid" when nothing recorded the date', () => {
    expect(relativeTiming(makeInvoice({ status: 'paid' }), 'paid', TODAY)).toBe('paid');
  });

  it('does not invent a negative day count for a stored overdue that is not due yet', () => {
    const invoice = makeInvoice({ status: 'overdue', dueDate: '2026-09-01' });
    expect(relativeTiming(invoice, 'overdue', TODAY)).toBe('marked overdue');
  });
});

describe('sumByCurrency', () => {
  it('never adds two currencies together', () => {
    const totals = sumByCurrency([
      makeInvoice({ id: 'a', currency: 'USD', totalCents: 10_000 }),
      makeInvoice({ id: 'b', currency: 'GBP', totalCents: 50_000 }),
      makeInvoice({ id: 'c', currency: 'USD', totalCents: 5_000 }),
    ]);
    expect(totals).toEqual([
      { currency: 'GBP', cents: 50_000 },
      { currency: 'USD', cents: 15_000 },
    ]);
  });

  it('is empty for an empty set', () => {
    expect(sumByCurrency([])).toEqual([]);
  });
});

describe('formatMoneyRounded', () => {
  it('drops the cents from a headline sum', () => {
    expect(formatMoneyRounded(4_291_512, 'USD')).toBe('$42,915');
  });

  it('falls back to a bare code for a currency Intl does not know', () => {
    expect(formatMoneyRounded(100_000, 'XYZ')).toContain('1,000');
  });
});

describe('formatCurrencyTotals', () => {
  it('joins the currencies it shows', () => {
    expect(
      formatCurrencyTotals([
        { currency: 'USD', cents: 4_291_500 },
        { currency: 'EUR', cents: 810_000 },
      ]),
    ).toBe('$42,915 · €8,100');
  });

  it('counts the ones it had no room for', () => {
    const totals = [
      { currency: 'USD', cents: 300 },
      { currency: 'EUR', cents: 200 },
      { currency: 'GBP', cents: 100 },
    ];
    expect(formatCurrencyTotals(totals, 1)).toBe('$3 +2');
  });

  it('is empty when there is nothing to add up', () => {
    expect(formatCurrencyTotals([])).toBe('');
  });
});

describe('matchesSegment / countSegments', () => {
  const cases: readonly [RowState, ListSegment, boolean][] = [
    ['overdue', 'overdue', true],
    ['overdue', 'sent', false],
    ['due-soon', 'sent', true],
    ['later', 'sent', true],
    ['draft', 'drafts', true],
    ['paid', 'all', true],
    ['paid', 'sent', false],
    ['void', 'all', true],
  ];
  it.each(cases)('%s in %s -> %s', (state, segment, expected) => {
    expect(matchesSegment(state, segment)).toBe(expected);
  });

  it('counts each segment over the same set', () => {
    const counts = countSegments(
      [
        makeInvoice({ id: 'a', dueDate: '2026-06-25' }), // overdue
        makeInvoice({ id: 'b', dueDate: '2026-07-31' }), // due soon
        makeInvoice({ id: 'c', dueDate: '2026-09-30' }), // later
        makeInvoice({ id: 'd', status: 'draft' }),
        makeInvoice({ id: 'e', status: 'paid' }),
      ],
      TODAY,
    );
    expect(counts).toEqual({ all: 5, overdue: 1, sent: 2, drafts: 1 });
  });
});

describe('buildInvoiceGroups', () => {
  const invoices = [
    makeInvoice({ id: 'a', number: 'INV-0051', dueDate: '2026-06-25', totalCents: 1_800_000 }),
    makeInvoice({ id: 'b', number: 'INV-0060', dueDate: '2026-07-31', clientId: 'c2' }),
    makeInvoice({ id: 'c', number: 'INV-0063', dueDate: '2026-08-18' }),
    makeInvoice({ id: 'd', number: 'INV-0066', status: 'draft', updatedAt: '2026-07-25T09:00:00.000Z' }),
    makeInvoice({ id: 'e', number: 'INV-0065', status: 'paid', paidAt: '2026-07-24T09:00:00.000Z' }),
    makeInvoice({ id: 'f', number: 'INV-0002', status: 'void' }),
  ];

  it('orders the groups by urgency and drops the empty ones', () => {
    const groups = buildInvoiceGroups({ invoices, clientNames: NAMES, today: TODAY, segment: 'all' });
    expect(groups.map((group) => group.key)).toEqual([
      'overdue',
      'due-soon',
      'later',
      'drafts',
      'paid',
      'void',
    ]);

    const onlyDrafts = buildInvoiceGroups({
      invoices,
      clientNames: NAMES,
      today: TODAY,
      segment: 'drafts',
    });
    expect(onlyDrafts.map((group) => group.key)).toEqual(['drafts']);
  });

  it('builds the second line out of the number and the relative time', () => {
    const [overdue] = buildInvoiceGroups({
      invoices,
      clientNames: NAMES,
      today: TODAY,
      segment: 'all',
    });
    expect(overdue?.rows[0]?.secondary).toBe('INV-0051 · 34 days late');
    expect(overdue?.rows[0]?.clientName).toBe('Halloway & Finch LLP');
    expect(overdue?.rows[0]?.amount).toBe('$18,000.00');
  });

  it('mutes settled and unissued rows and leaves open ones at full contrast', () => {
    const groups = buildInvoiceGroups({ invoices, clientNames: NAMES, today: TODAY, segment: 'all' });
    const byId = new Map(flattenGroups(groups).map((row) => [row.id, row.isMuted]));
    expect(byId.get('a')).toBe(false);
    expect(byId.get('d')).toBe(true);
    expect(byId.get('e')).toBe(true);
    expect(byId.get('f')).toBe(true);
  });

  it('carries a per-currency sum on every group but paid', () => {
    const groups = buildInvoiceGroups({ invoices, clientNames: NAMES, today: TODAY, segment: 'all' });
    const overdue = groups.find((group) => group.key === 'overdue');
    const paid = groups.find((group) => group.key === 'paid');
    expect(overdue?.totals).toEqual([{ currency: 'USD', cents: 1_800_000 }]);
    expect(groupHeaderLabel(overdue!)).toBe('Overdue · $18,000');
    // Money that has arrived is not a figure you are chasing.
    expect(paid?.totals).toEqual([]);
    expect(groupHeaderLabel(paid!)).toBe('Paid');
  });

  it('sorts open groups by due date and settled groups newest first', () => {
    const groups = buildInvoiceGroups({
      invoices: [
        makeInvoice({ id: 'late', number: 'INV-0002', dueDate: '2026-05-01' }),
        makeInvoice({ id: 'later', number: 'INV-0001', dueDate: '2026-06-01' }),
        makeInvoice({ id: 'newDraft', number: 'INV-0003', status: 'draft', updatedAt: '2026-07-28T09:00:00.000Z' }),
        makeInvoice({ id: 'oldDraft', number: 'INV-0004', status: 'draft', updatedAt: '2026-07-01T09:00:00.000Z' }),
      ],
      clientNames: NAMES,
      today: TODAY,
      segment: 'all',
    });
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(['late', 'later']);
    expect(groups[1]?.rows.map((row) => row.id)).toEqual(['newDraft', 'oldDraft']);
  });

  it('falls back to the client id when no name was joined in', () => {
    const groups = buildInvoiceGroups({
      invoices: [makeInvoice({ clientId: 'unknown' })],
      clientNames: new Map(),
      today: TODAY,
      segment: 'all',
    });
    expect(groups[0]?.rows[0]?.clientName).toBe('unknown');
  });
});

describe('adjacentRowId / rowPosition', () => {
  const rows = flattenGroups(
    buildInvoiceGroups({
      invoices: [
        makeInvoice({ id: 'a', number: 'INV-1', dueDate: '2026-05-01' }),
        makeInvoice({ id: 'b', number: 'INV-2', dueDate: '2026-05-02' }),
        makeInvoice({ id: 'c', number: 'INV-3', dueDate: '2026-05-03' }),
      ],
      clientNames: NAMES,
      today: TODAY,
      segment: 'all',
    }),
  );

  it('walks the flattened list across group boundaries', () => {
    expect(adjacentRowId(rows, 'a', 1)).toBe('b');
    expect(adjacentRowId(rows, 'b', -1)).toBe('a');
  });

  it('parks at both ends rather than wrapping and losing the reader', () => {
    expect(adjacentRowId(rows, 'c', 1)).toBe('c');
    expect(adjacentRowId(rows, 'a', -1)).toBe('a');
  });

  it('lands on the first row when the selection is gone or unset', () => {
    expect(adjacentRowId(rows, null, 1)).toBe('a');
    expect(adjacentRowId(rows, 'deleted', 1)).toBe('a');
  });

  it('has nothing to select in an empty list', () => {
    expect(adjacentRowId([], 'a', 1)).toBeNull();
  });

  it('reports a one-based position', () => {
    expect(rowPosition(rows, 'b')).toBe(2);
    expect(rowPosition(rows, 'nope')).toBeNull();
    expect(rowPosition(rows, null)).toBeNull();
  });
});

describe('outstandingTotals / overdueTotals', () => {
  const invoices = [
    makeInvoice({ id: 'a', dueDate: '2026-06-25', totalCents: 400_000 }), // overdue
    makeInvoice({ id: 'b', dueDate: '2026-09-01', totalCents: 100_000 }), // later
    makeInvoice({ id: 'c', status: 'paid', totalCents: 999_900 }),
    makeInvoice({ id: 'd', status: 'draft', totalCents: 888_800 }),
    makeInvoice({ id: 'e', status: 'void', totalCents: 777_700 }),
  ];

  it('counts only what is actually still owed', () => {
    expect(outstandingTotals(invoices, TODAY)).toEqual([{ currency: 'USD', cents: 500_000 }]);
  });

  it('reports the overdue slice on its own', () => {
    expect(overdueTotals(invoices, TODAY)).toEqual([{ currency: 'USD', cents: 400_000 }]);
  });

  it('agrees with isOpenState about what "open" means', () => {
    expect(isOpenState('overdue')).toBe(true);
    expect(isOpenState('due-soon')).toBe(true);
    expect(isOpenState('later')).toBe(true);
    expect(isOpenState('draft')).toBe(false);
    expect(isOpenState('paid')).toBe(false);
    expect(isOpenState('void')).toBe(false);
  });
});
