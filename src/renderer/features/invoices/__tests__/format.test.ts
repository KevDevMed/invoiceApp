/**
 * `todayIso` is the one helper in this feature that reads the wall clock, so
 * every assertion here pins the instant with fake timers first. Testing it
 * against a live clock would either be vacuous or flake at midnight.
 *
 * The decisive case is the one where the UTC calendar date and the local
 * calendar date are different days: that gap is the whole bug. The runner's
 * own zone is UTC, so that case has to shift `process.env.TZ` and then assert
 * the shift actually took, otherwise it would silently prove nothing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '../../../../shared/types';
import { isEffectivelyOverdue, todayIso } from '../format';

/** The expected value, built from the same local-calendar primitives the fix uses. */
function localCalendarDate(at: Date): string {
  const year = String(at.getFullYear()).padStart(4, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 02:00Z on 28 July is still 27 July anywhere west of UTC-3. */
const SPLIT_INSTANT = new Date('2026-07-28T02:00:00.000Z');

function makeInvoice(overrides: Partial<Invoice> = {}): Pick<Invoice, 'status' | 'dueDate'> {
  return { status: 'sent', dueDate: '2026-07-31', ...overrides };
}

describe('todayIso', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the local calendar date of the pinned instant', () => {
    vi.setSystemTime(SPLIT_INSTANT);
    expect(todayIso()).toBe(localCalendarDate(new Date()));
  });

  it('zero-pads month and day', () => {
    vi.setSystemTime(new Date('2026-03-05T12:00:00.000Z'));
    expect(todayIso()).toBe(localCalendarDate(new Date()));
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('todayIso west of UTC', () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SPLIT_INSTANT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the local day, not the UTC day, when the two differ', () => {
    // Without this the whole case collapses into the UTC-only assertion above.
    expect(new Date().getTimezoneOffset()).not.toBe(0);
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-07-28');
    expect(todayIso()).toBe('2026-07-27');
    expect(todayIso()).toBe(localCalendarDate(new Date()));
  });

  it('does not report an invoice due today as overdue', () => {
    expect(isEffectivelyOverdue(makeInvoice({ dueDate: '2026-07-27' }))).toBe(false);
  });
});

describe('isEffectivelyOverdue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is true for a sent invoice whose due date has passed', () => {
    expect(isEffectivelyOverdue(makeInvoice({ dueDate: '2026-07-27' }))).toBe(true);
  });

  it('is false on the due date itself', () => {
    expect(isEffectivelyOverdue(makeInvoice({ dueDate: '2026-07-28' }))).toBe(false);
  });

  it('is false before the due date', () => {
    expect(isEffectivelyOverdue(makeInvoice({ dueDate: '2026-08-01' }))).toBe(false);
  });

  it('only ever applies to a sent invoice', () => {
    expect(isEffectivelyOverdue(makeInvoice({ status: 'draft', dueDate: '2026-01-01' }))).toBe(false);
    expect(isEffectivelyOverdue(makeInvoice({ status: 'paid', dueDate: '2026-01-01' }))).toBe(false);
    expect(isEffectivelyOverdue(makeInvoice({ status: 'void', dueDate: '2026-01-01' }))).toBe(false);
    expect(isEffectivelyOverdue(makeInvoice({ status: 'overdue', dueDate: '2026-01-01' }))).toBe(
      false,
    );
  });
});
