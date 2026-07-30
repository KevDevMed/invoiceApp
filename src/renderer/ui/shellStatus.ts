/**
 * The two live numbers the shell itself states: how many invoices are open, and
 * how many of those are late.
 *
 * They appear twice — as the count on the Invoices nav row and as the status
 * line at the inline end of the breadcrumb bar — and both are the *same* pair,
 * fetched once. The design asks for a count in the sidebar and a `12 open · 3
 * overdue` line under the tab strip; two independent fetches would let those
 * two disagree with each other on screen, which is worse than either being
 * slightly stale.
 *
 * Deliberately fetched here rather than lifted off a page.
 * `features/invoices/InvoiceList` already sweeps the whole matching set, but it
 * exists only while `/invoices` is mounted and the sidebar count has to survive
 * a trip to Settings. So the shell runs its own sweep and re-runs it on every
 * route change, which is the cheapest event that reliably follows a status
 * edit.
 *
 * What it does *not* do is decide what the numbers mean. "Open" and "overdue"
 * have exactly one definition in this app — `countOpenInvoices` in
 * `features/invoices/listGrouping` — and this module fetches rows and hands
 * them to it, so the breadcrumb and the list's segmented control cannot print
 * two different answers to the same question.
 *
 * Every decision below is pure so the node-only vitest suite can assert it; the
 * hook at the foot is the one part that cannot be.
 */

import { useEffect, useState } from 'react';

import type { Invoice } from '../../shared/types';
import { todayIso } from '../features/invoices/format';
import { countOpenInvoices } from '../features/invoices/listGrouping';
import type { OpenInvoiceCounts } from '../features/invoices/listGrouping';

/** Unpaid invoice totals. `overdue` is a subset of `open`. */
export type InvoiceCounts = OpenInvoiceCounts;

/**
 * Which stored statuses the sweep asks for.
 *
 * `sent` and `overdue`: issued, not yet settled. Not `draft` — a draft has not
 * been sent to anybody and owes nothing — and not `void`, which is a bill that
 * was withdrawn. Overdue is the late half of the same set, which is why the
 * line reads `12 open · 3 overdue` rather than `9 open · 3 overdue`: the second
 * number qualifies the first instead of sitting beside it.
 *
 * These select the *rows*; they do not decide the numbers. Which of those rows
 * is late is `countOpenInvoices`' job and nothing else's — see the note on
 * `useInvoiceCounts`.
 */
export const OPEN_INVOICE_STATUSES = ['sent', 'overdue'] as const;

/** The stored status whose rows are late whatever the clock says. */
export const OVERDUE_INVOICE_STATUS = 'overdue';

/** Rows per sweep request. The contract caps `limit` at 500. */
const PAGE_LIMIT = 500;

/**
 * The breadcrumb bar's status line, or null when there is nothing to say.
 *
 * Null rather than a placeholder in two cases: before the first fetch lands
 * (the shell must not flash a zero it is about to replace) and when nothing is
 * outstanding at all. A bar reading `0 open` is a bar that has been given a job
 * of stating a non-fact; an empty inline end is a bar that is quiet because
 * there is nothing wrong.
 *
 * The overdue half is dropped when it is zero for the same reason.
 */
export function invoiceStatusLine(counts: InvoiceCounts | null): string | null {
  if (counts === null || counts.open === 0) return null;
  const open = `${String(counts.open)} open`;
  return counts.overdue === 0 ? open : `${open} · ${String(counts.overdue)} overdue`;
}

/**
 * The Invoices nav row's end content, or null when there is none.
 *
 * The same number as the status line's first half, and null in the same two
 * cases — a `0` pinned to the nav row would read as a permanent fixture of the
 * design rather than as a count that happens to be empty.
 */
export function invoiceCountLabel(counts: InvoiceCounts | null): string | null {
  if (counts === null || counts.open === 0) return null;
  return String(counts.open);
}

/** Every invoice with one stored status, paged out. */
async function fetchByStatus(status: (typeof OPEN_INVOICE_STATUSES)[number]): Promise<Invoice[]> {
  const items: Invoice[] = [];
  let total = 0;
  do {
    const page = await window.api.invoke('invoices:list', {
      status,
      limit: PAGE_LIMIT,
      offset: items.length,
    });
    if (page.items.length === 0) break;
    items.push(...page.items);
    total = page.total;
  } while (items.length < total);
  return items;
}

/**
 * The counts, refreshed on every route change.
 *
 * The sweep fetches the open *rows* rather than asking the backend for two
 * `total`s, because "overdue" is a question about today's date and not about a
 * stored flag: `countOpenInvoices` re-reads every `sent` invoice against the
 * clock, exactly as the list's segmented control does, so the breadcrumb and
 * the segment beneath it can no longer print two different numbers under the
 * same word. That costs one row per unsettled invoice on a local SQLite file —
 * the same set the cockpit already pages through — and it is the only way the
 * two can be the same number by construction rather than by coincidence.
 *
 * Failure is silence, not an error surface: this feeds a nav badge and a status
 * line, and neither is worth a banner over. A rejected fetch — no `window.api`
 * at all in a bare unit environment, a channel the browser preview refuses —
 * leaves the last good pair on screen rather than blanking it.
 *
 * The ticket guards the usual stale-response race: navigate twice quickly and
 * the first response can land last.
 */
export function useInvoiceCounts(pathname: string): InvoiceCounts | null {
  const [counts, setCounts] = useState<InvoiceCounts | null>(null);

  useEffect(() => {
    let isCurrent = true;
    void (async () => {
      try {
        const pages = await Promise.all(OPEN_INVOICE_STATUSES.map(fetchByStatus));
        if (!isCurrent) return;
        setCounts(countOpenInvoices(pages.flat(), todayIso()));
      } catch {
        // Keep whatever was last known good. See the note above.
      }
    })();
    return () => {
      isCurrent = false;
    };
  }, [pathname]);

  return counts;
}
