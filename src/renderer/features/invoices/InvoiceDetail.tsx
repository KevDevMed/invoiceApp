/**
 * Read-only invoice detail: the numbers on the left, the rendered document on
 * the right, and a tab bar that switches the left column only.
 *
 * A thin renderer over ./detail — every derived number (open amount, days past
 * due, the client's average payment delay, the history timeline) is built by a
 * pure function there, because the vitest project is `environment: 'node'` and
 * cannot mount React. The document on the right is the same `InvoiceDocument`
 * the editor previews, so the two screens can never drift apart.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Layout';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';

import type { Invoice, InvoiceStatus, InvoiceWithItems } from '../../../shared/types';
import { SETTINGS_KEYS } from '../../../shared/types';
import { Page, PageHeader } from '../../ui/Page';
import {
  averagePaymentDelayDays,
  buildHistoryEvents,
  buildLineSummary,
  buildNotesSections,
  buildStatTiles,
  buildStatusView,
} from './detail';
import { buildDocumentModel } from './document';
import { InvoiceDocument } from './InvoiceDocument';
import { STATUS_OPTIONS, isEffectivelyOverdue, todayIso } from './format';

/** Widest the two columns are allowed to get: the document needs ~600px to read as paper. */
const DETAIL_MAX_WIDTH = 1360;
/** Below this per-column width the Grid drops to one column, so nothing squashes. */
const COLUMN_MIN_WIDTH = 420;
/** Page size for the sibling-invoice sweep behind the average-delay tile. */
const SIBLING_PAGE_SIZE = 200;

type DetailTab = 'invoice' | 'history' | 'notes';

interface DetailData {
  readonly invoice: InvoiceWithItems;
  readonly business: { readonly name: string | null; readonly address: string | null };
  /**
   * Null when the client has no *other* paid invoice than this one, or when
   * the sweep failed.
   */
  readonly averageDelayDays: number | null;
}

/** Every paid invoice of one client, paged out so the mean is over the whole set. */
async function fetchPaidSiblings(clientId: string): Promise<Invoice[]> {
  const items: Invoice[] = [];
  let total = 0;
  do {
    const result = await window.api.invoke('invoices:list', {
      clientId,
      status: 'paid',
      limit: SIBLING_PAGE_SIZE,
      offset: items.length,
    });
    if (result.items.length === 0) break;
    items.push(...result.items);
    total = result.total;
  } while (items.length < total);
  return items;
}

function StatTileCard({
  label,
  value,
  isEmphasised,
}: {
  readonly label: string;
  readonly value: string;
  readonly isEmphasised: boolean;
}): React.JSX.Element {
  return (
    <Card padding={4} variant={isEmphasised ? 'default' : 'muted'}>
      <VStack gap={1}>
        {/* Two lines, not one: at three columns a 1440px page gives each tile
            ~175px, which clips "Other invoices av delay" to an ellipsis. The
            label wraps instead; the row stretches all six tiles together. */}
        <Text type="label" color="secondary" maxLines={2}>
          {label}
        </Text>
        {/* The headline number is never truncated: its tile spans the whole
            row (see GridSpan below), so `€1,234,567.89` at display-3 has room
            at both column widths. maxLines stays off it — an ellipsis on the
            most important figure on the page is worse than any overflow. */}
        <Text
          type={isEmphasised ? 'display-3' : 'large'}
          weight={isEmphasised ? 'bold' : 'semibold'}
          hasTabularNumbers
          maxLines={isEmphasised ? 0 : 1}
        >
          {value}
        </Text>
      </VStack>
    </Card>
  );
}

function SummaryRow({
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

export function InvoiceDetail(): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [data, setData] = useState<DetailData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('invoice');

  // Which invoice the screen is actually showing right now. Actions await an
  // IPC round trip and the route can change underneath them, so every state
  // write below is gated on this — the same guarantee the load effect gets
  // from its `cancelled` flag, which only covers the load.
  const currentIdRef = useRef<string | undefined>(id);
  useEffect(() => {
    currentIdRef.current = id;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Drop the previous invoice before fetching the next one, so navigating
      // between two detail pages shows the spinner rather than stale numbers.
      // The action banners go with it: "Status changed to paid." is about the
      // invoice that was on screen, not the one arriving.
      setData(null);
      setLoadError(null);
      setActionError(null);
      setNotice(null);
      if (id === undefined) {
        setLoadError('This invoice no longer exists.');
        return;
      }
      try {
        const [invoice, nameRow, addressRow] = await Promise.all([
          window.api.invoke('invoices:get', { id }),
          window.api.invoke('settings:get', { key: SETTINGS_KEYS.businessName }),
          window.api.invoke('settings:get', { key: SETTINGS_KEYS.businessAddress }),
        ]);
        if (cancelled) return;
        if (!invoice) {
          setLoadError('This invoice no longer exists.');
          return;
        }
        // The delay tile is a nice-to-have: a failed sweep leaves it blank
        // rather than taking the whole page down with it.
        let averageDelayDays: number | null = null;
        try {
          averageDelayDays = averagePaymentDelayDays(
            await fetchPaidSiblings(invoice.clientId),
            invoice.id,
          );
        } catch {
          averageDelayDays = null;
        }
        if (cancelled) return;
        setData({
          invoice,
          business: { name: nameRow.value, address: addressRow.value },
          averageDelayDays,
        });
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const invoice = data?.invoice ?? null;

  const documentModel = useMemo(() => {
    if (!invoice || !data) return null;
    return buildDocumentModel({
      number: invoice.number,
      status: invoice.status,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      taxRateBps: invoice.taxRateBps,
      notes: invoice.notes,
      items: invoice.items.map((item) => ({
        description: item.description,
        quantityMilli: item.quantityMilli,
        unitPriceCents: item.unitPriceCents,
      })),
      totals: {
        subtotalCents: invoice.subtotalCents,
        taxCents: invoice.taxCents,
        totalCents: invoice.totalCents,
      },
      client: invoice.client,
      business: data.business,
    });
  }, [invoice, data]);

  const changeStatus = async (next: InvoiceStatus): Promise<void> => {
    const requestedId = id;
    if (requestedId === undefined) return;
    setActionError(null);
    setNotice(null);
    try {
      const updated = await window.api.invoke('invoices:setStatus', {
        id: requestedId,
        status: next,
      });
      // Navigating away mid-flight would otherwise write this invoice's status
      // onto whichever row the page moved on to.
      if (currentIdRef.current !== requestedId) return;
      setData((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              invoice: {
                ...prev.invoice,
                status: updated.status,
                paidAt: updated.paidAt,
                updatedAt: updated.updatedAt,
              },
            },
      );
      // No sibling re-sweep: `averageDelayDays` is the mean over the client's
      // *other* paid invoices, and none of those rows changed here. Paying
      // this invoice cannot move a number it is excluded from.
      setNotice(`Status changed to ${updated.status}.`);
    } catch (cause) {
      if (currentIdRef.current !== requestedId) return;
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportPdf = async (): Promise<void> => {
    const requestedId = id;
    if (requestedId === undefined) return;
    setActionError(null);
    setNotice(null);
    try {
      const result = await window.api.invoke('invoices:exportPdf', { id: requestedId });
      if (result.path === '') return; // user closed the save dialog
      // Same hole as changeStatus: the banner would otherwise report invoice
      // A's export on invoice B's page.
      if (currentIdRef.current !== requestedId) return;
      setNotice(`PDF written to ${result.path} (${result.bytes} bytes).`);
    } catch (cause) {
      // DESKTOP_ONLY in the browser preview: an inline banner, never a crash.
      if (currentIdRef.current !== requestedId) return;
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (loadError !== null) {
    return (
      <Page maxWidth={DETAIL_MAX_WIDTH}>
        <Banner status="error" title={loadError} />
        <HStack gap={2}>
          <Button label="Back to invoices" onClick={() => void navigate('/invoices')} />
        </HStack>
      </Page>
    );
  }

  if (invoice === null || data === null || documentModel === null) {
    return (
      <Page maxWidth={DETAIL_MAX_WIDTH}>
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading invoice" />
        </VStack>
      </Page>
    );
  }

  const today = todayIso();
  const status = buildStatusView(invoice, today, isEffectivelyOverdue(invoice));
  const tiles = buildStatTiles({ invoice, averageDelayDays: data.averageDelayDays });
  const lineSummary = buildLineSummary(invoice);
  const history = buildHistoryEvents(invoice);
  const notes = buildNotesSections(
    invoice.notes,
    invoice.client?.name ?? null,
    invoice.client?.notes ?? null,
  );

  return (
    <Page maxWidth={DETAIL_MAX_WIDTH}>
      <PageHeader
        title={invoice.number}
        description={
          invoice.client === null
            ? 'This invoice has no client attached.'
            : `Issued to ${invoice.client.name}.`
        }
        actions={
          <>
            <Button label="Back" variant="ghost" onClick={() => void navigate('/invoices')} />
            <Selector
              label="Status"
              isLabelHidden
              options={STATUS_OPTIONS}
              value={invoice.status}
              onChange={(value) => {
                void changeStatus(value as InvoiceStatus);
              }}
            />
            <Button label="Export PDF" onClick={() => void exportPdf()} />
            <Button
              label="Edit"
              variant="primary"
              onClick={() => void navigate(`/invoices/${invoice.id}/edit`)}
            />
          </>
        }
      />

      {actionError ? <Banner status="error" title={actionError} isDismissable /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable /> : null}

      <TabList
        value={tab}
        hasDivider
        onChange={(value) => {
          setTab(value as DetailTab);
        }}
      >
        <Tab value="invoice" label="Invoice" />
        <Tab value="history" label="History" />
        <Tab value="notes" label="Notes" />
      </TabList>

      <Grid columns={{ minWidth: COLUMN_MIN_WIDTH, max: 2 }} gap={5} align="start">
        <VStack gap={5}>
          {tab === 'invoice' ? (
            <>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Badge variant={status.variant} label={status.label} />
                {status.delayNote === null ? null : (
                  <Text type="supporting" color="inherit" style={{ color: 'var(--color-error)' }}>
                    {status.delayNote}
                  </Text>
                )}
              </HStack>

              <Grid columns={{ minWidth: 150, max: 3 }} gap={3}>
                {/* The emphasised tile takes the whole row. At display-3 the
                    headline amount needs more than a third of the column —
                    €21,873.75 was being clipped to `€21,873....` at 1440px —
                    and growing the tile keeps the type size the mockup asked
                    for instead of shrinking the one number that matters. */}
                {tiles.map((tile) =>
                  tile.isEmphasised ? (
                    <GridSpan key={tile.key} columns="full">
                      <StatTileCard label={tile.label} value={tile.value} isEmphasised />
                    </GridSpan>
                  ) : (
                    <StatTileCard
                      key={tile.key}
                      label={tile.label}
                      value={tile.value}
                      isEmphasised={false}
                    />
                  ),
                )}
              </Grid>

              <Section padding={4}>
                <VStack gap={3}>
                  <Heading level={2}>Line items</Heading>
                  {lineSummary.count === 0 ? (
                    <Text type="supporting">This invoice has no line items.</Text>
                  ) : (
                    <List density="compact" hasDividers>
                      {lineSummary.rows.map((row) => (
                        <ListItem
                          key={row.key}
                          label={row.description}
                          description={`Quantity ${row.quantity}`}
                          endContent={
                            <Text type="body" weight="medium" hasTabularNumbers>
                              {row.amount}
                            </Text>
                          }
                        />
                      ))}
                    </List>
                  )}
                  <Divider />
                  <VStack gap={1}>
                    <SummaryRow label="Subtotal" value={lineSummary.subtotal} />
                    <SummaryRow label="Tax" value={lineSummary.tax} />
                    <SummaryRow label="Total" value={lineSummary.total} isEmphasised />
                  </VStack>
                </VStack>
              </Section>
            </>
          ) : null}

          {tab === 'history' ? (
            <Section padding={4}>
              <VStack gap={3}>
                <Heading level={2}>History</Heading>
                <List density="compact" hasDividers>
                  {history.map((event) => (
                    <ListItem
                      key={event.key}
                      label={event.label}
                      description={event.description}
                      endContent={<Timestamp value={event.timestamp} format="date_time" />}
                    />
                  ))}
                </List>
              </VStack>
            </Section>
          ) : null}

          {tab === 'notes' ? (
            <Section padding={4}>
              {notes.length === 0 ? (
                <EmptyState
                  title="No notes"
                  description="Neither this invoice nor its client carries a note."
                  headingLevel={2}
                />
              ) : (
                <VStack gap={4}>
                  {notes.map((section) => (
                    <VStack key={section.key} gap={1}>
                      <Heading level={2}>{section.heading}</Heading>
                      <Text type="supporting" display="block">
                        {section.body}
                      </Text>
                    </VStack>
                  ))}
                </VStack>
              )}
            </Section>
          ) : null}
        </VStack>

        {/* Pinned across all three tabs, on the recessed background from the mockup. */}
        <Section variant="muted" padding={4}>
          <InvoiceDocument model={documentModel} />
        </Section>
      </Grid>
    </Page>
  );
}
