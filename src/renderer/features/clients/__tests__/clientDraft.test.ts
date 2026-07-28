import { describe, expect, it } from 'vitest';

import type { Client } from '../../../../shared/types';
import { isValidEmail, toDraft, toInput, validateDraft } from '../clientDraft';

const CLIENT: Client = {
  id: 'c1',
  name: 'Acme GmbH',
  email: 'billing@acme.test',
  phone: null,
  addressLine1: 'Hauptstr. 1',
  addressLine2: null,
  city: 'Berlin',
  region: null,
  postalCode: '10115',
  country: 'DE',
  taxId: 'DE123456789',
  notes: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('toDraft', () => {
  it('maps null client to all-empty strings', () => {
    const draft = toDraft(null);
    expect(Object.values(draft).every((v) => v === '')).toBe(true);
  });

  it('maps client fields, null becomes empty string', () => {
    const draft = toDraft(CLIENT);
    expect(draft.name).toBe('Acme GmbH');
    expect(draft.email).toBe('billing@acme.test');
    expect(draft.phone).toBe('');
    expect(draft.region).toBe('');
    expect(draft.postalCode).toBe('10115');
  });
});

describe('toInput', () => {
  it('trims values and turns empty/whitespace into null', () => {
    const input = toInput({
      ...toDraft(null),
      name: '  Acme  ',
      email: ' billing@acme.test ',
      phone: '   ',
    });
    expect(input.name).toBe('Acme');
    expect(input.email).toBe('billing@acme.test');
    expect(input.phone).toBeNull();
    expect(input.city).toBeNull();
    expect(input.notes).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('accepts plausible addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.domain.example')).toBe(true);
  });

  it('rejects obvious non-addresses', () => {
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.de')).toBe(false);
    expect(isValidEmail('@c.de')).toBe(false);
    expect(isValidEmail('a@')).toBe(false);
  });
});

describe('validateDraft', () => {
  it('requires a name', () => {
    const errors = validateDraft({ ...toDraft(null), name: '   ' });
    expect(errors.name).toBe('A client needs a name.');
    expect(errors.email).toBeUndefined();
  });

  it('flags a non-empty malformed email', () => {
    const errors = validateDraft({ ...toDraft(null), name: 'Acme', email: 'not-an-email' });
    expect(errors.name).toBeUndefined();
    expect(errors.email).toBe('This does not look like an email address.');
  });

  it('empty email is fine and a valid draft has no errors', () => {
    expect(validateDraft({ ...toDraft(null), name: 'Acme' })).toEqual({});
    expect(validateDraft({ ...toDraft(null), name: 'Acme', email: 'a@b.co' })).toEqual({});
  });
});
