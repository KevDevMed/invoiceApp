/**
 * The four money tiles at the top of the invoice list.
 *
 * Design 3a's own argument for them: *"Four money tiles answer the real
 * question — outstanding, overdue, due this week, unsent drafts — before you
 * read a single row."* So each tile is a label, one figure, and a sub-line that
 * says how many invoices are behind the figure and — for overdue — how old the
 * worst one is.
 *
 * Money stays integer cents and stays per currency. This app holds no exchange
 * rate (see the Currency note in the 3a spec and the header of ./listGrouping),
 * so a tile leads with its largest currency and carries a count of the others
 * rather than inventing a converted total. `extraCurrencies` is what the view
 * turns into an affordance; `full` is what that affordance reveals.
 *
 * Pure module — no React, no `window.api`. Everything here is asserted by the
 * node-only vitest project.
 */

import type { Invoice } from '../../../shared/types';
import { daysBetween, daysPastDue } from './detail';
import type { ColumnFilterPredicate } from './listColumns';
import {
  isOpenState,
  rowStateOf,
  summariseTotals,
  sumByCurrency,
  type RowState,
} from './listGrouping';

export type MoneyTileKey = 'outstanding' | 'overdue' | 'due-soon' | 'drafts';

export interface MoneyTile {
  readonly key: MoneyTileKey;
  readonly label: string;
  /** The lead per-currency figure, or an em dash when the bucket is empty. */
  readonly figure: string;
  /**
   * The sub-line under the figure. Forward-looking rather than a restatement of
   * the count, which now sits in the tile's header row: `next: Halcyon, Fri`,
   * `never sent · oldest 12d`. Never empty — it says so when it is zero.
   */
  readonly detail: string;
  /** The count as the header row prints it: `31 invoices`, or a bare `4`. */
  readonly headerCount: string;
  /** How many currencies `figure` is standing in front of. */
  readonly extraCurrencies: number;
  /** Every currency joined — what the disclosure shows. */
  readonly full: string;
  /** How many invoices the figure covers. */
  readonly count: number;
  /** Only `overdue` is toned; the design colours exactly one tile. */
  readonly tone: 'neutral' | 'error';
  /**
   * The filter a click on this tile applies. A tile is a filter shortcut, and
   * it produces the same chip the matching column-menu option would — a tile
   * that reached a state no menu offers would be a state the reader cannot
   * reproduce or undo by hand.
   */
  readonly predicate: ColumnFilterPredicate;
}

/** The empty figure. An em dash, not `$0` — nothing is not zero of something. */
const NO_FIGURE = '—';

/** Past this, an overdue invoice has stopped being late and started being a problem. */
const STALE_OVERDUE_DAYS = 30;

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

function invoiceCount(count: number): string {
  return plural(count, 'invoice');
}

/**
 * `Fri` for an ISO date. Built through `Date.UTC` from the parsed parts rather
 * than `new Date(iso)` so the weekday is the one on the calendar, not the one
 * the runner's timezone shifts a midnight-UTC instant into.
 */
function weekdayOf(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, year, month, day] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return WEEKDAYS_SHORT[new Date(stamp).getUTCDay()] ?? null;
}

/**
 * `next: Halcyon, Fri` — who and when the soonest of a bucket is due. The one
 * fact a reader acts on next, in place of a count they can already see in the
 * header row. Falls back to the count when no name has been joined yet.
 */
function nextDueDetail(
  bucket: readonly Invoice[],
  clientNames: ReadonlyMap<string, string>,
): string {
  const soonest = bucket.reduce<Invoice | null>(
    (best, invoice) => (best === null || invoice.dueDate < best.dueDate ? invoice : best),
    null,
  );
  if (soonest === null) return invoiceCount(bucket.length);
  const name = clientNames.get(soonest.clientId);
  const day = weekdayOf(soonest.dueDate);
  if (name === undefined || day === null) return invoiceCount(bucket.length);
  return `next: ${name}, ${day}`;
}

/** `never sent · oldest 12d` — how long the stalest draft has been sitting. */
function draftDetail(drafts: readonly Invoice[], today: string): string {
  const oldest = drafts.reduce((worst, invoice) => {
    const age = daysBetween(invoice.issueDate, today);
    return age === null ? worst : Math.max(worst, age);
  }, 0);
  return oldest <= 0 ? 'never sent' : `never sent · oldest ${String(oldest)}d`;
}

/** Which tile, if any, an invoice's state feeds. Paid and void feed none. */
function tileOf(state: RowState): MoneyTileKey | null {
  if (state === 'draft') return 'drafts';
  if (state === 'due-soon') return 'due-soon';
  if (isOpenState(state)) return state === 'overdue' ? 'overdue' : null;
  return null;
}

/**
 * The four tiles, in design order.
 *
 * `outstanding` is every open receivable — overdue, due soon and later — so the
 * overdue and due-soon tiles are slices of it rather than peers of it. All four
 * are asked to lead with the currency the outstanding tile led with, for the
 * same reason the old header line was: four figures side by side that are not
 * the same money read as a breakdown of each other when they are not.
 */
export function buildMoneyTiles(
  invoices: readonly Invoice[],
  today: string,
  clientNames: ReadonlyMap<string, string> = new Map(),
): MoneyTile[] {
  const open: Invoice[] = [];
  const overdue: Invoice[] = [];
  const dueSoon: Invoice[] = [];
  const drafts: Invoice[] = [];

  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    if (isOpenState(state)) open.push(invoice);
    switch (tileOf(state)) {
      case 'overdue':
        overdue.push(invoice);
        break;
      case 'due-soon':
        dueSoon.push(invoice);
        break;
      case 'drafts':
        drafts.push(invoice);
        break;
      default:
        break;
    }
  }

  const outstandingSummary = summariseTotals(sumByCurrency(open));
  const lead = outstandingSummary.leadCurrency;

  /** The worst overdue invoice, in days. 0 when none is actually past due. */
  const oldest = overdue.reduce(
    (worst, invoice) => Math.max(worst, daysPastDue(invoice.dueDate, today)),
    0,
  );

  /**
   * How many are past `STALE_OVERDUE_DAYS`. The design's third overdue fact is
   * `4 past a reminder`; this app sends nothing and tracks no reminders (the
   * bulk bar says so too), so the fact that is actually true stands in its
   * place — same shape, same purpose, no invented history.
   */
  const stale = overdue.filter(
    (invoice) => daysPastDue(invoice.dueDate, today) > STALE_OVERDUE_DAYS,
  ).length;

  const overdueDetail =
    overdue.length === 0
      ? 'Nothing overdue'
      : [
          invoiceCount(overdue.length),
          oldest === 0 ? null : `oldest ${plural(oldest, 'day')}`,
          stale === 0 ? null : `${String(stale)} over ${String(STALE_OVERDUE_DAYS)} days`,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');

  const tile = (
    key: MoneyTileKey,
    label: string,
    bucket: readonly Invoice[],
    detail: string,
    headerCount: string,
    tone: 'neutral' | 'error',
    predicate: ColumnFilterPredicate,
    summary = summariseTotals(sumByCurrency(bucket), lead),
  ): MoneyTile => ({
    key,
    label,
    figure: summary.lead === '' ? NO_FIGURE : summary.lead,
    detail,
    headerCount,
    extraCurrencies: summary.extraCurrencies,
    full: summary.full,
    count: bucket.length,
    tone,
    predicate,
  });

  return [
    tile(
      'outstanding',
      'Outstanding',
      open,
      open.length === 0 ? 'Nothing outstanding' : invoiceCount(open.length),
      invoiceCount(open.length),
      'neutral',
      'status-open',
      outstandingSummary,
    ),
    tile(
      'overdue',
      'Overdue',
      overdue,
      overdueDetail,
      String(overdue.length),
      'error',
      'status-overdue',
    ),
    tile(
      'due-soon',
      'Due in 7 days',
      dueSoon,
      dueSoon.length === 0 ? 'Nothing due this week' : nextDueDetail(dueSoon, clientNames),
      String(dueSoon.length),
      'neutral',
      'status-due-soon',
    ),
    tile(
      'drafts',
      'Drafts',
      drafts,
      drafts.length === 0 ? 'No drafts' : draftDetail(drafts, today),
      String(drafts.length),
      'neutral',
      'status-draft',
    ),
  ];
}
