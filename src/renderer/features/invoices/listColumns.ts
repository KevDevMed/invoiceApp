/**
 * The invoice table's columns: what each one is, and which of them survive a
 * given content width.
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
 *
 * `COLUMNS` is the single column table. Label, alignment, kind, track, whether
 * it sorts and what it filters by all live on one object, because the previous
 * arrangement — `TRACKS` and `TIERS` here, `COLUMN_LABELS` and `END_ALIGNED`
 * inside the component — meant the label and the alignment of a column were
 * untestable and could drift from its width.
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

/**
 * The columns that carry a header menu. `select` and `menu` are structurally
 * special — empty label, fixed 34px, an interactive control rather than a value
 * — so they are never sorted and never filtered.
 */
export type SortColumnKey = 'client' | 'invoice' | 'status' | 'issued' | 'total';

/**
 * What kind of value a column holds. This is what picks the pair of sort
 * labels: "Largest first" is right for money and wrong for a client name.
 */
export type ListColumnKind = 'text' | 'status' | 'date' | 'num';

export type ListColumnAlign = 'start' | 'end';

/**
 * A filter a column menu can apply. Stable ids rather than the display string,
 * because a chip has to survive being compared to another chip (see
 * `FilterChip` in ./filters) and a rendered label is a presentation detail.
 */
export type ColumnFilterPredicate =
  | 'client-contains'
  | 'client-any-of'
  | 'client-has-open-balance'
  | 'number-contains'
  | 'status-open'
  | 'status-overdue'
  | 'status-due-soon'
  | 'status-sent'
  | 'status-draft'
  | 'status-paid'
  | 'issued-this-month'
  | 'issued-last-30-days'
  | 'issued-this-quarter'
  | 'issued-range'
  | 'total-over'
  | 'total-under'
  | 'total-between'
  | 'total-currency';

/**
 * Which second step an option needs before it can be committed. The design's
 * ellipsis options (`Contains…`, `Between…`, `Custom range…`, `By currency…`)
 * imply an input the mock never draws; this is that input, named. `none` means
 * the option commits on click.
 *
 * `text-list` is one field like `text`, but the value is a comma-separated set
 * rather than one string. It is its own kind because the two differ on both
 * ends: it is rejected when no comma token survives trimming (`", "` would
 * otherwise commit a chip that matches every invoice), and its chip identity is
 * the *normalised token set*, so `Halcyon, Northwind` and `northwind,Halcyon`
 * are one chip rather than two.
 */
export type ColumnFilterInput =
  | 'none'
  | 'text'
  | 'text-list'
  | 'money-range'
  | 'date-range'
  | 'currency';

export interface ListFilterOption {
  /** The design's own words, ellipsis included — the menu prints this verbatim. */
  readonly label: string;
  readonly predicate: ColumnFilterPredicate;
  readonly input: ColumnFilterInput;
}

export interface ListColumnDef {
  readonly key: ListColumnKey;
  /**
   * Header text, upper case as the design draws it. The chip rule strips
   * ` & DUE` from it, so the casing is load-bearing rather than cosmetic.
   */
  readonly label: string;
  readonly align: ListColumnAlign;
  readonly kind: ListColumnKind;
  /**
   * The `grid-template-columns` track. Pixels because these are structural — a
   * checkbox cell is a checkbox wide, and no spacing token expresses `1.6fr`.
   */
  readonly track: string;
  readonly sortable: boolean;
  readonly filterOptions: readonly ListFilterOption[];
}

/**
 * The column table, in design order.
 *
 * Two departures from the mock's `colDefs()`, both because the option has to be
 * real rather than decorative:
 *
 *   - INVOICE loses `Has attachment` and `Recurring only`, and STATUS & DUE
 *     loses `Sent · not viewed`. This app stores no attachments, no recurrence
 *     and no view events (`src/shared/types.ts`), so all three would be a menu
 *     entry that cannot narrow anything.
 *   - STATUS & DUE gains `Open · unpaid`. The Outstanding tile is a filter
 *     shortcut, and a tile that applies a filter no menu offers is a state the
 *     reader cannot reach or reproduce by hand.
 *
 * `Over 10,000` / `Under 1,000` drop the mock's `$`: the comparison is against
 * `totalCents` with no currency check, exactly like the existing amount filter
 * and `total-desc` in ./listRows, and a `$` on a threshold that also matches
 * €10,001 would be a claim this app cannot back.
 */
export const COLUMNS: readonly ListColumnDef[] = [
  {
    key: 'select',
    label: '',
    align: 'start',
    kind: 'text',
    track: '34px',
    sortable: false,
    filterOptions: [],
  },
  {
    key: 'client',
    label: 'CLIENT',
    align: 'start',
    kind: 'text',
    track: '1.6fr',
    sortable: true,
    filterOptions: [
      { label: 'Contains…', predicate: 'client-contains', input: 'text' },
      { label: 'Is any of…', predicate: 'client-any-of', input: 'text-list' },
      { label: 'Has open balance', predicate: 'client-has-open-balance', input: 'none' },
    ],
  },
  {
    key: 'invoice',
    label: 'INVOICE',
    align: 'start',
    kind: 'text',
    track: '106px',
    sortable: true,
    filterOptions: [{ label: 'Number contains…', predicate: 'number-contains', input: 'text' }],
  },
  {
    key: 'status',
    label: 'STATUS & DUE',
    align: 'start',
    kind: 'status',
    track: '1fr',
    sortable: true,
    filterOptions: [
      { label: 'Open · unpaid', predicate: 'status-open', input: 'none' },
      { label: 'Overdue only', predicate: 'status-overdue', input: 'none' },
      { label: 'Due in 7 days', predicate: 'status-due-soon', input: 'none' },
      { label: 'Sent', predicate: 'status-sent', input: 'none' },
      { label: 'Drafts', predicate: 'status-draft', input: 'none' },
      { label: 'Paid', predicate: 'status-paid', input: 'none' },
    ],
  },
  {
    key: 'issued',
    label: 'ISSUED',
    align: 'end',
    kind: 'date',
    track: '118px',
    sortable: true,
    filterOptions: [
      { label: 'This month', predicate: 'issued-this-month', input: 'none' },
      { label: 'Last 30 days', predicate: 'issued-last-30-days', input: 'none' },
      { label: 'This quarter', predicate: 'issued-this-quarter', input: 'none' },
      { label: 'Custom range…', predicate: 'issued-range', input: 'date-range' },
    ],
  },
  {
    key: 'total',
    label: 'TOTAL',
    align: 'end',
    kind: 'num',
    track: '150px',
    sortable: true,
    filterOptions: [
      { label: 'Over 10,000', predicate: 'total-over', input: 'none' },
      { label: 'Under 1,000', predicate: 'total-under', input: 'none' },
      { label: 'Between…', predicate: 'total-between', input: 'money-range' },
      { label: 'By currency…', predicate: 'total-currency', input: 'currency' },
    ],
  },
  {
    key: 'menu',
    label: '',
    align: 'start',
    kind: 'text',
    track: '34px',
    sortable: false,
    filterOptions: [],
  },
];

const BY_KEY = new Map<ListColumnKey, ListColumnDef>(COLUMNS.map((column) => [column.key, column]));

/** The definition for a column key. Throws rather than returning a hole. */
export function columnDef(key: ListColumnKey): ListColumnDef {
  const found = BY_KEY.get(key);
  if (found === undefined) throw new Error(`columnDef: unknown column ${key}`);
  return found;
}

/** Every column that carries a header menu, in display order. */
export const SORTABLE_COLUMNS: readonly SortColumnKey[] = COLUMNS.filter(
  (column) => column.sortable,
).map((column) => column.key as SortColumnKey);

/** Whether a column key is one a sort or a filter menu can be opened on. */
export function isSortColumn(key: ListColumnKey): key is SortColumnKey {
  return columnDef(key).sortable;
}

/** The column an option belongs to, paired with the option itself. */
export interface ColumnOption {
  readonly column: ListColumnDef;
  readonly option: ListFilterOption;
}

/** Every filter option on every column, flattened — the predicate lookup table. */
const OPTION_BY_PREDICATE = new Map<ColumnFilterPredicate, ColumnOption>(
  COLUMNS.flatMap((column) =>
    column.filterOptions.map((option): [ColumnFilterPredicate, ColumnOption] => [
      option.predicate,
      { column, option },
    ]),
  ),
);

/** The column and option a predicate came from. Throws on an unknown predicate. */
export function optionFor(predicate: ColumnFilterPredicate): ColumnOption {
  const found = OPTION_BY_PREDICATE.get(predicate);
  if (found === undefined) throw new Error(`optionFor: unknown predicate ${predicate}`);
  return found;
}

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
  return columnDef(column).track;
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
