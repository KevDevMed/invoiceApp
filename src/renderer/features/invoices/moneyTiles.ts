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
import { daysPastDue } from './detail';
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
  /** `6 invoices · oldest 34 days`. Never empty — says so when it is zero. */
  readonly detail: string;
  /** How many currencies `figure` is standing in front of. */
  readonly extraCurrencies: number;
  /** Every currency joined — what the disclosure shows. */
  readonly full: string;
  /** How many invoices the figure covers. */
  readonly count: number;
  /** Only `overdue` is toned; the design colours exactly one tile. */
  readonly tone: 'neutral' | 'error';
}

/** The empty figure. An em dash, not `$0` — nothing is not zero of something. */
const NO_FIGURE = '—';

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

function invoiceCount(count: number): string {
  return plural(count, 'invoice');
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
export function buildMoneyTiles(invoices: readonly Invoice[], today: string): MoneyTile[] {
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

  const overdueDetail =
    overdue.length === 0
      ? 'Nothing overdue'
      : oldest === 0
        ? invoiceCount(overdue.length)
        : `${invoiceCount(overdue.length)} · oldest ${plural(oldest, 'day')}`;

  const tile = (
    key: MoneyTileKey,
    label: string,
    bucket: readonly Invoice[],
    detail: string,
    tone: 'neutral' | 'error',
    summary = summariseTotals(sumByCurrency(bucket), lead),
  ): MoneyTile => ({
    key,
    label,
    figure: summary.lead === '' ? NO_FIGURE : summary.lead,
    detail,
    extraCurrencies: summary.extraCurrencies,
    full: summary.full,
    count: bucket.length,
    tone,
  });

  return [
    tile(
      'outstanding',
      'Outstanding',
      open,
      open.length === 0 ? 'Nothing outstanding' : invoiceCount(open.length),
      'neutral',
      outstandingSummary,
    ),
    tile('overdue', 'Overdue', overdue, overdueDetail, 'error'),
    tile(
      'due-soon',
      'Due in 7 days',
      dueSoon,
      dueSoon.length === 0 ? 'Nothing due this week' : invoiceCount(dueSoon.length),
      'neutral',
    ),
    tile(
      'drafts',
      'Drafts',
      drafts,
      drafts.length === 0 ? 'No drafts' : `${String(drafts.length)} never sent`,
      'neutral',
    ),
  ];
}
