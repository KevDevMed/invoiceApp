import { describe, expect, it } from 'vitest';

import { formatCents } from '../../../../shared/money';
import type { Client } from '../../../../shared/types';
import {
  buildDocumentModel,
  formatDocumentDate,
  netTermDays,
  type DocumentModelInput,
} from '../document';
import { money } from '../format';

// `money()` carries no pinned locale, so a literal '$1,620.00' would assert the
// host machine's Intl defaults rather than this module. Currency expectations
// therefore name the cents value they expect — the part this module decides —
// and let the shared formatter render it.

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Acme Corp',
    email: 'billing@acme.test',
    phone: '+1 555 0100',
    addressLine1: '12 Rua da Prata',
    addressLine2: 'Floor 3',
    city: 'Lisbon',
    region: 'Lisboa',
    postalCode: '1100-052',
    country: 'Portugal',
    taxId: 'PT123456789',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInput(overrides: Partial<DocumentModelInput> = {}): DocumentModelInput {
  return {
    number: 'INV-0007',
    status: 'sent',
    issueDate: '2026-01-29',
    dueDate: '2026-02-12',
    currency: 'USD',
    taxRateBps: 825,
    notes: 'Thanks for your business.',
    items: [
      { description: 'Design retainer', quantityMilli: 10_000, unitPriceCents: 15_000 },
      { description: 'Extra revision', quantityMilli: 1500, unitPriceCents: 8000 },
    ],
    totals: { subtotalCents: 162_000, taxCents: 13_365, totalCents: 175_365 },
    client: makeClient(),
    business: { name: 'Flowsrc Studio', address: '9 Baker Street, London' },
    ...overrides,
  };
}

describe('formatDocumentDate', () => {
  it('formats a January date', () => {
    expect(formatDocumentDate('2026-01-29')).toBe('29 January 2026');
  });

  it('formats a December date', () => {
    expect(formatDocumentDate('2025-12-01')).toBe('1 December 2025');
  });

  it('returns garbage input unchanged', () => {
    expect(formatDocumentDate('not-a-date')).toBe('not-a-date');
    expect(formatDocumentDate('')).toBe('');
    expect(formatDocumentDate('2026-13-01')).toBe('2026-13-01');
    expect(formatDocumentDate('2026-02-31')).toBe('2026-02-31');
  });
});

describe('netTermDays', () => {
  it('is 0 when the invoice is due the day it is issued', () => {
    expect(netTermDays('2026-01-29', '2026-01-29')).toBe(0);
  });

  it('counts whole days across a month boundary', () => {
    expect(netTermDays('2026-01-29', '2026-02-12')).toBe(14);
  });

  it('is negative when the due date precedes the issue date', () => {
    expect(netTermDays('2026-01-29', '2026-01-27')).toBe(-2);
  });

  it('is null when either date is unparseable', () => {
    expect(netTermDays('nope', '2026-02-12')).toBeNull();
    expect(netTermDays('2026-01-29', 'nope')).toBeNull();
  });
});

describe('buildDocumentModel', () => {
  it('maps a fully populated invoice', () => {
    const model = buildDocumentModel(makeInput());
    expect(model).toMatchObject({
      number: 'INV-0007',
      status: 'sent',
      issueDate: '29 January 2026',
      dueDate: '12 February 2026',
      paymentTerms: 'Net 14',
      subtotal: money(162_000, 'USD'),
      taxLabel: 'Tax (8.25%)',
      tax: money(13_365, 'USD'),
      total: money(175_365, 'USD'),
      notes: 'Thanks for your business.',
      currency: 'USD',
    });
    expect(model.billedBy).toEqual({
      name: 'Flowsrc Studio',
      address: '9 Baker Street, London',
      taxId: null,
    });
    expect(model.billedTo).toEqual({
      name: 'Acme Corp',
      address: '12 Rua da Prata, Floor 3, Lisbon, Lisboa, 1100-052, Portugal',
      taxId: 'PT123456789',
    });
  });

  it('derives line rows with stable index keys and integer line amounts', () => {
    const model = buildDocumentModel(makeInput());
    expect(model.lines).toEqual([
      {
        key: 'line-0',
        description: 'Design retainer',
        quantity: '10',
        unitPrice: money(15_000, 'USD'),
        // 10 units x $150.00, via the integer lineAmountCents path.
        amount: money(150_000, 'USD'),
      },
      {
        key: 'line-1',
        description: 'Extra revision',
        quantity: '1.5',
        unitPrice: money(8000, 'USD'),
        // 1.5 x $80.00 = $120.00 exactly — no float drift.
        amount: money(12_000, 'USD'),
      },
    ]);
    // Anchor the cents the money() expectations above stand for, so a wrong
    // line amount cannot hide behind the formatter on both sides.
    expect(formatCents(12_000)).toBe('120.00');
    expect(formatCents(150_000)).toBe('1500.00');
  });

  it('renders an em dash number and no client for a fresh draft', () => {
    const model = buildDocumentModel(
      makeInput({ number: null, client: null, status: 'draft', notes: null }),
    );
    expect(model.number).toBe('—');
    expect(model.billedTo).toBeNull();
    expect(model.status).toBe('draft');
    expect(model.notes).toBeNull();
  });

  it('still renders a tax row at a zero rate', () => {
    const model = buildDocumentModel(
      makeInput({
        taxRateBps: 0,
        totals: { subtotalCents: 162_000, taxCents: 0, totalCents: 162_000 },
      }),
    );
    expect(model.taxLabel).toBe('Tax (0.00%)');
    expect(model.tax).toBe(money(0, 'USD'));
  });

  it('says "Due on receipt" when the terms are zero days', () => {
    expect(buildDocumentModel(makeInput({ dueDate: '2026-01-29' })).paymentTerms).toBe(
      'Due on receipt',
    );
  });

  it('falls back to an em dash for negative or unparseable terms', () => {
    expect(buildDocumentModel(makeInput({ dueDate: '2026-01-27' })).paymentTerms).toBe('—');
    expect(buildDocumentModel(makeInput({ dueDate: 'nope' })).paymentTerms).toBe('—');
  });

  it('falls back to "Your business" when the business name is null or blank', () => {
    expect(
      buildDocumentModel(makeInput({ business: { name: null, address: null } })).billedBy,
    ).toEqual({ name: 'Your business', address: null, taxId: null });
    expect(
      buildDocumentModel(makeInput({ business: { name: '   ', address: null } })).billedBy.name,
    ).toBe('Your business');
  });

  it('composes a client address from only the fields that are present', () => {
    const cityOnly = buildDocumentModel(
      makeInput({
        client: makeClient({
          addressLine1: null,
          addressLine2: null,
          region: null,
          postalCode: null,
          country: null,
        }),
      }),
    );
    expect(cityOnly.billedTo?.address).toBe('Lisbon');
  });

  it('leaves the client address null when every part is missing or blank', () => {
    const model = buildDocumentModel(
      makeInput({
        client: makeClient({
          addressLine1: null,
          addressLine2: '  ',
          city: null,
          region: null,
          postalCode: null,
          country: null,
          taxId: null,
        }),
      }),
    );
    expect(model.billedTo).toEqual({ name: 'Acme Corp', address: null, taxId: null });
  });

  it('formats every currency figure in the invoice currency', () => {
    const model = buildDocumentModel(makeInput({ currency: 'EUR' }));
    expect(model.total).toBe(money(175_365, 'EUR'));
    expect(model.lines[0]?.amount).toBe(money(150_000, 'EUR'));
    // Same figures, different currency: the strings must actually differ.
    expect(model.total).not.toBe(money(175_365, 'USD'));
  });
});
