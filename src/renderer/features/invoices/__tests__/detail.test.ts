import { describe, expect, it } from 'vitest';

import type { Invoice, InvoiceItem } from '../../../../shared/types';
import {
  averagePaymentDelayDays,
  buildHistoryEvents,
  buildLineSummary,
  buildNotesSections,
  buildStatTiles,
  buildStatusView,
  calendarDateOf,
  daysBetween,
  daysPastDue,
  formatDelayDays,
  openAmountCents,
} from '../detail';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    currency: 'USD',
    taxRateBps: 2300,
    notes: null,
    subtotalCents: 100_000,
    taxCents: 23_000,
    totalCents: 123_000,
    paidAt: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'li1',
    invoiceId: 'i1',
    position: 0,
    description: 'Design retainer',
    quantityMilli: 2000,
    unitPriceCents: 50_000,
    amountCents: 100_000,
    ...overrides,
  };
}

describe('daysBetween', () => {
  it('counts whole days forward', () => {
    expect(daysBetween('2026-01-31', '2026-02-03')).toBe(3);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetween('2026-01-31', '2026-01-29')).toBe(-2);
  });

  it('crosses a leap day without drifting', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('returns null for a date that is not a real calendar date', () => {
    expect(daysBetween('2026-02-31', '2026-03-01')).toBeNull();
    expect(daysBetween('2026-01-31', 'not-a-date')).toBeNull();
  });
});

describe('calendarDateOf', () => {
  it('takes the calendar date off a full ISO timestamp', () => {
    expect(calendarDateOf('2026-02-03T22:30:00.000Z')).toBe('2026-02-03');
  });
});

describe('daysPastDue', () => {
  it('reports one day when the due date was yesterday', () => {
    expect(daysPastDue('2026-01-31', '2026-02-01')).toBe(1);
  });

  it('reports zero on the due date itself', () => {
    expect(daysPastDue('2026-01-31', '2026-01-31')).toBe(0);
  });

  it('reports zero when the invoice is not yet due', () => {
    expect(daysPastDue('2026-01-31', '2026-01-20')).toBe(0);
  });

  it('reports zero for an unparseable due date', () => {
    expect(daysPastDue('2026-13-01', '2026-02-01')).toBe(0);
  });
});

describe('openAmountCents', () => {
  it('is zero once the invoice is paid', () => {
    expect(openAmountCents(makeInvoice({ status: 'paid' }))).toBe(0);
  });

  it('is the full total while unpaid', () => {
    expect(openAmountCents(makeInvoice({ status: 'sent' }))).toBe(123_000);
    expect(openAmountCents(makeInvoice({ status: 'overdue' }))).toBe(123_000);
  });
});

describe('averagePaymentDelayDays', () => {
  it('averages a mix of early, on-time and late payments', () => {
    // -4, 0, +7 -> mean 1
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-01-27T10:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-02-28', paidAt: '2026-02-28T23:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-03-31', paidAt: '2026-04-07T08:00:00.000Z' }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(1);
  });

  it('returns null when the client has no paid invoices', () => {
    expect(averagePaymentDelayDays([makeInvoice({ status: 'sent' })])).toBeNull();
    expect(averagePaymentDelayDays([])).toBeNull();
  });

  it('ignores unpaid invoices and paid rows with no paidAt', () => {
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-02-10T00:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: null }),
      makeInvoice({ status: 'overdue', dueDate: '2026-01-01', paidAt: null }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(10);
  });

  it('rounds the mean to a whole day', () => {
    // +1 and +2 -> 1.5 -> 2
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-02-01T00:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-02-02T00:00:00.000Z' }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(2);
  });

  it('reports a negative mean when the client pays early', () => {
    // -6 and -4 -> -5
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-01-25T00:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-01-27T00:00:00.000Z' }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(-5);
  });

  it('normalises a zero mean so it is never -0', () => {
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-01-30T00:00:00.000Z' }),
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(0);
  });

  it('uses the calendar date of paidAt, not its UTC instant', () => {
    // 23:30 on the due date is still on time, not a day late.
    const invoices = [
      makeInvoice({ status: 'paid', dueDate: '2026-01-31', paidAt: '2026-01-31T23:30:00.000Z' }),
    ];
    expect(averagePaymentDelayDays(invoices)).toBe(0);
  });
});

describe('formatDelayDays', () => {
  it('renders an em dash when there is no data', () => {
    expect(formatDelayDays(null)).toBe('—');
  });

  it('renders late, early and on-time', () => {
    expect(formatDelayDays(12)).toBe('12 days late');
    expect(formatDelayDays(1)).toBe('1 day late');
    expect(formatDelayDays(-3)).toBe('3 days early');
    expect(formatDelayDays(0)).toBe('On time');
  });
});

describe('buildStatusView', () => {
  it('reads a sent invoice past its due date as overdue', () => {
    const view = buildStatusView(
      makeInvoice({ status: 'sent', dueDate: '2026-01-31' }),
      '2026-02-18',
      true,
    );
    expect(view.status).toBe('overdue');
    expect(view.variant).toBe('red');
    expect(view.delayDays).toBe(18);
    expect(view.delayNote).toBe('18 days delay');
  });

  it('singularises a one-day delay', () => {
    const view = buildStatusView(
      makeInvoice({ status: 'sent', dueDate: '2026-01-31' }),
      '2026-02-01',
      true,
    );
    expect(view.delayNote).toBe('1 day delay');
  });

  it('leaves a not-yet-due invoice on its stored status', () => {
    const view = buildStatusView(
      makeInvoice({ status: 'sent', dueDate: '2026-01-31' }),
      '2026-01-20',
      false,
    );
    expect(view.status).toBe('sent');
    expect(view.variant).toBe('blue');
    expect(view.delayDays).toBe(0);
    expect(view.delayNote).toBeNull();
  });

  it('never marks a paid invoice overdue', () => {
    const view = buildStatusView(
      makeInvoice({ status: 'paid', dueDate: '2026-01-01' }),
      '2026-02-18',
      false,
    );
    expect(view.status).toBe('paid');
    expect(view.variant).toBe('green');
    expect(view.delayNote).toBeNull();
  });

  it('keeps the delay note for a stored overdue status', () => {
    const view = buildStatusView(
      makeInvoice({ status: 'overdue', dueDate: '2026-01-31' }),
      '2026-02-05',
      false,
    );
    expect(view.status).toBe('overdue');
    expect(view.delayNote).toBe('5 days delay');
  });

  it('maps draft and void to their own tones', () => {
    expect(buildStatusView(makeInvoice({ status: 'draft' }), '2026-02-18', false).variant).toBe(
      'neutral',
    );
    expect(buildStatusView(makeInvoice({ status: 'void' }), '2026-02-18', false).variant).toBe(
      'orange',
    );
  });
});

describe('buildStatTiles', () => {
  it('maps every tile off the row', () => {
    const tiles = buildStatTiles({
      invoice: makeInvoice({ status: 'sent', paidAt: null }),
      averageDelayDays: 12,
    });
    expect(tiles.map((tile) => tile.label)).toEqual([
      'Total Amount',
      'Open Amount',
      'VAT Amount',
      'Due Date',
      'Paid On',
      'Customer av delay',
    ]);
    expect(tiles.map((tile) => tile.value)).toEqual([
      '$1,230.00',
      '$1,230.00',
      '$230.00',
      '31 January 2026',
      '—',
      '12 days late',
    ]);
    expect(tiles.filter((tile) => tile.isEmphasised).map((tile) => tile.key)).toEqual(['total']);
  });

  it('zeroes the open amount and dates the payment once paid', () => {
    const tiles = buildStatTiles({
      invoice: makeInvoice({ status: 'paid', paidAt: '2026-02-03T22:30:00.000Z' }),
      averageDelayDays: null,
    });
    const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile.value]));
    expect(byKey.open).toBe('$0.00');
    expect(byKey.paid).toBe('3 February 2026');
    expect(byKey.delay).toBe('—');
  });
});

describe('buildHistoryEvents', () => {
  it('collapses an untouched invoice to a single created event', () => {
    const events = buildHistoryEvents(makeInvoice());
    expect(events.map((event) => event.key)).toEqual(['created']);
    expect(events[0]?.timestamp).toBe('2026-01-01T09:00:00.000Z');
  });

  it('adds the update once the row has actually changed', () => {
    const events = buildHistoryEvents(
      makeInvoice({ updatedAt: '2026-01-15T12:00:00.000Z' }),
    );
    expect(events.map((event) => event.key)).toEqual(['created', 'updated']);
  });

  it('adds a paid event, in chronological order, when paidAt is set', () => {
    const events = buildHistoryEvents(
      makeInvoice({
        updatedAt: '2026-02-04T08:00:00.000Z',
        paidAt: '2026-02-03T22:30:00.000Z',
      }),
    );
    expect(events.map((event) => event.key)).toEqual(['created', 'paid', 'updated']);
    expect(events).toHaveLength(3);
  });

  it('never invents a fourth event', () => {
    const events = buildHistoryEvents(
      makeInvoice({ updatedAt: '2026-02-04T08:00:00.000Z', paidAt: '2026-02-03T22:30:00.000Z' }),
    );
    expect(events.length).toBeLessThanOrEqual(3);
  });
});

describe('buildNotesSections', () => {
  it('returns both sections, the client one titled by name', () => {
    const sections = buildNotesSections('Pay by wire.', 'Acme Corp', 'Slow payer.');
    expect(sections.map((section) => section.heading)).toEqual([
      'Invoice notes',
      'Notes on Acme Corp',
    ]);
    expect(sections[1]?.body).toBe('Slow payer.');
  });

  it('drops blank and missing notes', () => {
    expect(buildNotesSections(null, 'Acme Corp', '   ')).toEqual([]);
    expect(buildNotesSections('  ', null, null)).toEqual([]);
  });

  it('falls back to a generic heading when the client is unknown', () => {
    expect(buildNotesSections(null, null, 'Careful.')[0]?.heading).toBe('Client notes');
  });
});

describe('buildLineSummary', () => {
  it('formats every line and the totals in the invoice currency', () => {
    const summary = buildLineSummary({
      ...makeInvoice(),
      items: [makeItem(), makeItem({ id: 'li2', description: 'Hosting', quantityMilli: 1500, amountCents: 4500 })],
    });
    expect(summary.count).toBe(2);
    expect(summary.rows).toEqual([
      { key: 'li1', description: 'Design retainer', quantity: '2', amount: '$1,000.00' },
      { key: 'li2', description: 'Hosting', quantity: '1.5', amount: '$45.00' },
    ]);
    expect(summary.subtotal).toBe('$1,000.00');
    expect(summary.tax).toBe('$230.00');
    expect(summary.total).toBe('$1,230.00');
  });

  it('handles an invoice with no line items', () => {
    const summary = buildLineSummary({ ...makeInvoice(), items: [] });
    expect(summary.count).toBe(0);
    expect(summary.rows).toEqual([]);
  });
});
