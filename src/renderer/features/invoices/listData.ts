/**
 * The one IPC sweep the triage pane needs that the list itself does not.
 *
 * Shared by both hosts of the pane — the cockpit and `/invoices/:id` — so the
 * "Client balance" fact is computed over the same set on either screen. Not
 * unit-tested: it is a paging loop over `window.api`, and the arithmetic it
 * feeds lives in ./listPane where the node-only vitest project can reach it.
 */

import type { Invoice } from '../../../shared/types';

/** Page size for the client sweep. The contract caps `limit` at 500. */
const CLIENT_PAGE_SIZE = 200;

/**
 * Every invoice of one client, paged out so the balance is over the whole set
 * rather than over the first window of it.
 */
export async function fetchClientInvoices(clientId: string): Promise<Invoice[]> {
  const items: Invoice[] = [];
  let total = 0;
  do {
    const result = await window.api.invoke('invoices:list', {
      clientId,
      limit: CLIENT_PAGE_SIZE,
      offset: items.length,
    });
    if (result.items.length === 0) break;
    items.push(...result.items);
    total = result.total;
  } while (items.length < total);
  return items;
}
