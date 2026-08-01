import { describe, expect, it } from 'vitest';

import {
  EMPTY_DRAFT,
  addChip,
  arrowRotation,
  buildChip,
  chevronRotation,
  chipKey,
  chipLabel,
  chipTag,
  hasChips,
  inputFieldLabels,
  isSortActive,
  isSortChoiceActive,
  menuAnchor,
  removeChip,
  sortLabelsFor,
  sortPillLabel,
  toggleMenu,
  validateFilterInput,
} from '../columnMenu';
import { COLUMNS, SORTABLE_COLUMNS, columnDef } from '../listColumns';
import type { SortColumnKey } from '../listColumns';
import type { SortState } from '../listRows';

function by(column: SortColumnKey, direction: 'asc' | 'desc'): SortState {
  return { column, direction };
}

describe('sortLabelsFor', () => {
  it('gives every sortable column two labelled directions', () => {
    for (const key of SORTABLE_COLUMNS) {
      const choices = sortLabelsFor(columnDef(key).kind);
      expect(choices, key).toHaveLength(2);
      for (const choice of choices) {
        expect(choice.label.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('reads the pair off the kind, not off the column', () => {
    // CLIENT and INVOICE are both text, so they offer the same two orders.
    expect(sortLabelsFor(columnDef('client').kind)).toEqual(
      sortLabelsFor(columnDef('invoice').kind),
    );
    expect(sortLabelsFor(columnDef('total').kind)[0]?.label).toBe('Largest first');
    expect(sortLabelsFor(columnDef('issued').kind)[0]?.label).toBe('Newest first');
    expect(sortLabelsFor(columnDef('status').kind)[0]?.label).toBe('Most overdue first');
  });
});

describe('the arrow and the label agree', () => {
  it('points the arrow the way the chosen direction says, on every pair', () => {
    for (const key of SORTABLE_COLUMNS) {
      for (const choice of sortLabelsFor(columnDef(key).kind)) {
        const rotation = arrowRotation(choice.direction);
        expect(rotation, `${key} / ${choice.label}`).toBe(
          choice.direction === 'desc' ? 'rotate(180deg)' : 'rotate(0deg)',
        );
      }
    }
  });

  it('never lets a "first" label imply ascending on its own', () => {
    // `Largest first` and `Newest first` are descending; an implementation that
    // assumed the first option was `asc` would flip both arrows.
    expect(arrowRotation(sortLabelsFor('num')[0]?.direction ?? 'asc')).toBe('rotate(180deg)');
    expect(arrowRotation(sortLabelsFor('date')[0]?.direction ?? 'asc')).toBe('rotate(180deg)');
    expect(arrowRotation(sortLabelsFor('status')[0]?.direction ?? 'desc')).toBe('rotate(0deg)');
    expect(arrowRotation(sortLabelsFor('text')[0]?.direction ?? 'desc')).toBe('rotate(0deg)');
  });
});

describe('active column and active choice', () => {
  it('marks exactly one column active', () => {
    const sort = by('total', 'desc');
    const active = SORTABLE_COLUMNS.filter((key) => isSortActive(sort, key));
    expect(active).toEqual(['total']);
  });

  it('lights exactly one radio dot across the whole header strip', () => {
    const sort = by('issued', 'asc');
    const lit = SORTABLE_COLUMNS.flatMap((key) =>
      sortLabelsFor(columnDef(key).kind)
        .filter((choice) => isSortChoiceActive(sort, key, choice.direction))
        .map((choice) => `${key}:${choice.direction}`),
    );
    expect(lit).toEqual(['issued:asc']);
  });

  it('lights nothing on an inactive column', () => {
    const sort = by('client', 'asc');
    expect(isSortChoiceActive(sort, 'total', 'asc')).toBe(false);
    expect(isSortChoiceActive(sort, 'total', 'desc')).toBe(false);
  });
});

describe('chevronRotation', () => {
  it('flips only while this column’s menu is open', () => {
    expect(chevronRotation(true)).toBe('rotate(180deg)');
    expect(chevronRotation(false)).toBe('rotate(0deg)');
  });
});

describe('sortPillLabel', () => {
  it('title-cases the column label and strips " & DUE"', () => {
    expect(sortPillLabel('total')).toBe('Total');
    expect(sortPillLabel('client')).toBe('Client');
    expect(sortPillLabel('invoice')).toBe('Invoice');
    expect(sortPillLabel('issued')).toBe('Issued');
  });

  it('calls STATUS & DUE what the order actually is', () => {
    expect(sortPillLabel('status')).toBe('Due date');
  });

  it('has a name for every sortable column', () => {
    for (const key of SORTABLE_COLUMNS) {
      expect(sortPillLabel(key), key).not.toBe('');
    }
  });
});

describe('toggleMenu', () => {
  it('opens a closed menu', () => {
    expect(toggleMenu(null, 'client')).toBe('client');
  });

  it('closes its own menu on a second click', () => {
    expect(toggleMenu('client', 'client')).toBe(null);
  });

  it('closes any other column’s menu by opening this one', () => {
    expect(toggleMenu('total', 'client')).toBe('client');
  });
});

describe('menuAnchor', () => {
  it('hangs a left-aligned column’s menu from the left edge', () => {
    expect(menuAnchor('start')).toEqual({ insetInlineStart: '0px', insetInlineEnd: 'auto' });
  });

  it('flips a right-aligned column’s menu to the right edge', () => {
    expect(menuAnchor('end')).toEqual({ insetInlineStart: 'auto', insetInlineEnd: '0px' });
  });

  it('anchors every right-aligned column inward, so TOTAL never overflows', () => {
    for (const column of COLUMNS) {
      if (!column.sortable) continue;
      const anchor = menuAnchor(column.align);
      expect(anchor.insetInlineEnd === '0px', column.key).toBe(column.align === 'end');
    }
    expect(columnDef('total').align).toBe('end');
    expect(columnDef('issued').align).toBe('end');
  });
});

describe('chipTag', () => {
  it('reads as the design has it', () => {
    expect(chipTag('STATUS & DUE', 'Overdue only')).toBe('STATUS: Overdue only');
  });

  it('strips the ellipsis — an applied filter is no longer a prompt', () => {
    expect(chipTag('CLIENT', 'Contains…')).toBe('CLIENT: Contains');
    expect(chipTag('TOTAL', 'Between…')).toBe('TOTAL: Between');
    expect(chipTag('ISSUED', 'Custom range…')).toBe('ISSUED: Custom range');
  });

  it('leaves a label with neither marker alone', () => {
    expect(chipTag('TOTAL', 'Under 1,000')).toBe('TOTAL: Under 1,000');
  });
});

describe('chipLabel', () => {
  it('derives the label from the structured chip', () => {
    expect(chipLabel(buildChip('status-overdue'))).toBe('STATUS: Overdue only');
    expect(chipLabel(buildChip('number-contains', 'INV-9'))).toBe(
      'INVOICE: Number contains INV-9',
    );
  });

  it('labels every option on every column without throwing', () => {
    for (const column of COLUMNS) {
      for (const option of column.filterOptions) {
        expect(chipLabel(buildChip(option.predicate)), option.predicate).toContain(':');
      }
    }
  });
});

describe('buildChip', () => {
  it('records the column the predicate came from', () => {
    expect(buildChip('total-between', '1 – 2')).toEqual({
      columnKey: 'total',
      predicate: 'total-between',
      value: '1 – 2',
    });
  });

  it('leaves the value off when the option commits on click', () => {
    expect(buildChip('status-paid')).toEqual({ columnKey: 'status', predicate: 'status-paid' });
    expect(buildChip('status-paid', '   ')).toEqual({
      columnKey: 'status',
      predicate: 'status-paid',
    });
  });
});

describe('chip dedupe', () => {
  it('adds a chip', () => {
    const chips = addChip([], buildChip('status-overdue'));
    expect(chips).toHaveLength(1);
    expect(hasChips(chips)).toBe(true);
  });

  it('does not duplicate an identical filter', () => {
    const once = addChip([], buildChip('status-overdue'));
    const twice = addChip(once, buildChip('status-overdue'));
    expect(twice).toHaveLength(1);
    // Unchanged identity too, so nothing downstream re-renders for nothing.
    expect(twice).toBe(once);
  });

  it('dedupes on the structured identity, not on the rendered string', () => {
    const first = addChip([], buildChip('client-contains', 'Halcyon'));
    // Same filter, different casing and padding — one chip.
    expect(addChip(first, buildChip('client-contains', '  halcyon '))).toHaveLength(1);
    // A genuinely different value is a second chip.
    expect(addChip(first, buildChip('client-contains', 'Northwind'))).toHaveLength(2);
  });

  it('keeps two different predicates apart', () => {
    const chips = addChip(addChip([], buildChip('status-overdue')), buildChip('status-paid'));
    expect(chips).toHaveLength(2);
  });

  it('removes by key and empties the bar with the last one', () => {
    const chip = buildChip('status-overdue');
    const chips = addChip([], chip);
    const after = removeChip(chips, chipKey(chip));
    expect(after).toEqual([]);
    expect(hasChips(after)).toBe(false);
  });

  it('removes only the chip named', () => {
    const overdue = buildChip('status-overdue');
    const paid = buildChip('status-paid');
    const chips = addChip(addChip([], overdue), paid);
    expect(removeChip(chips, chipKey(overdue))).toEqual([paid]);
  });
});

describe('inputFieldLabels', () => {
  it('draws no fields for an option that commits on click', () => {
    expect(inputFieldLabels('none')).toEqual([]);
  });

  it('draws one field for text and currency, two for a range', () => {
    expect(inputFieldLabels('text')).toHaveLength(1);
    expect(inputFieldLabels('currency')).toHaveLength(1);
    expect(inputFieldLabels('money-range')).toEqual(['From', 'To']);
    expect(inputFieldLabels('date-range')).toEqual(['From', 'To']);
  });

  it('gives every ellipsis option in the column table at least one field', () => {
    for (const column of COLUMNS) {
      for (const option of column.filterOptions) {
        const needsInput = option.label.endsWith('…');
        expect(inputFieldLabels(option.input).length > 0, option.label).toBe(needsInput);
      }
    }
  });
});

describe('validateFilterInput', () => {
  it('commits an option that needs nothing', () => {
    expect(validateFilterInput('none', EMPTY_DRAFT)).toEqual({
      isValid: true,
      error: null,
      value: '',
    });
  });

  it('refuses an empty text value', () => {
    const result = validateFilterInput('text', EMPTY_DRAFT);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Enter a value');
  });

  it('trims a text value', () => {
    expect(validateFilterInput('text', { from: '  Halcyon ', to: '' }).value).toBe('Halcyon');
  });

  it('takes a three-letter currency code, upper-cased', () => {
    expect(validateFilterInput('currency', { from: 'eur', to: '' })).toEqual({
      isValid: true,
      error: null,
      value: 'EUR',
    });
  });

  it('refuses anything that is not a three-letter code', () => {
    for (const raw of ['', 'E', 'EURO', '12£', '€']) {
      expect(validateFilterInput('currency', { from: raw, to: '' }).isValid, raw).toBe(false);
    }
  });

  it('takes two amounts and canonicalises them', () => {
    expect(validateFilterInput('money-range', { from: '1,000', to: '5000' })).toEqual({
      isValid: true,
      error: null,
      value: '1000 – 5000',
    });
  });

  it('corrects a reversed money range rather than rejecting it', () => {
    expect(validateFilterInput('money-range', { from: '5000', to: '1000' }).value).toBe(
      '1000 – 5000',
    );
  });

  it('refuses a money range that is not two numbers', () => {
    expect(validateFilterInput('money-range', { from: 'abc', to: '10' }).isValid).toBe(false);
    expect(validateFilterInput('money-range', { from: '10', to: '' }).isValid).toBe(false);
    expect(validateFilterInput('money-range', { from: '-5', to: '10' }).isValid).toBe(false);
  });

  it('takes two ISO dates and corrects a reversed pair', () => {
    expect(
      validateFilterInput('date-range', { from: '2026-01-01', to: '2026-03-31' }).value,
    ).toBe('2026-01-01 – 2026-03-31');
    expect(
      validateFilterInput('date-range', { from: '2026-03-31', to: '2026-01-01' }).value,
    ).toBe('2026-01-01 – 2026-03-31');
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(
      validateFilterInput('date-range', { from: '01/01/2026', to: '2026-03-31' }).isValid,
    ).toBe(false);
    expect(validateFilterInput('date-range', { from: '2026-01-01', to: '' }).isValid).toBe(
      false,
    );
  });

  it('never returns a value it also called invalid', () => {
    const drafts = [
      EMPTY_DRAFT,
      { from: 'x', to: '' },
      { from: '2026-01-01', to: 'nope' },
      { from: '5', to: 'y' },
    ];
    for (const input of ['text', 'currency', 'money-range', 'date-range'] as const) {
      for (const draft of drafts) {
        const result = validateFilterInput(input, draft);
        if (!result.isValid) expect(result.value).toBe('');
      }
    }
  });
});
