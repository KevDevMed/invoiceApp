/**
 * Pure row derivation for the clients table, kept out of the component so it
 * can be unit-tested in the node vitest project.
 */

import type { Client } from '../../../shared/types';

export interface ClientTableRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  client: Client;
}

export function toRow(client: Client): ClientTableRow {
  return {
    id: client.id,
    name: client.name,
    email: client.email ?? '—',
    phone: client.phone ?? '—',
    location: [client.city, client.country].filter(Boolean).join(', ') || '—',
    client,
  };
}
