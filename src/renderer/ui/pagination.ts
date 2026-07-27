/**
 * Pure pagination maths shared by every list screen. No React, no astryx, no
 * feature knowledge — so it is testable in the node vitest project.
 *
 * Conventions:
 * - `page` is 1-based and always clamped into range before use.
 * - `pageSize` is coerced to a positive integer (bad input falls back to 1).
 * - There is always at least one page, so `total === 0` still means page 1.
 */

function normalizeSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1;
  return Math.max(1, Math.floor(pageSize));
}

function normalizeTotal(total: number): number {
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, Math.floor(total));
}

/** Number of pages for `total` items, never below 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(normalizeTotal(total) / normalizeSize(pageSize)));
}

/** Clamps a 1-based page into `[1, pageCount(total, pageSize)]`. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const last = pageCount(total, pageSize);
  if (!Number.isFinite(page)) return 1;
  return Math.min(last, Math.max(1, Math.floor(page)));
}

export interface PageRange {
  /** 0-based index of the first item on the page. */
  readonly startIndex: number;
  /** 0-based index one past the last item on the page. */
  readonly endIndex: number;
  /** 1-based number of the first item, 0 when there are no items. */
  readonly from: number;
  /** 1-based number of the last item, 0 when there are no items. */
  readonly to: number;
  /** Normalized total. */
  readonly total: number;
  /** The page actually used after clamping. */
  readonly page: number;
}

/** Index range covered by a page, with the page clamped into range first. */
export function pageRange(total: number, page: number, pageSize: number): PageRange {
  const size = normalizeSize(pageSize);
  const items = normalizeTotal(total);
  const current = clampPage(page, items, size);
  const startIndex = Math.min((current - 1) * size, items);
  const endIndex = Math.min(startIndex + size, items);
  return {
    startIndex,
    endIndex,
    from: items === 0 ? 0 : startIndex + 1,
    to: endIndex,
    total: items,
    page: current,
  };
}

/** The slice of `items` shown on `page`. Never throws on out-of-range pages. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const { startIndex, endIndex } = pageRange(items.length, page, pageSize);
  return items.slice(startIndex, endIndex);
}

/**
 * The footer string: `"1-10 of 240"`, `"231-240 of 240"` on a last partial
 * page, `"10 of 10"` when a page holds a single item, `"0 of 0"` when empty.
 */
export function rangeLabel(total: number, page: number, pageSize: number): string {
  const { from, to, total: items } = pageRange(total, page, pageSize);
  if (items === 0) return '0 of 0';
  if (from === to) return `${from} of ${items}`;
  return `${from}-${to} of ${items}`;
}
