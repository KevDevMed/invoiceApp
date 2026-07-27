/**
 * Reporting queries. All aggregation happens in SQL with bound parameters, and
 * money stays integer cents end to end.
 *
 * "Overdue" is derived, never stored: an invoice counts as overdue when its
 * status is 'sent' and its due date is before the as-of day (or when someone
 * explicitly set the stored 'overdue' status). Reads never mutate rows.
 * Void invoices are excluded from every report.
 */

import type { Db } from '../../db/client';
import type { RevenuePeriod } from '../../shared/ipc-contract';
import { SETTINGS_KEYS } from '../../shared/types';

function reportCurrency(db: Db): string {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(SETTINGS_KEYS.defaultCurrency);
  return row?.value && /^[A-Z]{3}$/.test(row.value) ? row.value : 'USD';
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DateRangeFilter {
  readonly from?: string;
  readonly to?: string;
}

export interface ReportSummary {
  readonly currency: string;
  readonly invoiceCount: number;
  readonly draftCents: number;
  readonly sentCents: number;
  readonly paidCents: number;
  readonly overdueCents: number;
  readonly outstandingCents: number;
}

export function summary(db: Db, range: DateRangeFilter = {}, asOf: string = todayIso()): ReportSummary {
  const row = db
    .prepare<
      { from: string | null; to: string | null; asOf: string },
      {
        invoiceCount: number;
        draftCents: number;
        sentCents: number;
        paidCents: number;
        overdueCents: number;
      }
    >(
      `SELECT
         COUNT(*) AS invoiceCount,
         COALESCE(SUM(CASE WHEN status = 'draft' THEN total_cents END), 0) AS draftCents,
         COALESCE(SUM(CASE WHEN status = 'sent' AND due_date >= :asOf THEN total_cents END), 0) AS sentCents,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents END), 0) AS paidCents,
         COALESCE(SUM(CASE WHEN (status = 'sent' AND due_date < :asOf) OR status = 'overdue'
                          THEN total_cents END), 0) AS overdueCents
       FROM invoices
       WHERE status != 'void'
         AND (:from IS NULL OR issue_date >= :from)
         AND (:to IS NULL OR issue_date <= :to)`,
    )
    .get({ from: range.from ?? null, to: range.to ?? null, asOf });

  const invoiceCount = row?.invoiceCount ?? 0;
  const draftCents = row?.draftCents ?? 0;
  const sentCents = row?.sentCents ?? 0;
  const paidCents = row?.paidCents ?? 0;
  const overdueCents = row?.overdueCents ?? 0;

  return {
    currency: reportCurrency(db),
    invoiceCount,
    draftCents,
    sentCents,
    paidCents,
    overdueCents,
    outstandingCents: sentCents + overdueCents,
  };
}

/** SQL expression producing the bucket start date (YYYY-MM-DD) for a period. */
function bucketExpression(period: RevenuePeriod): string {
  switch (period) {
    case 'day':
      return 'issue_date';
    case 'week':
      // Monday of the invoice's ISO week.
      return "date(issue_date, '-6 days', 'weekday 1')";
    case 'month':
      return "strftime('%Y-%m-01', issue_date)";
    case 'quarter':
      return (
        "printf('%s-%02d-01', strftime('%Y', issue_date)," +
        ' ((CAST(strftime(\'%m\', issue_date) AS INTEGER) - 1) / 3) * 3 + 1)'
      );
    case 'year':
      return "strftime('%Y-01-01', issue_date)";
  }
}

export interface RevenueBucket {
  readonly bucket: string;
  readonly invoiceCount: number;
  readonly totalCents: number;
  readonly paidCents: number;
}

export interface RevenueByPeriodResult {
  readonly currency: string;
  readonly period: RevenuePeriod;
  readonly buckets: RevenueBucket[];
}

export function revenueByPeriod(
  db: Db,
  period: RevenuePeriod,
  range: DateRangeFilter = {},
): RevenueByPeriodResult {
  const bucket = bucketExpression(period);
  const rows = db
    .prepare<
      { from: string | null; to: string | null },
      RevenueBucket
    >(
      `SELECT
         ${bucket} AS bucket,
         COUNT(*) AS invoiceCount,
         COALESCE(SUM(total_cents), 0) AS totalCents,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents END), 0) AS paidCents
       FROM invoices
       WHERE status != 'void'
         AND (:from IS NULL OR issue_date >= :from)
         AND (:to IS NULL OR issue_date <= :to)
       GROUP BY bucket
       ORDER BY bucket`,
    )
    .all({ from: range.from ?? null, to: range.to ?? null });

  return { currency: reportCurrency(db), period, buckets: rows };
}

export interface ClientReportRow {
  readonly clientId: string;
  readonly clientName: string;
  readonly invoiceCount: number;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly outstandingCents: number;
}

export interface ByClientResult {
  readonly currency: string;
  readonly rows: ClientReportRow[];
}

export function byClient(db: Db, range: DateRangeFilter = {}, limit = 50): ByClientResult {
  const rows = db
    .prepare<
      { from: string | null; to: string | null; limit: number },
      ClientReportRow
    >(
      `SELECT
         c.id AS clientId,
         c.name AS clientName,
         COUNT(i.id) AS invoiceCount,
         COALESCE(SUM(i.total_cents), 0) AS totalCents,
         COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.total_cents END), 0) AS paidCents,
         COALESCE(SUM(CASE WHEN i.status IN ('sent', 'overdue') THEN i.total_cents END), 0)
           AS outstandingCents
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.status != 'void'
         AND (:from IS NULL OR i.issue_date >= :from)
         AND (:to IS NULL OR i.issue_date <= :to)
       GROUP BY c.id, c.name
       ORDER BY totalCents DESC, c.name COLLATE NOCASE
       LIMIT :limit`,
    )
    .all({ from: range.from ?? null, to: range.to ?? null, limit });

  return { currency: reportCurrency(db), rows };
}

export interface OutstandingRow {
  readonly invoiceId: string;
  readonly number: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly dueDate: string;
  readonly daysOverdue: number;
  readonly totalCents: number;
}

export interface OutstandingResult {
  readonly currency: string;
  readonly asOf: string;
  readonly totalOutstandingCents: number;
  readonly rows: OutstandingRow[];
}

/** Unpaid ('sent' or stored-'overdue') invoices, worst overdue first. */
export function outstanding(db: Db, asOf: string = todayIso()): OutstandingResult {
  const rows = db
    .prepare<
      { asOf: string },
      OutstandingRow
    >(
      `SELECT
         i.id AS invoiceId,
         i.number AS number,
         i.client_id AS clientId,
         c.name AS clientName,
         i.due_date AS dueDate,
         MAX(0, CAST(julianday(:asOf) - julianday(i.due_date) AS INTEGER)) AS daysOverdue,
         i.total_cents AS totalCents
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
       WHERE i.status IN ('sent', 'overdue')
       ORDER BY daysOverdue DESC, i.total_cents DESC, i.number`,
    )
    .all({ asOf });

  const totalOutstandingCents = rows.reduce((sum, row) => sum + row.totalCents, 0);
  return { currency: reportCurrency(db), asOf, totalOutstandingCents, rows };
}
