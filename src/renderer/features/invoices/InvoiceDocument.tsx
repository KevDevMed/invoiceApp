/**
 * The rendered invoice document — the "paper" both the invoice detail view and
 * the live editor preview put on screen.
 *
 * Pure presentation: it takes a model built by `buildDocumentModel` and renders
 * it. No IPC, no effects, no router hooks, so the same component serves a saved
 * invoice and a draft that is still being typed. Section order mirrors the PDF
 * template in src/main/pdf/invoice-template.ts, so screen and export tell the
 * same story.
 *
 * The document is *paper*: a physical object that is light in dark mode too,
 * because that is what the recipient receives and what the PDF prints. It gets
 * there without a single literal colour — `color-scheme: light` on the sheet
 * makes every `light-dark()` token underneath it resolve to its light value, so
 * the paper is the theme's own light palette rather than a second set of hex
 * codes that would drift from it.
 */

import { useMemo } from 'react';

import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import type { TablePlugin } from '@astryxdesign/core/Table';
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
  /**
   * The document line the user is editing right now (`model.lines[n].key`), or
   * null when nothing is being edited. The editor passes it so the keystroke can
   * be seen landing in the document — the row lights up on the paper as it is
   * typed, which is what makes the preview feel like the same object as the
   * form rather than a delayed copy of it.
   */
  readonly activeLineKey?: string | null;
}

export function InvoiceDocument({
  model,
  activeLineKey = null,
}: InvoiceDocumentProps): React.JSX.Element {
  const rows: LineRow[] = model.lines.map((line) => ({
    key: line.key,
    description: line.description,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    amount: line.amount,
  }));

  /**
   * Row-level highlight through the table's own plugin pipeline: the column
   * budgets below were tuned to stop Amount clipping off the edge of the
   * preview, and re-hand-rolling the table in children mode to paint one `<tr>`
   * would put those back in play for no gain.
   */
  const highlight = useMemo<Record<string, TablePlugin<LineRow>>>(
    () => ({
      activeLine: {
        transformBodyRow: (props, item) =>
          item.key === activeLineKey
            ? {
                ...props,
                htmlProps: {
                  ...props.htmlProps,
                  style: {
                    ...props.htmlProps.style,
                    background: 'var(--color-background-yellow)',
                  },
                },
              }
            : props,
      },
    }),
    [activeLineKey],
  );

  return (
    // `colorScheme` is the sheet's one piece of physical-object styling: see the
    // file header. Everything inside it stays on tokens.
    <Card padding={6} style={{ colorScheme: 'light' }}>
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
          plugins={highlight}
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
