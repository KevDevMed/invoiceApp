/**
 * What state an invoice is in, which status tab it answers to, and what a set
 * of invoices adds up to.
 *
 * Pure module — no React, no `window.api`. The vitest project is
 * `environment: 'node'`, so every decision the list makes about state, segments
 * and money has to live here to be testable at all.
 *
 * The presentation built on top of these lives next door: ./listRows turns a
 * state into the row's merged status-and-due phrase, ./moneyTiles turns these
 * sums into the four tiles, and ./listColumns decides which columns survive the
 * available width. This module is the vocabulary all three share.
 *
 * Two rules the rest of the feature depends on:
 *
 * 1. **Relative timing is the payload.** A status pill says `overdue`; a row
 *    has to say `Overdue 34 days`, because the number is what decides whether
 *    you nudge, call, or write off. Every state therefore earns a sentence in
 *    ./listRows, not a label.
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
import { daysBetween } from './detail';

/** How far ahead "Due this week" reaches. */
export const DUE_SOON_DAYS = 7;

/** What a row is, as far as triage is concerned. */
export type RowState = 'overdue' | 'due-soon' | 'later' | 'draft' | 'paid' | 'void';

/** The status tabs above the list. */
export type ListSegment = 'all' | 'overdue' | 'sent' | 'drafts' | 'paid';

/**
 * Segments in display order — design 3a's five tabs. `paid` earns one because
 * a settled invoice is the thing you go looking for when a client says they
 * already paid; `void` still has no tab and stays reachable through `all` and
 * the filter vocabulary.
 */
export const LIST_SEGMENTS: readonly { readonly key: ListSegment; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'sent', label: 'Sent' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'paid', label: 'Paid' },
];

/** A sum of money that is only meaningful next to its currency. */
export interface CurrencyTotal {
  readonly currency: string;
  readonly cents: number;
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
    case 'paid':
      return state === 'paid';
  }
}

/**
 * The tab that is *about* a state, as opposed to one that merely tolerates it.
 *
 * `matchesSegment` is a containment test and `all` contains everything, so
 * searching `LIST_SEGMENTS` for the first segment that matches a state always
 * answers `all` — which is true and useless. This is the other relation: the
 * one segment whose subject is this state. `void` has no tab of its own and is
 * only reachable through `all` and the filter vocabulary, so `all` is its
 * honest answer rather than a fallback.
 */
const SEGMENT_ABOUT: Record<RowState, ListSegment> = {
  overdue: 'overdue',
  'due-soon': 'sent',
  later: 'sent',
  draft: 'drafts',
  paid: 'paid',
  void: 'all',
};

/**
 * The tab an action targeting `state` has to land on. The answer does not
 * depend on where the reader started, which is the whole point.
 *
 * `Chase all N` selects the overdue invoices and applies the Overdue chip, but
 * it used to leave the segment alone. On `Sent`, `Drafts` or `Paid` — none of
 * which admit an overdue row — the row set went empty, the selection was
 * narrowed to what is visible and therefore to nothing, and the button did
 * nothing at all with no error and no change on screen.
 *
 * The first repair kept a segment that already showed the state, and `all`
 * shows everything, so Chase from `All` left `All` pressed and `Overdue`
 * reporting `aria-pressed="false"` — one button with two behaviours depending
 * on the tab it was pressed from. The destination is now unconditional.
 *
 * The move is by *identity*, never by predicate search: `LIST_SEGMENTS` leads
 * with the universal `all`, so `find(matchesSegment)` reached `all` first and
 * Chase from `Sent` landed on `All` — the right 17 rows and the right chip
 * under a tab that was not the one the action is about.
 */
export function segmentShowing(state: RowState): ListSegment {
  return SEGMENT_ABOUT[state];
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
  const counts: Record<ListSegment, number> = {
    all: 0,
    overdue: 0,
    sent: 0,
    drafts: 0,
    paid: 0,
  };
  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    for (const { key } of LIST_SEGMENTS) {
      if (matchesSegment(state, key)) counts[key] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

/** The least a row has to be for `J`/`K` to walk it. */
export interface IdentifiedRow {
  readonly id: string;
}

/**
 * The row `delta` steps from `currentId`, clamped at both ends so holding `J`
 * parks on the last row rather than wrapping round to the top and losing the
 * reader's place. Null when there is nothing to select; the first row when the
 * current selection is no longer in the list.
 */
export function adjacentRowId(
  rows: readonly IdentifiedRow[],
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
export function rowPosition(rows: readonly IdentifiedRow[], id: string | null): number | null {
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
