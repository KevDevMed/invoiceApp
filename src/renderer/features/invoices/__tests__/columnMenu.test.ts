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
  headerAccessibleName,
  inputFieldLabels,
  isCalendarDate,
  isSortActive,
  isSortChoiceActive,
  menuAnchor,
  normaliseTokenList,
  removeChip,
  retainOpenMenu,
  sortLabelsFor,
  sortPillLabel,
  toggleMenu,
  validateFilterInput,
} from '../columnMenu';
import { COLUMNS, SORTABLE_COLUMNS, columnDef, listLayoutAt } from '../listColumns';
import type { ListColumnKey, SortColumnKey } from '../listColumns';
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
    expect(inputFieldLabels('text-list')).toHaveLength(1);
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
    for (const input of ['text', 'text-list', 'currency', 'money-range', 'date-range'] as const) {
      for (const draft of drafts) {
        const result = validateFilterInput(input, draft);
        if (!result.isValid) expect(result.value).toBe('');
      }
    }
  });
});

describe('validateFilterInput — "Is any of…" needs a usable token', () => {
  it('refuses input whose token list comes out empty', () => {
    // `", "` is not an empty string, so it used to pass the plain `text` check
    // and commit a chip whose `wanted` list is empty — which matches every
    // invoice. A chip that claims to restrict must restrict.
    for (const raw of ['', ' ', ',', ', ', ',,,', '  ,  ,  ']) {
      const result = validateFilterInput('text-list', { from: raw, to: '' });
      expect(result.isValid, JSON.stringify(raw)).toBe(false);
      expect(result.value, JSON.stringify(raw)).toBe('');
    }
  });

  it('names why', () => {
    expect(validateFilterInput('text-list', { from: ', ', to: '' }).error).toBe(
      'Enter at least one value',
    );
  });

  it('accepts one token, and canonicalises the separators around it', () => {
    expect(validateFilterInput('text-list', { from: ' , Halcyon ,, ', to: '' })).toEqual({
      isValid: true,
      error: null,
      value: 'Halcyon',
    });
  });

  it('keeps the reader’s own casing and order in the committed value', () => {
    // Identity is normalised separately (`chipKey`); the chip still prints what
    // was typed.
    expect(validateFilterInput('text-list', { from: 'Northwind, Halcyon', to: '' }).value).toBe(
      'Northwind, Halcyon',
    );
  });
});

describe('isCalendarDate', () => {
  it('accepts dates that exist', () => {
    for (const value of ['2026-01-01', '2026-02-28', '2024-02-29', '2026-12-31']) {
      expect(isCalendarDate(value), value).toBe(true);
    }
  });

  it('refuses a date that is only shaped like one', () => {
    // `2026-02-31` used to pass a shape-only regex, commit, and then be
    // compared *lexically* against `issueDate` — a range bounded by a day that
    // never happened, silently including or excluding rows by string order.
    for (const value of [
      '2026-02-31',
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-01-32',
      '2026-01-00',
    ]) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });

  it('refuses anything that is not YYYY-MM-DD at all', () => {
    for (const value of ['', '2026-1-1', '01/01/2026', '2026-01-01T00:00:00Z', 'nope']) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });
});

describe('validateFilterInput — a date range must be two real dates', () => {
  it('refuses an impossible day on either end', () => {
    expect(validateFilterInput('date-range', { from: '2026-02-31', to: '2026-03-31' })).toEqual({
      isValid: false,
      error: 'Enter two real dates as YYYY-MM-DD',
      value: '',
    });
    expect(
      validateFilterInput('date-range', { from: '2026-01-01', to: '2026-13-01' }).isValid,
    ).toBe(false);
  });

  it('still takes a real leap day', () => {
    expect(validateFilterInput('date-range', { from: '2024-02-29', to: '2024-03-01' }).value).toBe(
      '2024-02-29 – 2024-03-01',
    );
  });

  it('holds dates to the same standard money ranges already met', () => {
    // Money already refused non-numeric, negative and empty bounds and
    // corrected a reversed pair. Dates now do all four.
    expect(validateFilterInput('date-range', { from: 'x', to: '2026-01-01' }).isValid).toBe(false);
    expect(validateFilterInput('date-range', { from: '2026-01-01', to: '' }).isValid).toBe(false);
    expect(validateFilterInput('date-range', { from: '2026-03-31', to: '2026-01-01' }).value).toBe(
      '2026-01-01 – 2026-03-31',
    );
  });
});

describe('normaliseTokenList and text-list chip identity', () => {
  it('reduces a comma list to its set', () => {
    expect(normaliseTokenList('Halcyon, Northwind')).toBe('halcyon,northwind');
    expect(normaliseTokenList('northwind,Halcyon')).toBe('halcyon,northwind');
    expect(normaliseTokenList(' , Halcyon ,, ')).toBe('halcyon');
    expect(normaliseTokenList(', ')).toBe('');
  });

  it('treats two spellings of one token set as one chip', () => {
    // `chipKey` used to lowercase the whole string and stop there, so these two
    // were two entries in the bar narrowing to identical rows.
    const first = addChip([], buildChip('client-any-of', 'Halcyon, Northwind'));
    expect(addChip(first, buildChip('client-any-of', 'northwind,Halcyon'))).toHaveLength(1);
    expect(addChip(first, buildChip('client-any-of', ' NORTHWIND ,  halcyon '))).toHaveLength(1);
    expect(chipKey(buildChip('client-any-of', 'Halcyon, Northwind'))).toBe(
      chipKey(buildChip('client-any-of', 'northwind,Halcyon')),
    );
  });

  it('keeps a genuinely different token set apart', () => {
    const first = addChip([], buildChip('client-any-of', 'Halcyon, Northwind'));
    expect(addChip(first, buildChip('client-any-of', 'Halcyon'))).toHaveLength(2);
    expect(addChip(first, buildChip('client-any-of', 'Halcyon, Acme'))).toHaveLength(2);
  });

  it('leaves a plain text predicate comparing whole strings', () => {
    // `Contains…` is one substring, not a set: the comma is part of the needle.
    expect(chipKey(buildChip('client-contains', 'Halcyon, Northwind'))).not.toBe(
      chipKey(buildChip('client-contains', 'northwind,Halcyon')),
    );
  });

  it('removes a text-list chip by a key built from a different spelling', () => {
    const chips = addChip([], buildChip('client-any-of', 'Halcyon, Northwind'));
    expect(removeChip(chips, chipKey(buildChip('client-any-of', 'northwind, halcyon')))).toEqual(
      [],
    );
  });
});

describe('headerAccessibleName', () => {
  it('carries the active order in words, quoting the label that set it', () => {
    expect(headerAccessibleName(columnDef('total'), by('total', 'desc'))).toBe(
      'TOTAL, sorted Largest first',
    );
    expect(headerAccessibleName(columnDef('total'), by('total', 'asc'))).toBe(
      'TOTAL, sorted Smallest first',
    );
    expect(headerAccessibleName(columnDef('status'), by('status', 'asc'))).toBe(
      'STATUS & DUE, sorted Most overdue first',
    );
  });

  it('says "not sorted" on every column that is not the active one', () => {
    expect(headerAccessibleName(columnDef('client'), by('total', 'desc'))).toBe(
      'CLIENT, not sorted',
    );
  });

  it('names exactly one column as sorted, for every state the list can be in', () => {
    // This is the assertion `aria-sort` used to carry — kept, moved onto the
    // control, and no longer claiming a table that does not exist.
    for (const active of SORTABLE_COLUMNS) {
      for (const direction of ['asc', 'desc'] as const) {
        const sort = by(active, direction);
        const sorted = SORTABLE_COLUMNS.filter((key) =>
          headerAccessibleName(columnDef(key), sort).includes(', sorted '),
        );
        expect(sorted, `${active}/${direction}`).toEqual([active]);
      }
    }
  });

  it('quotes the direction’s own label, so the name cannot contradict the arrow', () => {
    for (const key of SORTABLE_COLUMNS) {
      for (const choice of sortLabelsFor(columnDef(key).kind)) {
        expect(headerAccessibleName(columnDef(key), by(key, choice.direction))).toBe(
          `${columnDef(key).label}, sorted ${choice.label}`,
        );
      }
    }
  });
});

describe('retainOpenMenu', () => {
  const wide = listLayoutAt(1400).columns;
  const narrow = listLayoutAt(600).columns;

  it('keeps a menu whose column is still on screen', () => {
    expect(retainOpenMenu('total', wide)).toBe('total');
    expect(retainOpenMenu('client', narrow)).toBe('client');
  });

  it('closes a menu whose column the responsive tier dropped', () => {
    // ISSUED is the first column to go; a menu open on it must not survive the
    // window narrowing and re-open when the window widens again.
    expect(narrow).not.toContain('issued');
    expect(retainOpenMenu('issued', narrow)).toBeNull();
    expect(retainOpenMenu('invoice', narrow)).toBeNull();
  });

  it('closes every menu when the header strip is not rendered at all', () => {
    // An empty result set removes the strip; the state and its document
    // listener used to outlive it and re-open on the next matching row.
    const none: readonly ListColumnKey[] = [];
    for (const key of SORTABLE_COLUMNS) {
      expect(retainOpenMenu(key, none), key).toBeNull();
    }
  });

  it('is a no-op on a closed menu', () => {
    expect(retainOpenMenu(null, wide)).toBeNull();
    expect(retainOpenMenu(null, [])).toBeNull();
  });
});
