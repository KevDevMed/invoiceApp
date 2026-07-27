/**
 * Reports feature barrel: date-range filter, summary tiles, revenue-by-period
 * chart (with its table-view twin), top clients, and outstanding invoices.
 */

import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { DateRangeInput, type DateRange } from '@astryxdesign/core/DateRangeInput';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { VStack } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';

import type { IpcResponse } from '../../../shared/ipc-contract';
import { formatMoney } from '../../../shared/money';
import { Page, PageHeader, PageToolbar } from '../../ui/Page';
import { RevenueChart } from './RevenueChart';

type Summary = IpcResponse<'reports:summary'>;
type Revenue = IpcResponse<'reports:revenueByPeriod'>;
type ByClient = IpcResponse<'reports:byClient'>;
type Outstanding = IpcResponse<'reports:outstanding'>;

type Period = 'week' | 'month';

interface ReportData {
  summary: Summary;
  revenue: Revenue;
  byClient: ByClient;
  outstanding: Outstanding;
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Heading level={3}>{value}</Heading>
        {hint ? <Text type="supporting">{hint}</Text> : null}
      </VStack>
    </Card>
  );
}

interface ClientRow extends Record<string, unknown> {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  total: string;
  paid: string;
  outstanding: string;
}

interface OutstandingTableRow extends Record<string, unknown> {
  invoiceId: string;
  number: string;
  clientName: string;
  dueDate: string;
  daysOverdue: number;
  total: string;
}

interface BucketRow extends Record<string, unknown> {
  bucket: string;
  invoiceCount: number;
  invoiced: string;
  paid: string;
}

export function ReportsPage(): React.JSX.Element {
  const [range, setRange] = useState<DateRange | null>(null);
  const [period, setPeriod] = useState<Period>('month');
  const [data, setData] = useState<ReportData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    const from = range?.start;
    const to = range?.end;
    void (async () => {
      try {
        const [summary, revenue, byClient, outstanding] = await Promise.all([
          window.api.invoke('reports:summary', { from, to }),
          window.api.invoke('reports:revenueByPeriod', { from, to, period }),
          window.api.invoke('reports:byClient', { from, to, limit: 10 }),
          window.api.invoke('reports:outstanding', {}),
        ]);
        if (cancelled) return;
        setData({ summary, revenue, byClient, outstanding });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [range, period]);

  const currency = data?.summary.currency ?? 'USD';
  const fmt = (cents: number): string => formatMoney(cents, currency);

  const totalInvoicedCents = data
    ? data.summary.draftCents +
      data.summary.sentCents +
      data.summary.paidCents +
      data.summary.overdueCents
    : 0;

  const clientRows: ClientRow[] = useMemo(
    () =>
      (data?.byClient.rows ?? []).map((row) => ({
        clientId: row.clientId,
        clientName: row.clientName,
        invoiceCount: row.invoiceCount,
        total: formatMoney(row.totalCents, currency),
        paid: formatMoney(row.paidCents, currency),
        outstanding: formatMoney(row.outstandingCents, currency),
      })),
    [data, currency],
  );

  const outstandingRows: OutstandingTableRow[] = useMemo(
    () =>
      (data?.outstanding.rows ?? []).map((row) => ({
        invoiceId: row.invoiceId,
        number: row.number,
        clientName: row.clientName,
        dueDate: row.dueDate,
        daysOverdue: row.daysOverdue,
        total: formatMoney(row.totalCents, currency),
      })),
    [data, currency],
  );

  const bucketRows: BucketRow[] = useMemo(
    () =>
      (data?.revenue.buckets ?? []).map((bucket) => ({
        bucket: bucket.bucket,
        invoiceCount: bucket.invoiceCount,
        invoiced: formatMoney(bucket.totalCents, currency),
        paid: formatMoney(bucket.paidCents, currency),
      })),
    [data, currency],
  );

  return (
    <Page>
      <PageHeader
        title="Reports"
        description="How invoicing is going, across clients and over time."
      />

      {/* One filter row above everything it scopes. */}
      <PageToolbar>
        <DateRangeInput label="Issue date range" value={range} onChange={setRange} />
        <Selector
          label="Group by"
          options={['month', 'week']}
          value={period}
          onChange={(value) => {
            setPeriod(value === 'week' ? 'week' : 'month');
          }}
        />
      </PageToolbar>

      {error ? <Banner status="error" title={error} isDismissable /> : null}

      {isLoading && !data ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading reports" />
        </VStack>
      ) : data ? (
        <VStack gap={5} style={isLoading ? { opacity: 0.6 } : undefined}>
          <Grid columns={{ minWidth: 180, max: 5 }} gap={3}>
            <StatTile
              label="Total invoiced"
              value={fmt(totalInvoicedCents)}
              hint={`${data.summary.invoiceCount} invoice(s)`}
            />
            <StatTile label="Paid" value={fmt(data.summary.paidCents)} />
            <StatTile label="Outstanding" value={fmt(data.summary.outstandingCents)} />
            <StatTile label="Overdue" value={fmt(data.summary.overdueCents)} />
            <StatTile label="Draft" value={fmt(data.summary.draftCents)} />
          </Grid>

          <Divider />

          <VStack gap={3}>
            <Heading level={2}>Revenue by {data.revenue.period}</Heading>
            {data.revenue.buckets.length === 0 ? (
              <EmptyState
                title="Nothing invoiced in this range"
                description="Create or backdate invoices to see revenue here."
                headingLevel={3}
              />
            ) : (
              <>
                <RevenueChart buckets={data.revenue.buckets} currency={currency} />
                {/* table-view twin: every charted value, readable without hover */}
                <Table<BucketRow>
                  data={bucketRows}
                  idKey="bucket"
                  density="compact"
                  columns={[
                    { key: 'bucket', header: 'Period', width: pixel(130) },
                    { key: 'invoiceCount', header: 'Invoices', width: pixel(90), align: 'end' },
                    { key: 'invoiced', header: 'Invoiced', width: proportional(1), align: 'end' },
                    { key: 'paid', header: 'Paid', width: proportional(1), align: 'end' },
                  ]}
                />
              </>
            )}
          </VStack>

          <Divider />

          <VStack gap={3}>
            <Heading level={2}>Top clients</Heading>
            {clientRows.length === 0 ? (
              <EmptyState title="No client activity in this range" headingLevel={3} />
            ) : (
              <Table<ClientRow>
                data={clientRows}
                idKey="clientId"
                density="compact"
                columns={[
                  { key: 'clientName', header: 'Client', width: proportional(2) },
                  { key: 'invoiceCount', header: 'Invoices', width: pixel(90), align: 'end' },
                  { key: 'total', header: 'Invoiced', width: proportional(1), align: 'end' },
                  { key: 'paid', header: 'Paid', width: proportional(1), align: 'end' },
                  { key: 'outstanding', header: 'Outstanding', width: proportional(1), align: 'end' },
                ]}
              />
            )}
          </VStack>

          <Divider />

          <VStack gap={3}>
            <VStack gap={1}>
              <Heading level={2}>Outstanding invoices</Heading>
              <Text type="supporting" display="block">
                As of {data.outstanding.asOf} — {fmt(data.outstanding.totalOutstandingCents)} unpaid.
              </Text>
            </VStack>
            {outstandingRows.length === 0 ? (
              <EmptyState title="Nothing outstanding" description="Every sent invoice is settled." headingLevel={3} />
            ) : (
              <Table<OutstandingTableRow>
                data={outstandingRows}
                idKey="invoiceId"
                density="compact"
                columns={[
                  { key: 'number', header: 'Number', width: pixel(120) },
                  { key: 'clientName', header: 'Client', width: proportional(2) },
                  { key: 'dueDate', header: 'Due', width: pixel(110) },
                  {
                    key: 'daysOverdue',
                    header: 'Days overdue',
                    width: pixel(130),
                    align: 'end',
                    renderCell: (row: OutstandingTableRow) =>
                      row.daysOverdue > 0 ? (
                        <Badge variant="error" label={String(row.daysOverdue)} />
                      ) : (
                        <Text type="supporting">0</Text>
                      ),
                  },
                  { key: 'total', header: 'Total', width: proportional(1), align: 'end' },
                ]}
              />
            )}
          </VStack>
        </VStack>
      ) : null}
    </Page>
  );
}
