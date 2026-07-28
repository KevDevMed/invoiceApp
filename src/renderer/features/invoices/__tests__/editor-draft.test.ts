/**
 * The editor's blank form. There is no DOM here (vitest runs in `node`), so the
 * component itself is out of reach — what is testable is the value the editor
 * initialises from and resets to, which is where the "new invoice inherits the
 * last one" bug lived: the reset covered two fields instead of all nine.
 */

import { describe, expect, it } from 'vitest';

import { emptyDraft } from '../InvoiceEditor';

describe('emptyDraft', () => {
  it('is blank in every field a saved invoice could fill', () => {
    const draft = emptyDraft();
    expect(draft.invoiceNumber).toBeNull();
    expect(draft.status).toBe('draft');
    expect(draft.clientId).toBe('');
    expect(draft.notes).toBe('');
    expect(draft.taxRateBps).toBe(0);
    expect(draft.currency).toBe('USD');
    expect(draft.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft.dueDate).toBe(draft.issueDate);
  });

  it('starts with exactly one empty line', () => {
    expect(emptyDraft().lines).toEqual([
      { key: expect.any(Number) as number, description: '', quantity: '1', unitPrice: '0.00' },
    ]);
  });

  it('covers every field of the draft shape, so a reset cannot miss one', () => {
    // The regression: the load effect reset `currency` and `taxRateBps` and left
    // `clientId`, `lines`, `notes`, `status` and `invoiceNumber` holding the
    // previous invoice. Reading the keys off the value keeps that honest.
    expect(Object.keys(emptyDraft()).sort()).toEqual([
      'clientId',
      'currency',
      'dueDate',
      'invoiceNumber',
      'issueDate',
      'lines',
      'notes',
      'status',
      'taxRateBps',
    ]);
  });

  it('hands out a fresh line each call, never a shared array', () => {
    const first = emptyDraft();
    const second = emptyDraft();
    expect(second.lines).not.toBe(first.lines);
    expect(second.lines[0]?.key).not.toBe(first.lines[0]?.key);
    // Mutating one draft's line must not reach a form opened later.
    first.lines[0] = { ...first.lines[0]!, description: 'leaked' };
    expect(second.lines[0]?.description).toBe('');
  });
});
