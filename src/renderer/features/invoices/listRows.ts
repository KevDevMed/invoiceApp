/**
 * A row of design 3a's invoice table, as data.
 *
 * 3a merges the status pill into the due date — *"A dot plus 'Overdue 18 days'
 * / 'Due in 4 days' replaces a pill that only said sent"* — so the phrase, the
 * tone it is painted in, whether the dot is filled or hollow, and the client
 * monogram are all decisions, not markup. They live here because the vitest
 * project is `environment: 'node'` and never mounts a component.
 *
 * The list is flat: 3a has no group headers, the row is the link, and the
 * ordering the reader chose in the sort control is the only ordering.
 */

import type { Invoice } from '../../../shared/types';
import { calendarDateOf } from './detail';
import { money } from './format';
import { daysUntilDue, rowStateOf, shortDate, type RowState } from './listGrouping';
import { rangeLabel } from '../../ui/pagination';

/**
 * How a row is coloured. The monogram square, the dot and the overdue row tint
 * all read from this one value, so they cannot disagree.
 */
export type RowTone = 'error' | 'accent' | 'success' | 'neutral';

export interface ListRow {
  readonly id: string;
  readonly invoice: Invoice;
  readonly clientName: string;
  /** Initials for the 26px monogram square. */
  readonly monogram: string;
  readonly state: RowState;
  readonly tone: RowTone;
  /** `Overdue 18 days`, `Due in 4 days`, `Draft · not sent`, `Paid 24 Jul`. */
  readonly statusLabel: string;
  /** The muted `· 11 Jul` after the phrase, or null when it would repeat it. */
  readonly statusDate: string | null;
  /**
   * A draft is the *absence* of a state, which the five semantic dot variants
   * cannot express — 3a draws it as a 1px ring with no fill.
   */
  readonly isDotHollow: boolean;
  /** `11 Jun 2026` for the ISSUED column. */
  readonly issued: string;
  /** The invoice's own money in its own currency. There is no exchange rate. */
  readonly amount: string;
  /** Settled and unissued rows recede: 3a dims money that is not in play. */
  readonly isMuted: boolean;
}

/**
 * Initials for the monogram square.
 *
 * Two words give one letter each; a single word gives its first two characters,
 * because `AC` reads as Acme where a lone `A` reads as nothing. Split on code
 * points rather than UTF-16 units so an emoji or an astral-plane character is
 * one initial and not half of a surrogate pair, and use `toLocaleUpperCase` so
 * scripts with no case (CJK, Arabic) pass through untouched instead of being
 * mangled. An empty or whitespace-only name gives `?` rather than an empty box.
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return '?';
  const second = words[1];
  const initials =
    second === undefined
      ? Array.from(first).slice(0, 2).join('')
      : `${Array.from(first)[0] ?? ''}${Array.from(second)[0] ?? ''}`;
  return initials.toLocaleUpperCase();
}

/**
 * Whether the money is out of play.
 *
 * A paid or void invoice is settled: nothing is owed and nothing is chased.
 * Everything else — overdue, due soon, due later, and drafts — is still
 * actionable, which is what the default order puts first. A draft is *not*
 * settled: it is unsent work, the earliest thing in the pipeline rather than
 * the last. Note this is deliberately narrower than `isMuted`, which also dims
 * drafts: dimming says "not yet money", sinking would say "no longer money".
 */
export function isSettled(state: RowState): boolean {
  return state === 'paid' || state === 'void';
}

/** The tone a state is painted in. Only four, because 3a only draws four. */
export function toneOf(state: RowState): RowTone {
  switch (state) {
    case 'overdue':
      return 'error';
    case 'due-soon':
      return 'accent';
    case 'paid':
      return 'success';
    case 'later':
    case 'draft':
    case 'void':
      return 'neutral';
  }
}

export interface StatusPhrase {
  readonly label: string;
  readonly date: string | null;
}

/**
 * The merged status-and-due phrase.
 *
 * Every branch answers *when*, which is the whole complaint the design makes
 * about the pill it replaces. The trailing date is the due date for anything
 * still owed — the phrase says how long, the date says which day — and is
 * dropped where the phrase already carries a date (`Paid 24 Jul`) or where
 * there is no date to give (a draft was never sent).
 */
export function statusPhrase(
  invoice: Pick<Invoice, 'dueDate' | 'updatedAt' | 'paidAt'>,
  state: RowState,
  today: string,
): StatusPhrase {
  const due = shortDate(invoice.dueDate, today);
  switch (state) {
    case 'overdue': {
      const days = daysUntilDue(invoice.dueDate, today);
      // An invoice *stored* as overdue whose due date has not arrived: say so
      // rather than print a negative day count.
      if (days === null || days >= 0) return { label: 'Marked overdue', date: due };
      const late = -days;
      return { label: `Overdue ${String(late)} day${late === 1 ? '' : 's'}`, date: due };
    }
    case 'due-soon': {
      const days = daysUntilDue(invoice.dueDate, today) ?? 0;
      if (days <= 0) return { label: 'Due today', date: due };
      if (days === 1) return { label: 'Due tomorrow', date: due };
      return { label: `Due in ${String(days)} days`, date: due };
    }
    case 'later':
      return { label: `Due ${due}`, date: null };
    case 'draft':
      return { label: 'Draft · not sent', date: null };
    case 'paid':
      return {
        label:
          invoice.paidAt === null
            ? 'Paid'
            : `Paid ${shortDate(calendarDateOf(invoice.paidAt), today)}`,
        date: null,
      };
    case 'void':
      return { label: `Void ${shortDate(calendarDateOf(invoice.updatedAt), today)}`, date: null };
  }
}

/** `11 Jun 2026` — the ISSUED column always carries its year; it is a fact, not a countdown. */
export function issuedLabel(iso: string): string {
  // `shortDate` drops the year within the current year, which is right for a
  // due date being counted down to and wrong for an archival issue date.
  return shortDate(iso, '0000-00-00');
}

export interface BuildRowsInput {
  readonly invoices: readonly Invoice[];
  /** clientId -> display name, joined in the view from `clients:list`. */
  readonly clientNames: ReadonlyMap<string, string>;
  readonly today: string;
}

/** Every matching invoice as a row, in input order. Sorting is a separate step. */
export function buildListRows({ invoices, clientNames, today }: BuildRowsInput): ListRow[] {
  return invoices.map((invoice) => {
    const state = rowStateOf(invoice, today);
    const phrase = statusPhrase(invoice, state, today);
    const clientName = clientNames.get(invoice.clientId) ?? invoice.clientId;
    return {
      id: invoice.id,
      invoice,
      clientName,
      monogram: monogram(clientName),
      state,
      tone: toneOf(state),
      statusLabel: phrase.label,
      statusDate: phrase.date,
      isDotHollow: state === 'draft',
      issued: issuedLabel(invoice.issueDate),
      amount: money(invoice.totalCents, invoice.currency),
      isMuted: state === 'paid' || state === 'void' || state === 'draft',
    };
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey = 'due-asc' | 'due-desc' | 'total-desc' | 'client-asc' | 'issued-desc';

/**
 * The sort control's options. Due date ascending leads and is the default,
 * because per the designer that "is the order the work actually happens in".
 */
export const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'due-asc', label: 'Due date ↑' },
  { key: 'due-desc', label: 'Due date ↓' },
  { key: 'total-desc', label: 'Largest first' },
  { key: 'client-asc', label: 'Client A–Z' },
  { key: 'issued-desc', label: 'Newest issued' },
];

export const DEFAULT_SORT: SortKey = 'due-asc';

/**
 * What the footer calls the current order: `sorted by due date · open first`.
 *
 * The default's sentence carries the settled-last clause because the caption is
 * the only thing that explains why a 2024 paid invoice sits below a 2026 one.
 * A caption that says only "due date" while the order is not purely due date
 * is worse than no caption.
 */
const SORT_SENTENCE: Record<SortKey, string> = {
  'due-asc': 'due date · open first',
  'due-desc': 'due date, latest first',
  'total-desc': 'total, largest first',
  'client-asc': 'client',
  'issued-desc': 'issue date, newest first',
};

/**
 * A stable sort. Ties fall back to the invoice number so two invoices due the
 * same day do not swap places between renders — a list that reorders under the
 * cursor loses the reader's place as surely as a wrong sort does.
 *
 * The default order sinks settled rows below unsettled ones before comparing
 * due dates at all. Due date ascending alone floats the *oldest* invoices to
 * the top, and the oldest invoices are the ones paid off long ago — the screen
 * that is supposed to answer "what do I owe attention to" would open on money
 * already collected. Within each of the two blocks the due-date ordering is
 * untouched, and the list stays flat: this is one comparator, not a grouping.
 *
 * It applies to the default only. An order the reader picked out of the sort
 * control is literal — sinking settled rows behind their back when they asked
 * for "Largest first" would hide the very row they were hunting for.
 */
export function sortRows(rows: readonly ListRow[], key: SortKey): ListRow[] {
  const compare = (a: ListRow, b: ListRow): number => {
    const left = a.invoice;
    const right = b.invoice;
    switch (key) {
      case 'due-asc':
        return (
          Number(isSettled(a.state)) - Number(isSettled(b.state)) ||
          left.dueDate.localeCompare(right.dueDate)
        );
      case 'due-desc':
        return right.dueDate.localeCompare(left.dueDate);
      case 'total-desc':
        // Integer cents, compared as integers. Different currencies are not
        // convertible, so this orders by magnitude within a currency and by
        // raw cents across them — the honest best a rate-less app can do.
        return right.totalCents - left.totalCents;
      case 'client-asc':
        return a.clientName.localeCompare(b.clientName);
      case 'issued-desc':
        return right.issueDate.localeCompare(left.issueDate);
    }
  };
  return [...rows].sort(
    (a, b) => compare(a, b) || a.invoice.number.localeCompare(b.invoice.number),
  );
}

/** `Showing 1-10 of 66 · sorted by due date`. `0 of 0` when nothing matches. */
export function footerSummary(
  total: number,
  page: number,
  pageSize: number,
  key: SortKey,
): string {
  return `Showing ${rangeLabel(total, page, pageSize)} · sorted by ${SORT_SENTENCE[key]}`;
}
