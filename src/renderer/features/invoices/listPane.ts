/**
 * Everything the triage pane says about one invoice, as pure data.
 *
 * The pane on the right of the cockpit — and the same component behind
 * `/invoices/:id` — is presentation only; the vitest project is
 * `environment: 'node'` and cannot mount React, so the timeline, the three
 * facts and the activity gutter are built here.
 *
 * **What is deliberately absent.** The mockup this implements shows reminders
 * sent, a reminder cadence, the date of the next automatic reminder, and
 * "viewed on" events. None of those exist: `src/shared/types.ts` stores
 * `createdAt`, `updatedAt` and `paidAt` on an invoice and nothing else that is
 * time-shaped, `src/shared/ipc-contract.ts` declares no channel that sends
 * anything, and there is no mail transport in the app at all. Rather than
 * render a plausible number nobody can act on, those elements are not built —
 * the timeline says only what the row can prove.
 */

import type { Invoice, InvoiceItem, InvoiceWithItems } from '../../../shared/types';
import {
  averagePaymentDelayDays,
  buildHistoryEvents,
  buildLineSummary,
  buildStatusView,
  calendarDateOf,
  daysBetween,
  daysPastDue,
  formatDelayDays,
  openAmountCents,
} from './detail';
import type { LineSummary } from './detail';
import { formatDocumentDate, netTermDays } from './document';
import { money } from './format';
import {
  formatCurrencyTotals,
  isOpenState,
  rowStateOf,
  shortDate,
  sumByCurrency,
} from './listGrouping';
import type { RowState } from './listGrouping';

/** Tone the pane paints a state in. Maps onto the theme's semantic colours. */
export type PaneTone = 'error' | 'warning' | 'neutral' | 'success';

export interface PaneTimeline {
  readonly tone: PaneTone;
  /** `34 days overdue`, `Due in 12 days`, `Paid 24 Jul`. */
  readonly headline: string;
  /** The clause after the headline, when there is a real one. */
  readonly detail: string | null;
  /** Share of the bar between issue and due date, 0-100. */
  readonly elapsedPercent: number;
  /** Share of the bar past the due date, 0-100. Zero unless overdue. */
  readonly overduePercent: number;
  /** `issued 26 May` · `due 25 Jun · Net 30` · `today 29 Jul`. */
  readonly axis: readonly string[];
}

export interface PaneFact {
  readonly key: string;
  readonly caption: string;
  readonly value: string;
  /** Second line under the value, or null when there is nothing true to say. */
  readonly sub: string | null;
  /** A further muted clause after `sub`. */
  readonly note: string | null;
  readonly isEmphasised: boolean;
}

export interface PaneActivityEntry {
  readonly key: string;
  /** Fixed-width gutter: `26 May`. */
  readonly date: string;
  readonly text: string;
}

export interface PaneIdentity {
  readonly clientName: string;
  /** `INV-0051 · accounts@example.com`, or just the number when there is no email. */
  readonly reference: string;
  /** Up to two letters off the client name. */
  readonly monogram: string;
  readonly tone: PaneTone;
}

/** `Net 30`, `Due on receipt`, or null when the dates do not make a term. */
export function paymentTermLabel(issueDate: string, dueDate: string): string | null {
  const days = netTermDays(issueDate, dueDate);
  if (days === null || days < 0) return null;
  return days === 0 ? 'Due on receipt' : `Net ${String(days)}`;
}

/** The tone a state is painted in, shared by the monogram, the dot and the banner. */
export function toneForState(state: RowState): PaneTone {
  switch (state) {
    case 'overdue':
      return 'error';
    case 'due-soon':
      return 'warning';
    case 'paid':
      return 'success';
    case 'later':
    case 'draft':
    case 'void':
      return 'neutral';
  }
}

/** Up to two initials: `Halloway & Finch LLP` -> `HF`. */
export function monogramOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((word) => word !== '');
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? '');
  return `${first}${second}`.toUpperCase();
}

export function buildPaneIdentity(
  invoice: Pick<InvoiceWithItems, 'number' | 'client' | 'clientId' | 'status' | 'dueDate'>,
  today: string,
): PaneIdentity {
  const clientName = invoice.client?.name ?? invoice.clientId;
  const email = invoice.client?.email ?? null;
  return {
    clientName,
    reference: email === null ? invoice.number : `${invoice.number} · ${email}`,
    monogram: monogramOf(clientName),
    tone: toneForState(rowStateOf(invoice, today)),
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

/**
 * The status banner as a timeline.
 *
 * The bar is two segments over one span: issue date to due date, then due date
 * to today when the invoice is late. Their widths are shares of that whole
 * span, so a fortnight overdue on Net 30 fills a third of the bar and a
 * fortnight overdue on Net 7 fills two thirds — the picture is the ratio of
 * "time you gave them" to "time they have taken", which is the judgement the
 * reader is actually making.
 *
 * A settled or unissued invoice has no race left to run: paid fills the bar,
 * void and draft leave it at the elapsed share of the term.
 */
export function buildPaneTimeline(
  invoice: Pick<Invoice, 'status' | 'issueDate' | 'dueDate' | 'paidAt'>,
  today: string,
): PaneTimeline {
  const state = rowStateOf(invoice, today);
  const terms = paymentTermLabel(invoice.issueDate, invoice.dueDate);
  const span = netTermDays(invoice.issueDate, invoice.dueDate) ?? 0;
  const late = daysPastDue(invoice.dueDate, today);

  let elapsedPercent = 0;
  let overduePercent = 0;
  if (state === 'paid') {
    elapsedPercent = 100;
  } else if (state === 'overdue' && late > 0) {
    // Only an invoice that is actually late gets the second segment. A draft or
    // a void invoice can sit past the date it *would* have been due on, and
    // painting that in the error tone would accuse nobody of anything.
    const whole = Math.max(span, 0) + late;
    elapsedPercent = whole === 0 ? 0 : clampPercent((Math.max(span, 0) / whole) * 100);
    overduePercent = 100 - elapsedPercent;
  } else {
    const gone = daysBetween(invoice.issueDate, today) ?? 0;
    elapsedPercent = span <= 0 ? 100 : clampPercent((gone / span) * 100);
  }

  const status = buildStatusView(invoice, today, state === 'overdue');
  let headline: string;
  let detail: string | null = null;
  switch (state) {
    case 'overdue':
      headline = status.delayDays > 0
        ? `${String(status.delayDays)} day${status.delayDays === 1 ? '' : 's'} overdue`
        : 'Marked overdue';
      detail = terms;
      break;
    case 'due-soon':
    case 'later': {
      const days = daysBetween(today, invoice.dueDate) ?? 0;
      headline = days <= 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${String(days)} days`;
      detail = terms;
      break;
    }
    case 'draft':
      headline = 'Draft — not issued yet';
      detail = terms;
      break;
    case 'paid': {
      headline =
        invoice.paidAt === null
          ? 'Paid'
          : `Paid ${shortDate(calendarDateOf(invoice.paidAt), today)}`;
      // `formatDelayDays` reads positive as late; an em dash means the payment
      // date is missing, and there is then nothing to say about promptness.
      const delay =
        invoice.paidAt === null
          ? null
          : daysBetween(invoice.dueDate, calendarDateOf(invoice.paidAt));
      detail = delay === null ? null : formatDelayDays(delay);
      break;
    }
    case 'void':
      headline = 'Void — cancelled';
      detail = null;
      break;
  }

  const dueEntry = terms === null ? `due ${shortDate(invoice.dueDate, today)}` : `due ${shortDate(invoice.dueDate, today)} · ${terms}`;
  const lastEntry =
    state === 'paid' && invoice.paidAt !== null
      ? `paid ${shortDate(calendarDateOf(invoice.paidAt), today)}`
      : `today ${shortDate(today, today)}`;

  return {
    tone: toneForState(state),
    headline,
    detail,
    elapsedPercent,
    overduePercent,
    axis: [`issued ${shortDate(invoice.issueDate, today)}`, dueEntry, lastEntry],
  };
}

export interface PaneFactsInput {
  readonly invoice: Pick<
    Invoice,
    'id' | 'status' | 'currency' | 'totalCents' | 'issueDate' | 'dueDate'
  >;
  /**
   * Every invoice belonging to this client, this one included. Null when the
   * caller has not fetched them — the balance fact is then not built at all
   * rather than shown as zero.
   */
  readonly clientInvoices: readonly Invoice[] | null;
  readonly today: string;
}

/**
 * The three facts a chase decision needs: what is owed, when the clock started,
 * and what the client owes in total.
 *
 * The mockup's "£16,442.10 invoiced" subline converts the amount into a second
 * currency. This app has no exchange rate and never had one, so the subline
 * says the only other true figure about the same money: the face value of the
 * document, shown when it differs from what is still open.
 */
export function buildPaneFacts({ invoice, clientInvoices, today }: PaneFactsInput): PaneFact[] {
  const open = openAmountCents(invoice);
  const facts: PaneFact[] = [
    {
      key: 'amount',
      caption: 'Amount due',
      value: money(open, invoice.currency),
      sub: open === invoice.totalCents ? null : `${money(invoice.totalCents, invoice.currency)} invoiced`,
      note: null,
      isEmphasised: true,
    },
    {
      key: 'issued',
      caption: 'Issued',
      value: formatDocumentDate(invoice.issueDate),
      sub: paymentTermLabel(invoice.issueDate, invoice.dueDate),
      note: null,
      isEmphasised: false,
    },
  ];

  if (clientInvoices !== null) {
    const openOnes = clientInvoices.filter((row) => isOpenState(rowStateOf(row, today)));
    const delay = averagePaymentDelayDays(clientInvoices, invoice.id);
    const totals = sumByCurrency(openOnes);
    facts.push({
      key: 'client',
      caption: 'Client balance',
      value: totals.length === 0 ? money(0, invoice.currency) : formatCurrencyTotals(totals, 2),
      sub:
        openOnes.length === 0
          ? 'No open invoices'
          : `${String(openOnes.length)} open invoice${openOnes.length === 1 ? '' : 's'}`,
      note: delay === null ? null : `pays ${formatDelayDays(delay).toLowerCase()}`,
      isEmphasised: false,
    });
  }

  return facts;
}

/**
 * The activity gutter, built from the three timestamps an invoice row actually
 * carries. No "viewed", no "reminder sent" — nothing records those.
 */
export function buildPaneActivity(
  invoice: Pick<Invoice, 'createdAt' | 'updatedAt' | 'paidAt'>,
  today: string,
): PaneActivityEntry[] {
  return buildHistoryEvents(invoice)
    .map((event) => ({
      key: event.key,
      date: shortDate(calendarDateOf(event.timestamp), today),
      text: event.description,
    }))
    .reverse();
}

/** The bordered line-item table plus its Total strip. */
export function buildPaneLines(
  invoice: Pick<Invoice, 'currency' | 'subtotalCents' | 'taxCents' | 'totalCents'> & {
    readonly items: readonly Pick<
      InvoiceItem,
      'id' | 'description' | 'quantityMilli' | 'unitPriceCents' | 'amountCents'
    >[];
  },
): LineSummary & { readonly rates: ReadonlyMap<string, string> } {
  const summary = buildLineSummary(invoice);
  return {
    ...summary,
    rates: new Map(
      invoice.items.map((item) => [item.id, money(item.unitPriceCents, invoice.currency)]),
    ),
  };
}
