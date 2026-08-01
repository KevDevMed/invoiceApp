/**
 * What the invoice table shows at a given content width.
 *
 * Design 3a is authored at a fixed 1240px with seven columns
 * (`34px 1.6fr 106px 1fr 118px 150px 34px`). That template does not survive a
 * narrow window: the `fr` tracks collapse first and the client name — the
 * thing you actually scan for — is what disappears. So the columns are dropped
 * deliberately instead, in the order the design can afford to lose them.
 *
 * Pure module — no React. The vitest project is `environment: 'node'`, so this
 * is where the decision has to live to be testable at all. The component reads
 * the *content column's* width from a `ResizeObserver`, never
 * `window.innerWidth`: the shell's side nav collapses, so the viewport is not
 * the content width and a media query would answer the wrong question.
 *
 * Two columns never drop, at any width: CLIENT and STATUS & DUE, plus TOTAL.
 * They are the whole point of the option — who, when, how much. Everything else
 * is an affordance that has a second home (the invoice number is on the detail
 * page, ISSUED is a sort key, the ⋯ menu duplicates row actions, the checkbox
 * only exists to feed the bulk bar).
 */

/** A column of the invoice table, in design order. */
export type ListColumnKey =
  | 'select'
  | 'client'
  | 'invoice'
  | 'status'
  | 'issued'
  | 'total'
  | 'menu';

/** How many columns the four money tiles sit in. */
export type TileColumns = 1 | 2 | 4;

export interface ListLayout {
  /** Visible columns, left to right. */
  readonly columns: readonly ListColumnKey[];
  /** The `grid-template-columns` value the header strip and every row share. */
  readonly gridTemplateColumns: string;
  /** `repeat(4,1fr)` at full width, then 2x2, then stacked. */
  readonly tileColumns: TileColumns;
  /**
   * Whether row selection (and with it the bulk action bar) is offered. False
   * at the narrowest tier: a 14px hit target next to a truncated client name
   * is a mis-click, and the bar it raises has nowhere to sit.
   */
  readonly hasSelection: boolean;
  /**
   * Whether the STATUS & DUE cell keeps its trailing `· 16 Sep` date.
   *
   * Once INVOICE is gone the status track is the narrowest it ever gets, and
   * the phrase and the date compete for it — which truncates `Overdue 319
   * days` to `Overdue 319 d…` while the date it was truncated for is still
   * fully drawn. The phrase is the payload; the date is the corroboration. So
   * the date leaves first.
   */
  readonly showsStatusDate: boolean;
}

/**
 * Track sizes, straight from the design. Pixels because these are structural —
 * a checkbox cell is a checkbox wide, and no spacing token expresses `1.6fr`.
 */
const TRACKS: Record<ListColumnKey, string> = {
  select: '34px',
  client: '1.6fr',
  invoice: '106px',
  status: '1fr',
  issued: '118px',
  total: '150px',
  menu: '34px',
};

/** The narrowest total column that still fits a five-figure sum plus symbol. */
const NARROW_TOTAL_TRACK = '112px';

/**
 * Breakpoints, widest first. `minWidth` is the *content column's* inline size,
 * not the viewport's — the card's own padding is already inside it.
 *
 * The full template needs 442px of fixed track plus six 14px gaps (84px) plus
 * the card's 56px of horizontal padding before either `fr` track gets a pixel,
 * so 1040 is the first width at which CLIENT and STATUS & DUE both still read.
 * Each tier below it buys roughly one dropped column's worth of room back.
 */
const TIERS: readonly {
  readonly minWidth: number;
  readonly columns: readonly ListColumnKey[];
  readonly tileColumns: TileColumns;
}[] = [
  {
    minWidth: 1040,
    columns: ['select', 'client', 'invoice', 'status', 'issued', 'total', 'menu'],
    tileColumns: 4,
  },
  // ISSUED goes first: it is the one date on the row that nothing is decided
  // from — the due date is already merged into STATUS & DUE.
  {
    minWidth: 880,
    columns: ['select', 'client', 'invoice', 'status', 'total', 'menu'],
    tileColumns: 4,
  },
  // Then INVOICE. The number identifies a row you already found; the client
  // name is how you find it.
  { minWidth: 720, columns: ['select', 'client', 'status', 'total', 'menu'], tileColumns: 2 },
  // Then ⋯, whose menu is a subset of what the detail page offers anyway.
  { minWidth: 560, columns: ['select', 'client', 'status', 'total'], tileColumns: 2 },
  // Then the checkbox, and the bulk bar with it.
  { minWidth: 0, columns: ['client', 'status', 'total'], tileColumns: 1 },
];

function trackFor(column: ListColumnKey, columns: readonly ListColumnKey[]): string {
  if (column === 'total' && !columns.includes('select')) return NARROW_TOTAL_TRACK;
  return TRACKS[column];
}

/**
 * The layout for a content column `width` px wide. Non-finite and negative
 * widths fall to the narrowest tier rather than throwing: a `ResizeObserver`
 * reports 0 for an element that has not been laid out yet, and the first paint
 * should be the safe arrangement, not a crash.
 */
export function listLayoutAt(width: number): ListLayout {
  const safe = Number.isFinite(width) ? Math.max(width, 0) : 0;
  // TIERS is widest-first and ends at 0, so this always matches.
  const tier = TIERS.find((candidate) => safe >= candidate.minWidth) ?? TIERS[TIERS.length - 1];
  if (tier === undefined) throw new Error('listLayoutAt: no tier');
  return {
    columns: tier.columns,
    gridTemplateColumns: tier.columns
      .map((column) => trackFor(column, tier.columns))
      .join(' '),
    tileColumns: tier.tileColumns,
    hasSelection: tier.columns.includes('select'),
    showsStatusDate: tier.columns.includes('invoice'),
  };
}
