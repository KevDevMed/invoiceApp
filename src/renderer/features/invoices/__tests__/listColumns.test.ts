import { describe, expect, it } from 'vitest';

import {
  COLUMNS,
  SORTABLE_COLUMNS,
  columnDef,
  isSortColumn,
  listLayoutAt,
  optionFor,
} from '../listColumns';
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

describe('COLUMNS', () => {
  it('is the seven columns in design order', () => {
    expect(COLUMNS.map((column) => column.key)).toEqual([
      'select',
      'client',
      'invoice',
      'status',
      'issued',
      'total',
      'menu',
    ]);
  });

  it('carries the design labels, upper case, so the chip rule can strip " & DUE"', () => {
    expect(columnDef('client').label).toBe('CLIENT');
    expect(columnDef('invoice').label).toBe('INVOICE');
    expect(columnDef('status').label).toBe('STATUS & DUE');
    expect(columnDef('issued').label).toBe('ISSUED');
    expect(columnDef('total').label).toBe('TOTAL');
  });

  it('right-aligns exactly ISSUED and TOTAL', () => {
    expect(COLUMNS.filter((column) => column.align === 'end').map((column) => column.key)).toEqual(
      ['issued', 'total'],
    );
  });

  it('gives each column the kind its sort labels are chosen from', () => {
    expect(columnDef('client').kind).toBe('text');
    expect(columnDef('invoice').kind).toBe('text');
    expect(columnDef('status').kind).toBe('status');
    expect(columnDef('issued').kind).toBe('date');
    expect(columnDef('total').kind).toBe('num');
  });

  it('keeps the checkbox and the ⋯ gutter structurally special', () => {
    // Empty label, fixed 34px, never sorted, never filtered — they render a
    // control rather than a value.
    for (const key of ['select', 'menu'] as const) {
      const column = columnDef(key);
      expect(column.label, key).toBe('');
      expect(column.track, key).toBe('34px');
      expect(column.sortable, key).toBe(false);
      expect(column.filterOptions, key).toEqual([]);
      expect(isSortColumn(key), key).toBe(false);
    }
  });

  it('offers a menu on exactly the five value columns', () => {
    expect([...SORTABLE_COLUMNS]).toEqual(['client', 'invoice', 'status', 'issued', 'total']);
    for (const key of SORTABLE_COLUMNS) {
      expect(columnDef(key).filterOptions.length, key).toBeGreaterThan(0);
    }
  });

  it('holds the tracks the grid template is built from', () => {
    expect(COLUMNS.map((column) => column.track).join(' ')).toBe(
      '34px 1.6fr 106px 1fr 118px 150px 34px',
    );
  });

  it('names every filter predicate exactly once across the whole table', () => {
    const predicates = COLUMNS.flatMap((column) =>
      column.filterOptions.map((option) => option.predicate),
    );
    expect(new Set(predicates).size).toBe(predicates.length);
  });

  it('maps every predicate back to the column that offers it', () => {
    for (const column of COLUMNS) {
      for (const option of column.filterOptions) {
        expect(optionFor(option.predicate).column.key, option.predicate).toBe(column.key);
        expect(optionFor(option.predicate).option.label, option.predicate).toBe(option.label);
      }
    }
  });

  it('throws rather than returning a hole for an unknown key', () => {
    expect(() => columnDef('nope' as ListColumnKey)).toThrow(/unknown column/);
  });
});

describe('the layout is built from COLUMNS', () => {
  it('emits each visible column’s own track, in order', () => {
    for (const width of WIDTHS) {
      const layout = listLayoutAt(width);
      const tracks = layout.gridTemplateColumns.split(' ');
      layout.columns.forEach((column, index) => {
        // TOTAL is the one column with a narrow variant, once the checkbox
        // gutter is gone.
        const expected =
          column === 'total' && !layout.columns.includes('select')
            ? '112px'
            : columnDef(column).track;
        expect(tracks[index], `${String(width)} / ${column}`).toBe(expected);
      });
    }
  });
});
