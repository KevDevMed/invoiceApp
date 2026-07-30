/**
 * The invoice pane: one invoice, rendered in full, with the chase actions
 * pinned to the bottom.
 *
 * There is exactly one of these. The cockpit (`InvoiceList`) puts it on the
 * right of the list; `/invoices/:id` (`InvoiceDetail`) puts it on its own,
 * which is what a tab or a deep link opens. Both hosts pass the same props, so
 * the two screens cannot drift — the whole reason the previous detail page's
 * separate stat-tile layout was retired rather than kept alongside this.
 *
 * Every derived string comes from ./listPane; this file is layout. The elements
 * of the mockup that had no data behind them (reminders sent, reminder cadence,
 * next automatic reminder, "viewed" events, a second currency) are not rendered
 * as empty shells — they are absent, and ./listPane's header says why.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Table, pixel } from '@astryxdesign/core/Table';
import type { TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';

import type { Invoice, InvoiceStatus, InvoiceWithItems } from '../../../shared/types';
import { buildNotesSections } from './detail';
import {
  buildPaneActivity,
  buildPaneFacts,
  buildPaneIdentity,
  buildPaneLines,
  buildPaneTimeline,
} from './listPane';
import type { PaneTone } from './listPane';

/** Width of the activity date gutter — the column that keeps `9 Jul` aligned. */
const ACTIVITY_GUTTER = 52;
/** Line-item column widths, in the mockup's proportions. */
const QTY_WIDTH = 64;
const RATE_WIDTH = 108;
const AMOUNT_WIDTH = 120;

interface ToneColours {
  readonly background: string;
  readonly border: string;
  readonly text: string;
  readonly dot: 'error' | 'warning' | 'success' | 'neutral';
}

/**
 * The theme has no "overdue" colour; it has semantic red/yellow/green families
 * that read correctly in both modes. This is the one place that maps a triage
 * tone onto them, so light mode never inherits a mockup's dark-mode hex.
 */
export function toneColours(tone: PaneTone): ToneColours {
  switch (tone) {
    case 'error':
      return {
        background: 'var(--color-background-red)',
        border: 'var(--color-border-red)',
        text: 'var(--color-text-red)',
        dot: 'error',
      };
    case 'warning':
      return {
        background: 'var(--color-background-yellow)',
        border: 'var(--color-border-yellow)',
        text: 'var(--color-text-yellow)',
        dot: 'warning',
      };
    case 'success':
      return {
        background: 'var(--color-background-green)',
        border: 'var(--color-border-green)',
        text: 'var(--color-text-green)',
        dot: 'success',
      };
    case 'neutral':
      return {
        background: 'var(--color-background-muted)',
        border: 'var(--color-border)',
        text: 'var(--color-text-secondary)',
        dot: 'neutral',
      };
  }
}

interface LineRow extends Record<string, unknown> {
  key: string;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
}

export interface PanePosition {
  /** 1-based place in the flattened list. */
  readonly index: number;
  readonly total: number;
}

export interface InvoicePaneProps {
  readonly invoice: InvoiceWithItems;
  /**
   * Every invoice of this invoice's client. Null when the host has not fetched
   * them — the Client balance fact is then not shown rather than shown as zero.
   */
  readonly clientInvoices: readonly Invoice[] | null;
  readonly today: string;
  /** 1 when the pane is the page (deep link), 2 when the page is the cockpit. */
  readonly headingLevel: 1 | 2;
  readonly position: PanePosition | null;
  /** `K` / `J`. Null in hosts where there is no list to move through. */
  readonly onPrevious: (() => void) | null;
  readonly onNext: (() => void) | null;
  /** Narrows the list to this client. Null when the host cannot filter. */
  readonly onShowClientInvoices: (() => void) | null;
  /** Opens this invoice on its own route, which is what puts it in a tab. */
  readonly onOpenInTab: (() => void) | null;
  /** The host keeps its own copy of the row; a status change has to reach it. */
  readonly onInvoiceChanged: (invoice: Invoice) => void;
}

export function InvoicePane({
  invoice,
  clientInvoices,
  today,
  headingLevel,
  position,
  onPrevious,
  onNext,
  onShowClientInvoices,
  onOpenInTab,
  onInvoiceChanged,
}: InvoicePaneProps): React.JSX.Element {
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Actions await an IPC round trip and the selection can move underneath them,
  // so every state write is gated on the invoice still being the one on screen.
  const shownIdRef = useRef(invoice.id);
  useEffect(() => {
    shownIdRef.current = invoice.id;
    setActionError(null);
    setNotice(null);
  }, [invoice.id]);

  const identity = buildPaneIdentity(invoice, today);
  const timeline = buildPaneTimeline(invoice, today);
  const facts = buildPaneFacts({ invoice, clientInvoices, today });
  const lines = buildPaneLines(invoice);
  const activity = buildPaneActivity(invoice, today);
  const notes = buildNotesSections(
    invoice.notes,
    invoice.client?.name ?? null,
    invoice.client?.notes ?? null,
  );
  const tone = toneColours(timeline.tone);

  const changeStatus = useCallback(
    async (next: InvoiceStatus): Promise<void> => {
      const requestedId = invoice.id;
      setActionError(null);
      setNotice(null);
      setIsBusy(true);
      try {
        const updated = await window.api.invoke('invoices:setStatus', { id: requestedId, status: next });
        if (shownIdRef.current !== requestedId) return;
        onInvoiceChanged(updated);
        setNotice(`Marked ${updated.status}.`);
      } catch (cause) {
        if (shownIdRef.current !== requestedId) return;
        setActionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setIsBusy(false);
      }
    },
    [invoice.id, onInvoiceChanged],
  );

  const exportPdf = useCallback(async (): Promise<void> => {
    const requestedId = invoice.id;
    setActionError(null);
    setNotice(null);
    setIsBusy(true);
    try {
      const result = await window.api.invoke('invoices:exportPdf', { id: requestedId });
      if (shownIdRef.current !== requestedId) return;
      if (result.path === '') return; // the user closed the save dialog
      setNotice(`PDF written to ${result.path}.`);
    } catch (cause) {
      // DESKTOP_ONLY in the browser preview: an inline banner, never a crash.
      if (shownIdRef.current !== requestedId) return;
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsBusy(false);
    }
  }, [invoice.id]);

  const lineRows: LineRow[] = lines.rows.map((row) => ({
    key: row.key,
    description: row.description,
    quantity: row.quantity,
    rate: lines.rates.get(row.key) ?? '',
    amount: row.amount,
  }));

  const lineColumns: TableColumn<LineRow>[] = [
    { key: 'description', header: 'Description' },
    { key: 'quantity', header: 'Qty', width: pixel(QTY_WIDTH), align: 'end' },
    { key: 'rate', header: 'Rate', width: pixel(RATE_WIDTH), align: 'end' },
    { key: 'amount', header: 'Amount', width: pixel(AMOUNT_WIDTH), align: 'end' },
  ];

  const menuItems: DropdownMenuOption[] = [
    ...(onOpenInTab === null
      ? []
      : [{ label: 'Open in its own tab', onClick: onOpenInTab }]),
    { label: 'Export PDF…', onClick: () => void exportPdf() },
    ...(invoice.status === 'void'
      ? []
      : [{ type: 'divider' } as DropdownMenuOption, { label: 'Mark void', onClick: () => void changeStatus('void') }]),
  ];

  return (
    <VStack height="100%" gap={0}>
      <VStack
        gap={3}
        paddingInline={5}
        paddingBlock={4}
        style={{ borderBlockEnd: '1px solid var(--color-border)' }}
      >
        <HStack justify="between" align="start" gap={4}>
          <HStack gap={3} align="center">
            <HStack
              align="center"
              justify="center"
              width="var(--size-element-lg)"
              height="var(--size-element-lg)"
              style={{
                flex: 'none',
                borderRadius: 'var(--radius-element)',
                background: toneColours(identity.tone).background,
              }}
            >
              <Text type="supporting" weight="semibold" style={{ color: toneColours(identity.tone).text }}>
                {identity.monogram}
              </Text>
            </HStack>
            <VStack gap={0.5}>
              <Heading level={headingLevel} maxLines={1}>
                {identity.clientName}
              </Heading>
              <Text type="supporting" maxLines={1}>
                {identity.reference}
              </Text>
            </VStack>
          </HStack>
          <HStack gap={2} align="center">
            {position === null ? null : (
              <Text type="supporting" hasTabularNumbers>
                {`${String(position.index)} of ${String(position.total)}`}
              </Text>
            )}
            {onPrevious === null ? null : (
              <Button
                label="K ↑"
                variant="secondary"
                size="sm"
                aria-label="Previous invoice (K)"
                onClick={onPrevious}
              />
            )}
            {onNext === null ? null : (
              <Button
                label="J ↓"
                variant="secondary"
                size="sm"
                aria-label="Next invoice (J)"
                onClick={onNext}
              />
            )}
            <MoreMenu label="More invoice actions" size="sm" items={menuItems} />
          </HStack>
        </HStack>

        {/* The status banner is a timeline, not a label: issued -> due -> today,
            with the two spans drawn to scale against each other. */}
        <VStack
          gap={2}
          padding={3}
          style={{
            background: tone.background,
            border: `1px solid ${tone.border}`,
            borderRadius: 'var(--radius-container)',
          }}
        >
          <HStack gap={2} align="center" wrap="wrap">
            <StatusDot variant={tone.dot} label={timeline.headline} />
            <Text weight="semibold" style={{ color: tone.text }}>
              {timeline.headline}
            </Text>
            {timeline.detail === null ? null : (
              <Text type="supporting" style={{ color: tone.text }}>
                {`· ${timeline.detail}`}
              </Text>
            )}
          </HStack>
          <HStack
            gap={0}
            height="var(--spacing-1)"
            style={{
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
              background: 'var(--color-background-muted)',
            }}
          >
            <StackItem
              style={{
                inlineSize: `${String(timeline.elapsedPercent)}%`,
                background: 'var(--color-text-primary)',
              }}
            >
              {null}
            </StackItem>
            <StackItem
              style={{
                inlineSize: `${String(timeline.overduePercent)}%`,
                background: 'var(--color-error)',
              }}
            >
              {null}
            </StackItem>
          </HStack>
          <HStack justify="between" gap={2} wrap="wrap">
            {timeline.axis.map((entry) => (
              <Text key={entry} type="supporting" hasTabularNumbers style={{ color: tone.text }}>
                {entry}
              </Text>
            ))}
          </HStack>
        </VStack>
      </VStack>

      <StackItem size="fill" isScrollable>
        <VStack gap={5} paddingInline={5} paddingBlock={4}>
          <Grid columns={{ minWidth: 150, max: 3 }} gap={4}>
            {facts.map((fact) => (
              <VStack key={fact.key} gap={0.5}>
                <Text type="supporting">{fact.caption}</Text>
                <Text
                  type={fact.isEmphasised ? 'display-3' : 'large'}
                  weight="semibold"
                  hasTabularNumbers
                >
                  {fact.value}
                </Text>
                <HStack gap={1} align="center" wrap="wrap">
                  {fact.sub === null ? null : fact.key === 'client' &&
                    onShowClientInvoices !== null ? (
                    <Button
                      label={fact.sub}
                      variant="ghost"
                      size="sm"
                      onClick={onShowClientInvoices}
                    />
                  ) : (
                    <Text type="supporting">{fact.sub}</Text>
                  )}
                  {fact.note === null ? null : (
                    <Text type="supporting" color="disabled">
                      {fact.note}
                    </Text>
                  )}
                </HStack>
              </VStack>
            ))}
          </Grid>

          <VStack
            gap={0}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-container)',
              overflow: 'hidden',
            }}
          >
            {lineRows.length === 0 ? (
              <HStack padding={3}>
                <Text type="supporting">This invoice has no line items.</Text>
              </HStack>
            ) : (
              <Table<LineRow>
                data={lineRows}
                columns={lineColumns}
                idKey="key"
                density="compact"
                dividers="rows"
                textOverflow="truncate"
              />
            )}
            <HStack
              gap={5}
              justify="end"
              align="center"
              paddingInline={3}
              paddingBlock={2}
              style={{
                background: 'var(--color-background-muted)',
                borderBlockStart: '1px solid var(--color-border)',
              }}
            >
              <Text type="supporting">Total</Text>
              <Text weight="semibold" hasTabularNumbers>
                {lines.total}
              </Text>
            </HStack>
          </VStack>

          <VStack gap={2}>
            <Text type="label" color="secondary">
              Activity
            </Text>
            <VStack gap={1.5}>
              {activity.map((entry) => (
                <HStack key={entry.key} gap={3} align="start">
                  <StackItem>
                    <Text
                      type="supporting"
                      hasTabularNumbers
                      color="disabled"
                      style={{ display: 'inline-block', inlineSize: `${String(ACTIVITY_GUTTER)}px` }}
                    >
                      {entry.date}
                    </Text>
                  </StackItem>
                  <Text type="supporting">{entry.text}</Text>
                </HStack>
              ))}
            </VStack>
          </VStack>

          {notes.map((section) => (
            <VStack key={section.key} gap={1}>
              <Text type="label" color="secondary">
                {section.heading}
              </Text>
              <Text type="supporting" display="block">
                {section.body}
              </Text>
            </VStack>
          ))}
        </VStack>
      </StackItem>

      {actionError === null ? null : (
        <Banner status="error" title={actionError} isDismissable onDismiss={() => setActionError(null)} />
      )}
      {notice === null ? null : (
        <Banner status="success" title={notice} isDismissable onDismiss={() => setNotice(null)} />
      )}

      <HStack
        gap={2}
        justify="end"
        align="center"
        paddingInline={5}
        paddingBlock={3}
        style={{
          background: 'var(--color-background-muted)',
          borderBlockStart: '1px solid var(--color-border)',
        }}
      >
        <Button
          label="Edit"
          variant="secondary"
          onClick={() => void navigate(`/invoices/${invoice.id}/edit`)}
        />
        {invoice.status === 'draft' ? (
          <Button
            label="Mark sent"
            variant="secondary"
            isDisabled={isBusy}
            onClick={() => void changeStatus('sent')}
          />
        ) : invoice.status === 'paid' || invoice.status === 'void' ? null : (
          <Button
            label="Mark paid"
            variant="secondary"
            isDisabled={isBusy}
            onClick={() => void changeStatus('paid')}
          />
        )}
        {/* The mockup's primary action is `Send reminder`. Nothing in this app
            can send anything — there is no mail transport and no channel for
            one — so the primary action is the chase step it *can* perform. */}
        <Button
          label="Export PDF"
          variant="primary"
          isDisabled={isBusy}
          onClick={() => void exportPdf()}
        />
      </HStack>
    </VStack>
  );
}
