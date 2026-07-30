/**
 * The invoice list as a triage queue: what state a row is in, when it is due in
 * words, which group it belongs to, and what each group adds up to.
 *
 * Pure module — no React, no `window.api`. The vitest project is
 * `environment: 'node'`, so every decision the cockpit makes about ordering,
 * grouping and relative time has to live here to be testable at all.
 *
 * Two rules the rest of the feature depends on:
 *
 * 1. **Relative timing is the payload.** A status pill says `overdue`; a row
 *    has to say `34 days late`, because the number is what decides whether you
 *    nudge, call, or write off. Every state therefore carries a sentence, not a
 *    label.
 * 2. **Sums are per currency.** This app stores one currency per invoice and
 *    holds no exchange rate anywhere (`src/shared/types.ts` has `currency` on
 *    the row and nothing that converts it). Adding GBP cents to USD cents would
 *    produce a headline number that is not any amount of any money, so a total
 *    is a *list* of per-currency totals and the formatter joins them.
 *
 * Dates are compared as calendar dates via ./detail's `daysBetween`, never as
 * `Date` objects built from a bare ISO string — see the note at the top of
 * ./detail for why that distinction decides whether "1 day late" is true.
 */

import type { Invoice } from '../../../shared/types';
import { calendarDateOf, daysBetween, daysPastDue } from './detail';
import { money } from './format';

/**
 * Width of the list column. Structural: it has to hold a client name, an
 * invoice number, a relative-time phrase and a right-aligned amount on two
 * lines, which no spacing token expresses.
 */
export const LIST_COLUMN_WIDTH = 396;

/**
 * The narrowest the list column is allowed to get before the pane stops taking
 * space off it. Two lines of ellipsised text and a right-aligned amount still
 * read at this width; below it the amount and the client name start colliding.
 */
export const LIST_COLUMN_MIN_WIDTH = 248;

/**
 * The narrowest the invoice pane is allowed to get. Below this the line-item
 * table's three fixed columns (qty, rate, amount) plus a description stop
 * fitting and the pane would rather scroll sideways than shrink.
 */
export const PANE_MIN_WIDTH = 448;

/**
 * How wide the list column is when the cockpit body has `available` px.
 *
 * The cockpit has to fit the app's own minimum window (`src/main/window.ts`
 * sets `minWidth: 960`, and the side nav takes 224-240 of it), so the two
 * columns cannot both be rigid. The rule: the pane is served first down to
 * `PANE_MIN_WIDTH`, the list gives up the difference, and neither goes below
 * its own floor — past that the *pane* scrolls inside itself rather than the
 * whole content region growing a horizontal scrollbar.
 *
 * This is the same rule the stylesheet evaluates via `listColumnWidthCss`; it
 * lives here as a number so the node-only suite can assert it.
 */
export function listColumnWidthAt(available: number): number {
  const wanted = available - PANE_MIN_WIDTH;
  return Math.min(Math.max(wanted, LIST_COLUMN_MIN_WIDTH), LIST_COLUMN_WIDTH);
}

/**
 * `listColumnWidthAt` as a CSS length. `100%` inside a flex item resolves
 * against the flex container's content box, which is the cockpit body — so the
 * clamp reacts to the window without a resize listener or a media query.
 */
export function listColumnWidthCss(): string {
  return `clamp(${String(LIST_COLUMN_MIN_WIDTH)}px, calc(100% - ${String(PANE_MIN_WIDTH)}px), ${String(LIST_COLUMN_WIDTH)}px)`;
}

/** How far ahead "Due this week" reaches. */
export const DUE_SOON_DAYS = 7;

/** What a row is, as far as triage is concerned. */
export type RowState = 'overdue' | 'due-soon' | 'later' | 'draft' | 'paid' | 'void';

/** The buckets rows fall into, in the order they are shown. */
export type GroupKey = 'overdue' | 'due-soon' | 'later' | 'drafts' | 'paid' | 'void';

/** The segmented control above the list. */
export type ListSegment = 'all' | 'overdue' | 'sent' | 'drafts';

export const GROUP_ORDER: readonly GroupKey[] = [
  'overdue',
  'due-soon',
  'later',
  'drafts',
  'paid',
  'void',
];

const GROUP_TITLES: Record<GroupKey, string> = {
  overdue: 'Overdue',
  'due-soon': 'Due this week',
  later: 'Later',
  drafts: 'Drafts',
  paid: 'Paid',
  void: 'Void',
};

/** Segments in display order. `void` and `paid` rows are only in `all`. */
export const LIST_SEGMENTS: readonly { readonly key: ListSegment; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'sent', label: 'Sent' },
  { key: 'drafts', label: 'Drafts' },
];

/** A sum of money that is only meaningful next to its currency. */
export interface CurrencyTotal {
  readonly currency: string;
  readonly cents: number;
}

export interface ListRow {
  readonly id: string;
  readonly invoice: Invoice;
  readonly clientName: string;
  readonly state: RowState;
  /** `34 days late`, `due in 2 days`, `paid 24 Jul` — never a status word alone. */
  readonly timing: string;
  /** The second line as shown: `INV-0051 · 34 days late`. */
  readonly secondary: string;
  readonly amount: string;
  /** Settled and unissued rows recede: lighter text, regular weight. */
  readonly isMuted: boolean;
}

export interface ListGroup {
  readonly key: GroupKey;
  readonly title: string;
  readonly totals: readonly CurrencyTotal[];
  readonly rows: readonly ListRow[];
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `2026-08-18` -> `18 Aug`, or `18 Aug 2027` when the year is not the year of
 * `today`. The year is dropped in the common case because the list is a column
 * 396px wide and "due 18 Aug 2026" spends four characters saying "this year".
 * Unparseable input is returned unchanged rather than guessed at.
 */
export function shortDate(iso: string, today: string): string {
  const match = ISO_DATE.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const label = MONTHS_SHORT[Number(month) - 1];
  if (label === undefined || year === undefined || day === undefined) return iso;
  const dayText = String(Number(day));
  return year === today.slice(0, 4) ? `${dayText} ${label}` : `${dayText} ${label} ${year}`;
}

/** Whole days from `today` until `dueDate`. Negative once it is past. */
export function daysUntilDue(dueDate: string, today: string): number | null {
  return daysBetween(today, dueDate);
}

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// State and timing
// ---------------------------------------------------------------------------

/**
 * Which triage state a row is in.
 *
 * `sent` is the only status that is re-read against the clock: an invoice sent
 * and past its due date is overdue whether or not anyone has run a job to
 * restate it, which is the same rule `isEffectivelyOverdue` in ./format applies.
 * Written as an exhaustive switch so a sixth `InvoiceStatus` fails typecheck
 * here instead of quietly landing in whichever branch a ternary fell into.
 */
export function rowStateOf(
  invoice: Pick<Invoice, 'status' | 'dueDate'>,
  today: string,
): RowState {
  switch (invoice.status) {
    case 'void':
      return 'void';
    case 'paid':
      return 'paid';
    case 'draft':
      return 'draft';
    case 'overdue':
      return 'overdue';
    case 'sent': {
      const days = daysUntilDue(invoice.dueDate, today);
      if (days === null) return 'later';
      if (days < 0) return 'overdue';
      return days <= DUE_SOON_DAYS ? 'due-soon' : 'later';
    }
  }
}

/**
 * The half-sentence that replaces the status pill. Every branch answers *when*,
 * because "when" is the thing the pill never said.
 */
export function relativeTiming(
  invoice: Pick<Invoice, 'dueDate' | 'updatedAt' | 'paidAt'>,
  state: RowState,
  today: string,
): string {
  switch (state) {
    case 'overdue': {
      const late = daysPastDue(invoice.dueDate, today);
      // A row stored as `overdue` whose due date has not arrived yet: say that
      // it is marked overdue rather than invent a negative day count.
      return late > 0 ? `${plural(late, 'day')} late` : 'marked overdue';
    }
    case 'due-soon': {
      const days = daysUntilDue(invoice.dueDate, today) ?? 0;
      if (days <= 0) return 'due today';
      if (days === 1) return 'due tomorrow';
      return `due in ${plural(days, 'day')}`;
    }
    case 'later':
      return `due ${shortDate(invoice.dueDate, today)}`;
    case 'draft':
      return `edited ${shortDate(calendarDateOf(invoice.updatedAt), today)}`;
    case 'paid':
      return invoice.paidAt === null
        ? 'paid'
        : `paid ${shortDate(calendarDateOf(invoice.paidAt), today)}`;
    case 'void':
      return `voided ${shortDate(calendarDateOf(invoice.updatedAt), today)}`;
  }
}

/** Which group a state lands in. */
export function groupOf(state: RowState): GroupKey {
  return state === 'draft' ? 'drafts' : state;
}

/** Open states — the ones with a receivable behind them. */
export function isOpenState(state: RowState): boolean {
  return state === 'overdue' || state === 'due-soon' || state === 'later';
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Per-currency totals, biggest first. Never one number: see the module header.
 */
export function sumByCurrency(invoices: readonly Invoice[]): CurrencyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const invoice of invoices) {
    byCurrency.set(invoice.currency, (byCurrency.get(invoice.currency) ?? 0) + invoice.totalCents);
  }
  return [...byCurrency]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => b.cents - a.cents || a.currency.localeCompare(b.currency));
}

/**
 * A headline sum: `$42,915`, no cents. Group sums and the page header are
 * scanned, not reconciled — the exact figure is on the row and in the pane.
 */
export function formatMoneyRounded(cents: number, currency: string): string {
  const units = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(units);
  } catch {
    return `${currency} ${String(Math.round(units))}`;
  }
}

/**
 * Per-currency totals as one string: `$42,915 · €8,100`, trailing `+1` when
 * there are more currencies than `maxEntries` has room for. Empty input gives
 * an empty string so the caller can drop the whole line.
 */
export function formatCurrencyTotals(
  totals: readonly CurrencyTotal[],
  maxEntries = 2,
): string {
  if (totals.length === 0) return '';
  const shown = totals.slice(0, Math.max(maxEntries, 1));
  const rest = totals.length - shown.length;
  const joined = shown.map((total) => formatMoneyRounded(total.cents, total.currency)).join(' · ');
  return rest > 0 ? `${joined} +${String(rest)}` : joined;
}

/**
 * One headline figure, plus an honest note that it is not the whole story.
 *
 * Summing across currencies is still refused — there is no rate anywhere in
 * this app — but `£124,333 · €103,073 · $83,819 +1` is a wall, and a line that
 * exists to answer "what do I owe attention to" has to be readable at a
 * glance. So the *largest* currency leads, the count of the others rides
 * beside it as a label rather than as more numbers, and `full` is what a
 * caller shows when the reader asks for the rest.
 */
export interface TotalsSummary {
  /** The biggest per-currency total, formatted: `£124,333`. Empty when none. */
  readonly lead: string;
  /** The currency `lead` is in, so a second summary can be led by the same one. */
  readonly leadCurrency: string | null;
  /** `+3 currencies`, or null when the lead is the whole set. */
  readonly more: string | null;
  /** Every currency, joined — what the disclosure reveals. */
  readonly full: string;
  /** How many currencies the lead is standing in front of. */
  readonly extraCurrencies: number;
}

/** `+3 currencies`, or null when one figure says it all. */
export function extraCurrencyLabel(count: number): string | null {
  if (count <= 0) return null;
  return `+${String(count)} ${count === 1 ? 'currency' : 'currencies'}`;
}

/**
 * `preferredCurrency` leads when the set contains it, largest first otherwise.
 *
 * The page header prints two summaries side by side — outstanding and its
 * overdue slice — and two figures under one sentence have to be in the same
 * money or the second reads as a fraction of the first when it is not even
 * denominated in it. So the overdue summary is asked to lead with whatever
 * currency the outstanding one led with.
 */
export function summariseTotals(
  totals: readonly CurrencyTotal[],
  preferredCurrency: string | null = null,
): TotalsSummary {
  const preferred =
    preferredCurrency === null
      ? undefined
      : totals.find((total) => total.currency === preferredCurrency);
  const first = preferred ?? totals[0];
  if (first === undefined) {
    return { lead: '', leadCurrency: null, more: null, full: '', extraCurrencies: 0 };
  }
  const extra = totals.length - 1;
  return {
    lead: formatMoneyRounded(first.cents, first.currency),
    leadCurrency: first.currency,
    more: extraCurrencyLabel(extra),
    full: formatCurrencyTotals(totals, totals.length),
    extraCurrencies: extra,
  };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

export function matchesSegment(state: RowState, segment: ListSegment): boolean {
  switch (segment) {
    case 'all':
      return true;
    case 'overdue':
      return state === 'overdue';
    case 'sent':
      // Everything issued and still open but not yet late. An overdue invoice
      // was sent too, but it has its own segment and belongs to it alone.
      return state === 'due-soon' || state === 'later';
    case 'drafts':
      return state === 'draft';
  }
}

/**
 * The counts printed inside the segmented control. Computed over the set the
 * search and the filter tokens already narrowed, so the numbers describe what
 * clicking a segment would actually show.
 */
export function countSegments(
  invoices: readonly Invoice[],
  today: string,
): Record<ListSegment, number> {
  const counts: Record<ListSegment, number> = { all: 0, overdue: 0, sent: 0, drafts: 0 };
  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    for (const { key } of LIST_SEGMENTS) {
      if (matchesSegment(state, key)) counts[key] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Within a group, the most urgent row first. Open groups sort by due date;
 * settled and unissued groups sort by when they last moved, newest first. Ties
 * fall back to the invoice number so the order is stable across renders.
 */
function compareInGroup(group: GroupKey, a: ListRow, b: ListRow): number {
  const left = a.invoice;
  const right = b.invoice;
  let primary = 0;
  switch (group) {
    case 'overdue':
    case 'due-soon':
    case 'later':
      primary = left.dueDate.localeCompare(right.dueDate);
      break;
    case 'paid':
      primary = (right.paidAt ?? right.updatedAt).localeCompare(left.paidAt ?? left.updatedAt);
      break;
    case 'drafts':
    case 'void':
      primary = right.updatedAt.localeCompare(left.updatedAt);
      break;
  }
  return primary !== 0 ? primary : left.number.localeCompare(right.number);
}

export interface BuildGroupsInput {
  readonly invoices: readonly Invoice[];
  /** clientId -> display name, joined in the view from `clients:list`. */
  readonly clientNames: ReadonlyMap<string, string>;
  readonly today: string;
  readonly segment: ListSegment;
}

/**
 * The list as the reader sees it: groups in urgency order, empty groups
 * dropped, each carrying its own per-currency sum.
 *
 * Paid rows get no sum in the mockup, and they get none here either: money that
 * has arrived is not a figure you are chasing, and printing it beside four
 * chase totals invites adding it to them.
 */
export function buildInvoiceGroups({
  invoices,
  clientNames,
  today,
  segment,
}: BuildGroupsInput): ListGroup[] {
  const buckets = new Map<GroupKey, ListRow[]>();
  const sources = new Map<GroupKey, Invoice[]>();

  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    if (!matchesSegment(state, segment)) continue;
    const group = groupOf(state);
    const timing = relativeTiming(invoice, state, today);
    const row: ListRow = {
      id: invoice.id,
      invoice,
      clientName: clientNames.get(invoice.clientId) ?? invoice.clientId,
      state,
      timing,
      secondary: `${invoice.number} · ${timing}`,
      amount: money(invoice.totalCents, invoice.currency),
      isMuted: !isOpenState(state),
    };
    const rows = buckets.get(group);
    if (rows === undefined) buckets.set(group, [row]);
    else rows.push(row);
    const raw = sources.get(group);
    if (raw === undefined) sources.set(group, [invoice]);
    else raw.push(invoice);
  }

  const groups: ListGroup[] = [];
  for (const key of GROUP_ORDER) {
    const rows = buckets.get(key);
    if (rows === undefined || rows.length === 0) continue;
    rows.sort((a, b) => compareInGroup(key, a, b));
    groups.push({
      key,
      title: GROUP_TITLES[key],
      totals: key === 'paid' ? [] : sumByCurrency(sources.get(key) ?? []),
      rows,
    });
  }
  return groups;
}

/**
 * The sticky caption, in the two parts the view paints differently:
 * `Overdue · £124,333` at full strength and `+3 currencies` beside it in the
 * muted colour.
 *
 * The caption used to read `DRAFTS · $73,308 · €49,499 +2`, which is three
 * numbers deep in a 248-396px column and still hides half the currencies. One
 * figure and a count of what it stands in front of says the same thing without
 * pretending the rest are not there; the page header's disclosure has the
 * whole breakdown.
 */
export interface GroupHeaderParts {
  readonly label: string;
  readonly more: string | null;
}

/** `Overdue · $42,915` + `+3 currencies`, or just `Overdue` when there is no sum. */
export function groupHeaderParts(group: ListGroup): GroupHeaderParts {
  const summary = summariseTotals(group.totals);
  if (summary.lead === '') return { label: group.title, more: null };
  return { label: `${group.title} · ${summary.lead}`, more: summary.more };
}

/** Every row in reading order — what `J`/`K` walk. */
export function flattenGroups(groups: readonly ListGroup[]): ListRow[] {
  return groups.flatMap((group) => [...group.rows]);
}

/**
 * The row `delta` steps from `currentId`, clamped at both ends so holding `J`
 * parks on the last row rather than wrapping round to the top and losing the
 * reader's place. Null when there is nothing to select; the first row when the
 * current selection is no longer in the list.
 */
export function adjacentRowId(
  rows: readonly ListRow[],
  currentId: string | null,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const index = currentId === null ? -1 : rows.findIndex((row) => row.id === currentId);
  if (index === -1) return rows[0]?.id ?? null;
  const next = Math.min(Math.max(index + delta, 0), rows.length - 1);
  return rows[next]?.id ?? null;
}

/** 1-based position of a row in the flattened list, or null when absent. */
export function rowPosition(rows: readonly ListRow[], id: string | null): number | null {
  if (id === null) return null;
  const index = rows.findIndex((row) => row.id === id);
  return index === -1 ? null : index + 1;
}

// ---------------------------------------------------------------------------
// Page header sums
// ---------------------------------------------------------------------------

/** Everything still owed: sent, due soon, later, and overdue. */
export function outstandingTotals(invoices: readonly Invoice[], today: string): CurrencyTotal[] {
  return sumByCurrency(invoices.filter((invoice) => isOpenState(rowStateOf(invoice, today))));
}

/** The overdue slice of `outstandingTotals`. */
export function overdueTotals(invoices: readonly Invoice[], today: string): CurrencyTotal[] {
  return sumByCurrency(invoices.filter((invoice) => rowStateOf(invoice, today) === 'overdue'));
}

// ---------------------------------------------------------------------------
// The one definition of "open" and "overdue"
// ---------------------------------------------------------------------------

/** Unpaid invoice totals. `overdue` is a subset of `open`. */
export interface OpenInvoiceCounts {
  readonly open: number;
  readonly overdue: number;
}

/**
 * How many invoices are open, and how many of those are late — the single
 * definition both the shell's status line and the list's segmented control
 * read.
 *
 * It is the *date-derived* one. The stored `overdue` status is a flag somebody
 * has to remember to set; `rowStateOf` re-reads every `sent` invoice against
 * the clock, so an invoice that went past its due date last night is late this
 * morning without a job having run. The two used to be computed separately —
 * the breadcrumb counted `status = 'overdue'` and said `4`, the segment
 * counted the clock and said `17` — and two true numbers under the same word
 * on the same screen read as a bug. There is now one function.
 */
export function countOpenInvoices(
  invoices: readonly Invoice[],
  today: string,
): OpenInvoiceCounts {
  let open = 0;
  let overdue = 0;
  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    if (!isOpenState(state)) continue;
    open += 1;
    if (state === 'overdue') overdue += 1;
  }
  return { open, overdue };
}
