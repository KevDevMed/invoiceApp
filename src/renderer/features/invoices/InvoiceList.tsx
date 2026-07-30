/**
 * Invoices, as a triage cockpit.
 *
 * Chasing is the job, so the list never leaves the screen: a grouped list on
 * the left, the selected invoice rendered in full on the right, and the chase
 * actions pinned to the bottom of that pane. Select a row, read the invoice,
 * act, press `J` for the next one — no navigation, no losing your place.
 *
 * What changed from the table this replaced, and why:
 *   - Rows are two lines and say *when* (`INV-0051 · 34 days late`), because a
 *     status pill never did. Grouping, ordering and every one of those phrases
 *     is decided in ./listGrouping, which the node-only vitest project covers.
 *   - The row is the link; there is no `Open` button, and selection is a rail
 *     in the foreground colour rather than a colour-coded highlight.
 *   - Selection is *state*, not navigation. `/invoices/:id` appends a tab
 *     (ui/invoiceTabsState.ts `syncTabs`), so routing on every `J` would open
 *     sixty pills in a minute. The pane's overflow menu opens the route
 *     deliberately when a tab is what you want.
 *
 * The visible filter chrome is a compact search box and a segmented control.
 * The `PowerSearch` filter vocabulary is not deleted: it still owns what a
 * filter *is* (./filters), still builds the `invoices:list` request, and is one
 * click away behind the Filters toggle — the segments and the search box are
 * the two filters that earn permanent chrome, not a replacement for the rest.
 *
 * `load` still pages `invoices:list` until it holds the whole matching set:
 * group sums and the segment counts speak for every matching invoice, not for
 * the first window of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Item } from '@astryxdesign/core/Item';
import { Kbd } from '@astryxdesign/core/Kbd';
import { PowerSearch } from '@astryxdesign/core/PowerSearch';
import type {
  PowerSearchComponents,
  PowerSearchConfig,
  PowerSearchFilter,
  PowerSearchTokenProps,
} from '@astryxdesign/core/PowerSearch';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';

import type { Client, Invoice, InvoiceWithItems } from '../../../shared/types';
import { todayIso } from './format';
import {
  FIELD_AMOUNT,
  FIELD_CLIENT,
  FIELD_ISSUED,
  FIELD_NUMBER,
  FIELD_STATUS,
  OPERATOR_IS,
  applyClientFilters,
  buildInvoiceSearchConfig,
  toListRequest,
} from './filters';
import { fetchClientInvoices } from './listData';
import {
  LIST_COLUMN_WIDTH,
  LIST_SEGMENTS,
  adjacentRowId,
  buildInvoiceGroups,
  countSegments,
  flattenGroups,
  formatCurrencyTotals,
  groupHeaderLabel,
  outstandingTotals,
  overdueTotals,
  rowPosition,
} from './listGrouping';
import type { ListRow, ListSegment, RowState } from './listGrouping';
import { InvoicePane } from './listPaneView';

/**
 * Rows per `invoices:list` request. The contract caps `limit` at 500
 * (src/shared/ipc-contract.ts, `Pagination`), so this is one round trip per 500
 * matching invoices — the whole matching set is pulled, never a prefix of it.
 * The database is local SQLite on the user's own machine, so this is cheap, and
 * it is the only way the group sums and the segment counts can be true.
 */
const PAGE_LIMIT = 500;

/** Width of the selection rail down the left edge of a row. */
const RAIL_WIDTH = 'var(--spacing-0-5)';

// The semantic icon set ships no person / money / hash glyph, and the Icon docs
// sanction passing an SVG component directly. These follow the same conventions
// as the shipped set: 24x24 box, currentColor, 1.5 stroke.
function PersonIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <circle cx="12" cy="8" r="3.25" />
      <path d="M4.75 19.25a7.25 7.25 0 0 1 14.5 0" strokeLinecap="round" />
    </svg>
  );
}
function MoneyIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path d="M12 4.75v14.5" strokeLinecap="round" />
      <path
        d="M15.5 8.25a3 3 0 0 0-3-1.5h-1a2.75 2.75 0 0 0 0 5.5h1a2.75 2.75 0 0 1 0 5.5h-1a3 3 0 0 1-3-1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
function HashIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} {...props}>
      <path d="M9.5 4.75 7.75 19.25M16.25 4.75 14.5 19.25M4.75 9h14.5M4.25 15h14.5" strokeLinecap="round" />
    </svg>
  );
}

const FIELD_ICONS: Record<string, React.JSX.Element> = {
  [FIELD_STATUS]: <Icon icon="info" size="sm" />,
  [FIELD_CLIENT]: <Icon icon={PersonIcon} size="sm" />,
  [FIELD_ISSUED]: <Icon icon="calendar" size="sm" />,
  [FIELD_AMOUNT]: <Icon icon={MoneyIcon} size="sm" />,
  [FIELD_NUMBER]: <Icon icon={HashIcon} size="sm" />,
};

/**
 * Token pill for our filters: `[field icon] Field · operator · value · ×`.
 *
 * PowerSearch's own token renders one flat `Field: operator` string and only
 * ever passes an `icon` for single-entity filters. The sanctioned way past that
 * is the per-type `components.Token` override, which is what this is: the
 * shipped `Token` with the icon slot filled and the three parts kept as
 * separate runs of text.
 *
 * `label` stays the `Field: operator` string the default builds, so the remove
 * button keeps its "Remove Status: is" accessible name; it is hidden visually
 * and re-rendered in parts.
 */
function formatFilterValue(props: PowerSearchTokenProps): string {
  const { filter, operator, maxLength } = props;
  const truncate = (text: string): string =>
    text.length <= maxLength ? text : `${text.slice(0, Math.max(maxLength - 1, 1))}…`;

  switch (filter.value.type) {
    case 'string':
      return truncate(filter.value.value);
    case 'float':
    case 'integer':
      return new Intl.NumberFormat().format(filter.value.value);
    case 'enum': {
      const raw = filter.value.value;
      const values = operator.value.type === 'enum' ? operator.value.values : [];
      const item = values.find((option) => option.value === raw);
      return truncate(item?.label ?? raw);
    }
    case 'enum_list': {
      const values = operator.value.type === 'enum_list' ? operator.value.values : [];
      const labels = filter.value.value.map(
        (raw) => values.find((option) => option.value === raw)?.label ?? raw,
      );
      if (labels.length === 0) return '';
      const joined = labels.join(', ');
      return joined.length <= maxLength ? joined : `${labels.length} items`;
    }
    case 'date_range':
      return 'Date range';
    default:
      return '';
  }
}

function InvoiceFilterToken(props: PowerSearchTokenProps): React.JSX.Element {
  const { field, operator, filter, onClick, onRemove, isDisabled } = props;
  const operatorLabel = 'label' in operator ? (operator.label ?? '') : '';
  const value = formatFilterValue(props);

  return (
    <Token
      icon={FIELD_ICONS[filter.field]}
      label={`${field.label}: ${operatorLabel}`.trim()}
      isLabelHidden
      endContent={
        <HStack gap={1} align="center">
          <Text as="span" type="supporting">
            {field.label}
          </Text>
          {operatorLabel === '' ? null : (
            <Text as="span" type="supporting" color="secondary">
              {operatorLabel}
            </Text>
          )}
          {value === '' ? null : (
            <Text as="span" type="supporting" weight="semibold">
              {value}
            </Text>
          )}
        </HStack>
      }
      onClick={
        onClick
          ? (event: React.MouseEvent) => {
              event.stopPropagation();
              onClick();
            }
          : undefined
      }
      onRemove={onRemove}
      isDisabled={isDisabled}
    />
  );
}

/** Every operator value type this app's config produces gets the same token. */
const SEARCH_COMPONENTS: PowerSearchComponents = {
  enum: { Token: InvoiceFilterToken },
  enum_list: { Token: InvoiceFilterToken },
  string: { Token: InvoiceFilterToken },
  float: { Token: InvoiceFilterToken },
  integer: { Token: InvoiceFilterToken },
  date_range: { Token: InvoiceFilterToken },
};

/**
 * The state dot. Four of the six states map onto a semantic `StatusDot`; a
 * draft is the exception — it is the *absence* of a state, and the design says
 * so with a hollow ring, which the five semantic variants cannot express.
 */
function StateDot({ state }: { readonly state: RowState }): React.JSX.Element {
  if (state === 'draft') {
    return (
      <HStack
        width="var(--spacing-1-5)"
        height="var(--spacing-1-5)"
        aria-label="Draft"
        role="img"
        style={{
          flex: 'none',
          borderRadius: 'var(--radius-full)',
          border: '1px solid var(--color-border-emphasized)',
        }}
      >
        {null}
      </HStack>
    );
  }
  switch (state) {
    case 'overdue':
      return <StatusDot variant="error" label="Overdue" />;
    case 'due-soon':
      return <StatusDot variant="warning" label="Due this week" />;
    case 'paid':
      return <StatusDot variant="success" label="Paid" />;
    case 'void':
      return <StatusDot variant="neutral" label="Void" />;
    case 'later':
      return <StatusDot variant="accent" label="Open" />;
  }
}

export function InvoiceList(): React.JSX.Element {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<readonly PowerSearchFilter[]>([]);
  const [segment, setSegment] = useState<ListSegment>('all');
  const [isFilterBarOpen, setIsFilterBarOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [pane, setPane] = useState<InvoiceWithItems | null>(null);
  const [paneClientInvoices, setPaneClientInvoices] = useState<readonly Invoice[] | null>(null);
  const [paneError, setPaneError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  // Every load takes a ticket; only the newest one is allowed to write state.
  // Paging is several awaits long, so a load started by an earlier search term
  // can finish after a later one and would otherwise overwrite it.
  const loadTicket = useRef(0);
  const paneTicket = useRef(0);

  const today = todayIso();

  const load = useCallback(async (term: string, active: readonly PowerSearchFilter[]) => {
    const ticket = ++loadTicket.current;
    const isStale = (): boolean => ticket !== loadTicket.current;
    setError(null);
    try {
      const request = (offset: number): ReturnType<typeof toListRequest> =>
        toListRequest(active, { search: term, limit: PAGE_LIMIT, offset });

      const [firstPage, clientResult] = await Promise.all([
        window.api.invoke('invoices:list', request(0)),
        // The list response carries clientId only — join names client-side.
        window.api.invoke('clients:list', { limit: 500, offset: 0 }),
      ]);
      if (isStale()) return;

      // `total` is the size of the set the backend filter matched. Keep asking
      // for the next window until we hold all of it; an empty page ends the
      // loop too, so a shrinking list cannot spin here.
      const collected = [...firstPage.items];
      while (collected.length < firstPage.total) {
        const next = await window.api.invoke('invoices:list', request(collected.length));
        if (isStale()) return;
        if (next.items.length === 0) break;
        collected.push(...next.items);
      }

      setInvoices(collected);
      setClients(clientResult.items);
    } catch (cause) {
      if (isStale()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setInvoices([]);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load(search, filters);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [search, filters, load]);

  const clientNames = useMemo(
    () => new Map(clients.map((client) => [client.id, client.name])),
    [clients],
  );

  const config: PowerSearchConfig = useMemo(() => {
    const base = buildInvoiceSearchConfig(clients);
    return {
      ...base,
      fields: base.fields.map((field) => ({ ...field, icon: FIELD_ICONS[field.key] })),
    };
  }, [clients]);

  /** The whole matching set, before the segment narrows it. */
  const matching = useMemo(
    () => applyClientFilters(invoices ?? [], filters),
    [invoices, filters],
  );

  const counts = useMemo(() => countSegments(matching, today), [matching, today]);

  const groups = useMemo(
    () => buildInvoiceGroups({ invoices: matching, clientNames, today, segment }),
    [matching, clientNames, today, segment],
  );

  const rows = useMemo(() => flattenGroups(groups), [groups]);

  /**
   * The row actually on screen. A selection made against an older set — before
   * a search term, a segment or a status change moved the rows — would
   * otherwise survive unseen and reappear later, so it is *derived* rather than
   * corrected after the fact: keep the chosen row while it is still in the
   * list, fall to the top of the list when it is not.
   */
  const selected = useMemo(() => {
    if (selectedId !== null && rows.some((row) => row.id === selectedId)) return selectedId;
    return rows[0]?.id ?? null;
  }, [rows, selectedId]);

  // The pane needs the line items and the client, which the list response does
  // not carry, plus the client's other invoices for the balance fact. Debounced
  // because holding `J` would otherwise fire one round trip per keystroke, and
  // ticketed because those round trips can land out of order.
  useEffect(() => {
    const ticket = ++paneTicket.current;
    const isStale = (): boolean => ticket !== paneTicket.current;
    const handle = window.setTimeout(() => {
      if (selected === null) {
        setPane(null);
        setPaneClientInvoices(null);
        setPaneError(null);
        return;
      }
      void (async () => {
        setPaneError(null);
        try {
          const full = await window.api.invoke('invoices:get', { id: selected });
          if (isStale()) return;
          if (full === null) {
            setPane(null);
            setPaneClientInvoices(null);
            setPaneError('This invoice no longer exists.');
            return;
          }
          setPane(full);
          setPaneClientInvoices(null);
          const siblings = await fetchClientInvoices(full.clientId);
          if (isStale()) return;
          setPaneClientInvoices(siblings);
        } catch (cause) {
          if (isStale()) return;
          setPaneError(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    }, 120);
    return () => {
      window.clearTimeout(handle);
    };
  }, [selected]);

  const move = useCallback(
    (delta: number) => {
      const next = adjacentRowId(rows, selected, delta);
      if (next === null) return;
      setSelectedId(next);
      rowRefs.current.get(next)?.scrollIntoView({ block: 'nearest' });
    },
    [rows, selected],
  );

  // `J`/`K` move the selection, `/` focuses the search. Scoped to this page
  // because the listener lives and dies with it, and inert whenever a text
  // field or a modifier has the keystroke.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
      }
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        move(-1);
      } else if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [move]);

  // Any change to what is being looked at sends the reader to the top of the
  // new list; the selection effect above does that as soon as `rows` changes.
  const changeSearch = useCallback((term: string) => {
    setSearch(term);
  }, []);
  const changeFilters = useCallback((next: readonly PowerSearchFilter[]) => {
    setFilters([...next]);
  }, []);

  const showClientInvoices = useCallback((clientId: string) => {
    setFilters((current) => [
      ...current.filter((filter) => filter.field !== FIELD_CLIENT),
      { field: FIELD_CLIENT, operator: OPERATOR_IS, value: { type: 'enum', value: clientId } },
    ]);
    setSegment('all');
    setIsFilterBarOpen(true);
  }, []);

  /** A status change in the pane has to land in the list's own copy of the row. */
  const applyInvoiceChange = useCallback((updated: Invoice) => {
    setInvoices((current) =>
      current === null
        ? current
        : current.map((invoice) => (invoice.id === updated.id ? { ...invoice, ...updated } : invoice)),
    );
    setPane((current) => (current === null || current.id !== updated.id ? current : { ...current, ...updated }));
  }, []);

  const outstanding = useMemo(() => outstandingTotals(matching, today), [matching, today]);
  const overdue = useMemo(() => overdueTotals(matching, today), [matching, today]);
  const position = rowPosition(rows, selected);
  const hasActiveFilters = filters.length > 0 || search.trim() !== '' || segment !== 'all';

  return (
    <VStack height="100%" gap={0}>
      <VStack
        gap={3}
        paddingInline={5}
        paddingBlock={4}
        style={{ borderBlockEnd: '1px solid var(--color-border)' }}
      >
        <HStack justify="between" align="center" gap={4} wrap="wrap">
          <HStack gap={3} align="center" wrap="wrap">
            <Heading level={1}>Invoices</Heading>
            {invoices === null ? null : (
              <HStack gap={1} align="center" wrap="wrap">
                <Text type="supporting" hasTabularNumbers>
                  {outstanding.length === 0
                    ? 'Nothing outstanding'
                    : `${formatCurrencyTotals(outstanding, 3)} outstanding`}
                </Text>
                {overdue.length === 0 ? null : (
                  <Text
                    type="supporting"
                    hasTabularNumbers
                    style={{ color: 'var(--color-error)' }}
                  >
                    {`· ${formatCurrencyTotals(overdue, 3)} overdue`}
                  </Text>
                )}
              </HStack>
            )}
          </HStack>
          <Button
            label="New invoice"
            variant="primary"
            onClick={() => {
              void navigate('new');
            }}
          />
        </HStack>

        {/* PowerSearch keeps the filter vocabulary — status, client, issued
            range, amount, invoice number — and still builds the backend
            request. It is one click away rather than always on screen, because
            the two filters used every day earned the permanent chrome. */}
        {isFilterBarOpen || filters.length > 0 ? (
          <HStack gap={2} align="start">
            <StackItem size="fill">
              <PowerSearch
                label="Filter invoices"
                config={config}
                components={SEARCH_COMPONENTS}
                filters={filters}
                onChange={changeFilters}
                placeholder="Add filter"
                // The built-in clear-all reports itself as a single token
                // removal, so one click only ever drops one token. Own control,
                // one click, every token.
                hasClear={false}
                endContent={
                  filters.length > 0 ? (
                    <Button
                      label="Clear all"
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        // The tokenizer wrapper refocuses its input on any
                        // click inside it; keep the click to this button.
                        event.stopPropagation();
                        changeFilters([]);
                      }}
                    />
                  ) : undefined
                }
                resultCount={invoices === null ? undefined : matching.length}
              />
            </StackItem>
          </HStack>
        ) : null}
      </VStack>

      {error === null ? null : <Banner status="error" title={error} isDismissable />}

      <StackItem size="fill">
        <HStack gap={0} height="100%" align="stretch">
          <VStack
            width={LIST_COLUMN_WIDTH}
            gap={0}
            style={{ flex: 'none', borderInlineEnd: '1px solid var(--color-border)' }}
          >
            <VStack
              gap={2}
              paddingInline={3}
              paddingBlock={2}
              style={{ borderBlockEnd: '1px solid var(--color-border)' }}
            >
              <HStack gap={2} align="center">
                <StackItem size="fill">
                  <TextInput
                    ref={searchRef}
                    label="Search invoices"
                    isLabelHidden
                    size="sm"
                    placeholder="Client, number, amount"
                    startIcon="search"
                    hasClear
                    value={search}
                    onChange={changeSearch}
                  />
                </StackItem>
                <Kbd keys="/" />
                <Button
                  label={filters.length > 0 ? `Filters ${String(filters.length)}` : 'Filters'}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsFilterBarOpen((open) => !open);
                  }}
                />
              </HStack>
              <SegmentedControl
                label="Invoice state"
                size="sm"
                layout="fill"
                value={segment}
                onChange={(value) => {
                  setSegment(value as ListSegment);
                }}
              >
                {LIST_SEGMENTS.map((item) => (
                  <SegmentedControlItem
                    key={item.key}
                    value={item.key}
                    label={`${item.label} ${String(counts[item.key])}`}
                  />
                ))}
              </SegmentedControl>
            </VStack>

            <StackItem size="fill" isScrollable>
              {invoices === null ? (
                <VStack gap={2} align="center" padding={6}>
                  <Spinner size="lg" label="Loading invoices" />
                </VStack>
              ) : rows.length === 0 ? (
                <VStack padding={4}>
                  <EmptyState
                    title={hasActiveFilters ? 'Nothing here' : 'No invoices yet'}
                    description={
                      hasActiveFilters
                        ? 'Widen the search, the segment, or the filter tokens.'
                        : 'Create your first invoice to get started.'
                    }
                    headingLevel={2}
                  />
                </VStack>
              ) : (
                <VStack gap={0}>
                  {groups.map((group) => (
                    <VStack key={group.key} gap={0}>
                      <HStack
                        paddingInline={3}
                        paddingBlock={1}
                        style={{
                          position: 'sticky',
                          insetBlockStart: 0,
                          zIndex: 1,
                          // The tinted background tokens are translucent, so
                          // they are composited over the surface: a sticky
                          // header has to be opaque or the rows read through it.
                          background:
                            group.key === 'overdue'
                              ? 'linear-gradient(var(--color-background-red), var(--color-background-red)), var(--color-background-surface)'
                              : 'var(--color-background-surface)',
                          borderBlockEnd: '1px solid var(--color-border)',
                        }}
                      >
                        <Text
                          type="supporting"
                          weight="semibold"
                          maxLines={1}
                          hasTabularNumbers
                          style={{
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color:
                              group.key === 'overdue'
                                ? 'var(--color-text-red)'
                                : 'var(--color-text-secondary)',
                          }}
                        >
                          {groupHeaderLabel(group)}
                        </Text>
                      </HStack>
                      {group.rows.map((row) => (
                        <InvoiceListRow
                          key={row.id}
                          row={row}
                          isSelected={row.id === selected}
                          onSelect={setSelectedId}
                          registerRef={(id, element) => {
                            if (element === null) rowRefs.current.delete(id);
                            else rowRefs.current.set(id, element);
                          }}
                        />
                      ))}
                    </VStack>
                  ))}
                </VStack>
              )}
            </StackItem>
          </VStack>

          <StackItem size="fill">
            {paneError !== null ? (
              <VStack padding={5}>
                <Banner status="error" title={paneError} />
              </VStack>
            ) : pane === null ? (
              <VStack gap={2} align="center" justify="center" height="100%" padding={6}>
                {rows.length === 0 ? (
                  <Text type="supporting">Select an invoice to see it here.</Text>
                ) : (
                  <Spinner size="lg" label="Loading invoice" />
                )}
              </VStack>
            ) : (
              <InvoicePane
                invoice={pane}
                clientInvoices={paneClientInvoices}
                today={today}
                headingLevel={2}
                position={position === null ? null : { index: position, total: rows.length }}
                onPrevious={() => {
                  move(-1);
                }}
                onNext={() => {
                  move(1);
                }}
                onShowClientInvoices={() => {
                  showClientInvoices(pane.clientId);
                }}
                onOpenInTab={() => {
                  void navigate(pane.id);
                }}
                onInvoiceChanged={applyInvoiceChange}
              />
            )}
          </StackItem>
        </HStack>
      </StackItem>
    </VStack>
  );
}

/**
 * Two lines and an amount. The row *is* the link — there is no `Open` button —
 * and selection is a rail in the foreground colour plus a wash, so it reads as
 * "you are here" rather than as another status colour.
 */
function InvoiceListRow({
  row,
  isSelected,
  onSelect,
  registerRef,
}: {
  readonly row: ListRow;
  readonly isSelected: boolean;
  readonly onSelect: (id: string) => void;
  readonly registerRef: (id: string, element: HTMLElement | null) => void;
}): React.JSX.Element {
  return (
    <Item
      ref={(element) => {
        registerRef(row.id, element);
      }}
      density="compact"
      align="center"
      isSelected={isSelected}
      aria-current={isSelected ? 'true' : undefined}
      onClick={() => {
        onSelect(row.id);
      }}
      style={{
        borderInlineStart: `${RAIL_WIDTH} solid ${
          isSelected ? 'var(--color-text-primary)' : 'transparent'
        }`,
        borderBlockEnd: '1px solid var(--color-border)',
        background: isSelected ? 'var(--color-overlay-pressed)' : undefined,
      }}
      startContent={<StateDot state={row.state} />}
      label={
        <Text maxLines={1} color={row.isMuted ? 'secondary' : 'primary'}>
          {row.clientName}
        </Text>
      }
      description={
        <Text
          type="supporting"
          maxLines={1}
          style={row.state === 'overdue' ? { color: 'var(--color-error)' } : undefined}
        >
          {row.secondary}
        </Text>
      }
      endContent={
        <Text
          hasTabularNumbers
          weight={row.isMuted ? 'normal' : 'semibold'}
          color={row.isMuted ? 'secondary' : 'primary'}
        >
          {row.amount}
        </Text>
      }
    />
  );
}
