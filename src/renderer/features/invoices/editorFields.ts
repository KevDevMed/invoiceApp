/**
 * The editor's derived field values: payment terms, the due date they imply,
 * sales tax as a percentage, the notes counter, and the saved-state caption in
 * the form's header line.
 *
 * The 2a form flips the old relationship between terms and dates. The user picks
 * a payment term and the due date is *computed* from it (and rendered as a
 * derived value, not an input); before, the user picked two dates and the term
 * was the read-only readout. Everything that flip needs is arithmetic, so it
 * lives here where the node-only vitest project can cover it.
 */

import { formatBpsAsPercent } from '../../../shared/money';
import type { InvoiceStatus } from '../../../shared/types';
import { addCalendarDays, netTermDays } from './document';

/** Terms offered in the selector, in days from the issue date. */
export const PAYMENT_TERM_PRESETS = [0, 7, 14, 30, 45, 60] as const;

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export function paymentTermLabel(days: number): string {
  if (days === 0) return 'Due on receipt';
  return `Net ${String(days)}`;
}

/**
 * The term options, always including the invoice's own term.
 *
 * A saved invoice can hold any interval — Net 21, Net 3 — and a selector that
 * silently could not show it would be a control that lies about the document it
 * is editing. An off-preset term is inserted in its numeric place instead.
 * A negative or unparseable interval gets no option: there is nothing sensible
 * to name it, and picking any real term repairs the invoice.
 */
export function paymentTermOptions(currentDays: number | null): SelectOption[] {
  const days: number[] = [...PAYMENT_TERM_PRESETS];
  if (currentDays !== null && currentDays >= 0 && !days.includes(currentDays)) {
    days.push(currentDays);
    days.sort((left, right) => left - right);
  }
  return days.map((value) => ({ value: String(value), label: paymentTermLabel(value) }));
}

/** The term a saved invoice is already on, or null when its dates make no sense. */
export function paymentTermOf(issueDate: string, dueDate: string): number | null {
  const days = netTermDays(issueDate, dueDate);
  if (days === null || days < 0) return null;
  return days;
}

/** The due date a term implies. Unparseable issue dates come back unchanged. */
export function dueDateFor(issueDate: string, termDays: number): string {
  return addCalendarDays(issueDate, termDays);
}

/**
 * Sales tax, as the percentage the user types rather than the basis points the
 * invoice stores. 825 bps is 8.25% — two decimal places exactly, which is why
 * the round-trip is integer division and `Math.round`, never a float compare.
 */
export function bpsToPercent(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.max(0, Math.trunc(bps)) / 100;
}

export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.round(percent * 100));
}

/** The tax rate as it is printed on the document, e.g. `8.25`. */
export function taxPercentText(bps: number): string {
  return formatBpsAsPercent(Math.max(0, Math.trunc(bps)));
}

/**
 * How long a note can be before it stops fitting the notes block on the printed
 * page. The database allows 10,000 characters, so this is a budget and not a
 * limit: the counter warns, nothing is truncated, and a longer note still saves.
 */
export const NOTES_PRINT_BUDGET = 300;

export function notesCounter(notes: string): string {
  return `${String([...notes].length)} / ${String(NOTES_PRINT_BUDGET)}`;
}

export function isNotesOverBudget(notes: string): boolean {
  return [...notes].length > NOTES_PRINT_BUDGET;
}

export interface DraftCaptionInput {
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly isNew: boolean;
  readonly isSaving: boolean;
  readonly hasUnsavedChanges: boolean;
}

/**
 * The right-hand caption on the form's header line: `INV-0042 · draft saved`.
 *
 * It names the invoice and then its saved state, in that order, because the
 * number is the stable half — it is what the user is looking for when they
 * glance up — and the state is the half that changes as they type.
 */
export function draftCaption(input: DraftCaptionInput): string {
  const name = input.number ?? 'New invoice';
  if (input.isSaving) return `${name} · saving…`;
  if (input.isNew) return `${name} · not saved yet`;
  if (input.hasUnsavedChanges) return `${name} · unsaved changes`;
  return `${name} · ${input.status} saved`;
}
