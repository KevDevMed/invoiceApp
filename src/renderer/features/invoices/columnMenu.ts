/**
 * Every decision the column header menus make.
 *
 * The menus themselves are markup in ./InvoiceList; this is what they read.
 * The split is not stylistic: the vitest project is `environment: 'node'` with
 * an `*.test.ts` include glob, so anything left inside the `.tsx` is
 * permanently untestable *and* a `.tsx` test file is skipped silently rather
 * than failing loudly. Which arrow points which way, which edge a menu anchors
 * to, and whether a chip is a duplicate are exactly the things that break
 * quietly, so they live here.
 *
 * Pure module — no React.
 */

import type { FilterChip } from './filters';
import { formatRangeValue } from './filters';
import type {
  ColumnFilterInput,
  ColumnFilterPredicate,
  ListColumnDef,
  ListColumnKey,
  ListColumnKind,
  SortColumnKey,
} from './listColumns';
import { columnDef, optionFor } from './listColumns';
import { SORT_LABELS } from './listRows';
import type { SortChoice, SortDirection, SortState } from './listRows';

// ---------------------------------------------------------------------------
// Sort presentation
// ---------------------------------------------------------------------------

/**
 * The two sort rows a column of this kind offers, in the design's order.
 *
 * The direction is carried by the label, not assumed from its position: the
 * first option is `desc` for numbers and dates and `asc` for status, so
 * "first option = ascending" is wrong on three of the four kinds.
 */
export function sortLabelsFor(kind: ListColumnKind): readonly SortChoice[] {
  return SORT_LABELS[kind];
}

/** Whether this column is the one the list is currently ordered by. */
export function isSortActive(sort: SortState, column: SortColumnKey): boolean {
  return sort.column === column;
}

/**
 * Whether a given sort row is the one in force — what fills its radio dot.
 * False on every row of an inactive column, so two dots are never lit at once.
 */
export function isSortChoiceActive(
  sort: SortState,
  column: SortColumnKey,
  direction: SortDirection,
): boolean {
  return sort.column === column && sort.direction === direction;
}

/**
 * The sort arrow's transform. Up for ascending, flipped for descending — and
 * because the direction comes from the chosen label's own pair, the arrow can
 * never contradict the words that set it.
 */
export function arrowRotation(direction: SortDirection): string {
  return direction === 'desc' ? 'rotate(180deg)' : 'rotate(0deg)';
}

/** The header chevron's transform: flipped while this column's menu is open. */
export function chevronRotation(isOpen: boolean): string {
  return isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
}

/**
 * A header button's accessible name, carrying the sort state in words.
 *
 * The header strip used to be a synthetic one-row `role="table"` whose
 * `columnheader` cells carried `aria-sort`, while the data rows below were
 * `role="link"` siblings *outside* it. Assistive technology saw column headers
 * with no rows and then a pile of unassociated links: the `aria-sort` was
 * syntactically valid and structurally meaningless. Converting the rows to a
 * real table is a rewrite the row cannot survive (it is the click target and it
 * contains a checkbox and a menu button), so the scaffolding is gone and the
 * sort state rides here instead — announced on the control that sets it, which
 * is where a reader operating the list actually is.
 *
 * `TOTAL, sorted Largest first` / `CLIENT, not sorted`. The active direction's
 * own label is quoted verbatim rather than re-worded, for the same reason the
 * arrow reads its rotation from that label: two spellings of one order are two
 * chances to disagree.
 */
export function headerAccessibleName(definition: ListColumnDef, sort: SortState): string {
  if (sort.column !== definition.key) return `${definition.label}, not sorted`;
  const choice = sortLabelsFor(definition.kind).find(
    (candidate) => candidate.direction === sort.direction,
  );
  return choice === undefined
    ? `${definition.label}, not sorted`
    : `${definition.label}, sorted ${choice.label}`;
}

/**
 * The toolbar pill's name for the active column: the label with ` & DUE`
 * stripped and title-cased, except STATUS & DUE itself, which reads `Due date`
 * because that is what the order actually is.
 */
export function sortPillLabel(column: SortColumnKey): string {
  if (column === 'status') return 'Due date';
  const bare = columnDef(column).label.replace(' & DUE', '');
  return bare.charAt(0) + bare.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Menu open/close and placement
// ---------------------------------------------------------------------------

/**
 * The open menu after a header is clicked: its own menu toggles, and any other
 * column's closes. One reduction, so "clicking a header closes the other menu"
 * is a property of the state rather than of the order two handlers ran in.
 */
export function toggleMenu(
  open: SortColumnKey | null,
  column: SortColumnKey,
): SortColumnKey | null {
  return open === column ? null : column;
}

/**
 * The open menu after a render, given the columns the header strip actually
 * drew. Null once the column that owns it is gone.
 *
 * `openMenu` used to outlive its header. An empty result set removes the header
 * strip entirely, and the responsive tiers drop columns as the window narrows —
 * either way the state and the document-level close listener survived, so
 * restoring rows or widening the window re-opened a menu the reader never asked
 * for, sometimes minutes later. A menu belongs to a header; when the header
 * stops being rendered the menu is closed, not suspended.
 *
 * `rendered` is empty whenever the strip itself is absent, which is why this
 * takes the drawn columns rather than the layout's.
 */
export function retainOpenMenu(
  open: SortColumnKey | null,
  rendered: readonly ListColumnKey[],
): SortColumnKey | null {
  if (open === null) return null;
  return rendered.includes(open) ? open : null;
}

export interface MenuAnchor {
  readonly insetInlineStart: string;
  readonly insetInlineEnd: string;
}

/**
 * Which edge the menu hangs from. A right-aligned column anchors right so a
 * 206px menu on TOTAL — the last column before the ⋯ gutter — opens inward
 * instead of off the card.
 */
export function menuAnchor(align: ListColumnDef['align']): MenuAnchor {
  return align === 'end'
    ? { insetInlineStart: 'auto', insetInlineEnd: '0px' }
    : { insetInlineStart: '0px', insetInlineEnd: 'auto' };
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/**
 * The design's own rule: `STATUS & DUE` + `Overdue only` reads
 * `STATUS: Overdue only`. The ` & DUE` is dropped because the chip is already
 * next to four others and the column it names has to fit; the `…` is dropped
 * because an applied filter is no longer a prompt for input.
 */
export function chipTag(columnLabel: string, optionLabel: string): string {
  return `${columnLabel.replace(' & DUE', '')}: ${optionLabel.replace('…', '')}`;
}

/** What a chip prints. A chip carrying an input appends the reader's value. */
export function chipLabel(chip: FilterChip): string {
  const { column, option } = optionFor(chip.predicate);
  const tag = chipTag(column.label, option.label);
  const value = chip.value?.trim() ?? '';
  return value === '' ? tag : `${tag} ${value}`;
}

/**
 * A comma-separated value reduced to its set: split, trimmed, empties dropped,
 * folded to lower case, **deduplicated**, sorted, rejoined.
 *
 * This is what a `text-list` chip *means*, as opposed to what the reader typed.
 * `Halcyon, Northwind` and `northwind,Halcyon` are one predicate over one set
 * of names and must therefore be one chip; the order the two names were typed
 * in is not part of the filter.
 *
 * Nor is the *multiplicity*. Without the dedupe this said `halcyon` for one
 * mention and `halcyon,halcyon` for two, so `Halcyon` and `Halcyon, Halcyon`
 * were two chips — and `matchesChip` narrows on the token set, so both narrowed
 * to the same rows and removing either left the other still filtering, with the
 * bar showing a chip the reader had already dismissed. A set has no counts.
 */
export function normaliseTokenList(value: string): string {
  const tokens = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
  return [...new Set(tokens)].sort().join(',');
}

/**
 * A chip's structural identity: what makes two chips the same filter.
 *
 * The predicate and the value, never the rendered label — `TOTAL: Between
 * 1,000 – 5,000` and `TOTAL: Between 1000 – 5000` are the same filter typed
 * two ways, and two different predicates could one day print the same words.
 *
 * A `text-list` value is reduced to its normalised token set first. Lower-casing
 * the whole string, which is all this used to do, left `Halcyon, Northwind` and
 * `northwind,Halcyon` as two different keys — two chips in the bar, both
 * narrowing to the same rows, and the second one no more removable than the
 * first because they are genuinely distinct entries.
 */
export function chipKey(chip: FilterChip): string {
  const raw = chip.value?.trim() ?? '';
  const { option } = optionFor(chip.predicate);
  const value = option.input === 'text-list' ? normaliseTokenList(raw) : raw.toLowerCase();
  return `${chip.predicate}::${value}`;
}

/** `chip` appended, or the list unchanged when that filter is already applied. */
export function addChip(
  chips: readonly FilterChip[],
  chip: FilterChip,
): readonly FilterChip[] {
  const key = chipKey(chip);
  if (chips.some((existing) => chipKey(existing) === key)) return chips;
  return [...chips, chip];
}

/** The list without the chip identified by `key`. */
export function removeChip(chips: readonly FilterChip[], key: string): readonly FilterChip[] {
  return chips.filter((chip) => chipKey(chip) !== key);
}

/** The chip bar exists only while it has something in it. */
export function hasChips(chips: readonly FilterChip[]): boolean {
  return chips.length > 0;
}

/** The chip a filter option commits, given whatever the input step produced. */
export function buildChip(predicate: ColumnFilterPredicate, value?: string): FilterChip {
  const { column } = optionFor(predicate);
  const trimmed = value?.trim() ?? '';
  return trimmed === ''
    ? { columnKey: column.key, predicate }
    : { columnKey: column.key, predicate, value: trimmed };
}

// ---------------------------------------------------------------------------
// The input step
// ---------------------------------------------------------------------------

/**
 * What the second page of the menu holds. One surface, not a nested popover:
 * Astryx's `usePopover` traps focus unconditionally (CLAUDE.md), so a popover
 * inside a popover would leave the reader unable to Tab out of either. Choosing
 * an ellipsis option swaps this menu's body in place instead.
 */
export interface FilterInputDraft {
  readonly from: string;
  /** Unused by the single-field inputs (`text`, `currency`). */
  readonly to: string;
}

export interface FilterInputResult {
  readonly isValid: boolean;
  /** Why not, for the field's error text. Null when valid. */
  readonly error: string | null;
  /** The canonical value to store on the chip. Empty when invalid. */
  readonly value: string;
}

export const EMPTY_DRAFT: FilterInputDraft = { from: '', to: '' };

/**
 * What the menu focuses when its body changes, most wanted first — the caller
 * takes the first selector that matches something inside the surface.
 *
 * The list step is all buttons, so the first button is the first row. The value
 * step is the whole reason there is a second page, and it opened with focus on
 * `Cancel`: the surface was queried for `button`, and the two fields render
 * above the footer but are not buttons, so choosing `Between…` or `Is any of…`
 * with the keyboard left the reader typing into nothing. The field comes first
 * there, and the button stays as the fallback for an input step that somehow
 * drew none.
 */
export function menuFocusSelectors(hasValueStep: boolean): readonly string[] {
  return hasValueStep ? ['input, textarea', 'button'] : ['button'];
}

/**
 * Whether the menu's own Up/Down row-walking applies. It does not on the value
 * step: focus is in a text field there, and the arrow keys belong to the
 * caret — stealing them to cycle Cancel/Apply would make the field
 * unnavigable the moment it is focused, which is what this round just fixed.
 */
export function menuHandlesArrowKeys(hasValueStep: boolean): boolean {
  return !hasValueStep;
}

/** How many fields the input step draws, and what it calls them. */
export function inputFieldLabels(input: ColumnFilterInput): readonly string[] {
  switch (input) {
    case 'none':
      return [];
    case 'text':
      return ['Value'];
    case 'text-list':
      return ['Values, comma separated'];
    case 'currency':
      return ['Currency code'];
    case 'money-range':
      return ['From', 'To'];
    case 'date-range':
      return ['From', 'To'];
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function money(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Whether `value` is a date that exists, not merely one shaped like a date.
 *
 * The shape check alone accepted `2026-02-31` and `2026-13-01`, which then went
 * into a chip and were compared *lexically* against `issueDate` — so a "range"
 * ending on a day that never happened silently included or excluded rows by
 * string order with nothing on screen admitting it. `Date.UTC` normalises an
 * impossible day into the next month, so a round trip that comes back with the
 * same three fields is the whole test. UTC throughout: these are calendar
 * dates, and building them in local time would move a date across a boundary
 * depending on where the reader is sitting.
 */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/**
 * Whether the draft can be committed, and what it commits as.
 *
 * Reversed ranges are corrected rather than rejected — a reader who typed the
 * larger number first meant a range, not a mistake — but anything that is not a
 * number, not a *real calendar* date, not a three-letter code, or not at least
 * one comma token is refused, because a chip that cannot be evaluated would
 * silently match everything.
 */
export function validateFilterInput(
  input: ColumnFilterInput,
  draft: FilterInputDraft,
): FilterInputResult {
  const from = draft.from.trim();
  const to = draft.to.trim();

  switch (input) {
    case 'none':
      return { isValid: true, error: null, value: '' };

    case 'text':
      return from === ''
        ? { isValid: false, error: 'Enter a value', value: '' }
        : { isValid: true, error: null, value: from };

    case 'text-list': {
      // `", "` is not empty and used to pass the `text` check, committing a chip
      // whose token list is empty — which matches every invoice. A chip that
      // claims to restrict and narrows nothing is worse than a rejected field.
      const tokens = from
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
      // The reader's own casing and order are kept: this is what the chip
      // prints. `chipKey` normalises separately, so identity and display can
      // disagree without either being wrong.
      return tokens.length === 0
        ? { isValid: false, error: 'Enter at least one value', value: '' }
        : { isValid: true, error: null, value: tokens.join(', ') };
    }

    case 'currency':
      return CURRENCY_CODE.test(from)
        ? { isValid: true, error: null, value: from.toUpperCase() }
        : { isValid: false, error: 'Enter a three-letter code, e.g. USD', value: '' };

    case 'money-range': {
      const low = money(from);
      const high = money(to);
      if (low === null || high === null) {
        return { isValid: false, error: 'Enter two amounts', value: '' };
      }
      const [a, b] = low <= high ? [low, high] : [high, low];
      return { isValid: true, error: null, value: formatRangeValue(String(a), String(b)) };
    }

    case 'date-range': {
      if (!isCalendarDate(from) || !isCalendarDate(to)) {
        return { isValid: false, error: 'Enter two real dates as YYYY-MM-DD', value: '' };
      }
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { isValid: true, error: null, value: formatRangeValue(a, b) };
    }
  }
}
