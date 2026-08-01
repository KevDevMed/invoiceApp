import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { INVOICE_STATUSES } from '../../../../shared/types';
import {
  adjacentRowId,
  countOpenInvoices,
  countSegments,
  extraCurrencyLabel,
  formatCurrencyTotals,
  formatMoneyRounded,
  isOpenState,
  matchesSegment,
  outstandingTotals,
  overdueTotals,
  rowPosition,
  rowStateOf,
  shortDate,
  sumByCurrency,
  summariseTotals,
} from '../listGrouping';
import type { ListSegment, RowState } from '../listGrouping';

const ROW_STATES: readonly RowState[] = [
  'overdue',
  'due-soon',
  'later',
  'draft',
  'paid',
  'void',
];

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
      expect(ROW_STATES).toContain(rowStateOf(makeInvoice({ status }), TODAY));
    }
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
    expect(counts).toEqual({ all: 5, overdue: 1, sent: 2, drafts: 1, paid: 1 });
  });
});

describe('adjacentRowId / rowPosition', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('walks the list one row at a time', () => {
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

describe('countOpenInvoices', () => {
  const invoices = [
    makeInvoice({ id: 'a', status: 'sent', dueDate: '2026-06-25' }), // past due -> overdue
    makeInvoice({ id: 'b', status: 'sent', dueDate: '2026-07-31' }), // due soon
    makeInvoice({ id: 'c', status: 'sent', dueDate: '2026-09-01' }), // later
    makeInvoice({ id: 'd', status: 'overdue', dueDate: '2026-01-01' }),
    makeInvoice({ id: 'e', status: 'draft' }),
    makeInvoice({ id: 'f', status: 'paid' }),
    makeInvoice({ id: 'g', status: 'void' }),
  ];

  it('counts the late ones by the clock, not by the stored flag', () => {
    // Two rows are late: the one stored `overdue`, and the `sent` one whose
    // due date has passed. Counting the flag alone would say 1.
    expect(countOpenInvoices(invoices, TODAY)).toEqual({ open: 4, overdue: 2 });
  });

  it('leaves drafts, paid and void out of "open" entirely', () => {
    expect(countOpenInvoices(
      [makeInvoice({ id: 'e', status: 'draft' }), makeInvoice({ id: 'f', status: 'paid' })],
      TODAY,
    )).toEqual({ open: 0, overdue: 0 });
  });

  it('is the same answer the segmented control gives', () => {
    const counts = countSegments(invoices, TODAY);
    const open = countOpenInvoices(invoices, TODAY);
    expect(open.overdue).toBe(counts.overdue);
    expect(open.open).toBe(counts.overdue + counts.sent);
  });
});

describe('extraCurrencyLabel / summariseTotals', () => {
  const totals = [
    { currency: 'GBP', cents: 12_433_300 },
    { currency: 'EUR', cents: 10_307_300 },
    { currency: 'USD', cents: 8_381_900 },
    { currency: 'CAD', cents: 300_000 },
  ];

  it('names how many currencies the headline is standing in front of', () => {
    expect(extraCurrencyLabel(0)).toBeNull();
    expect(extraCurrencyLabel(-1)).toBeNull();
    expect(extraCurrencyLabel(1)).toBe('+1 currency');
    expect(extraCurrencyLabel(3)).toBe('+3 currencies');
  });

  it('leads with the largest currency and counts the rest', () => {
    const summary = summariseTotals(totals);
    expect(summary.lead).toBe('£124,333');
    expect(summary.more).toBe('+3 currencies');
    expect(summary.extraCurrencies).toBe(3);
  });

  it('keeps every currency in the breakdown, never summed together', () => {
    expect(summariseTotals(totals).full).toBe('£124,333 · €103,073 · $83,819 · CA$3,000');
  });

  it('says nothing extra when one currency is the whole story', () => {
    const summary = summariseTotals([{ currency: 'USD', cents: 100_000 }]);
    expect(summary.lead).toBe('$1,000');
    expect(summary.more).toBeNull();
    expect(summary.full).toBe('$1,000');
  });

  it('is empty for an empty set so the caller can drop the line', () => {
    expect(summariseTotals([])).toEqual({
      lead: '',
      leadCurrency: null,
      more: null,
      full: '',
      extraCurrencies: 0,
    });
  });

  it('leads with the currency it is asked for, so two summaries can be compared', () => {
    // The overdue slice is led by whatever the outstanding line led with —
    // "£124,333 outstanding · €86,925 overdue" invites reading the second as a
    // fraction of the first when it is not even the same money.
    const overdue = [
      { currency: 'EUR', cents: 8_692_500 },
      { currency: 'GBP', cents: 2_000_000 },
    ];
    const summary = summariseTotals(overdue, 'GBP');
    expect(summary.lead).toBe('£20,000');
    expect(summary.leadCurrency).toBe('GBP');
    // The breakdown is untouched: still every currency, still largest first.
    expect(summary.full).toBe('€86,925 · £20,000');
  });

  it('falls back to the largest when the asked-for currency is not in the set', () => {
    expect(summariseTotals([{ currency: 'EUR', cents: 100_000 }], 'GBP').lead).toBe('€1,000');
  });
});
