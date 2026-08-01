import { describe, expect, it } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { buildMoneyTiles } from '../moneyTiles';
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
    expect(byKey(tiles, 'overdue').detail).toBe('2 invoices · oldest 34 days');
    expect(byKey(tiles, 'overdue').count).toBe(2);
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
    expect(byKey(tiles, 'drafts').detail).toBe('1 never sent');
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
});
