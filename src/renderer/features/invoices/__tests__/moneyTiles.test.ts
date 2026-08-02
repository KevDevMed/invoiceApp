import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { COLUMNS } from '../listColumns';
import { buildMoneyTiles, tileSlotTakesClicks } from '../moneyTiles';
import type { MoneyTile, MoneyTileKey } from '../moneyTiles';

const TODAY = '2026-07-29';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'i1',
    number: 'INV-0001',
    clientId: 'c1',
    status: 'sent',
    issueDate: '2026-05-26',
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

function byKey(tiles: readonly MoneyTile[], key: MoneyTileKey): MoneyTile {
  const tile = tiles.find((candidate) => candidate.key === key);
  if (tile === undefined) throw new Error(`no ${key} tile`);
  return tile;
}

describe('buildMoneyTiles', () => {
  it('builds the four tiles the design specifies, in order', () => {
    const tiles = buildMoneyTiles([], TODAY);
    expect(tiles.map((tile) => tile.key)).toEqual([
      'outstanding',
      'overdue',
      'due-soon',
      'drafts',
    ]);
    expect(tiles.map((tile) => tile.label)).toEqual([
      'Outstanding',
      'Overdue',
      'Due in 7 days',
      'Drafts',
    ]);
  });

  it('says nothing rather than zero on an empty workspace', () => {
    const tiles = buildMoneyTiles([], TODAY);
    for (const tile of tiles) {
      expect(tile.figure).toBe('—');
      expect(tile.count).toBe(0);
      expect(tile.extraCurrencies).toBe(0);
    }
    expect(tiles.map((tile) => tile.detail)).toEqual([
      'Nothing outstanding',
      'Nothing overdue',
      'Nothing due this week',
      'No drafts',
    ]);
  });

  it('tones only the overdue tile', () => {
    const tiles = buildMoneyTiles([], TODAY);
    expect(tiles.filter((tile) => tile.tone === 'error').map((tile) => tile.key)).toEqual([
      'overdue',
    ]);
  });

  it('counts one invoice in the singular', () => {
    const tiles = buildMoneyTiles([makeInvoice({ dueDate: '2026-09-30' })], TODAY);
    expect(byKey(tiles, 'outstanding').detail).toBe('1 invoice');
    expect(byKey(tiles, 'outstanding').figure).toBe('$1,000');
  });

  it('reports the oldest overdue invoice in days', () => {
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', dueDate: '2026-07-11' }), // 18 days late
        makeInvoice({ id: 'b', dueDate: '2026-06-25' }), // 34 days late
      ],
      TODAY,
    );
    expect(byKey(tiles, 'overdue').detail).toBe(
      '2 invoices · oldest 34 days · 1 over 30 days',
    );
    expect(byKey(tiles, 'overdue').count).toBe(2);
  });

  it('carries three overdue facts, and drops the third when none is stale', () => {
    // The design's third fact is `4 past a reminder`; this app sends no
    // reminders, so the count past 30 days stands in its place.
    const tiles = buildMoneyTiles(
      [makeInvoice({ id: 'a', dueDate: '2026-07-11' })], // 18 days late
      TODAY,
    );
    expect(byKey(tiles, 'overdue').detail).toBe('1 invoice · oldest 18 days');
  });

  it('drops the oldest clause for an invoice only flagged overdue', () => {
    // Stored as overdue while its due date is still ahead: no negative day
    // count, and no invented lateness.
    const tiles = buildMoneyTiles(
      [makeInvoice({ status: 'overdue', dueDate: '2026-12-01' })],
      TODAY,
    );
    expect(byKey(tiles, 'overdue').detail).toBe('1 invoice');
  });

  it('counts an invoice due today as due this week, not overdue', () => {
    const tiles = buildMoneyTiles([makeInvoice({ dueDate: TODAY })], TODAY);
    expect(byKey(tiles, 'due-soon').count).toBe(1);
    expect(byKey(tiles, 'overdue').count).toBe(0);
    expect(byKey(tiles, 'outstanding').count).toBe(1);
  });

  it('counts drafts as never sent and keeps them out of outstanding', () => {
    const tiles = buildMoneyTiles([makeInvoice({ status: 'draft' })], TODAY);
    expect(byKey(tiles, 'drafts').detail).toBe('never sent · oldest 64d');
    expect(byKey(tiles, 'drafts').headerCount).toBe('1');
    expect(byKey(tiles, 'drafts').figure).toBe('$1,000');
    expect(byKey(tiles, 'outstanding').count).toBe(0);
    expect(byKey(tiles, 'outstanding').figure).toBe('—');
  });

  it('leaves an all-paid workspace with nothing outstanding', () => {
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', status: 'paid', paidAt: '2026-07-24T09:00:00.000Z' }),
        makeInvoice({ id: 'b', status: 'paid', paidAt: '2026-07-25T09:00:00.000Z' }),
      ],
      TODAY,
    );
    expect(tiles.every((tile) => tile.figure === '—')).toBe(true);
    expect(byKey(tiles, 'outstanding').detail).toBe('Nothing outstanding');
  });

  it('ignores void invoices entirely', () => {
    const tiles = buildMoneyTiles([makeInvoice({ status: 'void' })], TODAY);
    expect(tiles.every((tile) => tile.count === 0)).toBe(true);
  });

  it('leads with one currency and counts the rest rather than converting', () => {
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', currency: 'GBP', totalCents: 500_000, dueDate: '2026-09-30' }),
        makeInvoice({ id: 'b', currency: 'USD', totalCents: 100_000, dueDate: '2026-09-30' }),
        makeInvoice({ id: 'c', currency: 'EUR', totalCents: 200_000, dueDate: '2026-09-30' }),
      ],
      TODAY,
    );
    const outstanding = byKey(tiles, 'outstanding');
    expect(outstanding.figure).toBe('£5,000');
    expect(outstanding.extraCurrencies).toBe(2);
    expect(outstanding.full).toContain('€2,000');
    expect(outstanding.full).toContain('$1,000');
    expect(outstanding.count).toBe(3);
  });

  it('leads every tile with the currency outstanding led with', () => {
    // Two figures side by side that are not the same money read as a breakdown
    // of each other when they are not.
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', currency: 'GBP', totalCents: 900_000, dueDate: '2026-09-30' }),
        makeInvoice({ id: 'b', currency: 'GBP', totalCents: 100_000, dueDate: '2026-06-25' }),
        makeInvoice({ id: 'c', currency: 'USD', totalCents: 800_000, dueDate: '2026-06-25' }),
      ],
      TODAY,
    );
    expect(byKey(tiles, 'outstanding').figure).toBe('£10,000');
    // USD is the larger overdue pile, but GBP leads so the two can be read
    // against each other.
    expect(byKey(tiles, 'overdue').figure).toBe('£1,000');
    expect(byKey(tiles, 'overdue').extraCurrencies).toBe(1);
  });

  it('keeps money in integer cents — no floats reach the figure', () => {
    const tiles = buildMoneyTiles(
      [makeInvoice({ totalCents: 5_021_490, dueDate: '2026-09-30' })],
      TODAY,
    );
    expect(byKey(tiles, 'outstanding').figure).toBe('$50,215');
  });

  it('puts the count in the header row, not in the sub-line', () => {
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', dueDate: '2026-09-30' }),
        makeInvoice({ id: 'b', dueDate: '2026-09-30' }),
        makeInvoice({ id: 'c', status: 'draft' }),
      ],
      TODAY,
    );
    expect(byKey(tiles, 'outstanding').headerCount).toBe('2 invoices');
    expect(byKey(tiles, 'overdue').headerCount).toBe('0');
    expect(byKey(tiles, 'due-soon').headerCount).toBe('0');
    expect(byKey(tiles, 'drafts').headerCount).toBe('1');
  });

  it('gives the due-soon tile the next invoice rather than a repeat of the count', () => {
    const tiles = buildMoneyTiles(
      [
        makeInvoice({ id: 'a', clientId: 'c1', dueDate: '2026-08-02' }), // a Sunday
        makeInvoice({ id: 'b', clientId: 'c2', dueDate: '2026-07-31' }), // a Friday
      ],
      TODAY,
      new Map([
        ['c1', 'Halcyon'],
        ['c2', 'Northwind'],
      ]),
    );
    expect(byKey(tiles, 'due-soon').detail).toBe('next: Northwind, Fri');
  });

  it('falls back to the count when no client name has been joined yet', () => {
    const tiles = buildMoneyTiles([makeInvoice({ dueDate: '2026-08-02' })], TODAY);
    expect(byKey(tiles, 'due-soon').detail).toBe('1 invoice');
  });

  it('gives each tile the filter a click on it applies', () => {
    const tiles = buildMoneyTiles([], TODAY);
    expect(tiles.map((tile) => tile.predicate)).toEqual([
      'status-open',
      'status-overdue',
      'status-due-soon',
      'status-draft',
    ]);
  });

  it('gives the click to the Chase slot and lets every other slot pass it on', () => {
    // The whole card is one hit area. The top-right slot paints over it, so it
    // has to declare itself: Overdue's slot is `Chase all N` and answers, the
    // rest are counts and must not swallow the click — a card advertised as
    // pressable with a dead patch in its corner is the defect this replaced.
    expect(tileSlotTakesClicks('overdue')).toBe(true);
    for (const key of ['outstanding', 'due-soon', 'drafts'] as const) {
      expect(tileSlotTakesClicks(key), key).toBe(false);
    }
  });

  it('marks exactly one tile slot as a control', () => {
    const takers = buildMoneyTiles([], TODAY).filter((tile) => tileSlotTakesClicks(tile.key));
    expect(takers.map((tile) => tile.key)).toEqual(['overdue']);
  });

  it('names every tile predicate as a real option on the STATUS & DUE menu', () => {
    // A tile that reached a filter no menu offers would be a state the reader
    // could not reproduce, or undo, by hand.
    const status = COLUMNS.find((column) => column.key === 'status');
    const offered = new Set(status?.filterOptions.map((option) => option.predicate));
    for (const tile of buildMoneyTiles([], TODAY)) {
      expect(offered.has(tile.predicate), tile.key).toBe(true);
    }
  });
});
