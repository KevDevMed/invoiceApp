import { describe, expect, it } from 'vitest';

import type { Client, Invoice, InvoiceItem, InvoiceWithItems } from '../../../../shared/types';
import {
  buildPaneActivity,
  buildPaneFacts,
  buildPaneIdentity,
  buildPaneLines,
  buildPaneTimeline,
  monogramOf,
  paymentTermLabel,
  toneForState,
} from '../listPane';

const TODAY = '2026-07-29';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0051',
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

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Halloway & Finch LLP',
    email: 'accounts@halloway-finch.co.uk',
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    taxId: null,
    notes: null,
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

describe('paymentTermLabel', () => {
  it('names the net term', () => {
    expect(paymentTermLabel('2026-05-26', '2026-06-25')).toBe('Net 30');
  });

  it('says due on receipt when there is no term at all', () => {
    expect(paymentTermLabel('2026-05-26', '2026-05-26')).toBe('Due on receipt');
  });

  it('is null when the dates make no sense as a term', () => {
    expect(paymentTermLabel('2026-06-25', '2026-05-26')).toBeNull();
    expect(paymentTermLabel('nope', '2026-05-26')).toBeNull();
  });
});

describe('monogramOf', () => {
  it('takes the first and last initials', () => {
    expect(monogramOf('Halloway & Finch LLP')).toBe('HL');
    expect(monogramOf('Northwind Analytics')).toBe('NA');
  });

  it('takes two letters off a single word', () => {
    expect(monogramOf('Corvus')).toBe('CO');
  });

  it('never renders empty', () => {
    expect(monogramOf('   ')).toBe('?');
  });
});

describe('buildPaneIdentity', () => {
  it('pairs the number with the address the reminder would go to', () => {
    const identity = buildPaneIdentity(
      { ...makeInvoice(), client: makeClient(), items: [] } as InvoiceWithItems,
      TODAY,
    );
    expect(identity.clientName).toBe('Halloway & Finch LLP');
    expect(identity.reference).toBe('INV-0051 · accounts@halloway-finch.co.uk');
    expect(identity.tone).toBe('error');
  });

  it('shows the number alone when the client has no email to chase', () => {
    const identity = buildPaneIdentity(
      { ...makeInvoice(), client: makeClient({ email: null }), items: [] } as InvoiceWithItems,
      TODAY,
    );
    expect(identity.reference).toBe('INV-0051');
  });

  it('falls back to the client id when the join found nothing', () => {
    const identity = buildPaneIdentity(
      { ...makeInvoice(), client: null, items: [] } as InvoiceWithItems,
      TODAY,
    );
    expect(identity.clientName).toBe('c1');
  });
});

describe('toneForState', () => {
  it('maps every state onto a semantic tone', () => {
    expect(toneForState('overdue')).toBe('error');
    expect(toneForState('due-soon')).toBe('warning');
    expect(toneForState('later')).toBe('neutral');
    expect(toneForState('draft')).toBe('neutral');
    expect(toneForState('paid')).toBe('success');
    expect(toneForState('void')).toBe('neutral');
  });
});

describe('buildPaneTimeline', () => {
  it('counts the days overdue and draws them against the term that was given', () => {
    // Net 30 issued 26 May, due 25 Jun, 34 days late on 29 Jul: 30 days of term
    // against 34 days of lateness.
    const timeline = buildPaneTimeline(makeInvoice(), TODAY);
    expect(timeline.tone).toBe('error');
    expect(timeline.headline).toBe('34 days overdue');
    expect(timeline.elapsedPercent).toBe(47);
    expect(timeline.overduePercent).toBe(53);
    expect(timeline.axis).toEqual(['issued 26 May', 'due 25 Jun · Net 30', 'today 29 Jul']);
  });

  it('singularises one day', () => {
    const timeline = buildPaneTimeline(makeInvoice({ dueDate: '2026-07-28' }), TODAY);
    expect(timeline.headline).toBe('1 day overdue');
  });

  it('counts forward while the invoice is still in its term', () => {
    const timeline = buildPaneTimeline(
      makeInvoice({ issueDate: '2026-07-19', dueDate: '2026-08-18' }),
      TODAY,
    );
    expect(timeline.headline).toBe('Due in 20 days');
    expect(timeline.overduePercent).toBe(0);
    expect(timeline.elapsedPercent).toBe(33);
  });

  it('says due today rather than "in 0 days"', () => {
    expect(buildPaneTimeline(makeInvoice({ dueDate: TODAY }), TODAY).headline).toBe('Due today');
  });

  it('closes the bar and dates the payment once it has arrived', () => {
    const timeline = buildPaneTimeline(
      makeInvoice({ status: 'paid', paidAt: '2026-06-22T09:00:00.000Z' }),
      TODAY,
    );
    expect(timeline.tone).toBe('success');
    expect(timeline.headline).toBe('Paid 22 Jun');
    expect(timeline.detail).toBe('3 days early');
    expect(timeline.elapsedPercent).toBe(100);
    expect(timeline.overduePercent).toBe(0);
    expect(timeline.axis[2]).toBe('paid 22 Jun');
  });

  it('says a draft has not been issued rather than calling it late', () => {
    const timeline = buildPaneTimeline(makeInvoice({ status: 'draft' }), TODAY);
    expect(timeline.headline).toBe('Draft — not issued yet');
    expect(timeline.overduePercent).toBe(0);
  });

  it('draws no timeline for a draft, because no clock has started', () => {
    const timeline = buildPaneTimeline(
      makeInvoice({ status: 'draft', updatedAt: '2026-07-25T18:00:00.000Z' }),
      TODAY,
    );
    // The banner used to say "not issued yet" directly above
    // "issued 26 May · due 25 Jun · today 29 Jul" and a full progress bar.
    expect(timeline.hasProgress).toBe(false);
    expect(timeline.elapsedPercent).toBe(0);
    expect(timeline.axis).toEqual(['last edited 25 Jul']);
    expect(timeline.axis.join(' ')).not.toContain('issued');
    expect(timeline.axis.join(' ')).not.toContain('due');
  });

  it('says the term is prospective on a draft rather than in force', () => {
    expect(buildPaneTimeline(makeInvoice({ status: 'draft' }), TODAY).detail).toBe(
      'Net 30 once issued',
    );
  });

  it('keeps the timeline on every invoice that has actually been issued', () => {
    for (const status of ['sent', 'overdue', 'paid', 'void'] as const) {
      expect(buildPaneTimeline(makeInvoice({ status }), TODAY).hasProgress).toBe(true);
    }
  });

  it('names a void invoice as cancelled', () => {
    expect(buildPaneTimeline(makeInvoice({ status: 'void' }), TODAY).headline).toBe(
      'Void — cancelled',
    );
  });
});

describe('buildPaneFacts', () => {
  it('leads with what is still open and names the face value when they differ', () => {
    const facts = buildPaneFacts({
      invoice: makeInvoice({ status: 'paid' }),
      clientInvoices: null,
      today: TODAY,
    });
    const amount = facts.find((fact) => fact.key === 'amount');
    expect(amount?.value).toBe('$0.00');
    expect(amount?.sub).toBe('$1,000.00 invoiced');
    expect(amount?.isEmphasised).toBe(true);
  });

  it('says nothing extra when the whole invoice is still open', () => {
    const facts = buildPaneFacts({ invoice: makeInvoice(), clientInvoices: null, today: TODAY });
    expect(facts.find((fact) => fact.key === 'amount')?.sub).toBeNull();
  });

  it('dates the issue and names the term', () => {
    const facts = buildPaneFacts({ invoice: makeInvoice(), clientInvoices: null, today: TODAY });
    const issued = facts.find((fact) => fact.key === 'issued');
    expect(issued?.value).toBe('26 May 2026');
    expect(issued?.sub).toBe('Net 30');
  });

  it('omits the client balance entirely when the sweep has not run', () => {
    const facts = buildPaneFacts({ invoice: makeInvoice(), clientInvoices: null, today: TODAY });
    expect(facts.map((fact) => fact.key)).toEqual(['amount', 'issued']);
  });

  it('adds up only the client invoices that are still open', () => {
    const facts = buildPaneFacts({
      invoice: makeInvoice(),
      clientInvoices: [
        makeInvoice({ id: 'i1', totalCents: 100_000 }),
        makeInvoice({ id: 'i2', totalCents: 250_000, dueDate: '2026-09-01' }),
        makeInvoice({ id: 'i3', totalCents: 999_900, status: 'paid', paidAt: '2026-07-01T09:00:00.000Z' }),
        makeInvoice({ id: 'i4', totalCents: 888_800, status: 'draft' }),
      ],
      today: TODAY,
    });
    const client = facts.find((fact) => fact.key === 'client');
    expect(client?.value).toBe('$3,500');
    expect(client?.sub).toBe('2 open invoices');
    // i3 was paid six days after its due date; the invoice on screen is excluded.
    expect(client?.note).toBe('pays 6 days late');
  });

  it('never puts an amount *due* on a draft', () => {
    const facts = buildPaneFacts({
      invoice: makeInvoice({ status: 'draft', totalCents: 65_356 }),
      clientInvoices: null,
      today: TODAY,
    });
    const amount = facts.find((fact) => fact.key === 'amount');
    // It used to read "Amount due $0.00" over "$653.56 invoiced" — one invoice
    // claiming both that nothing is owed and that it has been invoiced.
    expect(amount?.caption).toBe('Draft total');
    expect(amount?.value).toBe('$653.56');
    expect(amount?.sub).toBe('Nothing due until it is sent');
  });

  it('dates a draft as planned rather than as done', () => {
    const facts = buildPaneFacts({
      invoice: makeInvoice({ status: 'draft' }),
      clientInvoices: null,
      today: TODAY,
    });
    const issued = facts.find((fact) => fact.key === 'issued');
    expect(issued?.caption).toBe('Issue date');
    expect(issued?.value).toBe('26 May 2026');
    expect(issued?.sub).toBe('Not sent yet · Net 30');
  });

  it('says so plainly when the client owes nothing', () => {
    const facts = buildPaneFacts({
      invoice: makeInvoice({ status: 'paid' }),
      clientInvoices: [makeInvoice({ id: 'i1', status: 'paid' })],
      today: TODAY,
    });
    const client = facts.find((fact) => fact.key === 'client');
    expect(client?.value).toBe('$0.00');
    expect(client?.sub).toBe('No open invoices');
    expect(client?.note).toBeNull();
  });
});

describe('buildPaneActivity', () => {
  it('builds the gutter out of the three timestamps a row actually carries', () => {
    const activity = buildPaneActivity(
      makeInvoice({
        createdAt: '2026-05-26T09:00:00.000Z',
        updatedAt: '2026-06-26T09:00:00.000Z',
        paidAt: '2026-07-09T09:00:00.000Z',
      }),
      TODAY,
    );
    // Newest first, which is how a chase history is read.
    expect(activity.map((entry) => entry.date)).toEqual(['9 Jul', '26 Jun', '26 May']);
    expect(activity[2]?.text).toContain('drafted');
  });

  it('does not repeat an untouched invoice as two identical events', () => {
    expect(buildPaneActivity(makeInvoice(), TODAY)).toHaveLength(1);
  });
});

describe('buildPaneLines', () => {
  it('carries the unit rate alongside the recap the summary already built', () => {
    const lines = buildPaneLines({
      currency: 'USD',
      subtotalCents: 100_000,
      taxCents: 0,
      totalCents: 100_000,
      items: [makeItem()],
    });
    expect(lines.rows[0]?.quantity).toBe('2');
    expect(lines.rows[0]?.amount).toBe('$1,000.00');
    expect(lines.rates.get('li1')).toBe('$500.00');
    expect(lines.total).toBe('$1,000.00');
  });
});
