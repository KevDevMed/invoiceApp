import { describe, expect, it } from 'vitest';

import { listLayoutAt } from '../listColumns';
import type { ListColumnKey } from '../listColumns';

/** The three columns design 3a exists to show. They never drop. */
const LOAD_BEARING: readonly ListColumnKey[] = ['client', 'status', 'total'];

const WIDTHS = [2000, 1400, 1240, 1100, 1040, 1039, 900, 880, 800, 720, 700, 600, 560, 400, 0];

describe('listLayoutAt', () => {
  it('shows all seven columns at the design width', () => {
    expect(listLayoutAt(1240).columns).toEqual([
      'select',
      'client',
      'invoice',
      'status',
      'issued',
      'total',
      'menu',
    ]);
    expect(listLayoutAt(1240).gridTemplateColumns).toBe(
      '34px 1.6fr 106px 1fr 118px 150px 34px',
    );
    expect(listLayoutAt(1240).tileColumns).toBe(4);
    expect(listLayoutAt(1240).hasSelection).toBe(true);
  });

  it('drops ISSUED first', () => {
    const layout = listLayoutAt(900);
    expect(layout.columns).not.toContain('issued');
    expect(layout.columns).toContain('invoice');
    expect(layout.gridTemplateColumns).toBe('34px 1.6fr 106px 1fr 150px 34px');
  });

  it('drops INVOICE second', () => {
    const layout = listLayoutAt(760);
    expect(layout.columns).not.toContain('invoice');
    expect(layout.columns).toContain('menu');
    expect(layout.tileColumns).toBe(2);
  });

  it('drops the row menu third', () => {
    const layout = listLayoutAt(600);
    expect(layout.columns).not.toContain('menu');
    expect(layout.columns).toContain('select');
  });

  it('drops the checkbox last, and with it the bulk bar', () => {
    const layout = listLayoutAt(420);
    expect(layout.columns).toEqual(['client', 'status', 'total']);
    expect(layout.hasSelection).toBe(false);
    expect(layout.tileColumns).toBe(1);
  });

  it('never drops client, status or total at any width', () => {
    for (const width of WIDTHS) {
      const { columns } = listLayoutAt(width);
      for (const required of LOAD_BEARING) {
        expect(columns, `width ${String(width)}`).toContain(required);
      }
    }
  });

  it('degrades monotonically — a narrower width never shows more columns', () => {
    const descending = [...WIDTHS].sort((a, b) => b - a);
    let previous = Infinity;
    for (const width of descending) {
      const count = listLayoutAt(width).columns.length;
      expect(count, `width ${String(width)}`).toBeLessThanOrEqual(previous);
      previous = count;
    }
  });

  it('steps the tiles 4 -> 2 -> 1 and never back up', () => {
    expect(listLayoutAt(1240).tileColumns).toBe(4);
    expect(listLayoutAt(900).tileColumns).toBe(4);
    expect(listLayoutAt(760).tileColumns).toBe(2);
    expect(listLayoutAt(600).tileColumns).toBe(2);
    expect(listLayoutAt(420).tileColumns).toBe(1);
  });

  it('emits one track per visible column', () => {
    for (const width of WIDTHS) {
      const layout = listLayoutAt(width);
      expect(layout.gridTemplateColumns.split(' ')).toHaveLength(layout.columns.length);
    }
  });

  it('narrows the total column once the checkbox gutter is gone', () => {
    expect(listLayoutAt(600).gridTemplateColumns).toContain('150px');
    expect(listLayoutAt(420).gridTemplateColumns).toBe('1.6fr 1fr 112px');
  });

  it('falls to the narrowest tier for a width that has not been laid out yet', () => {
    // A ResizeObserver reports 0 before first layout; NaN is what an unmeasured
    // element's bounding box can produce.
    expect(listLayoutAt(0).columns).toEqual(['client', 'status', 'total']);
    expect(listLayoutAt(Number.NaN).columns).toEqual(['client', 'status', 'total']);
    expect(listLayoutAt(-500).columns).toEqual(['client', 'status', 'total']);
  });

  it('drops the trailing status date before it truncates the phrase', () => {
    // The phrase is the payload; the date corroborates it. Once INVOICE is gone
    // the status track is at its narrowest and the two compete for it.
    expect(listLayoutAt(1240).showsStatusDate).toBe(true);
    expect(listLayoutAt(900).showsStatusDate).toBe(true);
    expect(listLayoutAt(760).showsStatusDate).toBe(false);
    expect(listLayoutAt(420).showsStatusDate).toBe(false);
  });

  it('hasSelection agrees with the checkbox column', () => {
    for (const width of WIDTHS) {
      const layout = listLayoutAt(width);
      expect(layout.hasSelection).toBe(layout.columns.includes('select'));
    }
  });
});
