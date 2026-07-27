import { describe, expect, it } from 'vitest';

import { clampPage, pageCount, pageRange, pageSlice, rangeLabel } from '../pagination';

describe('pageCount', () => {
  it('divides evenly and rounds up partial pages', () => {
    expect(pageCount(240, 10)).toBe(24);
    expect(pageCount(241, 10)).toBe(25);
  });

  it('never returns fewer than one page', () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(3, 10)).toBe(1);
  });

  it('coerces a nonsense page size to 1', () => {
    expect(pageCount(5, 0)).toBe(5);
    expect(pageCount(5, Number.NaN)).toBe(5);
  });
});

describe('rangeLabel', () => {
  it('renders the first page exactly', () => {
    expect(rangeLabel(240, 1, 10)).toBe('1-10 of 240');
  });

  it('renders a middle page exactly', () => {
    expect(rangeLabel(240, 3, 10)).toBe('21-30 of 240');
  });

  it('stops at the total on a last partial page', () => {
    expect(rangeLabel(243, 25, 10)).toBe('241-243 of 243');
  });

  it('drops the dash when a page holds a single item', () => {
    expect(rangeLabel(241, 25, 10)).toBe('241 of 241');
  });

  it('reads 0 of 0 with no results', () => {
    expect(rangeLabel(0, 1, 10)).toBe('0 of 0');
    expect(rangeLabel(0, 7, 10)).toBe('0 of 0');
  });

  it('clamps an out-of-range page back onto the last page', () => {
    expect(rangeLabel(240, 99, 10)).toBe('231-240 of 240');
    expect(rangeLabel(240, 0, 10)).toBe('1-10 of 240');
    expect(rangeLabel(240, -5, 10)).toBe('1-10 of 240');
  });

  it('follows a page-size change', () => {
    expect(rangeLabel(240, 2, 10)).toBe('11-20 of 240');
    expect(rangeLabel(240, 2, 25)).toBe('26-50 of 240');
    expect(rangeLabel(240, 2, 100)).toBe('101-200 of 240');
    // page 24 exists at size 10 but not at size 100: it clamps to the last page.
    expect(rangeLabel(240, 24, 100)).toBe('201-240 of 240');
  });
});

describe('clampPage', () => {
  it('keeps in-range pages', () => {
    expect(clampPage(5, 240, 10)).toBe(5);
  });

  it('clamps below 1 and above the last page', () => {
    expect(clampPage(0, 240, 10)).toBe(1);
    expect(clampPage(1000, 240, 10)).toBe(24);
  });

  it('clamps to 1 when the list is empty', () => {
    expect(clampPage(4, 0, 10)).toBe(1);
  });
});

describe('pageRange', () => {
  it('reports zero-based indices and 1-based labels together', () => {
    expect(pageRange(240, 3, 10)).toEqual({
      startIndex: 20,
      endIndex: 30,
      from: 21,
      to: 30,
      total: 240,
      page: 3,
    });
  });

  it('collapses to an empty range with no results', () => {
    expect(pageRange(0, 3, 10)).toEqual({
      startIndex: 0,
      endIndex: 0,
      from: 0,
      to: 0,
      total: 0,
      page: 1,
    });
  });
});

describe('pageSlice', () => {
  const items = Array.from({ length: 23 }, (_, index) => index + 1);

  it('slices a full page', () => {
    expect(pageSlice(items, 1, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('slices the last partial page', () => {
    expect(pageSlice(items, 3, 10)).toEqual([21, 22, 23]);
  });

  it('clamps instead of returning an empty tail', () => {
    expect(pageSlice(items, 99, 10)).toEqual([21, 22, 23]);
  });

  it('returns nothing for an empty list', () => {
    expect(pageSlice([], 1, 10)).toEqual([]);
  });

  it('re-slices after a page-size change', () => {
    expect(pageSlice(items, 2, 20)).toEqual([21, 22, 23]);
  });
});
