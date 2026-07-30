/**
 * The rendered invoice "paper" document, as pure data.
 *
 * Both the saved-invoice view and the live editing draft build one of these and
 * hand it to `InvoiceDocument`, so the two screens can never drift apart. All
 * of the logic lives here — the component is presentation only — because the
 * vitest project is `environment: 'node'` and cannot mount React.
 *
 * Money and quantities go through the shared integer helpers in
 * src/shared/money.ts: the same arithmetic the backend persists and the PDF
 * exporter prints, so screen, database, and paper always agree.
 */

import {
  formatBpsAsPercent,
  formatMilli,
  lineAmountCents,
} from '../../../shared/money';
import type { Client, InvoiceStatus } from '../../../shared/types';
import { money } from './format';

export interface DocumentLineInput {
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

export interface DocumentModelInput {
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly taxRateBps: number;
  readonly notes: string | null;
  readonly items: readonly DocumentLineInput[];
  readonly totals: {
    readonly subtotalCents: number;
    readonly taxCents: number;
    readonly totalCents: number;
  };
  readonly client: Client | null;
  readonly business: { readonly name: string | null; readonly address: string | null };
}

export interface DocumentLine {
  readonly key: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly amount: string;
}

export interface DocumentParty {
  readonly name: string;
  readonly address: string | null;
  readonly taxId: string | null;
}

export interface InvoiceDocumentModel {
  readonly number: string;
  readonly status: InvoiceStatus;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly paymentTerms: string;
  readonly billedBy: DocumentParty;
  readonly billedTo: DocumentParty | null;
  readonly lines: readonly DocumentLine[];
  readonly subtotal: string;
  readonly taxLabel: string;
  readonly tax: string;
  readonly total: string;
  readonly notes: string | null;
  readonly currency: string;
}

const EM_DASH = '—';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

/**
 * Parse `yyyy-mm-dd` by splitting on `-`, never via `new Date(iso)`: that
 * constructor reads a bare ISO date as UTC midnight, which prints as the
 * previous day in every negative-offset timezone. Returns null for anything
 * that is not a real calendar date (`2026-02-31` included).
 */
function parseIsoDate(iso: string): CalendarDate | null {
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const [yearText, monthText, dayText] = parts;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    !/^\d{4}$/.test(yearText) ||
    !/^\d{2}$/.test(monthText) ||
    !/^\d{2}$/.test(dayText)
  ) {
    return null;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through UTC to reject overflow days like 31 February.
  const stamp = Date.UTC(year, month - 1, day);
  const probe = new Date(stamp);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** ISO yyyy-mm-dd -> '29 January 2026'. Returns the input unchanged if unparseable. */
export function formatDocumentDate(iso: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) return iso;
  return `${String(parsed.day)} ${MONTHS[parsed.month - 1] ?? ''} ${String(parsed.year)}`;
}

/**
 * `yyyy-mm-dd` plus a whole number of days, as another `yyyy-mm-dd`.
 *
 * The inverse of `netTermDays`, and the reason the editor can derive a due date
 * from a payment term. Arithmetic in UTC for the same reason `parseIsoDate`
 * refuses `new Date(iso)`: a calendar date has no zone, and doing the addition
 * in local time would shift the answer by a day across a DST boundary. An
 * unparseable input comes back unchanged — the caller is mid-edit, not broken.
 */
export function addCalendarDays(iso: string, days: number): string {
  const parsed = parseIsoDate(iso);
  if (!parsed || !Number.isFinite(days)) return iso;
  const stamp = Date.UTC(parsed.year, parsed.month - 1, parsed.day + Math.trunc(days));
  const shifted = new Date(stamp);
  const year = String(shifted.getUTCFullYear()).padStart(4, '0');
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole days from issueDate to dueDate, or null if either date is unparseable. */
export function netTermDays(issueDate: string, dueDate: string): number | null {
  const from = parseIsoDate(issueDate);
  const to = parseIsoDate(dueDate);
  if (!from || !to) return null;
  const MS_PER_DAY = 86_400_000;
  const fromStamp = Date.UTC(from.year, from.month - 1, from.day);
  const toStamp = Date.UTC(to.year, to.month - 1, to.day);
  // Both stamps are UTC midnight, so the difference is always whole days.
  return (toStamp - fromStamp) / MS_PER_DAY;
}

function paymentTermsFor(issueDate: string, dueDate: string): string {
  const days = netTermDays(issueDate, dueDate);
  if (days === null || days < 0) return EM_DASH;
  if (days === 0) return 'Due on receipt';
  return `Net ${String(days)}`;
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function clientAddress(client: Client): string | null {
  const parts = [
    client.addressLine1,
    client.addressLine2,
    client.city,
    client.region,
    client.postalCode,
    client.country,
  ].filter(present);
  return parts.length > 0 ? parts.join(', ') : null;
}

export function buildDocumentModel(input: DocumentModelInput): InvoiceDocumentModel {
  const lines: DocumentLine[] = input.items.map((item, index) => ({
    // Index-based so the key survives a keystroke-by-keystroke rebuild.
    key: `line-${String(index)}`,
    description: item.description,
    quantity: formatMilli(item.quantityMilli),
    unitPrice: money(item.unitPriceCents, input.currency),
    amount: money(lineAmountCents(item.quantityMilli, item.unitPriceCents), input.currency),
  }));

  return {
    number: input.number ?? EM_DASH,
    status: input.status,
    issueDate: formatDocumentDate(input.issueDate),
    dueDate: formatDocumentDate(input.dueDate),
    paymentTerms: paymentTermsFor(input.issueDate, input.dueDate),
    billedBy: {
      name: present(input.business.name) ? input.business.name : 'Your business',
      address: input.business.address,
      taxId: null,
    },
    billedTo: input.client
      ? {
          name: input.client.name,
          address: clientAddress(input.client),
          taxId: input.client.taxId,
        }
      : null,
    lines,
    subtotal: money(input.totals.subtotalCents, input.currency),
    taxLabel: `Tax (${formatBpsAsPercent(input.taxRateBps)}%)`,
    tax: money(input.totals.taxCents, input.currency),
    total: money(input.totals.totalCents, input.currency),
    notes: input.notes,
    currency: input.currency,
  };
}
