/**
 * Every decision the read-only invoice detail page makes, as pure functions.
 *
 * `InvoiceDetail.tsx` is a thin renderer over these builders: the vitest
 * project is `environment: 'node'` and cannot mount React, so anything worth
 * asserting on has to live here to be testable at all.
 *
 * Dates are compared as calendar dates, never as `Date` objects built from a
 * bare ISO string — `new Date('2026-01-29')` is UTC midnight and prints as the
 * previous day in every negative-offset timezone, which would make a "days
 * overdue" number depend on the machine's clock. The whole-day arithmetic is
 * reused from `netTermDays` in ./document, which already splits on `-` and
 * round-trips through `Date.UTC`.
 */

import { formatMilli } from '../../../shared/money';
import type { Invoice, InvoiceItem } from '../../../shared/types';
import { formatDocumentDate, netTermDays } from './document';
import { money } from './format';

const EM_DASH = '—';

/** Badge palette shared with the list's `statusBadge`, so status reads the same on both screens. */
export type StatusVariant = 'neutral' | 'blue' | 'green' | 'red' | 'orange';

export interface StatusView {
  /** The status as displayed: a `sent` invoice past its due date reads as `overdue`. */
  readonly status: Invoice['status'];
  readonly label: string;
  readonly variant: StatusVariant;
  /** Whole days past the due date, 0 when not overdue. */
  readonly delayDays: number;
  /** `18 days delay`, or null when there is nothing to say. */
  readonly delayNote: string | null;
}

export interface StatTile {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** The one tile that carries the headline number. */
  readonly isEmphasised: boolean;
}

export interface HistoryEvent {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Full ISO timestamp, straight off the row. */
  readonly timestamp: string;
}

export interface NotesSection {
  readonly key: string;
  readonly heading: string;
  readonly body: string;
}

export interface LineSummaryRow {
  readonly key: string;
  readonly description: string;
  readonly quantity: string;
  readonly amount: string;
}

export interface LineSummary {
  readonly count: number;
  readonly rows: readonly LineSummaryRow[];
  readonly subtotal: string;
  readonly tax: string;
  readonly total: string;
}

/**
 * Whole days from `fromIso` to `toIso`, both `yyyy-mm-dd`. Positive when `toIso`
 * is later. Null when either side is not a real calendar date.
 */
export function daysBetween(fromIso: string, toIso: string): number | null {
  return netTermDays(fromIso, toIso);
}

/** The calendar date of an ISO timestamp: `2026-02-03T22:00:00.000Z` -> `2026-02-03`. */
export function calendarDateOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Whole days the invoice is past `dueDate` as of `today`. 0 when not yet due. */
export function daysPastDue(dueDate: string, today: string): number {
  const days = daysBetween(dueDate, today);
  if (days === null || days <= 0) return 0;
  return days;
}

/** What is still owed: nothing once paid, the full total otherwise. */
export function openAmountCents(invoice: Pick<Invoice, 'status' | 'totalCents'>): number {
  return invoice.status === 'paid' ? 0 : invoice.totalCents;
}

/**
 * Mean payment delay in whole days across a client's paid invoices — positive
 * is late, negative is early. Invoices without a `paidAt`, and dates that do
 * not parse, are skipped. Null when nothing is left to average.
 *
 * The mean is rounded with `Math.round`, which breaks ties toward positive
 * infinity (-2.5 rounds to -2).
 */
export function averagePaymentDelayDays(
  invoices: readonly Pick<Invoice, 'status' | 'dueDate' | 'paidAt'>[],
): number | null {
  let sum = 0;
  let count = 0;
  for (const invoice of invoices) {
    if (invoice.status !== 'paid' || invoice.paidAt === null) continue;
    const delay = daysBetween(invoice.dueDate, calendarDateOf(invoice.paidAt));
    if (delay === null) continue;
    sum += delay;
    count += 1;
  }
  if (count === 0) return null;
  const rounded = Math.round(sum / count);
  // Normalise -0, which would otherwise fail an Object.is comparison with 0.
  return rounded === 0 ? 0 : rounded;
}

/** `12 days late` / `3 days early` / `On time`. */
export function formatDelayDays(days: number | null): string {
  if (days === null) return EM_DASH;
  if (days === 0) return 'On time';
  const magnitude = Math.abs(days);
  const unit = magnitude === 1 ? 'day' : 'days';
  return days > 0 ? `${String(magnitude)} ${unit} late` : `${String(magnitude)} ${unit} early`;
}

/**
 * The pill, plus the danger-tone note beside it.
 *
 * `isOverdueNow` is the caller's reading of `isEffectivelyOverdue` from
 * ./format — that helper owns the rule (a `sent` invoice past its due date
 * reads as overdue) but calls `todayIso()` internally, so taking both the
 * verdict and `today` as arguments is what keeps this function deterministic
 * enough to test in a node-only vitest project.
 */
export function buildStatusView(
  invoice: Pick<Invoice, 'status' | 'dueDate'>,
  today: string,
  isOverdueNow: boolean,
): StatusView {
  const status = isOverdueNow ? 'overdue' : invoice.status;
  const delayDays = status === 'overdue' ? daysPastDue(invoice.dueDate, today) : 0;
  const unit = delayDays === 1 ? 'day' : 'days';
  return {
    status,
    label: status,
    variant: statusVariant(status),
    delayDays,
    delayNote: delayDays > 0 ? `${String(delayDays)} ${unit} delay` : null,
  };
}

function statusVariant(status: Invoice['status']): StatusVariant {
  switch (status) {
    case 'paid':
      return 'green';
    case 'sent':
      return 'blue';
    case 'overdue':
      return 'red';
    case 'void':
      return 'orange';
    default:
      return 'neutral';
  }
}

export interface StatTilesInput {
  readonly invoice: Pick<
    Invoice,
    'status' | 'currency' | 'totalCents' | 'taxCents' | 'dueDate' | 'paidAt'
  >;
  /** Mean delay across the client's other paid invoices, or null when there are none. */
  readonly averageDelayDays: number | null;
}

/** The six tiles above the fold. Every value comes off the row — nothing derived from thin air. */
export function buildStatTiles({ invoice, averageDelayDays }: StatTilesInput): StatTile[] {
  return [
    {
      key: 'total',
      label: 'Total Amount',
      value: money(invoice.totalCents, invoice.currency),
      isEmphasised: true,
    },
    {
      key: 'open',
      label: 'Open Amount',
      value: money(openAmountCents(invoice), invoice.currency),
      isEmphasised: false,
    },
    {
      key: 'vat',
      label: 'VAT Amount',
      value: money(invoice.taxCents, invoice.currency),
      isEmphasised: false,
    },
    {
      key: 'due',
      label: 'Due Date',
      value: formatDocumentDate(invoice.dueDate),
      isEmphasised: false,
    },
    {
      key: 'paid',
      label: 'Paid On',
      value: invoice.paidAt === null ? EM_DASH : formatDocumentDate(calendarDateOf(invoice.paidAt)),
      isEmphasised: false,
    },
    {
      key: 'delay',
      label: 'Customer av delay',
      value: formatDelayDays(averageDelayDays),
      isEmphasised: false,
    },
  ];
}

/**
 * The timeline, built only from timestamps the row actually carries: created,
 * last updated, and paid. `updatedAt` is dropped when it equals `createdAt` —
 * a never-touched invoice has one event, not two identical ones.
 */
export function buildHistoryEvents(
  invoice: Pick<Invoice, 'createdAt' | 'updatedAt' | 'paidAt'>,
): HistoryEvent[] {
  const events: HistoryEvent[] = [
    { key: 'created', label: 'Created', description: 'The invoice was drafted.', timestamp: invoice.createdAt },
  ];
  if (invoice.updatedAt !== invoice.createdAt) {
    events.push({
      key: 'updated',
      label: 'Last updated',
      description: 'Details or status were changed.',
      timestamp: invoice.updatedAt,
    });
  }
  if (invoice.paidAt !== null) {
    events.push({
      key: 'paid',
      label: 'Paid',
      description: 'Payment was recorded.',
      timestamp: invoice.paidAt,
    });
  }
  // ISO-8601 UTC timestamps sort correctly as plain strings.
  return events.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/** Invoice notes and the client's own notes, each dropped when blank. */
export function buildNotesSections(
  invoiceNotes: string | null,
  clientName: string | null,
  clientNotes: string | null,
): NotesSection[] {
  const sections: NotesSection[] = [];
  if (invoiceNotes !== null && invoiceNotes.trim() !== '') {
    sections.push({ key: 'invoice', heading: 'Invoice notes', body: invoiceNotes });
  }
  if (clientNotes !== null && clientNotes.trim() !== '') {
    sections.push({
      key: 'client',
      heading: clientName === null ? 'Client notes' : `Notes on ${clientName}`,
      body: clientNotes,
    });
  }
  return sections;
}

/** The left column's line-item recap; the full document on the right stays the authority. */
export function buildLineSummary(
  invoice: Pick<Invoice, 'currency' | 'subtotalCents' | 'taxCents' | 'totalCents'> & {
    readonly items: readonly Pick<InvoiceItem, 'id' | 'description' | 'quantityMilli' | 'amountCents'>[];
  },
): LineSummary {
  return {
    count: invoice.items.length,
    rows: invoice.items.map((item) => ({
      key: item.id,
      description: item.description,
      quantity: formatMilli(item.quantityMilli),
      amount: money(item.amountCents, invoice.currency),
    })),
    subtotal: money(invoice.subtotalCents, invoice.currency),
    tax: money(invoice.taxCents, invoice.currency),
    total: money(invoice.totalCents, invoice.currency),
  };
}
