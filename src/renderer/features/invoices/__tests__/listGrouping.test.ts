import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { INVOICE_STATUSES } from '../../../../shared/types';
import {
  GROUP_ORDER,
  LIST_COLUMN_MIN_WIDTH,
  LIST_COLUMN_WIDTH,
  PANE_MIN_WIDTH,
  adjacentRowId,
  buildInvoiceGroups,
  countOpenInvoices,
  countSegments,
  extraCurrencyLabel,
  flattenGroups,
  formatCurrencyTotals,
  formatMoneyRounded,
  groupHeaderParts,
  groupOf,
  isOpenState,
  listColumnWidthAt,
  listColumnWidthCss,
  matchesSegment,
  outstandingTotals,
  overdueTotals,
  relativeTiming,
  rowPosition,
  rowStateOf,
  shortDate,
  sumByCurrency,
  summariseTotals,
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
    expect(groupHeaderParts(overdue!).label).toBe('Overdue · $18,000');
    // Money that has arrived is not a figure you are chasing.
    expect(paid?.totals).toEqual([]);
    expect(groupHeaderParts(paid!).label).toBe('Paid');
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

describe('groupHeaderParts', () => {
  it('splits the caption into the figure and the count of the rest', () => {
    const groups = buildInvoiceGroups({
      invoices: [
        makeInvoice({ id: 'a', status: 'draft', currency: 'USD', totalCents: 7_330_800 }),
        makeInvoice({ id: 'b', status: 'draft', currency: 'EUR', totalCents: 4_949_900 }),
        makeInvoice({ id: 'c', status: 'draft', currency: 'GBP', totalCents: 100_000 }),
      ],
      clientNames: NAMES,
      today: TODAY,
      segment: 'all',
    });
    const drafts = groups.find((group) => group.key === 'drafts');
    expect(groupHeaderParts(drafts!)).toEqual({
      label: 'Drafts · $73,308',
      more: '+2 currencies',
    });
  });
});

describe('listColumnWidthAt / listColumnWidthCss', () => {
  it('gives the list its ideal width once the pane is comfortable', () => {
    expect(listColumnWidthAt(1184)).toBe(LIST_COLUMN_WIDTH);
  });

  it('takes width off the list before the pane goes under its floor', () => {
    expect(listColumnWidthAt(LIST_COLUMN_WIDTH + PANE_MIN_WIDTH)).toBe(LIST_COLUMN_WIDTH);
    expect(listColumnWidthAt(700)).toBe(700 - PANE_MIN_WIDTH);
  });

  it('never squeezes the list past the point where a row stops reading', () => {
    expect(listColumnWidthAt(600)).toBe(LIST_COLUMN_MIN_WIDTH);
    expect(listColumnWidthAt(0)).toBe(LIST_COLUMN_MIN_WIDTH);
  });

  it('fits the app’s own minimum window', () => {
    // src/main/window.ts: minWidth 960, less the side nav at its 224px minimum
    // and its 240px default. Both have to leave the pane its floor.
    for (const nav of [224, 240]) {
      const available = 960 - nav;
      expect(listColumnWidthAt(available) + PANE_MIN_WIDTH).toBeLessThanOrEqual(available);
    }
  });

  it('hands the stylesheet the same three numbers', () => {
    const css = listColumnWidthCss();
    expect(css).toContain(`${String(LIST_COLUMN_MIN_WIDTH)}px`);
    expect(css).toContain(`${String(PANE_MIN_WIDTH)}px`);
    expect(css).toContain(`${String(LIST_COLUMN_WIDTH)}px`);
    expect(css.startsWith('clamp(')).toBe(true);
  });
});
