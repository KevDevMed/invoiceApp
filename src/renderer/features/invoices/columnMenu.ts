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
 * A chip's structural identity: what makes two chips the same filter.
 *
 * The predicate and the value, never the rendered label — `TOTAL: Between
 * 1,000 – 5,000` and `TOTAL: Between 1000 – 5000` are the same filter typed
 * two ways, and two different predicates could one day print the same words.
 */
export function chipKey(chip: FilterChip): string {
  return `${chip.predicate}::${chip.value?.trim().toLowerCase() ?? ''}`;
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

/** How many fields the input step draws, and what it calls them. */
export function inputFieldLabels(input: ColumnFilterInput): readonly string[] {
  switch (input) {
    case 'none':
      return [];
    case 'text':
      return ['Value'];
    case 'currency':
      return ['Currency code'];
    case 'money-range':
      return ['From', 'To'];
    case 'date-range':
      return ['From', 'To'];
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

function money(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Whether the draft can be committed, and what it commits as.
 *
 * Reversed ranges are corrected rather than rejected — a reader who typed the
 * larger number first meant a range, not a mistake — but anything that is not a
 * number, not a date, or not a three-letter code is refused, because a chip
 * that cannot be evaluated would silently match everything.
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
      if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
        return { isValid: false, error: 'Enter two dates as YYYY-MM-DD', value: '' };
      }
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { isValid: true, error: null, value: formatRangeValue(a, b) };
    }
  }
}
