/**
 * Pure draft logic for the client form: draft <-> ClientInput mapping and
 * pre-IPC validation. Kept free of React so it can run under the node
 * vitest environment.
 */

import type { Client, ClientInput } from '../../../shared/types';

export interface ClientDraft {
  name: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  taxId: string;
  notes: string;
}

export interface DraftErrors {
  name?: string;
  email?: string;
}

export function toDraft(client: Client | null): ClientDraft {
  return {
    name: client?.name ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    addressLine1: client?.addressLine1 ?? '',
    addressLine2: client?.addressLine2 ?? '',
    city: client?.city ?? '',
    region: client?.region ?? '',
    postalCode: client?.postalCode ?? '',
    country: client?.country ?? '',
    taxId: client?.taxId ?? '',
    notes: client?.notes ?? '',
  };
}

export function toInput(draft: ClientDraft): ClientInput {
  const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    name: draft.name.trim(),
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    addressLine1: orNull(draft.addressLine1),
    addressLine2: orNull(draft.addressLine2),
    city: orNull(draft.city),
    region: orNull(draft.region),
    postalCode: orNull(draft.postalCode),
    country: orNull(draft.country),
    taxId: orNull(draft.taxId),
    notes: orNull(draft.notes),
  };
}

/**
 * Loose shape check mirroring the zod `email()` gate on the main process:
 * one @ with something on both sides and a dot in the domain. Catches
 * obvious non-addresses before the IPC round-trip without rejecting
 * unusual-but-plausible ones.
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Name is the only hard requirement; a non-empty email must look like one. */
export function validateDraft(draft: ClientDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.name.trim() === '') {
    errors.name = 'A client needs a name.';
  }
  const email = draft.email.trim();
  if (email !== '' && !isValidEmail(email)) {
    errors.email = 'This does not look like an email address.';
  }
  return errors;
}
