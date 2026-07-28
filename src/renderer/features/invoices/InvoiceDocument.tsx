/**
 * The rendered invoice document — the "paper" both the invoice detail view and
 * the live editor preview put on screen.
 *
 * Pure presentation: it takes a model built by `buildDocumentModel` and renders
 * it. No IPC, no effects, no router hooks, so the same component serves a saved
 * invoice and a draft that is still being typed. Section order mirrors the PDF
 * template in src/main/pdf/invoice-template.ts, so screen and export tell the
 * same story.
 */

import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';

import type { InvoiceStatus } from '../../../shared/types';
import type { DocumentParty, InvoiceDocumentModel } from './document';

/** Width of the right-aligned totals column, in px — a budgeted region, not styling. */
const TOTALS_WIDTH = 280;

/** Budgeted widths for the line table's numeric columns, in px. */
const QTY_WIDTH = 64;
const MONEY_WIDTH = 104;

interface LineRow extends Record<string, unknown> {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

function statusBadge(status: InvoiceStatus): React.JSX.Element {
  switch (status) {
    case 'paid':
      return <Badge variant="green" label="paid" />;
    case 'sent':
      return <Badge variant="blue" label="sent" />;
    case 'overdue':
      return <Badge variant="red" label="overdue" />;
    case 'void':
      return <Badge variant="orange" label="void" />;
    default:
      return <Badge variant="neutral" label="draft" />;
  }
}

function PartyBlock({
  heading,
  party,
}: {
  readonly heading: string;
  readonly party: DocumentParty | null;
}): React.JSX.Element {
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {heading}
      </Text>
      {party ? (
        <>
          <Text weight="medium">{party.name}</Text>
          {party.address ? (
            <Text type="supporting">{party.address}</Text>
          ) : null}
          {party.taxId ? <Text type="supporting">Tax ID: {party.taxId}</Text> : null}
        </>
      ) : (
        <Text type="supporting" color="placeholder">
          No client selected yet
        </Text>
      )}
    </VStack>
  );
}

function TotalRow({
  label,
  value,
  isEmphasised = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly isEmphasised?: boolean;
}): React.JSX.Element {
  return (
    <HStack gap={2} vAlign="center">
      <StackItem size="fill">
        <Text type={isEmphasised ? 'body' : 'supporting'} weight={isEmphasised ? 'semibold' : undefined}>
          {label}
        </Text>
      </StackItem>
      <Text
        type={isEmphasised ? 'body' : 'supporting'}
        weight={isEmphasised ? 'semibold' : undefined}
        hasTabularNumbers
      >
        {value}
      </Text>
    </HStack>
  );
}

export interface InvoiceDocumentProps {
  readonly model: InvoiceDocumentModel;
}

export function InvoiceDocument({ model }: InvoiceDocumentProps): React.JSX.Element {
  const rows: LineRow[] = model.lines.map((line) => ({
    key: line.key,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
  }));

  return (
    <Card padding={6}>
      <VStack gap={5}>
        <HStack gap={3} vAlign="start" wrap="wrap">
          <StackItem size="fill">
            <HStack gap={2} vAlign="center">
              <Avatar size="md" name={model.billedBy.name} />
              <Text type="label" color="secondary">
                {model.billedBy.name}
              </Text>
            </HStack>
          </StackItem>
          <VStack gap={1} hAlign="end">
            <Heading level={2}>Invoice</Heading>
            <Text type="supporting" hasTabularNumbers>
              {model.number}
            </Text>
            {statusBadge(model.status)}
          </VStack>
        </HStack>

        <Divider />

        <MetadataList columns={3} label={{ position: 'top' }}>
          <MetadataListItem label="Issue date">
            <Text type="body">{model.issueDate}</Text>
          </MetadataListItem>
          <MetadataListItem label="Due date">
            <Text type="body">{model.dueDate}</Text>
          </MetadataListItem>
          <MetadataListItem label="Payment terms">
            <Text type="body">{model.paymentTerms}</Text>
          </MetadataListItem>
        </MetadataList>

        <HStack gap={6} wrap="wrap" vAlign="start">
          <StackItem size="fill">
            <PartyBlock heading="Billed by" party={model.billedBy} />
          </StackItem>
          <StackItem size="fill">
            <PartyBlock heading="Billed to" party={model.billedTo} />
          </StackItem>
        </HStack>

        <Table<LineRow>
          data={rows}
          idKey="key"
          density="compact"
          columns={[
            // Only the description flexes. `proportional(n)` carries a 120px
            // minimum per column, and four of those overflow the editor's
            // preview panel, clipping Amount off the right edge — so the three
            // numeric columns are budgeted in px instead.
            { key: 'description', header: 'Item', width: proportional(1) },
            { key: 'quantity', header: 'Qty', width: pixel(QTY_WIDTH), align: 'end' },
            { key: 'unitPrice', header: 'Unit price', width: pixel(MONEY_WIDTH), align: 'end' },
            { key: 'amount', header: 'Amount', width: pixel(MONEY_WIDTH), align: 'end' },
          ]}
        />

        <HStack>
          <StackItem size="fill" />
          <VStack gap={1} width={TOTALS_WIDTH}>
            <TotalRow label="Subtotal" value={model.subtotal} />
            <TotalRow label={model.taxLabel} value={model.tax} />
            <Divider />
            <TotalRow label="Total" value={model.total} isEmphasised />
          </VStack>
        </HStack>

        {model.notes !== null ? (
          <VStack gap={1}>
            <Divider />
            <Text type="label" color="secondary">
              Notes
            </Text>
            <Text type="supporting">{model.notes}</Text>
          </VStack>
        ) : null}
      </VStack>
    </Card>
  );
}
