/**
 * The editor's line-item rows, as pure data.
 *
 * The 2a form has no "Add item" button: one blank ghost row always waits at the
 * bottom, Enter commits a row and creates the next, and Backspace on an already
 * empty row deletes it. All three of those are list transformations, so they
 * live here where the node-only vitest project can cover them rather than inside
 * the component where they would only ever be exercised by hand.
 *
 * The other job of this module is the rule the preview used to get wrong: a row
 * the user has not finished typing must never reach the document or the totals.
 * `completeLines` is the single gate for both — the money math itself is
 * untouched (`src/shared/money.ts` is shared with the backend), only what feeds
 * it is filtered.
 */

import { parseAmountToCents, parseQuantityToMilli } from '../../../shared/money';
import type { InvoiceItemInput } from '../../../shared/types';

/** One editable row. Numbers stay as typed text until they parse cleanly. */
export interface LineDraft {
  key: number;
  description: string;
  quantity: string; // decimal text, parsed to milli
  unitPrice: string; // decimal text, parsed to cents
}

export interface ParsedLine {
  readonly description: string;
  readonly quantityMilli: number | null;
  readonly unitPriceCents: number | null;
}

/** A row that has everything an invoice line needs, carrying its draft key. */
export interface CompleteLine {
  readonly key: number;
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

/**
 * What a blank row holds. The ghost row is a real row with these values, not a
 * placeholder: the moment it is typed into it is already the invoice's next
 * line, and `isBlankLine` is what keeps it out of the document until then.
 */
export const DEFAULT_QUANTITY = '1';
export const DEFAULT_UNIT_PRICE = '0.00';

/** One unit, in the milli units `parseQuantityToMilli` returns. */
const ONE_UNIT_MILLI = 1000;

let nextKey = 1;

/** A fresh key for a row built elsewhere (the load effect maps a saved invoice). */
export function nextLineKey(): number {
  return nextKey++;
}

export function emptyLine(): LineDraft {
  return {
    key: nextLineKey(),
    description: '',
    quantity: DEFAULT_QUANTITY,
    unitPrice: DEFAULT_UNIT_PRICE,
  };
}

function safeMilli(text: string): number | null {
  try {
    return parseQuantityToMilli(text);
  } catch {
    return null;
  }
}

function safeCents(text: string): number | null {
  try {
    return parseAmountToCents(text);
  } catch {
    return null;
  }
}

export function parseLine(line: LineDraft): ParsedLine {
  return {
    description: line.description,
    quantityMilli: safeMilli(line.quantity),
    unitPriceCents: safeCents(line.unitPrice),
  };
}

/**
 * A row nobody has touched: no description, the default quantity (or none), and
 * no money on it. Blank rows are dropped silently — they are never an error and
 * never reach the invoice.
 *
 * Deliberately not "the description is empty": a row with a price typed into it
 * and no description yet is unfinished, not blank, and silently dropping it
 * would lose money the user can see on screen. That row reports a problem
 * instead (`lineProblem`).
 */
export function isBlankLine(line: LineDraft): boolean {
  if (line.description.trim() !== '') return false;
  const quantity = line.quantity.trim();
  const quantityMilli = safeMilli(quantity);
  const isDefaultQuantity = quantity === '' || quantityMilli === ONE_UNIT_MILLI;
  if (!isDefaultQuantity) return false;
  const unitPrice = line.unitPrice.trim();
  return unitPrice === '' || safeCents(unitPrice) === 0;
}

/** A row with a description, a positive quantity and a price that parses. */
export function isCompleteLine(line: LineDraft): boolean {
  const parsed = parseLine(line);
  return (
    parsed.description.trim() !== '' &&
    parsed.quantityMilli !== null &&
    parsed.quantityMilli > 0 &&
    parsed.unitPriceCents !== null
  );
}

/**
 * The rows that are allowed to reach the document and the totals — the fix for
 * "empty rows are mirrored into the preview as $0.00 lines".
 */
export function completeLines(lines: readonly LineDraft[]): CompleteLine[] {
  const complete: CompleteLine[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (
      parsed.description.trim() === '' ||
      parsed.quantityMilli === null ||
      parsed.quantityMilli <= 0 ||
      parsed.unitPriceCents === null
    ) {
      continue;
    }
    complete.push({
      key: line.key,
      description: parsed.description.trim(),
      quantityMilli: parsed.quantityMilli,
      unitPriceCents: parsed.unitPriceCents,
    });
  }
  return complete;
}

/**
 * What is wrong with a row that is neither blank nor complete, or null when
 * there is nothing to say about it. `position` is the row's 1-based place in the
 * list as the user sees it.
 */
export function lineProblem(line: LineDraft, position: number): string | null {
  if (isBlankLine(line) || isCompleteLine(line)) return null;
  const parsed = parseLine(line);
  if (parsed.description.trim() === '') return `Line ${String(position)} needs a description.`;
  if (parsed.quantityMilli === null || parsed.quantityMilli <= 0) {
    return `Line ${String(position)} needs a positive quantity.`;
  }
  return `Line ${String(position)} has an invalid unit price.`;
}

/**
 * The items to save, or the first thing standing in the way of saving.
 *
 * Blank rows — including the ghost row that is always at the bottom — are
 * dropped rather than reported, which is what lets the form save while a blank
 * row is on screen. A half-typed row is still an error: it is visible, so
 * dropping it silently would be the form losing work.
 */
export function buildItemInputs(lines: readonly LineDraft[]): InvoiceItemInput[] | string {
  for (const [index, line] of lines.entries()) {
    const problem = lineProblem(line, index + 1);
    if (problem !== null) return problem;
  }
  const items = completeLines(lines).map((line, index) => ({
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitPriceCents: line.unitPriceCents,
    position: index,
  }));
  if (items.length === 0) return 'An invoice needs at least one line item.';
  return items;
}

/** The list with a blank row waiting at the end — the ghost row invariant. */
export function withTrailingBlank(lines: readonly LineDraft[]): LineDraft[] {
  const last = lines.at(-1);
  if (last && isBlankLine(last)) return [...lines];
  return [...lines, emptyLine()];
}

/** Rows a user counts: everything except the ghost row waiting at the bottom. */
export function countedLines(lines: readonly LineDraft[]): number {
  return lines.filter((line) => !isBlankLine(line)).length;
}

export function moveLine(lines: readonly LineDraft[], from: number, to: number): LineDraft[] {
  if (from === to || from < 0 || from >= lines.length) return [...lines];
  const clamped = Math.max(0, Math.min(to, lines.length - 1));
  const next = [...lines];
  const [line] = next.splice(from, 1);
  if (!line) return [...lines];
  next.splice(clamped, 0, line);
  return withTrailingBlank(next);
}

export function removeLineAt(lines: readonly LineDraft[], index: number): LineDraft[] {
  if (index < 0 || index >= lines.length) return [...lines];
  const next = lines.filter((_, at) => at !== index);
  return withTrailingBlank(next);
}

export function duplicateLineAt(lines: readonly LineDraft[], index: number): LineDraft[] {
  const line = lines[index];
  if (!line) return [...lines];
  const next = [...lines];
  next.splice(index + 1, 0, { ...line, key: nextLineKey() });
  return withTrailingBlank(next);
}

/** Where the caret should go after a list transformation, or null to leave it. */
export interface LineFocus {
  readonly lines: LineDraft[];
  readonly focusKey: number | null;
}

/**
 * Enter: commit this row and open the next one.
 *
 * On a blank row there is nothing to commit, so the list is left alone — that
 * keeps Enter from growing a tail of empty rows when it is held down.
 */
export function commitLineAt(lines: readonly LineDraft[], index: number): LineFocus {
  const line = lines[index];
  if (!line || isBlankLine(line)) return { lines: withTrailingBlank(lines), focusKey: null };
  const next = lines[index + 1];
  if (next && isBlankLine(next)) {
    return { lines: withTrailingBlank(lines), focusKey: next.key };
  }
  const inserted = emptyLine();
  const result = [...lines];
  result.splice(index + 1, 0, inserted);
  return { lines: withTrailingBlank(result), focusKey: inserted.key };
}

/**
 * Backspace at the start of an already-empty row: delete it.
 *
 * Returns null when the keystroke is an ordinary edit — the row has something in
 * it, or it is the only row left, in which case deleting it would leave the form
 * with no row to type into at all.
 *
 * On the ghost row at the bottom the caret steps back to the row above instead:
 * the ghost is the invariant, so removing it and immediately re-adding one would
 * be a remount that only cost the user their caret.
 */
export function removeBlankLineAt(lines: readonly LineDraft[], index: number): LineFocus | null {
  const line = lines[index];
  if (!line || !isBlankLine(line)) return null;
  if (lines.length <= 1) return null;
  const previousKey = lines[index - 1]?.key ?? null;
  if (index === lines.length - 1) {
    if (previousKey === null) return null;
    return { lines: [...lines], focusKey: previousKey };
  }
  const focusKey = previousKey ?? lines[index + 1]?.key ?? null;
  return { lines: withTrailingBlank(lines.filter((_, at) => at !== index)), focusKey };
}
