import { describe, expect, it } from 'vitest';

import type { Client } from '../../../../shared/types';
import { toRow } from '../rows';

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Acme Corp',
    email: 'billing@acme.test',
    phone: '+1 555 0100',
    addressLine1: null,
    addressLine2: null,
    city: 'Lisbon',
    region: null,
    postalCode: null,
    country: 'Portugal',
    taxId: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toRow', () => {
  it('maps a fully populated client', () => {
    const client = makeClient();
    const row = toRow(client);
    expect(row).toMatchObject({
      id: 'c1',
      name: 'Acme Corp',
      email: 'billing@acme.test',
      phone: '+1 555 0100',
      location: 'Lisbon, Portugal',
    });
    expect(row.client).toBe(client);
  });

  it('renders em dashes for missing email and phone', () => {
    const row = toRow(makeClient({ email: null, phone: null }));
    expect(row.email).toBe('—');
    expect(row.phone).toBe('—');
  });

  it('uses only the city when country is missing', () => {
    expect(toRow(makeClient({ country: null })).location).toBe('Lisbon');
  });

  it('uses only the country when city is missing', () => {
    expect(toRow(makeClient({ city: null })).location).toBe('Portugal');
  });

  it('renders an em dash when both city and country are missing', () => {
    expect(toRow(makeClient({ city: null, country: null })).location).toBe('—');
  });
});
