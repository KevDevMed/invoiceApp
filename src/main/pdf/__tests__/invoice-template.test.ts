import { describe, expect, it } from 'vitest';

import type { Client, InvoiceWithItems } from '../../../shared/types';
import { escapeHtml, renderInvoiceHtml } from '../invoice-template';

const NOW = '2026-03-01T00:00:00.000Z';

const CLIENT: Client = {
  id: 'client-1',
  name: 'Acme & Sons',
  email: 'billing@acme.example',
  phone: null,
  addressLine1: '1 Main St',
  addressLine2: null,
  city: 'Springfield',
  region: 'IL',
  postalCode: '62701',
  country: 'USA',
  taxId: null,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const INVOICE: InvoiceWithItems = {
  id: 'invoice-1',
  number: 'INV-0042',
  clientId: 'client-1',
  status: 'sent',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  currency: 'USD',
  taxRateBps: 875,
  notes: 'Payable within 30 days.',
  subtotalCents: 125_000,
  taxCents: 10_938,
  totalCents: 135_938,
  paidAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  items: [
    {
      id: 'item-1',
      invoiceId: 'invoice-1',
      position: 0,
      description: 'Design sprint',
      quantityMilli: 2500,
      unitPriceCents: 12_000,
      amountCents: 30_000,
    },
    {
      id: 'item-2',
      invoiceId: 'invoice-1',
      position: 1,
      description: 'Development retainer',
      quantityMilli: 10_000,
      unitPriceCents: 9_500,
      amountCents: 95_000,
    },
  ],
  client: CLIENT,
};

const BUSINESS = { name: 'Flow Source LLC', address: '9 Harbor Way\nOakland, CA' };

describe('renderInvoiceHtml', () => {
  it('contains the number, client name, every line description, and the formatted total', () => {
    const html = renderInvoiceHtml(INVOICE, CLIENT, BUSINESS);
    expect(html).toContain('INV-0042');
    expect(html).toContain('Acme &amp; Sons');
    expect(html).toContain('Design sprint');
    expect(html).toContain('Development retainer');
    expect(html).toContain('$1,359.38'); // total, en-US USD formatting
    expect(html).toContain('$1,250.00'); // subtotal
    expect(html).toContain('$109.38'); // tax
    expect(html).toContain('8.75'); // tax rate percent
    expect(html).toContain('Payable within 30 days.');
    expect(html).toContain('Flow Source LLC');
  });

  it('escapes an HTML-injecting client name instead of executing it', () => {
    const hostile: Client = { ...CLIENT, name: '<script>alert("pwned")</script> GmbH' };
    const html = renderInvoiceHtml({ ...INVOICE, client: hostile }, hostile, BUSINESS);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt; GmbH');
  });

  it('escapes hostile item descriptions and notes too', () => {
    const html = renderInvoiceHtml(
      {
        ...INVOICE,
        notes: '<img src=x onerror=alert(1)>',
        items: [{ ...INVOICE.items[0]!, description: '"><iframe src=evil>' }],
      },
      CLIENT,
      BUSINESS,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&quot;&gt;&lt;iframe src=evil&gt;');
  });

  it('references no remote assets', () => {
    const html = renderInvoiceHtml(INVOICE, CLIENT, BUSINESS);
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('escapeHtml', () => {
  it('escapes all five significant characters', () => {
    expect(escapeHtml(`<a href="x" data-y='&'>`)).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;&amp;&#39;&gt;',
    );
  });
});
