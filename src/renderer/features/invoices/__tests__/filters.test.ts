/**
 * Filter plumbing tests. Everything here is pure data in, pure data out — no
 * DOM, no IPC — so the mapping between the filter bar, the `invoices:list`
 * request and the client-side pass is pinned down exactly.
 */

import { describe, expect, it } from 'vitest';

import type { PowerSearchFilter } from '@astryxdesign/core/PowerSearch';

import type { Invoice, InvoiceStatus } from '../../../../shared/types';
import {
  DEFAULT_SORT,
  FIELD_AMOUNT,
  FIELD_CLIENT,
  FIELD_ISSUED,
  FIELD_NUMBER,
  FIELD_STATUS,
  OPERATOR_ANY_OF,
  OPERATOR_AT_LEAST,
  OPERATOR_AT_MOST,
  OPERATOR_BETWEEN,
  OPERATOR_CONTAINS,
  OPERATOR_EQUALS,
  OPERATOR_IS,
  SORT_OPTIONS,
  applyChips,
  applyClientFilters,
  buildInvoiceSearchConfig,
  formatRangeValue,
  matchesChip,
  openClientIdsOf,
  parseRangeValue,
  matchesClientFilters,
  resolveDateRange,
  sortInvoices,
  toListRequest,
} from '../filters';

const NOW = new Date('2026-07-27T12:00:00.000Z');
/** The same instant as a calendar date, for the chip predicates. */
const TODAY = '2026-07-27';

function invoice(patch: Partial<Invoice> = {}): Invoice {
  return {
    id: patch.id ?? 'inv-1',
    number: patch.number ?? 'INV-0001',
    clientId: patch.clientId ?? 'client-1',
    status: patch.status ?? 'draft',
    issueDate: patch.issueDate ?? '2026-01-01',
    dueDate: patch.dueDate ?? '2026-01-31',
    currency: patch.currency ?? 'USD',
    taxRateBps: patch.taxRateBps ?? 0,
    notes: patch.notes ?? null,
    subtotalCents: patch.subtotalCents ?? 10_000,
    taxCents: patch.taxCents ?? 0,
    totalCents: patch.totalCents ?? 10_000,
    paidAt: patch.paidAt ?? null,
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function statusFilter(status: InvoiceStatus): PowerSearchFilter {
  return { field: FIELD_STATUS, operator: OPERATOR_IS, value: { type: 'enum', value: status } };
}
function statusListFilter(statuses: InvoiceStatus[]): PowerSearchFilter {
  return {
    field: FIELD_STATUS,
    operator: OPERATOR_ANY_OF,
    value: { type: 'enum_list', value: statuses },
  };
}
function clientFilter(id: string): PowerSearchFilter {
  return { field: FIELD_CLIENT, operator: OPERATOR_IS, value: { type: 'enum', value: id } };
}
function issuedFilter(from: string, to: string): PowerSearchFilter {
  return {
    field: FIELD_ISSUED,
    operator: OPERATOR_BETWEEN,
    value: {
      type: 'date_range',
      value: {
        start: { type: 'ABSOLUTE', unixSeconds: Date.parse(`${from}T00:00:00.000Z`) / 1000 },
        end: { type: 'ABSOLUTE', unixSeconds: Date.parse(`${to}T00:00:00.000Z`) / 1000 },
      },
    },
  };
}
function amountFilter(operator: string, major: number): PowerSearchFilter {
  return { field: FIELD_AMOUNT, operator, value: { type: 'float', value: major } };
}
function numberFilter(term: string): PowerSearchFilter {
  return {
    field: FIELD_NUMBER,
    operator: OPERATOR_CONTAINS,
    value: { type: 'string', value: term },
  };
}

describe('buildInvoiceSearchConfig', () => {
  it('exposes exactly the five supported fields', () => {
    const config = buildInvoiceSearchConfig([{ id: 'client-1', name: 'Acrocraft' }]);
    expect(config.fields.map((field) => field.key)).toEqual([
      FIELD_STATUS,
      FIELD_CLIENT,
      FIELD_ISSUED,
      FIELD_AMOUNT,
      FIELD_NUMBER,
    ]);
  });

  it('turns the loaded client list into the Client field options', () => {
    const config = buildInvoiceSearchConfig([
      { id: 'client-1', name: 'Acrocraft' },
      { id: 'client-2', name: 'Hyperrise' },
    ]);
    const client = config.fields.find((field) => field.key === FIELD_CLIENT);
    const operator = client?.operators[0];
    expect(operator?.value.type).toBe('enum');
    expect(operator?.value.type === 'enum' ? operator.value.values : []).toEqual([
      { value: 'client-1', label: 'Acrocraft' },
      { value: 'client-2', label: 'Hyperrise' },
    ]);
  });
});

describe('toListRequest — field mapping', () => {
  it('returns only pagination when there are no filters and no search', () => {
    expect(toListRequest([], { limit: 200, offset: 0, now: NOW })).toEqual({
      limit: 200,
      offset: 0,
    });
  });

  it('maps a single-value status token to request.status', () => {
    const request = toListRequest([statusFilter('paid')], { limit: 200, offset: 0, now: NOW });
    expect(request.status).toBe('paid');
  });

  it('maps a one-entry status list to request.status but leaves multi-value out', () => {
    expect(
      toListRequest([statusListFilter(['sent'])], { limit: 200, offset: 0, now: NOW }).status,
    ).toBe('sent');
    expect(
      toListRequest([statusListFilter(['sent', 'paid'])], { limit: 200, offset: 0, now: NOW })
        .status,
    ).toBeUndefined();
  });

  it('maps the client token to request.clientId', () => {
    const request = toListRequest([clientFilter('client-7')], { limit: 50, offset: 0, now: NOW });
    expect(request.clientId).toBe('client-7');
  });

  it('maps the issued date range to request.issuedBetween as ISO dates', () => {
    const request = toListRequest([issuedFilter('2026-03-01', '2026-03-31')], {
      limit: 50,
      offset: 0,
      now: NOW,
    });
    expect(request.issuedBetween).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('trims the free-text term and drops it when empty', () => {
    expect(toListRequest([], { search: '  acme  ', limit: 10, offset: 0, now: NOW }).search).toBe(
      'acme',
    );
    expect(toListRequest([], { search: '   ', limit: 10, offset: 0, now: NOW }).search).toBeUndefined();
  });

  it('leaves amount and invoice-number tokens out of the request entirely', () => {
    const request = toListRequest([amountFilter(OPERATOR_AT_MOST, 50), numberFilter('INV')], {
      limit: 10,
      offset: 0,
      now: NOW,
    });
    expect(request).toEqual({ limit: 10, offset: 0 });
  });

  it('combines status, client, issued and search in one request', () => {
    const request = toListRequest(
      [
        statusFilter('sent'),
        clientFilter('client-2'),
        issuedFilter('2026-01-01', '2026-06-30'),
        amountFilter(OPERATOR_AT_LEAST, 100),
        numberFilter('0042'),
      ],
      { search: 'hyperrise', limit: 200, offset: 0, now: NOW },
    );
    expect(request).toEqual({
      search: 'hyperrise',
      status: 'sent',
      clientId: 'client-2',
      issuedBetween: { from: '2026-01-01', to: '2026-06-30' },
      limit: 200,
      offset: 0,
    });
  });
});

describe('resolveDateRange', () => {
  it('resolves a relative start against now', () => {
    expect(
      resolveDateRange(
        { start: { type: 'RELATIVE', backValue: 7, unit: 'day' }, end: { type: 'NOW' } },
        NOW,
      ),
    ).toEqual({ from: '2026-07-20', to: '2026-07-27' });
  });

  it('resolves a relative month start', () => {
    expect(
      resolveDateRange(
        { start: { type: 'RELATIVE', backValue: 3, unit: 'month' }, end: { type: 'NOW' } },
        NOW,
      ),
    ).toEqual({ from: '2026-04-27', to: '2026-07-27' });
  });

  it('swaps reversed bounds so from is never after to', () => {
    expect(
      resolveDateRange(
        {
          start: { type: 'ABSOLUTE', unixSeconds: Date.parse('2026-05-01T00:00:00Z') / 1000 },
          end: { type: 'ABSOLUTE', unixSeconds: Date.parse('2026-04-01T00:00:00Z') / 1000 },
        },
        NOW,
      ),
    ).toEqual({ from: '2026-04-01', to: '2026-05-01' });
  });
});

describe('matchesClientFilters — amount boundaries', () => {
  const at5000 = invoice({ totalCents: 500_000 });

  it('includes the exact value for "at least"', () => {
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_LEAST, 5000)])).toBe(true);
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_LEAST, 5000.01)])).toBe(false);
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_LEAST, 4999.99)])).toBe(true);
  });

  it('includes the exact value for "not more than"', () => {
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_MOST, 5000)])).toBe(true);
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_MOST, 4999.99)])).toBe(false);
    expect(matchesClientFilters(at5000, [amountFilter(OPERATOR_AT_MOST, 5000.01)])).toBe(true);
  });

  it('compares "is" on exact cents, not floats', () => {
    expect(matchesClientFilters(invoice({ totalCents: 1_010 }), [amountFilter(OPERATOR_EQUALS, 10.1)])).toBe(
      true,
    );
    expect(matchesClientFilters(invoice({ totalCents: 1_011 }), [amountFilter(OPERATOR_EQUALS, 10.1)])).toBe(
      false,
    );
  });
});

describe('matchesClientFilters — invoice number contains', () => {
  it('is case-insensitive in both directions', () => {
    const row = invoice({ number: 'INV-0006' });
    expect(matchesClientFilters(row, [numberFilter('inv-0006')])).toBe(true);
    expect(matchesClientFilters(row, [numberFilter('0006')])).toBe(true);
    expect(matchesClientFilters(invoice({ number: 'inv-2026-14' }), [numberFilter('INV-2026')])).toBe(
      true,
    );
    expect(matchesClientFilters(row, [numberFilter('0007')])).toBe(false);
  });

  it('ignores a whitespace-only term', () => {
    expect(matchesClientFilters(invoice({ number: 'INV-0006' }), [numberFilter('  ')])).toBe(true);
  });
});

describe('matchesClientFilters — status', () => {
  it('accepts any status in a multi-value token', () => {
    const filters = [statusListFilter(['sent', 'overdue'])];
    expect(matchesClientFilters(invoice({ status: 'sent' }), filters)).toBe(true);
    expect(matchesClientFilters(invoice({ status: 'overdue' }), filters)).toBe(true);
    expect(matchesClientFilters(invoice({ status: 'paid' }), filters)).toBe(false);
  });

  it('re-checks a single status token idempotently', () => {
    expect(matchesClientFilters(invoice({ status: 'paid' }), [statusFilter('paid')])).toBe(true);
    expect(matchesClientFilters(invoice({ status: 'draft' }), [statusFilter('paid')])).toBe(false);
  });
});

describe('applyClientFilters', () => {
  const rows = [
    invoice({ id: 'a', number: 'INV-0001', status: 'sent', totalCents: 100_000 }),
    invoice({ id: 'b', number: 'INV-0002', status: 'paid', totalCents: 600_000 }),
    invoice({ id: 'c', number: 'ACME-0003', status: 'sent', totalCents: 400_000 }),
    invoice({ id: 'd', number: 'INV-0004', status: 'draft', totalCents: 50_000 }),
  ];

  it('returns every row when no filters are active', () => {
    expect(applyClientFilters(rows, []).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ANDs several filters together and keeps input order', () => {
    const kept = applyClientFilters(rows, [
      statusListFilter(['sent', 'paid']),
      amountFilter(OPERATOR_AT_MOST, 5000),
      numberFilter('inv'),
    ]);
    expect(kept.map((row) => row.id)).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    applyClientFilters(rows, [statusFilter('paid')]);
    expect(rows).toEqual(copy);
  });
});

describe('sortInvoices', () => {
  const rows = [
    invoice({ id: 'a', number: 'INV-0002', issueDate: '2026-02-01', dueDate: '2026-03-05', totalCents: 300 }),
    invoice({ id: 'b', number: 'INV-0001', issueDate: '2026-03-01', dueDate: '2026-03-02', totalCents: 100 }),
    invoice({ id: 'c', number: 'INV-0003', issueDate: '2026-01-01', dueDate: '2026-04-01', totalCents: 200 }),
  ];

  it('defaults to newest issued first', () => {
    expect(sortInvoices(rows, DEFAULT_SORT).map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts oldest issued first', () => {
    expect(sortInvoices(rows, 'issued-asc').map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('sorts by due date soonest', () => {
    expect(sortInvoices(rows, 'due-asc').map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by amount in both directions', () => {
    expect(sortInvoices(rows, 'amount-desc').map((row) => row.id)).toEqual(['a', 'c', 'b']);
    expect(sortInvoices(rows, 'amount-asc').map((row) => row.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by number in both directions', () => {
    expect(sortInvoices(rows, 'number-asc').map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(sortInvoices(rows, 'number-desc').map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('breaks ties on the invoice number and never mutates the input', () => {
    const tied = [
      invoice({ id: 'x', number: 'INV-9', issueDate: '2026-05-01' }),
      invoice({ id: 'y', number: 'INV-1', issueDate: '2026-05-01' }),
    ];
    const copy = [...tied];
    expect(sortInvoices(tied, 'issued-desc').map((row) => row.id)).toEqual(['y', 'x']);
    expect(tied).toEqual(copy);
  });

  it('offers a label for every sort key it can be given', () => {
    for (const option of SORT_OPTIONS) {
      expect(sortInvoices(rows, option.value)).toHaveLength(rows.length);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Column-menu chips
// ---------------------------------------------------------------------------

describe('range values', () => {
  it('round-trips a pair through one canonical form', () => {
    expect(parseRangeValue(formatRangeValue('1000', '5000'))).toEqual(['1000', '5000']);
    expect(formatRangeValue(' 2026-01-01 ', '2026-03-31 ')).toBe('2026-01-01 – 2026-03-31');
  });

  it('refuses anything that is not a pair', () => {
    expect(parseRangeValue('1000')).toBe(null);
    expect(parseRangeValue('1000 – ')).toBe(null);
    expect(parseRangeValue('1 – 2 – 3')).toBe(null);
  });
});

describe('openClientIdsOf', () => {
  it('names only the clients with something still owed', () => {
    const ids = openClientIdsOf(
      [
        invoice({ id: 'a', clientId: 'c1', status: 'sent', dueDate: '2026-08-01' }),
        invoice({ id: 'b', clientId: 'c2', status: 'paid' }),
        invoice({ id: 'c', clientId: 'c3', status: 'draft' }),
      ],
      TODAY,
    );
    expect([...ids]).toEqual(['c1']);
  });
});

describe('matchesChip', () => {
  const NAMES = new Map([
    ['c1', 'Halcyon Systems'],
    ['c2', 'Northwind Analytics'],
  ]);
  const context = {
    today: TODAY,
    clientNames: NAMES,
    openClientIds: new Set(['c1']),
  };
  const match = (
    predicate: Parameters<typeof matchesChip>[1]['predicate'],
    patch: Partial<Invoice> = {},
    value?: string,
  ): boolean =>
    matchesChip(invoice(patch), { columnKey: 'status', predicate, value }, context);

  it('matches a client name case-insensitively', () => {
    expect(match('client-contains', { clientId: 'c1' }, 'halcyon')).toBe(true);
    expect(match('client-contains', { clientId: 'c2' }, 'halcyon')).toBe(false);
  });

  it('matches any of a comma-separated list of clients', () => {
    expect(match('client-any-of', { clientId: 'c2' }, 'Halcyon, Northwind')).toBe(true);
    expect(match('client-any-of', { clientId: 'c2' }, 'Halcyon, Acme')).toBe(false);
  });

  it('reads "has open balance" off the set-level fact, not off the row', () => {
    // The paid invoice still matches: its *client* has something open.
    expect(match('client-has-open-balance', { clientId: 'c1', status: 'paid' })).toBe(true);
    expect(match('client-has-open-balance', { clientId: 'c2', status: 'sent' })).toBe(false);
  });

  it('matches an invoice number substring', () => {
    expect(match('number-contains', { number: 'INV-2026-0042' }, 'inv-2026')).toBe(true);
    expect(match('number-contains', { number: 'INV-2026-0042' }, '9999')).toBe(false);
  });

  it('reads status against the clock, not against the stored flag', () => {
    // Sent, past its due date, never restated: overdue this morning regardless.
    const late = { status: 'sent' as InvoiceStatus, dueDate: '2026-07-01' };
    expect(match('status-overdue', late)).toBe(true);
    expect(match('status-open', late)).toBe(true);
    expect(match('status-sent', late)).toBe(false);
  });

  it('separates the status buckets the tiles and the tabs use', () => {
    expect(match('status-due-soon', { status: 'sent', dueDate: '2026-08-01' })).toBe(true);
    expect(match('status-sent', { status: 'sent', dueDate: '2026-12-01' })).toBe(true);
    expect(match('status-draft', { status: 'draft' })).toBe(true);
    expect(match('status-paid', { status: 'paid' })).toBe(true);
    expect(match('status-open', { status: 'paid' })).toBe(false);
    expect(match('status-open', { status: 'draft' })).toBe(false);
  });

  it('reads the issued windows off the calendar', () => {
    // TODAY is 2026-07-27.
    expect(match('issued-this-month', { issueDate: '2026-07-02' })).toBe(true);
    expect(match('issued-this-month', { issueDate: '2026-06-30' })).toBe(false);
    expect(match('issued-last-30-days', { issueDate: '2026-07-01' })).toBe(true);
    expect(match('issued-last-30-days', { issueDate: '2026-05-01' })).toBe(false);
    // A future issue date is not "the last 30 days".
    expect(match('issued-last-30-days', { issueDate: '2026-08-01' })).toBe(false);
    expect(match('issued-this-quarter', { issueDate: '2026-09-30' })).toBe(true);
    expect(match('issued-this-quarter', { issueDate: '2026-06-30' })).toBe(false);
    expect(match('issued-this-quarter', { issueDate: '2025-08-01' })).toBe(false);
  });

  it('matches an inclusive custom issued range', () => {
    const range = formatRangeValue('2026-01-01', '2026-03-31');
    expect(match('issued-range', { issueDate: '2026-01-01' }, range)).toBe(true);
    expect(match('issued-range', { issueDate: '2026-03-31' }, range)).toBe(true);
    expect(match('issued-range', { issueDate: '2026-04-01' }, range)).toBe(false);
  });

  it('compares totals as integer cents at the stated thresholds', () => {
    expect(match('total-over', { totalCents: 1_000_001 })).toBe(true);
    expect(match('total-over', { totalCents: 1_000_000 })).toBe(false);
    expect(match('total-under', { totalCents: 99_999 })).toBe(true);
    expect(match('total-under', { totalCents: 100_000 })).toBe(false);
  });

  it('matches an inclusive money range, in major units', () => {
    const range = formatRangeValue('1000', '5000');
    expect(match('total-between', { totalCents: 100_000 }, range)).toBe(true);
    expect(match('total-between', { totalCents: 500_000 }, range)).toBe(true);
    expect(match('total-between', { totalCents: 99_999 }, range)).toBe(false);
    expect(match('total-between', { totalCents: 500_001 }, range)).toBe(false);
  });

  it('matches a currency by code, case-insensitively', () => {
    expect(match('total-currency', { currency: 'EUR' }, 'eur')).toBe(true);
    expect(match('total-currency', { currency: 'USD' }, 'EUR')).toBe(false);
  });

  it('matches everything rather than nothing when a value is missing', () => {
    // A half-built filter must not empty the screen. The input step never
    // commits one, so this is a guard rather than a path.
    expect(match('client-contains', { clientId: 'c2' })).toBe(true);
    expect(match('total-between', { totalCents: 1 }, 'not a range')).toBe(true);
    expect(match('issued-range', { issueDate: '2020-01-01' }, '')).toBe(true);
  });
});

describe('applyChips', () => {
  const context = {
    today: TODAY,
    clientNames: new Map([['c1', 'Halcyon']]),
    openClientIds: new Set<string>(),
  };
  const invoices = [
    invoice({ id: 'a', status: 'draft', totalCents: 50_000 }),
    invoice({ id: 'b', status: 'sent', dueDate: '2026-07-01', totalCents: 2_000_000 }),
    invoice({ id: 'c', status: 'paid', totalCents: 2_000_000 }),
  ];

  it('returns a copy of the list when there is nothing to apply', () => {
    const result = applyChips(invoices, [], context);
    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(result).not.toBe(invoices);
  });

  it('ANDs every chip and preserves order', () => {
    const result = applyChips(
      invoices,
      [
        { columnKey: 'status', predicate: 'status-open' },
        { columnKey: 'total', predicate: 'total-over' },
      ],
      context,
    );
    expect(result.map((item) => item.id)).toEqual(['b']);
  });

  it('does not mutate its input', () => {
    const before = invoices.map((item) => item.id);
    applyChips(invoices, [{ columnKey: 'status', predicate: 'status-paid' }], context);
    expect(invoices.map((item) => item.id)).toEqual(before);
  });
});
