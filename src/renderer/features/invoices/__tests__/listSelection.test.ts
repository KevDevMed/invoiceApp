import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import {
  retainVisible,
  selectAllValue,
  setSelectedForRows,
  summariseSelection,
  toggleSelected,
} from '../listSelection';
import type { SelectableRow } from '../listSelection';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-06-11',
    dueDate: '2026-06-25',
    currency: 'USD',
    taxRateBps: 0,
    notes: null,
    subtotalCents: 100_000,
    taxCents: 0,
    totalCents: 100_000,
    paidAt: null,
    createdAt: '2026-05-26T09:00:00.000Z',
    updatedAt: '2026-05-26T09:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Partial<Invoice>): SelectableRow {
  const invoice = makeInvoice(overrides);
  return { id: invoice.id, invoice };
}

const ROWS: readonly SelectableRow[] = [
  row({ id: 'a', number: 'INV-0001', status: 'sent', totalCents: 3_589_468 }),
  row({ id: 'b', number: 'INV-0002', status: 'overdue', totalCents: 3_600_000 }),
  row({ id: 'c', number: 'INV-0003', status: 'draft' }),
  row({ id: 'd', number: 'INV-0004', status: 'paid' }),
];

/** Two pages of the same result set — what pagination hands the header. */
const PAGE_ONE: readonly SelectableRow[] = [
  row({ id: 'p1a', number: 'INV-0101' }),
  row({ id: 'p1b', number: 'INV-0102' }),
  row({ id: 'p1c', number: 'INV-0103' }),
];

const PAGE_TWO: readonly SelectableRow[] = [
  row({ id: 'p2a', number: 'INV-0201' }),
  row({ id: 'p2b', number: 'INV-0202' }),
  row({ id: 'p2c', number: 'INV-0203' }),
];

describe('toggleSelected', () => {
  it('adds an id that is not there and removes one that is', () => {
    const once = toggleSelected(new Set(), 'a');
    expect([...once]).toEqual(['a']);
    expect([...toggleSelected(once, 'a')]).toEqual([]);
  });

  it('never mutates the set it was given', () => {
    const before = new Set(['a']);
    toggleSelected(before, 'b');
    expect([...before]).toEqual(['a']);
  });
});

describe('retainVisible', () => {
  it('drops ids that are no longer on screen', () => {
    const kept = retainVisible(new Set(['a', 'zz']), ROWS);
    expect([...kept]).toEqual(['a']);
  });

  it('empties out when the list does', () => {
    expect([...retainVisible(new Set(['a']), [])]).toEqual([]);
  });
});

describe('selectAllValue', () => {
  it('is false when nothing is selected', () => {
    expect(selectAllValue(new Set(), ROWS)).toBe(false);
  });

  it('is indeterminate when some are', () => {
    expect(selectAllValue(new Set(['a']), ROWS)).toBe('indeterminate');
  });

  it('is true when every row is', () => {
    expect(selectAllValue(new Set(['a', 'b', 'c', 'd']), ROWS)).toBe(true);
  });

  it('is false for an empty list rather than vacuously true', () => {
    expect(selectAllValue(new Set(), [])).toBe(false);
  });

  // The header sits above one page; the selection spans every page. Counting the
  // set's size instead of membership of these rows checks the box over rows that
  // were never selected.
  it('ignores rows selected on another page', () => {
    expect(selectAllValue(new Set(PAGE_ONE.map((r) => r.id)), PAGE_TWO)).toBe(false);
  });

  it('is true for the page that is selected and false for the one that is not', () => {
    const pageOneSelected = new Set(PAGE_ONE.map((r) => r.id));
    expect(selectAllValue(pageOneSelected, PAGE_ONE)).toBe(true);
    expect(selectAllValue(pageOneSelected, PAGE_TWO)).toBe(false);
  });

  it('is indeterminate for a partly selected page, whatever other pages hold', () => {
    const selected = new Set(['p1a', 'p1b', 'p1c', 'p2a']);
    expect(selectAllValue(selected, PAGE_TWO)).toBe('indeterminate');
  });

  it('is false for an empty page however much is selected elsewhere', () => {
    expect(selectAllValue(new Set(['p1a', 'p1b', 'p1c']), [])).toBe(false);
  });
});

describe('setSelectedForRows', () => {
  it('adds exactly this page and keeps the previous page selected', () => {
    const next = setSelectedForRows(new Set(PAGE_ONE.map((r) => r.id)), PAGE_TWO, true);
    expect([...next].sort()).toEqual(['p1a', 'p1b', 'p1c', 'p2a', 'p2b', 'p2c']);
    expect(selectAllValue(next, PAGE_ONE)).toBe(true);
    expect(selectAllValue(next, PAGE_TWO)).toBe(true);
  });

  it('removes exactly this page and leaves the previous page intact', () => {
    const both = new Set([...PAGE_ONE, ...PAGE_TWO].map((r) => r.id));
    const next = setSelectedForRows(both, PAGE_TWO, false);
    expect([...next].sort()).toEqual(['p1a', 'p1b', 'p1c']);
    expect(selectAllValue(next, PAGE_ONE)).toBe(true);
    expect(selectAllValue(next, PAGE_TWO)).toBe(false);
  });

  it('never mutates the set it was given', () => {
    const before = new Set(['p1a']);
    setSelectedForRows(before, PAGE_TWO, true);
    expect([...before]).toEqual(['p1a']);
  });
});

describe('summariseSelection', () => {
  it('says nothing is selected, and permits nothing', () => {
    const summary = summariseSelection(new Set(), ROWS);
    expect(summary).toMatchObject({
      count: 0,
      label: '0 selected',
      amount: '',
      canMarkPaid: false,
      canExport: false,
    });
  });

  it('counts and totals the selection', () => {
    const summary = summariseSelection(new Set(['a', 'b']), ROWS);
    expect(summary.count).toBe(2);
    expect(summary.label).toBe('2 selected');
    // 3_589_468 + 3_600_000 cents = $71,894.68 — the headline figure drops the
    // cents, rounding rather than truncating.
    expect(summary.amount).toBe('$71,895');
    expect(summary.extraCurrencies).toBe(0);
  });

  it('leads with one currency and counts the rest rather than converting', () => {
    const mixed: readonly SelectableRow[] = [
      row({ id: 'a', currency: 'USD', totalCents: 100_000 }),
      row({ id: 'b', currency: 'GBP', totalCents: 500_000 }),
    ];
    const summary = summariseSelection(new Set(['a', 'b']), mixed);
    expect(summary.amount).toBe('£5,000');
    expect(summary.extraCurrencies).toBe(1);
    expect(summary.full).toContain('$1,000');
  });

  it('permits mark-paid only for issued, unsettled invoices', () => {
    expect(summariseSelection(new Set(['a']), ROWS).canMarkPaid).toBe(true);
    expect(summariseSelection(new Set(['a', 'b']), ROWS).canMarkPaid).toBe(true);
    // A draft was never sent, so there is no payment to record against it.
    expect(summariseSelection(new Set(['a', 'c']), ROWS).canMarkPaid).toBe(false);
    // Already paid.
    expect(summariseSelection(new Set(['d']), ROWS).canMarkPaid).toBe(false);
  });

  it('permits export for exactly one row — the channel writes one file', () => {
    expect(summariseSelection(new Set(['a']), ROWS).canExport).toBe(true);
    expect(summariseSelection(new Set(['a', 'b']), ROWS).canExport).toBe(false);
    expect(summariseSelection(new Set(), ROWS).canExport).toBe(false);
  });

  it('ignores selected ids that are not in the row set', () => {
    const summary = summariseSelection(new Set(['a', 'gone']), ROWS);
    expect(summary.count).toBe(1);
    expect(summary.canExport).toBe(true);
  });
});
