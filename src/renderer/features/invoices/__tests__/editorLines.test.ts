/**
 * The line-item rules of the 2a form: the ghost row that always waits at the
 * bottom, the keyboard transitions that replace the "Add item" button, and the
 * gate that keeps unfinished rows out of the document and the totals.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUANTITY,
  DEFAULT_UNIT_PRICE,
  type LineDraft,
  buildItemInputs,
  commitLineAt,
  completeLines,
  countedLines,
  duplicateLineAt,
  emptyLine,
  isBlankLine,
  isCompleteLine,
  lineProblem,
  moveLine,
  removeBlankLineAt,
  removeLineAt,
  withTrailingBlank,
} from '../editorLines';

let key = 100;
function line(partial: Partial<Omit<LineDraft, 'key'>> = {}): LineDraft {
  return {
    key: key++,
    description: '',
    quantity: DEFAULT_QUANTITY,
    unitPrice: DEFAULT_UNIT_PRICE,
    ...partial,
  };
}

const work = (): LineDraft => line({ description: 'Design retainer', quantity: '2', unitPrice: '150.00' });

describe('isBlankLine', () => {
  it('is true for the row the form starts with', () => {
    expect(isBlankLine(emptyLine())).toBe(true);
  });

  it('accepts the blank spellings of the defaults', () => {
    expect(isBlankLine(line({ quantity: '', unitPrice: '' }))).toBe(true);
    expect(isBlankLine(line({ quantity: '1.0', unitPrice: '0' }))).toBe(true);
    expect(isBlankLine(line({ quantity: ' 1 ', unitPrice: ' 0.00 ' }))).toBe(true);
  });

  it('is false as soon as the user touches any cell', () => {
    expect(isBlankLine(line({ description: 'a' }))).toBe(false);
    expect(isBlankLine(line({ quantity: '3' }))).toBe(false);
    expect(isBlankLine(line({ unitPrice: '12.00' }))).toBe(false);
    // A price typed with no description yet is unfinished, not blank: dropping
    // it silently would lose money that is on screen.
    expect(isBlankLine(line({ description: '   ', unitPrice: '500' }))).toBe(false);
  });
});

describe('isCompleteLine', () => {
  it('needs a description, a positive quantity, and a price that parses', () => {
    expect(isCompleteLine(work())).toBe(true);
    expect(isCompleteLine(line({ description: 'a', quantity: '0' }))).toBe(false);
    expect(isCompleteLine(line({ description: 'a', quantity: 'two' }))).toBe(false);
    expect(isCompleteLine(line({ description: 'a', unitPrice: 'free' }))).toBe(false);
  });

  it('counts a zero-priced line with a description as complete', () => {
    // A named freebie is a real invoice line; a nameless zero row is not.
    expect(isCompleteLine(line({ description: 'Included revision' }))).toBe(true);
  });
});

describe('completeLines', () => {
  it('drops blank and half-typed rows and trims what it keeps', () => {
    const kept = completeLines([
      line({ description: '  Brand identity  ', quantity: '1', unitPrice: '6400.00' }),
      line(),
      line({ description: 'Broken', quantity: '0' }),
    ]);
    expect(kept).toEqual([
      { key: expect.any(Number) as number, description: 'Brand identity', quantityMilli: 1000, unitPriceCents: 640_000 },
    ]);
  });

  it('carries the draft key through, so the preview can point back at a row', () => {
    const row = work();
    expect(completeLines([row, emptyLine()])[0]?.key).toBe(row.key);
  });

  it('is empty for a form nobody has typed into', () => {
    expect(completeLines([emptyLine()])).toEqual([]);
  });
});

describe('lineProblem', () => {
  it('says nothing about a blank row or a complete one', () => {
    expect(lineProblem(emptyLine(), 1)).toBeNull();
    expect(lineProblem(work(), 1)).toBeNull();
  });

  it('names the row and what it is missing', () => {
    expect(lineProblem(line({ unitPrice: '50.00' }), 3)).toBe('Line 3 needs a description.');
    expect(lineProblem(line({ description: 'a', quantity: '0' }), 2)).toBe(
      'Line 2 needs a positive quantity.',
    );
    expect(lineProblem(line({ description: 'a', unitPrice: 'free' }), 1)).toBe(
      'Line 1 has an invalid unit price.',
    );
  });
});

describe('buildItemInputs', () => {
  it('saves through a trailing ghost row without complaining about it', () => {
    const items = buildItemInputs([work(), emptyLine()]);
    expect(items).toEqual([
      { description: 'Design retainer', quantityMilli: 2000, unitPriceCents: 15_000, position: 0 },
    ]);
  });

  it('renumbers positions after the dropped rows', () => {
    const items = buildItemInputs([work(), emptyLine(), work(), emptyLine()]);
    expect(Array.isArray(items) ? items.map((item) => item.position) : items).toEqual([0, 1]);
  });

  it('still refuses a row the user half-typed', () => {
    expect(buildItemInputs([work(), line({ unitPrice: '20.00' })])).toBe(
      'Line 2 needs a description.',
    );
  });

  it('refuses a form with nothing on it', () => {
    expect(buildItemInputs([emptyLine()])).toBe('An invoice needs at least one line item.');
  });
});

describe('withTrailingBlank', () => {
  it('adds the ghost row when the last row has been typed into', () => {
    const next = withTrailingBlank([work()]);
    expect(next).toHaveLength(2);
    expect(isBlankLine(next[1]!)).toBe(true);
  });

  it('leaves a list that already ends blank alone', () => {
    const rows = [work(), emptyLine()];
    expect(withTrailingBlank(rows).map((row) => row.key)).toEqual(rows.map((row) => row.key));
  });

  it('never mutates its input', () => {
    const rows = [work()];
    withTrailingBlank(rows);
    expect(rows).toHaveLength(1);
  });
});

describe('countedLines', () => {
  it('counts the rows the user typed, not the ghost', () => {
    expect(countedLines([work(), work(), emptyLine()])).toBe(2);
    expect(countedLines([emptyLine()])).toBe(0);
  });
});

describe('commitLineAt', () => {
  it('opens a fresh row after the committed one and points the caret at it', () => {
    const rows = [work()];
    const { lines, focusKey } = commitLineAt(rows, 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.key).toBe(focusKey);
    expect(isBlankLine(lines[1]!)).toBe(true);
  });

  it('reuses the ghost row instead of stacking a second empty one', () => {
    const rows = [work(), emptyLine()];
    const { lines, focusKey } = commitLineAt(rows, 0);
    expect(lines).toHaveLength(2);
    expect(focusKey).toBe(rows[1]?.key);
  });

  it('inserts in the middle when the next row is already filled in', () => {
    const first = work();
    const second = work();
    const { lines, focusKey } = commitLineAt([first, second, emptyLine()], 0);
    expect(lines.map((row) => row.key)).toEqual([first.key, focusKey, second.key, expect.any(Number)]);
  });

  it('does nothing on a blank row, so a held Enter cannot grow a tail', () => {
    const rows = [work(), emptyLine()];
    const { lines, focusKey } = commitLineAt(rows, 1);
    expect(lines.map((row) => row.key)).toEqual(rows.map((row) => row.key));
    expect(focusKey).toBeNull();
  });
});

describe('removeBlankLineAt', () => {
  it('deletes an empty row that is not the ghost and steps the caret back', () => {
    const first = work();
    const blank = emptyLine();
    const result = removeBlankLineAt([first, blank, work(), emptyLine()], 1);
    expect(result?.lines.map((row) => row.key)).not.toContain(blank.key);
    expect(result?.focusKey).toBe(first.key);
  });

  it('steps back off the ghost row without removing it', () => {
    const first = work();
    const ghost = emptyLine();
    const result = removeBlankLineAt([first, ghost], 1);
    expect(result?.lines.map((row) => row.key)).toEqual([first.key, ghost.key]);
    expect(result?.focusKey).toBe(first.key);
  });

  it('is an ordinary keystroke on a row with something in it', () => {
    expect(removeBlankLineAt([work(), emptyLine()], 0)).toBeNull();
  });

  it('never removes the last row on the form', () => {
    expect(removeBlankLineAt([emptyLine()], 0)).toBeNull();
  });
});

describe('moveLine / removeLineAt / duplicateLineAt', () => {
  it('moves a row and keeps the ghost at the bottom', () => {
    const first = work();
    const second = work();
    const ghost = emptyLine();
    const moved = moveLine([first, second, ghost], 1, 0);
    expect(moved.map((row) => row.key)).toEqual([second.key, first.key, ghost.key]);
  });

  it('clamps a move past either end', () => {
    const first = work();
    const second = work();
    expect(moveLine([first, second], 0, -3).map((row) => row.key)).toEqual([first.key, second.key, expect.any(Number)]);
    expect(moveLine([first, second], 0, 9).map((row) => row.key)).toEqual([second.key, first.key, expect.any(Number)]);
  });

  it('re-adds a ghost row when the last real row is removed', () => {
    const only = work();
    const next = removeLineAt([only, emptyLine()], 0);
    expect(next).toHaveLength(1);
    expect(isBlankLine(next[0]!)).toBe(true);
  });

  it('duplicates a row directly below itself with its own key', () => {
    const row = work();
    const next = duplicateLineAt([row, emptyLine()], 0);
    expect(next[1]?.description).toBe(row.description);
    expect(next[1]?.key).not.toBe(row.key);
  });
});
