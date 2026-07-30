import { describe, expect, it } from 'vitest';

import {
  invoiceCountLabel,
  invoiceStatusLine,
  OPEN_INVOICE_STATUSES,
  OVERDUE_INVOICE_STATUS,
} from '../shellStatus';

describe('OPEN_INVOICE_STATUSES', () => {
  // Drafts owe nothing and void invoices were withdrawn; neither is "open".
  it('counts the issued-but-unsettled statuses and no others', () => {
    expect([...OPEN_INVOICE_STATUSES]).toEqual(['sent', 'overdue']);
    expect(OPEN_INVOICE_STATUSES).not.toContain('draft');
    expect(OPEN_INVOICE_STATUSES).not.toContain('paid');
    expect(OPEN_INVOICE_STATUSES).not.toContain('void');
  });

  // The second number qualifies the first rather than sitting beside it, so
  // overdue has to be inside the open set or `3 overdue` of `12 open` is a lie.
  it('keeps overdue inside the open set', () => {
    expect(OPEN_INVOICE_STATUSES).toContain(OVERDUE_INVOICE_STATUS);
  });
});

describe('invoiceStatusLine', () => {
  it('reads open first, overdue as the qualifier', () => {
    expect(invoiceStatusLine({ open: 12, overdue: 3 })).toBe('12 open · 3 overdue');
  });

  // Nothing late is not news. The line keeps saying what is outstanding.
  it('drops the overdue half when nothing is late', () => {
    expect(invoiceStatusLine({ open: 12, overdue: 0 })).toBe('12 open');
  });

  // Two silences, one reason: the band must not state a non-fact. Before the
  // first fetch there is nothing known; with nothing outstanding there is
  // nothing to report, and `0 open` reads as a permanent fixture of the design.
  it('says nothing at all when there is nothing to say', () => {
    expect(invoiceStatusLine(null)).toBeNull();
    expect(invoiceStatusLine({ open: 0, overdue: 0 })).toBeNull();
  });

  it('states a single open invoice as a number, not as prose', () => {
    expect(invoiceStatusLine({ open: 1, overdue: 1 })).toBe('1 open · 1 overdue');
  });
});

describe('invoiceCountLabel', () => {
  // The same number as the status line's first half — one fetch feeds both, so
  // the nav row and the breadcrumb cannot disagree on screen.
  it('is the open count, as the nav row prints it', () => {
    expect(invoiceCountLabel({ open: 12, overdue: 3 })).toBe('12');
    expect(invoiceCountLabel({ open: 1, overdue: 0 })).toBe('1');
  });

  it('is absent in exactly the cases the status line is', () => {
    expect(invoiceCountLabel(null)).toBeNull();
    expect(invoiceCountLabel({ open: 0, overdue: 0 })).toBeNull();
  });
});
