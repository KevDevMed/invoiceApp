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
import { daysBetween } from './detail';
import { STATUS_OPTIONS } from './format';
import type { ColumnFilterPredicate, ListColumnKey } from './listColumns';
import { isOpenState, matchesSegment, rowStateOf } from './listGrouping';

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
// Column-menu filter chips
// ---------------------------------------------------------------------------

/**
 * One filter applied from a column header menu.
 *
 * The design stores chips as rendered strings (`'STATUS: Overdue only'`). This
 * stores the decision instead: which column it came from, which predicate it
 * means, and the reader's input where the option asked for one. The label is
 * derived (./columnMenu), so two chips are the same chip when they mean the
 * same thing rather than when they happen to print the same.
 */
export interface FilterChip {
  readonly columnKey: ListColumnKey;
  readonly predicate: ColumnFilterPredicate;
  /** The ellipsis options' second step. Absent for options that commit on click. */
  readonly value?: string;
}

/**
 * What a chip needs beyond the invoice itself: the client-name join (the row
 * carries a `clientId`, the reader typed a name) and the set of clients with
 * something open (a set-level fact no per-invoice predicate can see).
 */
export interface ChipContext {
  readonly today: string;
  readonly clientNames: ReadonlyMap<string, string>;
  readonly openClientIds: ReadonlySet<string>;
}

/** En dash. Both range inputs canonicalise to `from – to` with this between. */
const RANGE_SEPARATOR = '–';

/** `1000 – 5000` -> `['1000', '5000']`. Null when it is not a pair. */
export function parseRangeValue(value: string): readonly [string, string] | null {
  const parts = value.split(RANGE_SEPARATOR).map((part) => part.trim());
  const [from, to] = parts;
  if (parts.length !== 2 || from === undefined || to === undefined) return null;
  if (from === '' || to === '') return null;
  return [from, to];
}

/** `from` and `to` joined the one way every range chip stores them. */
export function formatRangeValue(from: string, to: string): string {
  return `${from.trim()} ${RANGE_SEPARATOR} ${to.trim()}`;
}

/** Clients with at least one invoice still owed. Feeds `client-has-open-balance`. */
export function openClientIdsOf(
  invoices: readonly Invoice[],
  today: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const invoice of invoices) {
    if (isOpenState(rowStateOf(invoice, today))) ids.add(invoice.clientId);
  }
  return ids;
}

/** Which calendar quarter an ISO date's month falls in: 1-4. */
function quarterOf(iso: string): number {
  return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
}

function containsFold(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The thresholds behind `Over 10,000` / `Under 1,000`, in integer minor units.
 * Compared against `totalCents` with no currency check — the same knowingly
 * rate-less comparison the existing Amount filter and `total-desc` make, and
 * the reason the labels carry no currency symbol.
 */
const OVER_THRESHOLD_CENTS = 1_000_000;
const UNDER_THRESHOLD_CENTS = 100_000;

/**
 * True when the invoice satisfies one chip.
 *
 * A chip whose option needed a value and does not have one matches everything
 * rather than nothing: a half-built filter should not empty the screen. The
 * input step never commits such a chip, so this is a guard, not a path.
 */
export function matchesChip(invoice: Invoice, chip: FilterChip, context: ChipContext): boolean {
  const clientName = context.clientNames.get(invoice.clientId) ?? invoice.clientId;
  const state = rowStateOf(invoice, context.today);
  const value = chip.value?.trim() ?? '';

  switch (chip.predicate) {
    case 'client-contains':
      return value === '' || containsFold(clientName, value);
    case 'client-any-of': {
      const wanted = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      return wanted.length === 0 || wanted.some((part) => containsFold(clientName, part));
    }
    case 'client-has-open-balance':
      return context.openClientIds.has(invoice.clientId);
    case 'number-contains':
      return value === '' || containsFold(invoice.number, value);

    case 'status-open':
      return isOpenState(state);
    case 'status-overdue':
      return state === 'overdue';
    case 'status-due-soon':
      return state === 'due-soon';
    case 'status-sent':
      // The same reading the Sent tab uses: issued, still open, not yet late.
      return matchesSegment(state, 'sent');
    case 'status-draft':
      return state === 'draft';
    case 'status-paid':
      return state === 'paid';

    case 'issued-this-month':
      return invoice.issueDate.slice(0, 7) === context.today.slice(0, 7);
    case 'issued-last-30-days': {
      const age = daysBetween(invoice.issueDate, context.today);
      return age !== null && age >= 0 && age <= 30;
    }
    case 'issued-this-quarter':
      return (
        invoice.issueDate.slice(0, 4) === context.today.slice(0, 4) &&
        quarterOf(invoice.issueDate) === quarterOf(context.today)
      );
    case 'issued-range': {
      const range = parseRangeValue(value);
      if (range === null) return true;
      const [from, to] = range;
      return invoice.issueDate >= from && invoice.issueDate <= to;
    }

    case 'total-over':
      return invoice.totalCents > OVER_THRESHOLD_CENTS;
    case 'total-under':
      return invoice.totalCents < UNDER_THRESHOLD_CENTS;
    case 'total-between': {
      const range = parseRangeValue(value);
      if (range === null) return true;
      const from = Math.round(Number(range[0]) * 100);
      const to = Math.round(Number(range[1]) * 100);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
      return invoice.totalCents >= from && invoice.totalCents <= to;
    }
    case 'total-currency':
      return value === '' || invoice.currency === value.toUpperCase();
  }
}

/**
 * Every chip ANDed, preserving order and never mutating the input.
 *
 * Applied in the renderer rather than pushed into `toListRequest`: the backend
 * understands a *stored* status, and every status chip here is date-derived
 * (`rowStateOf` re-reads a sent invoice against the clock), so narrowing
 * server-side would silently drop invoices that went late overnight. The view
 * already holds the complete matching set, which is what makes that safe — the
 * same reason the amount and invoice-number filters are client-side.
 */
export function applyChips(
  invoices: readonly Invoice[],
  chips: readonly FilterChip[],
  context: ChipContext,
): Invoice[] {
  if (chips.length === 0) return [...invoices];
  return invoices.filter((invoice) =>
    chips.every((chip) => matchesChip(invoice, chip, context)),
  );
}

// ---------------------------------------------------------------------------
// Sorting
//
// **Not the list's sorter.** `InvoiceList` sorts `ListRow`s with `sortRows` /
// `SortState` from ./listRows; these seven keys order raw `Invoice`s and are
// used by other hosts. The two unions overlap in name only (`issued-desc`
// exists in both with different companions), so importing the wrong one
// typechecks and silently sorts by something else.
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
