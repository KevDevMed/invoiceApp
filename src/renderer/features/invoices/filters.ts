/**
 * Invoice filter plumbing. Pure module: no React, no `window.api`.
 *
 * The inline filter bar (PowerSearch) produces `PowerSearchFilter[]`. Part of
 * that set maps straight onto the `invoices:list` IPC request — the backend
 * understands `search`, a single `status`, a single `clientId` and an
 * `issuedBetween` date range. Everything else (amount comparisons,
 * invoice-number contains, multi-value status) is applied client-side over the
 * complete matching set — the view pages `invoices:list` until it holds every
 * row the backend filter matched, so a client-side filter never judges a mere
 * prefix. Sorting is client-side too.
 *
 * Splitting it this way keeps every decision testable without a DOM or an
 * Electron bridge.
 */

import type {
  DateTimeRange,
  DateTimeRangePart,
  PowerSearchConfig,
  PowerSearchFilter,
} from '@astryxdesign/core/PowerSearch';

import type { Invoice, InvoiceStatus } from '../../../shared/types';
import { STATUS_OPTIONS } from './format';

// ---------------------------------------------------------------------------
// Field and operator keys — the single source of truth shared by the config,
// the request mapper and the client-side predicate.
// ---------------------------------------------------------------------------

export const FIELD_STATUS = 'status';
export const FIELD_CLIENT = 'clientId';
export const FIELD_ISSUED = 'issued';
export const FIELD_AMOUNT = 'amount';
export const FIELD_NUMBER = 'number';

export const OPERATOR_IS = 'is';
export const OPERATOR_ANY_OF = 'any_of';
export const OPERATOR_BETWEEN = 'between';
export const OPERATOR_AT_LEAST = 'at_least';
export const OPERATOR_AT_MOST = 'at_most';
export const OPERATOR_EQUALS = 'equals';
export const OPERATOR_CONTAINS = 'contains';

/** Just enough of a client to name it in the Client field's option list. */
export interface FilterClientOption {
  readonly id: string;
  readonly name: string;
}

/**
 * The `invoices:list` request shape (see src/shared/ipc-contract.ts). Repeated
 * here as a plain interface so this module stays free of zod and of any
 * renderer-only imports.
 */
export interface InvoiceListRequest {
  search?: string;
  status?: InvoiceStatus;
  clientId?: string;
  issuedBetween?: { from?: string; to?: string };
  limit: number;
  offset: number;
}

export interface ListRequestOptions {
  /** Free-text term from the toolbar search input. Trimmed; empty means none. */
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
  /** Reference point for relative date ranges ("last 30 days"). */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// PowerSearch config
// ---------------------------------------------------------------------------

const STATUS_VALUES = STATUS_OPTIONS.map((status) => ({
  value: status,
  label: status.charAt(0).toUpperCase() + status.slice(1),
}));

/**
 * Builds the filter-bar config. The Client field's options come from
 * `clients:list`, so the config is rebuilt whenever that list changes.
 * Field icons are added by the view — this module renders nothing.
 */
export function buildInvoiceSearchConfig(
  clients: readonly FilterClientOption[] = [],
): PowerSearchConfig {
  return {
    name: 'InvoiceFilters',
    fields: [
      {
        key: FIELD_STATUS,
        label: 'Status',
        defaultOperator: OPERATOR_IS,
        typeaheadAliases: ['state', 'paid', 'draft', 'overdue'],
        operators: [
          { key: OPERATOR_IS, label: 'is', value: { type: 'enum', values: STATUS_VALUES } },
          {
            key: OPERATOR_ANY_OF,
            label: 'is any of',
            value: { type: 'enum_list', values: STATUS_VALUES },
          },
        ],
      },
      {
        key: FIELD_CLIENT,
        label: 'Client',
        defaultOperator: OPERATOR_IS,
        typeaheadAliases: ['customer', 'company'],
        operators: [
          {
            key: OPERATOR_IS,
            label: 'is',
            value: {
              type: 'enum',
              values: clients.map((client) => ({ value: client.id, label: client.name })),
            },
          },
        ],
      },
      {
        key: FIELD_ISSUED,
        label: 'Issued',
        defaultOperator: OPERATOR_BETWEEN,
        typeaheadAliases: ['issue date', 'date'],
        operators: [{ key: OPERATOR_BETWEEN, label: 'between', value: { type: 'date_range' } }],
      },
      {
        key: FIELD_AMOUNT,
        label: 'Amount',
        defaultOperator: OPERATOR_AT_MOST,
        typeaheadAliases: ['total', 'value'],
        operators: [
          { key: OPERATOR_AT_LEAST, label: 'at least', value: { type: 'float', minValue: 0 } },
          { key: OPERATOR_AT_MOST, label: 'not more than', value: { type: 'float', minValue: 0 } },
          { key: OPERATOR_EQUALS, label: 'is', value: { type: 'float', minValue: 0 } },
        ],
      },
      {
        key: FIELD_NUMBER,
        label: 'Invoice number',
        defaultOperator: OPERATOR_CONTAINS,
        typeaheadAliases: ['number', 'invoice #', 'reference'],
        operators: [{ key: OPERATOR_CONTAINS, label: 'contains', value: { type: 'string' } }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

const UNIT_MILLIS: Record<'second' | 'minute' | 'hour' | 'day' | 'week', number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolvePart(part: DateTimeRangePart, now: Date): Date {
  switch (part.type) {
    case 'NOW':
      return now;
    case 'ABSOLUTE':
      return new Date(part.unixSeconds * 1000);
    case 'RELATIVE': {
      if (part.unit === 'month' || part.unit === 'year') {
        const shifted = new Date(now.getTime());
        if (part.unit === 'month') shifted.setUTCMonth(shifted.getUTCMonth() - part.backValue);
        else shifted.setUTCFullYear(shifted.getUTCFullYear() - part.backValue);
        return shifted;
      }
      return new Date(now.getTime() - part.backValue * UNIT_MILLIS[part.unit]);
    }
  }
}

/**
 * Flattens a PowerSearch date range into the `{ from, to }` ISO pair the IPC
 * contract expects. Relative parts are resolved against `now`, which the caller
 * supplies so the function stays deterministic.
 */
export function resolveDateRange(range: DateTimeRange, now: Date): { from: string; to: string } {
  const start = resolvePart(range.start, now);
  const end = resolvePart(range.end, now);
  const from = isoDate(start);
  const to = isoDate(end);
  return from <= to ? { from, to } : { from: to, to: from };
}

// ---------------------------------------------------------------------------
// Filter → IPC request
// ---------------------------------------------------------------------------

function isStatus(value: string): value is InvoiceStatus {
  return (STATUS_OPTIONS as string[]).includes(value);
}

/**
 * Maps the active filter tokens onto an `invoices:list` request, using only the
 * fields the backend actually supports. A multi-value status token is pushed to
 * the client side unless it holds exactly one status; everything the backend
 * cannot express is simply left out here and handled by `applyClientFilters`.
 */
export function toListRequest(
  filters: readonly PowerSearchFilter[],
  options: ListRequestOptions,
): InvoiceListRequest {
  const request: InvoiceListRequest = { limit: options.limit, offset: options.offset };

  const search = options.search?.trim() ?? '';
  if (search !== '') request.search = search;

  for (const filter of filters) {
    if (filter.field === FIELD_STATUS && filter.value.type === 'enum') {
      if (isStatus(filter.value.value)) request.status = filter.value.value;
    } else if (filter.field === FIELD_STATUS && filter.value.type === 'enum_list') {
      const [only] = filter.value.value;
      if (filter.value.value.length === 1 && only !== undefined && isStatus(only)) {
        request.status = only;
      }
    } else if (filter.field === FIELD_CLIENT && filter.value.type === 'enum') {
      if (filter.value.value !== '') request.clientId = filter.value.value;
    } else if (filter.field === FIELD_ISSUED && filter.value.type === 'date_range') {
      request.issuedBetween = resolveDateRange(filter.value.value, options.now ?? new Date());
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Filter → client-side predicate
// ---------------------------------------------------------------------------

function amountMatches(invoice: Invoice, operator: string, major: number): boolean {
  const cents = Math.round(major * 100);
  if (operator === OPERATOR_AT_LEAST) return invoice.totalCents >= cents;
  if (operator === OPERATOR_AT_MOST) return invoice.totalCents <= cents;
  if (operator === OPERATOR_EQUALS) return invoice.totalCents === cents;
  return true;
}

/**
 * True when the invoice satisfies every filter this app resolves in the
 * renderer: amount comparisons, invoice-number contains (case-insensitive) and
 * status (single or multi-value). Status is re-checked here even though the
 * backend can narrow a single status — the check is idempotent, so the result
 * is the same whether or not the request carried it.
 */
export function matchesClientFilters(
  invoice: Invoice,
  filters: readonly PowerSearchFilter[],
): boolean {
  for (const filter of filters) {
    if (filter.field === FIELD_STATUS && filter.value.type === 'enum') {
      if (invoice.status !== filter.value.value) return false;
    } else if (filter.field === FIELD_STATUS && filter.value.type === 'enum_list') {
      const wanted = filter.value.value;
      if (wanted.length > 0 && !wanted.includes(invoice.status)) return false;
    } else if (filter.field === FIELD_AMOUNT && filter.value.type === 'float') {
      if (!amountMatches(invoice, filter.operator, filter.value.value)) return false;
    } else if (filter.field === FIELD_AMOUNT && filter.value.type === 'integer') {
      if (!amountMatches(invoice, filter.operator, filter.value.value)) return false;
    } else if (filter.field === FIELD_NUMBER && filter.value.type === 'string') {
      const needle = filter.value.value.trim().toLowerCase();
      if (needle !== '' && !invoice.number.toLowerCase().includes(needle)) return false;
    }
  }
  return true;
}

/** `matchesClientFilters` applied across a list, preserving order. */
export function applyClientFilters(
  invoices: readonly Invoice[],
  filters: readonly PowerSearchFilter[],
): Invoice[] {
  return invoices.filter((invoice) => matchesClientFilters(invoice, filters));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type InvoiceSortKey =
  | 'issued-desc'
  | 'issued-asc'
  | 'due-asc'
  | 'amount-desc'
  | 'amount-asc'
  | 'number-asc'
  | 'number-desc';

export const DEFAULT_SORT: InvoiceSortKey = 'issued-desc';

export const SORT_OPTIONS: readonly { readonly value: InvoiceSortKey; readonly label: string }[] = [
  { value: 'issued-desc', label: 'Newest first' },
  { value: 'issued-asc', label: 'Oldest first' },
  { value: 'due-asc', label: 'Due soonest' },
  { value: 'amount-desc', label: 'Amount: high to low' },
  { value: 'amount-asc', label: 'Amount: low to high' },
  { value: 'number-asc', label: 'Number: A to Z' },
  { value: 'number-desc', label: 'Number: Z to A' },
];

function compare(a: Invoice, b: Invoice, sort: InvoiceSortKey): number {
  switch (sort) {
    case 'issued-desc':
      return b.issueDate.localeCompare(a.issueDate);
    case 'issued-asc':
      return a.issueDate.localeCompare(b.issueDate);
    case 'due-asc':
      return a.dueDate.localeCompare(b.dueDate);
    case 'amount-desc':
      return b.totalCents - a.totalCents;
    case 'amount-asc':
      return a.totalCents - b.totalCents;
    case 'number-asc':
      return a.number.localeCompare(b.number);
    case 'number-desc':
      return b.number.localeCompare(a.number);
  }
}

/**
 * Returns a new sorted array — never mutates the input. Ties fall back to the
 * invoice number so the order is stable across renders.
 */
export function sortInvoices(invoices: readonly Invoice[], sort: InvoiceSortKey): Invoice[] {
  return [...invoices].sort((a, b) => {
    const primary = compare(a, b, sort);
    return primary !== 0 ? primary : a.number.localeCompare(b.number);
  });
}
