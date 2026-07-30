/**
 * The editor's structural geometry — the handful of numbers that are budgeted
 * regions rather than styling, plus the page arithmetic the preview rail needs.
 *
 * Everything here is a *size decision* the design system has no token for: a
 * fixed-width preview rail, the height the item list scrolls inside, the
 * proportions of a sheet of A4. Colour, radius, spacing and type all come from
 * tokens in the components; nothing in this file is appearance.
 *
 * Pure by design: the vitest project is `environment: 'node'`, so the page
 * arithmetic is testable here and the components only measure.
 */

import { PAPER_WIDTH_PX } from './previewScale';

/**
 * Width of the preview rail, in px.
 *
 * Fixed, not proportional: the rail holds a sheet of paper at a fixed aspect
 * ratio, and a rail that grew with the window would make the page grow with it.
 * The rule the design is built on is "the pane never grows — content overflows
 * onto another page instead", and that only holds if this number is a constant.
 */
export const PREVIEW_RAIL_WIDTH = 470;

/**
 * How tall the item list is allowed to get before it scrolls, in px — about ten
 * rows. The list scrolls, the page doesn't: an invoice with forty lines must not
 * push the notes field and the action row off the bottom of the window.
 */
export const ITEM_LIST_MAX_HEIGHT = 280;

/** Column budgets for the item grid, in px: qty · rate · amount. */
export const LINE_QTY_WIDTH = 64;
export const LINE_RATE_WIDTH = 96;
export const LINE_AMOUNT_WIDTH = 100;

/**
 * The two near-invisible gutter columns — the drag handle on the left and the
 * overflow menu on the right. The mockup draws them at 16/18px because they are
 * glyphs there; here they are real controls, so each column is one small
 * element wide (`--size-element-sm`, 28px) and the handle keeps a hit target.
 */
export const LINE_GUTTER_WIDTH = 28;

/**
 * Width of a row's overflow menu, in px. Stated because the menu's default is
 * "as wide as the button that opened it", and the button that opens this one is
 * a 28px glyph.
 */
export const LINE_MENU_WIDTH = 180;

/** A sheet of A4, as a CSS `aspect-ratio` value. */
export const PAPER_ASPECT_RATIO = '210 / 297';

/**
 * The height of one A4 page at `PAPER_WIDTH_PX`, in px.
 *
 * Derived rather than written down: the paper width is already A4's 210mm at
 * 96dpi, so the page height is that same width in the ratio of the page. This is
 * what makes the preview frame show exactly one page of the document.
 */
export const PAPER_HEIGHT_PX = Math.round((PAPER_WIDTH_PX * 297) / 210);

/** Width of a page thumbnail, in px. */
export const PAGE_THUMBNAIL_WIDTH = 44;

/**
 * Slack allowed at the bottom of a page before it counts as overflowing, in px.
 *
 * A sheet measured at 1123.4px is a rounding artefact, not a second page; a
 * sheet measured at 1180px genuinely has content below the fold. Half a line of
 * body text is the line between the two.
 */
const PAGE_OVERFLOW_SLACK = 8;

/**
 * How many pages the rendered document covers.
 *
 * Measured, not estimated: the sheet is drawn at a fixed width, so its own
 * layout height is the honest number of pages it fills. A height that has not
 * been measured yet (0 before the first `ResizeObserver` callback) is one page,
 * which is also the answer for every invoice that fits.
 */
export function documentPageCount(
  naturalHeight: number,
  pageHeight: number = PAPER_HEIGHT_PX,
): number {
  if (!Number.isFinite(naturalHeight) || naturalHeight <= 0) return 1;
  if (!Number.isFinite(pageHeight) || pageHeight <= 0) return 1;
  return Math.max(1, Math.ceil((naturalHeight - PAGE_OVERFLOW_SLACK) / pageHeight));
}

/** A page index held inside the document, whatever the caller last asked for. */
export function clampPageIndex(index: number, pageCount: number): number {
  if (!Number.isFinite(index)) return 0;
  const pages = Math.max(1, Math.trunc(pageCount));
  return Math.min(Math.max(0, Math.trunc(index)), pages - 1);
}

/**
 * How far the sheet is lifted to bring a page into the frame, in unscaled px.
 * Negative because the sheet moves up as the page number goes down the document.
 */
export function pageOffsetPx(pageIndex: number, pageHeight: number = PAPER_HEIGHT_PX): number {
  if (!Number.isFinite(pageIndex) || pageIndex <= 0) return 0;
  return -Math.trunc(pageIndex) * pageHeight;
}

/** `2 / 5` — the pager's readout, 1-based for the reader. */
export function pageLabel(pageIndex: number, pageCount: number): string {
  const pages = Math.max(1, Math.trunc(pageCount));
  return `${String(clampPageIndex(pageIndex, pages) + 1)} / ${String(pages)}`;
}
