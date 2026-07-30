/**
 * The derived fields of the 2a form: the payment term the user now picks, the
 * due date it computes, sales tax as a percentage, and the header caption.
 */

import { describe, expect, it } from 'vitest';

import { addCalendarDays } from '../document';
import {
  NOTES_PRINT_BUDGET,
  bpsToPercent,
  draftCaption,
  dueDateFor,
  isNotesOverBudget,
  notesCounter,
  paymentTermLabel,
  paymentTermOf,
  paymentTermOptions,
  percentToBps,
  taxPercentText,
} from '../editorFields';

describe('addCalendarDays', () => {
  it('adds whole days across a month boundary', () => {
    expect(addCalendarDays('2026-01-29', 14)).toBe('2026-02-12');
  });

  it('adds nothing for a zero term', () => {
    expect(addCalendarDays('2026-07-29', 0)).toBe('2026-07-29');
  });

  it('crosses a year and a leap day', () => {
    expect(addCalendarDays('2026-12-30', 7)).toBe('2027-01-06');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is the inverse of the term it was derived from', () => {
    expect(addCalendarDays('2026-01-29', 30)).toBe('2026-02-28');
    expect(addCalendarDays('2026-02-28', -30)).toBe('2026-01-29');
  });

  it('hands back an unparseable date unchanged', () => {
    expect(addCalendarDays('nope', 14)).toBe('nope');
    expect(addCalendarDays('2026-02-31', 1)).toBe('2026-02-31');
  });
});

describe('payment terms', () => {
  it('names the presets the way an invoice does', () => {
    expect(paymentTermLabel(0)).toBe('Due on receipt');
    expect(paymentTermLabel(14)).toBe('Net 14');
  });

  it('offers the presets in order', () => {
    expect(paymentTermOptions(null).map((option) => option.value)).toEqual([
      '0',
      '7',
      '14',
      '30',
      '45',
      '60',
    ]);
  });

  it('inserts an invoice’s own off-preset term in its numeric place', () => {
    expect(paymentTermOptions(21).map((option) => option.label)).toEqual([
      'Due on receipt',
      'Net 7',
      'Net 14',
      'Net 21',
      'Net 30',
      'Net 45',
      'Net 60',
    ]);
  });

  it('does not duplicate a term that is already a preset', () => {
    expect(paymentTermOptions(30)).toHaveLength(6);
  });

  it('offers nothing extra for a term that makes no sense', () => {
    expect(paymentTermOptions(-4)).toHaveLength(6);
  });

  it('reads the term off a saved invoice’s two dates', () => {
    expect(paymentTermOf('2026-01-29', '2026-02-12')).toBe(14);
    expect(paymentTermOf('2026-01-29', '2026-01-29')).toBe(0);
    expect(paymentTermOf('2026-01-29', '2026-01-27')).toBeNull();
    expect(paymentTermOf('nope', '2026-01-27')).toBeNull();
  });

  it('derives the due date the term implies', () => {
    expect(dueDateFor('2026-07-29', 14)).toBe('2026-08-12');
    expect(dueDateFor('2026-07-29', 0)).toBe('2026-07-29');
  });
});

describe('sales tax', () => {
  it('shows basis points as the percentage the user types', () => {
    expect(bpsToPercent(825)).toBe(8.25);
    expect(bpsToPercent(0)).toBe(0);
    expect(bpsToPercent(2000)).toBe(20);
  });

  it('stores the typed percentage back as whole basis points', () => {
    expect(percentToBps(8.25)).toBe(825);
    expect(percentToBps(0)).toBe(0);
    // Two decimal places is all an invoice keeps: the third is rounded, never
    // carried as a float into the money math.
    expect(percentToBps(8.256)).toBe(826);
  });

  it('round-trips every preset step', () => {
    for (const bps of [0, 25, 825, 1750, 2000]) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    }
  });

  it('refuses negatives and rubbish from either side', () => {
    expect(bpsToPercent(-100)).toBe(0);
    expect(bpsToPercent(Number.NaN)).toBe(0);
    expect(percentToBps(-3)).toBe(0);
    expect(percentToBps(Number.NaN)).toBe(0);
  });

  it('prints the rate the way the document does', () => {
    expect(taxPercentText(825)).toBe('8.25');
    expect(taxPercentText(0)).toBe('0.00');
  });
});

describe('notes counter', () => {
  it('counts what is typed against the print budget', () => {
    expect(notesCounter('')).toBe(`0 / ${String(NOTES_PRINT_BUDGET)}`);
    expect(notesCounter('abc')).toBe(`3 / ${String(NOTES_PRINT_BUDGET)}`);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(notesCounter('née 🧾')).toBe(`5 / ${String(NOTES_PRINT_BUDGET)}`);
  });

  it('flags a note that will not fit the printed block', () => {
    expect(isNotesOverBudget('x'.repeat(NOTES_PRINT_BUDGET))).toBe(false);
    expect(isNotesOverBudget('x'.repeat(NOTES_PRINT_BUDGET + 1))).toBe(true);
  });
});

describe('draftCaption', () => {
  const base = {
    number: 'INV-0042',
    status: 'draft',
    isNew: false,
    isSaving: false,
    hasUnsavedChanges: false,
  } as const;

  it('names the invoice and then its saved state', () => {
    expect(draftCaption(base)).toBe('INV-0042 · draft saved');
    expect(draftCaption({ ...base, status: 'sent' })).toBe('INV-0042 · sent saved');
  });

  it('says what is happening while a save is in flight', () => {
    expect(draftCaption({ ...base, isSaving: true })).toBe('INV-0042 · saving…');
  });

  it('never claims a new invoice is saved', () => {
    expect(draftCaption({ ...base, number: null, isNew: true })).toBe('New invoice · not saved yet');
  });

  it('admits to unsaved edits on a saved invoice', () => {
    expect(draftCaption({ ...base, hasUnsavedChanges: true })).toBe('INV-0042 · unsaved changes');
  });
});
