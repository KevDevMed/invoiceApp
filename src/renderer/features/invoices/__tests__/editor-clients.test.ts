/**
 * The editor's client-side derivations: folding a client saved in the inline
 * dialog into the list without a re-fetch, and the two read-only values the
 * details section shows next to the customer and the dates.
 *
 * No DOM here (vitest runs in `node`), which is why these are exported
 * functions rather than logic inlined in the component.
 */

import { describe, expect, it } from 'vitest';

import type { Client } from '../../../../shared/types';
import { billingAddressFor, paymentTermsLabel, upsertClient } from '../InvoiceEditor';

function client(partial: Partial<Client> & { id: string; name: string }): Client {
  return {
    email: null,
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    taxId: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Client;
}

const acme = client({ id: 'c2', name: 'Acme' });
const northwind = client({ id: 'c3', name: 'Northwind' });
const zenith = client({ id: 'c9', name: 'Zenith' });

describe('upsertClient', () => {
  it('inserts a new client where the repository ordering would put it', () => {
    const next = upsertClient([acme, zenith], northwind);
    expect(next.map((entry) => entry.name)).toEqual(['Acme', 'Northwind', 'Zenith']);
  });

  it('inserts at the front and at the back', () => {
    expect(upsertClient([northwind, zenith], acme).map((entry) => entry.id)).toEqual([
      'c2',
      'c3',
      'c9',
    ]);
    expect(upsertClient([acme, northwind], zenith).map((entry) => entry.id)).toEqual([
      'c2',
      'c3',
      'c9',
    ]);
  });

  it('orders case-insensitively, like ORDER BY name COLLATE NOCASE', () => {
    const lower = client({ id: 'c5', name: 'aardvark' });
    expect(upsertClient([acme, zenith], lower).map((entry) => entry.name)).toEqual([
      'aardvark',
      'Acme',
      'Zenith',
    ]);
  });

  it('breaks a name tie on id, like the repository does', () => {
    const twin = client({ id: 'c1', name: 'Acme' });
    expect(upsertClient([acme], twin).map((entry) => entry.id)).toEqual(['c1', 'c2']);
    const later = client({ id: 'c7', name: 'Acme' });
    expect(upsertClient([acme], later).map((entry) => entry.id)).toEqual(['c2', 'c7']);
  });

  it('replaces in place when the id is already in the list — no duplicate row', () => {
    const renamed = client({ id: 'c3', name: 'Northwind Analytics', email: 'ops@northwind.test' });
    const next = upsertClient([acme, northwind, zenith], renamed);
    expect(next).toHaveLength(3);
    expect(next[1]).toBe(renamed);
    expect(next.map((entry) => entry.id)).toEqual(['c2', 'c3', 'c9']);
  });

  it('never mutates the list it was given', () => {
    const before = [acme, zenith];
    const next = upsertClient(before, northwind);
    expect(before.map((entry) => entry.id)).toEqual(['c2', 'c9']);
    expect(next).not.toBe(before);
  });

  it('handles the first client ever created', () => {
    expect(upsertClient([], acme)).toEqual([acme]);
  });
});

describe('billingAddressFor', () => {
  it('is null with no client', () => {
    expect(billingAddressFor(null)).toBeNull();
  });

  it('is null when the client has no address parts at all', () => {
    expect(billingAddressFor(acme)).toBeNull();
  });

  it('skips blank and whitespace-only parts', () => {
    const withAddress = client({
      id: 'c4',
      name: 'Vertex',
      addressLine1: '12 Mill Road',
      addressLine2: '   ',
      city: 'Bristol',
      postalCode: 'BS1 4TR',
      country: 'UK',
    });
    expect(billingAddressFor(withAddress)).toBe('12 Mill Road, Bristol, BS1 4TR, UK');
  });
});

describe('paymentTermsLabel', () => {
  it('reads the same day as due on receipt', () => {
    expect(paymentTermsLabel('2026-07-28', '2026-07-28')).toBe('Due on receipt');
  });

  it('reads a later due date as a net term', () => {
    expect(paymentTermsLabel('2026-07-28', '2026-08-11')).toBe('Net 14');
  });

  it('refuses to invent a term for a due date before the issue date', () => {
    expect(paymentTermsLabel('2026-07-28', '2026-07-27')).toBe('—');
  });

  it('refuses to invent a term for an unparseable date', () => {
    expect(paymentTermsLabel('', '2026-07-28')).toBe('—');
  });
});
