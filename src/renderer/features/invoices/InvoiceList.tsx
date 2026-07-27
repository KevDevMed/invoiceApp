/**
 * Invoice list: status filter + search, newest first, row actions.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Invoice, InvoiceStatus } from '../../../shared/types';
import { STATUS_OPTIONS, isEffectivelyOverdue, money } from './format';

interface InvoiceTableRow extends Record<string, unknown> {
  id: string;
  number: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
  status: string;
  total: string;
  invoice: Invoice;
}

export function InvoiceList(): React.JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<InvoiceStatus | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clientNames, setClientNames] = useState<Map<string, string>>(new Map());
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (term: string, statusFilter: InvoiceStatus | null) => {
    setError(null);
    try {
      const [invoiceResult, clientResult] = await Promise.all([
        window.api.invoke('invoices:list', {
          search: term.trim() === '' ? undefined : term.trim(),
          status: statusFilter ?? undefined,
          limit: 200,
          offset: 0,
        }),
        // The list response carries clientId only — join names client-side.
        window.api.invoke('clients:list', { limit: 500, offset: 0 }),
      ]);
      setInvoices(invoiceResult.items);
      setTotal(invoiceResult.total);
      setClientNames(new Map(clientResult.items.map((c) => [c.id, c.name])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setInvoices([]);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load(search, status);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [search, status, load]);

  const rows: InvoiceTableRow[] = (invoices ?? []).map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    clientName: clientNames.get(invoice.clientId) ?? invoice.clientId,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    total: money(invoice.totalCents, invoice.currency),
    invoice,
  }));

  return (
    <VStack gap={4} padding={4} height="100%" isScrollable>
      <HStack gap={2} align="center" justify="between">
        <Heading level={1}>Invoices</Heading>
        <Button
          label="New invoice"
          variant="primary"
          onClick={() => {
            void navigate('new');
          }}
        />
      </HStack>

      <HStack gap={2} align="end">
        <TextInput
          label="Search"
          isLabelHidden
          placeholder="Search by number or client"
          value={search}
          onChange={setSearch}
        />
        <Selector
          label="Status"
          isLabelHidden
          placeholder="All statuses"
          options={STATUS_OPTIONS}
          value={status}
          hasClear
          onChange={(value) => {
            setStatus((value as InvoiceStatus) || null);
          }}
        />
        <Text type="supporting">{total} invoice(s)</Text>
      </HStack>

      {error ? <Banner status="error" title={error} isDismissable /> : null}

      {invoices === null ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading invoices" />
        </VStack>
      ) : rows.length === 0 ? (
        <EmptyState
          title={search || status ? 'No invoices match' : 'No invoices yet'}
          description={
            search || status
              ? 'Try clearing the search or the status filter.'
              : 'Create your first invoice to get started.'
          }
          headingLevel={2}
        />
      ) : (
        <Table<InvoiceTableRow>
          data={rows}
          idKey="id"
          hasHover
          columns={[
            { key: 'number', header: 'Number', width: pixel(130) },
            { key: 'clientName', header: 'Client', width: proportional(2) },
            { key: 'issueDate', header: 'Issued', width: pixel(110) },
            { key: 'dueDate', header: 'Due', width: pixel(110) },
            {
              key: 'status',
              header: 'Status',
              width: pixel(110),
              renderCell: (row: InvoiceTableRow) =>
                isEffectivelyOverdue(row.invoice) ? (
                  <Badge variant="error" label="overdue" />
                ) : (
                  <Text type="supporting">{row.invoice.status}</Text>
                ),
            },
            { key: 'total', header: 'Total', width: pixel(130), align: 'end' },
            {
              key: 'actions',
              header: '',
              width: pixel(90),
              renderCell: (row: InvoiceTableRow) => (
                <Button
                  label="Open"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void navigate(row.id);
                  }}
                />
              ),
            },
          ]}
        />
      )}
    </VStack>
  );
}
