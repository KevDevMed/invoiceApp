/**
 * Row selection and the bulk action bar it raises.
 *
 * Per the designer: *"Checkboxes now do work: selecting rows raises a bulk
 * bar."* So the bar has to say what is selected, what it is worth, and which of
 * its actions the selection actually permits — a bulk bar whose buttons are
 * always lit is the dead chrome 3a is replacing.
 *
 * Which actions exist at all is decided by the frozen IPC contract
 * (`src/shared/ipc-contract.ts`), not by the mock:
 *
 *   - **Mark paid** is `invoices:setStatus`, and it is legal only for invoices
 *     that were actually issued. Marking a draft paid would record money
 *     against a document nobody ever sent; a void invoice is not owed.
 *   - **Export** is `invoices:exportPdf`, which takes one id and — with no
 *     `targetPath` — puts a save dialog on screen. Ten selected rows would mean
 *     ten dialogs, so it is offered for a single selected row and withheld
 *     otherwise, rather than shipped as a button that misbehaves.
 *   - **Send reminder** has no channel anywhere in the contract. It is not
 *     built; see the report.
 *
 * Pure module — no React, no `window.api`.
 */

import type { Invoice } from '../../../shared/types';
import { summariseTotals, sumByCurrency } from './listGrouping';

/** A row as far as selection is concerned. */
export interface SelectableRow {
  readonly id: string;
  readonly invoice: Invoice;
}

export interface SelectionSummary {
  readonly count: number;
  /** `2 selected`. */
  readonly label: string;
  /** The lead per-currency total of the selection; empty when nothing is selected. */
  readonly amount: string;
  /** How many currencies `amount` stands in front of. */
  readonly extraCurrencies: number;
  /** Every currency joined — what a disclosure would show. */
  readonly full: string;
  /** Every selected invoice was issued and is still unsettled. */
  readonly canMarkPaid: boolean;
  /** Exactly one row is selected, so one save dialog is one action. */
  readonly canExport: boolean;
}

/** Add or remove one id, returning a new set — never mutating the old one. */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * The selection narrowed to rows that are still on screen.
 *
 * A search term, a segment or a status change moves rows out from under a
 * selection, and a bulk action against an invoice the reader can no longer see
 * is the worst kind of surprise. So the selection is *derived* on every render
 * rather than corrected after the fact.
 */
export function retainVisible(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): Set<string> {
  const visible = new Set(rows.map((row) => row.id));
  return new Set([...selected].filter((id) => visible.has(id)));
}

/**
 * The header checkbox: checked when all rows are in, indeterminate when some are.
 *
 * Counted by *membership of the rows it was given*, never by the size of the
 * selection. The header sits above one page while the selection spans every
 * page, so a size comparison reads a full page 1 as a full page 2 and renders
 * a checked box over rows that were never selected.
 */
export function selectAllValue(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): boolean | 'indeterminate' {
  if (rows.length === 0) return false;
  const chosen = rows.filter((row) => selected.has(row.id)).length;
  if (chosen === 0) return false;
  return chosen === rows.length ? true : 'indeterminate';
}

/**
 * The header checkbox's toggle: adds or removes exactly the rows it was given.
 *
 * The mirror of `selectAllValue` — ticking the box on page 2 must not discard
 * what page 1 had selected, and unticking it must not clear the other pages.
 */
export function setSelectedForRows(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const row of rows) {
    if (checked) next.add(row.id);
    else next.delete(row.id);
  }
  return next;
}

/** Everything the bulk bar prints and enables. */
export function summariseSelection(
  selected: ReadonlySet<string>,
  rows: readonly SelectableRow[],
): SelectionSummary {
  const chosen = rows.filter((row) => selected.has(row.id)).map((row) => row.invoice);
  const totals = summariseTotals(sumByCurrency(chosen));
  return {
    count: chosen.length,
    label: `${String(chosen.length)} selected`,
    amount: totals.lead,
    extraCurrencies: totals.extraCurrencies,
    full: totals.full,
    canMarkPaid:
      chosen.length > 0 &&
      chosen.every((invoice) => invoice.status === 'sent' || invoice.status === 'overdue'),
    canExport: chosen.length === 1,
  };
}
