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

import { SHELL_GUTTER_STEP } from '../../chrome';
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

/**
 * Width of the activity date gutter — the column that keeps `9 Jul` aligned.
 * Sized for `shortDate`'s widest output, not its commonest: a date outside the
 * current year carries its year (`15 Aug 2025`), and at the mockup's 52px that
 * wrapped onto two lines and broke the alignment the gutter exists to hold.
 */
const ACTIVITY_GUTTER = 76;
/** Line-item column widths, in the mockup's proportions. */
const QTY_WIDTH = 64;
const RATE_WIDTH = 108;
const AMOUNT_WIDTH = 120;

/**
 * The tones this mapping can paint. `accent` is not a pane tone — the pane has
 * no "coming up soon" state — but design 3a's list marks a due-soon row in the
 * accent hue, and one mapping from tone to token is the whole point of this
 * function, so it lives here rather than being re-derived next door.
 */
export type RowToneName = PaneTone | 'accent';

interface ToneColours {
  /** A large tinted surface: a banner, a sticky group header. Opaque. */
  readonly wash: string;
  /** A small tinted block — the monogram — where the tint has to be seen. */
  readonly chip: string;
  readonly border: string;
  readonly text: string;
  /** The one saturated line in the tone: the dot, the bar, the rule. */
  readonly accent: string;
  readonly dot: 'error' | 'warning' | 'success' | 'neutral';
}

/**
 * How far the tone's accent is mixed into the surface underneath it.
 *
 * `--color-background-red` and friends are a 20% alpha wash of a fully
 * saturated hue. Over a dark surface that lands where the mockup did; over a
 * *white* one it composites to a flat pink slab (`#F9D1D8`) that owns the
 * screen and drowns everything written on it. The mockup's own value was
 * `#1c1414` on `#121212` — about a 7% shift, a warmth you notice without
 * reading it, with the urgency carried by the hairline, the dot and the text.
 *
 * So the tint is mixed rather than layered: a small percentage of the *opaque*
 * accent into whichever surface is behind it. `color-mix` resolves after
 * `light-dark()` has picked the mode's values, so one number is correct in
 * both — 7% of `#E3193B` into white is `#FDEFF1`, 7% of `#F5394F` into
 * `#1F1F22` is `#302126`, and both are the same barely-perceptible warm shift.
 */
const WASH_STRENGTH = '7%';
/** The monogram is 36px square; at wash strength the tint would not register. */
const CHIP_STRENGTH = '22%';
/** Enough hue in the hairline to read as a warm edge, not as a red rule. */
const EDGE_STRENGTH = '35%';

function mix(accent: string, strength: string, over: string): string {
  return `color-mix(in srgb, ${accent} ${strength}, ${over})`;
}

/**
 * The theme has no "overdue" colour; it has semantic red/yellow/green families
 * that read correctly in both modes. This is the one place that maps a triage
 * tone onto them, so light mode never inherits a mockup's dark-mode hex.
 *
 * `over` is the surface the tint will sit on, so a banner inside a card and a
 * sticky header over the list both composite against the right thing.
 */
export function toneColours(
  tone: RowToneName,
  over = 'var(--color-background-surface)',
): ToneColours {
  const build = (accent: string, text: string, dot: ToneColours['dot']): ToneColours => ({
    wash: mix(accent, WASH_STRENGTH, over),
    chip: mix(accent, CHIP_STRENGTH, over),
    border: mix(accent, EDGE_STRENGTH, 'var(--color-border-emphasized)'),
    text,
    accent,
    dot,
  });

  switch (tone) {
    case 'error':
      return build('var(--color-border-red)', 'var(--color-text-red)', 'error');
    case 'warning':
      return build('var(--color-border-yellow)', 'var(--color-text-yellow)', 'warning');
    case 'success':
      return build('var(--color-border-green)', 'var(--color-text-green)', 'success');
    case 'accent':
      // `dot` names one of `StatusDot`'s four semantic variants and there is no
      // accent among them; a due-soon row is not a warning, so it takes the
      // neutral variant and carries its blue in the chip, the text and the wash.
      return build('var(--color-border-blue)', 'var(--color-text-blue)', 'neutral');
    case 'neutral':
      return {
        wash: mix('var(--color-text-primary)', WASH_STRENGTH, over),
        chip: mix('var(--color-text-primary)', CHIP_STRENGTH, over),
        border: 'var(--color-border)',
        text: 'var(--color-text-secondary)',
        accent: 'var(--color-text-secondary)',
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
        paddingInline={SHELL_GUTTER_STEP}
        paddingBlock={4}
        style={{ borderBlockEnd: '1px solid var(--color-border)' }}
      >
        {/* Wraps rather than overflows: at the app's minimum window the pane is
            ~448px wide and the position/K/J/⋯ cluster has to fall to its own
            line instead of hanging off the right edge. */}
        <HStack justify="between" align="start" gap={4} wrap="wrap">
          <HStack gap={3} align="center" style={{ minInlineSize: 0, flex: '1 1 auto' }}>
            <HStack
              align="center"
              justify="center"
              width="var(--size-element-lg)"
              height="var(--size-element-lg)"
              style={{
                flex: 'none',
                borderRadius: 'var(--radius-element)',
                background: toneColours(identity.tone).chip,
              }}
            >
              <Text type="supporting" weight="semibold" style={{ color: toneColours(identity.tone).text }}>
                {identity.monogram}
              </Text>
            </HStack>
            <VStack gap={0.5} style={{ minInlineSize: 0 }}>
              <Heading level={headingLevel} maxLines={1}>
                {identity.clientName}
              </Heading>
              <Text type="supporting" maxLines={1}>
                {identity.reference}
              </Text>
            </VStack>
          </HStack>
          <HStack gap={2} align="center" style={{ flex: 'none' }}>
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
            with the two spans drawn to scale against each other. The surface is
            only just warm (see WASH_STRENGTH); the urgency is in the hairline,
            the dot, the headline and the overdue half of the bar. */}
        <VStack
          gap={2}
          padding={3}
          style={{
            background: tone.wash,
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
              <Text type="supporting" style={{ color: 'var(--color-text-secondary)' }}>
                {`· ${timeline.detail}`}
              </Text>
            )}
          </HStack>
          {/* Two segments, one span, and a notch of bare track between them so
              the due date is a boundary you can see rather than a change of
              shade you have to look for. The widths are flex-grow ratios, so
              the notch comes out of the bar instead of pushing past its end. */}
          {timeline.hasProgress ? (
            <HStack
              gap={0.5}
              height="var(--spacing-1-5)"
              style={{
                borderRadius: 'var(--radius-full)',
                overflow: 'hidden',
                background: 'var(--color-overlay-pressed)',
              }}
            >
              <StackItem
                style={{
                  flex: `${String(timeline.elapsedPercent)} 1 0`,
                  background:
                    timeline.tone === 'success' ? tone.accent : 'var(--color-text-secondary)',
                }}
              >
                {null}
              </StackItem>
              {timeline.overduePercent === 0 ? null : (
                <StackItem
                  style={{
                    flex: `${String(timeline.overduePercent)} 1 0`,
                    background: tone.accent,
                  }}
                >
                  {null}
                </StackItem>
              )}
            </HStack>
          ) : null}
          <HStack justify="between" gap={2} wrap="wrap">
            {timeline.axis.map((entry, index) => (
              <Text
                key={entry}
                type="supporting"
                hasTabularNumbers
                style={{
                  // "today" is the end of the axis and the only entry that
                  // carries the tone; the rest are dates, not accusations.
                  color:
                    index === timeline.axis.length - 1 && timeline.axis.length > 1
                      ? tone.text
                      : 'var(--color-text-secondary)',
                }}
              >
                {entry}
              </Text>
            ))}
          </HStack>
        </VStack>
      </VStack>

      <StackItem size="fill" isScrollable>
        <VStack gap={5} paddingInline={SHELL_GUTTER_STEP} paddingBlock={4}>
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
                    // Not `disabled`: "pays 128 days late" is the fact that
                    // decides how hard you chase, and it was reading fainter
                    // than the link beside it in both themes.
                    <Text type="supporting" color="secondary">
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
              // Qty, rate and amount are fixed columns; when the pane is at its
              // narrowest the table scrolls inside its own box rather than
              // pushing the whole content region sideways.
              <StackItem style={{ minInlineSize: 0, overflowX: 'auto' }}>
                <Table<LineRow>
                  data={lineRows}
                  columns={lineColumns}
                  idKey="key"
                  density="compact"
                  dividers="rows"
                  textOverflow="truncate"
                />
              </StackItem>
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
                      style={{
                        display: 'inline-block',
                        inlineSize: `${String(ACTIVITY_GUTTER)}px`,
                        whiteSpace: 'nowrap',
                      }}
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
        paddingInline={SHELL_GUTTER_STEP}
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
