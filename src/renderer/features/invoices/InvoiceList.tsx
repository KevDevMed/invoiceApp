/**
 * Invoices, as design 3a: one bordered card that answers *what do I owe
 * attention to* before it shows a single row.
 *
 * The shape, top to bottom, is the design's: card header, four money tiles,
 * status tabs with counts beside the search and sort controls, a column header
 * strip, a dense ~48px row list that scrolls *inside* the card so the page
 * never grows, a footer pager, and a bulk action bar that appears only when
 * rows are selected.
 *
 * Three things this file deliberately does not do:
 *
 *   - **It does not set its own width.** It renders into `<Page maxWidth>` like
 *     every other route. The list used to be the one screen that built its own
 *     full-bleed column, which is why it spanned a wide monitor edge to edge
 *     while every sibling route stayed in a centred column. 1240 is 3a's own
 *     authored width.
 *   - **It does not decide anything testable.** Which columns survive the
 *     available width (./listColumns), what the tiles say (./moneyTiles), how a
 *     row phrases its status and draws its monogram (./listRows), and what the
 *     bulk bar permits (./listSelection) are all pure modules with tests,
 *     because the vitest project is `environment: 'node'` and never mounts a
 *     component.
 *   - **It does not convert currency.** There is no exchange rate in this app.
 *     The row's total is its own money in its own currency; the tiles lead with
 *     the dominant currency and say how many others they stand in front of.
 *
 * The split preview pane is gone — 3a has no pane, the row itself is the link,
 * and `/invoices/:id` renders the same `InvoicePane` at full width.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Pagination } from '@astryxdesign/core/Pagination';
import { PowerSearch } from '@astryxdesign/core/PowerSearch';
import type {
  PowerSearchComponents,
  PowerSearchConfig,
  PowerSearchFilter,
  PowerSearchTokenProps,
} from '@astryxdesign/core/PowerSearch';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';

import type { Client, Invoice } from '../../../shared/types';
import { Page } from '../../ui/Page';
import { pageSlice } from '../../ui/pagination';
import { todayIso } from './format';
import {
  FIELD_AMOUNT,
  FIELD_CLIENT,
  FIELD_ISSUED,
  FIELD_NUMBER,
  FIELD_STATUS,
  applyClientFilters,
  buildInvoiceSearchConfig,
  toListRequest,
} from './filters';
import {
  LIST_SEGMENTS,
  adjacentRowId,
  countSegments,
  extraCurrencyLabel,
  matchesSegment,
  rowStateOf,
} from './listGrouping';
import type { ListSegment } from './listGrouping';
import { listLayoutAt } from './listColumns';
import type { ListColumnKey } from './listColumns';
import { buildMoneyTiles } from './moneyTiles';
import type { MoneyTile } from './moneyTiles';
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  buildListRows,
  footerSummary,
  sortRows,
} from './listRows';
import type { ListRow, RowTone, SortKey } from './listRows';
import {
  retainVisible,
  selectAllValue,
  summariseSelection,
  toggleSelected,
} from './listSelection';
import { toneColours } from './listPaneView';

/**
 * Rows per `invoices:list` request. The contract caps `limit` at 500
 * (src/shared/ipc-contract.ts, `Pagination`), so this is one round trip per 500
 * matching invoices — the whole matching set is pulled, never a prefix of it.
 * The database is local SQLite on the user's own machine, so this is cheap, and
 * it is the only way the tile figures and the tab counts can be true.
 */
const PAGE_LIMIT = 500;

/** 3a's own authored width. The cap is the fix for the full-bleed list. */
const CONTENT_MAX_WIDTH = 1240;

/**
 * The row list scrolls inside the card at this height. Load-bearing, and the
 * design says so: ten rows at ~48px, and the page itself never grows.
 */
const ROW_LIST_MAX_HEIGHT = 430;

/** Column gap of the header strip and every row — 3a's `gap:14px`. */
const COLUMN_GAP = '14px';

/** The monogram square: 26px, 7px radius, 10px initials. All from the design. */
const MONOGRAM_SIZE = '26px';
const MONOGRAM_RADIUS = '7px';

const CARD_BORDER = '1px solid var(--color-border)';

/** Rows-per-page choices. 3a's footer shows `Rows [25 ⌄]`. */
const PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];

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
 * The width of the content column, measured rather than assumed.
 *
 * `window.innerWidth` is the wrong number: the shell's side nav collapses, so
 * the viewport and the content column disagree by 224-240px depending on a
 * setting the list knows nothing about. A `ResizeObserver` on the card itself
 * is the only source that is right in both states, and it also covers the
 * `<Page>` cap — a 2000px window still measures 1240 here.
 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Measure once synchronously: the observer's first callback lands after a
    // frame, and a first paint at the narrowest tier followed by a jump to the
    // widest is a visible flash of the wrong layout.
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return [ref, width];
}

export function InvoiceList(): React.JSX.Element {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<readonly PowerSearchFilter[]>([]);
  const [segment, setSegment] = useState<ListSegment>('all');
  const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
  const [isFilterBarOpen, setIsFilterBarOpen] = useState(false);
  const [openTile, setOpenTile] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [rawSelected, setRawSelected] = useState<ReadonlySet<string>>(new Set());

  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const [cardRef, contentWidth] = useMeasuredWidth();
  const layout = useMemo(() => listLayoutAt(contentWidth), [contentWidth]);

  // Every load takes a ticket; only the newest one is allowed to write state.
  // Paging is several awaits long, so a load started by an earlier search term
  // can finish after a later one and would otherwise overwrite it.
  const loadTicket = useRef(0);

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

  // Any change to what is being looked at sends the reader back to page one;
  // staying on page 5 of a set that now has two pages shows an empty card.
  useEffect(() => {
    setPage(1);
  }, [search, filters, segment, sort, pageSize]);

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

  /** The whole matching set, before the status tab narrows it. */
  const matching = useMemo(
    () => applyClientFilters(invoices ?? [], filters),
    [invoices, filters],
  );

  const counts = useMemo(() => countSegments(matching, today), [matching, today]);
  // The tiles describe the filtered set, not the tab — the point of the tiles
  // is to tell you which tab to press.
  const tiles = useMemo(() => buildMoneyTiles(matching, today), [matching, today]);

  const rows = useMemo(() => {
    const inSegment = matching.filter((invoice) =>
      matchesSegment(rowStateOf(invoice, today), segment),
    );
    return sortRows(buildListRows({ invoices: inSegment, clientNames, today }), sort);
  }, [matching, clientNames, today, segment, sort]);

  const pageRows = useMemo(() => pageSlice(rows, page, pageSize), [rows, page, pageSize]);

  /**
   * Selection narrowed to what is on screen. Derived rather than corrected
   * after the fact: a search term or a status change moves rows out from under
   * a selection, and a bulk action against an invoice the reader can no longer
   * see is the worst kind of surprise.
   */
  const selected = useMemo(
    () => (layout.hasSelection ? retainVisible(rawSelected, rows) : new Set<string>()),
    [rawSelected, rows, layout.hasSelection],
  );
  const selection = useMemo(() => summariseSelection(selected, rows), [selected, rows]);

  /** The row `J`/`K` are parked on. Falls to the top of the page when it leaves. */
  const cursor = useMemo(() => {
    if (cursorId !== null && pageRows.some((row) => row.id === cursorId)) return cursorId;
    return pageRows[0]?.id ?? null;
  }, [pageRows, cursorId]);

  const move = useCallback(
    (delta: number) => {
      const next = adjacentRowId(pageRows, cursor, delta);
      if (next === null) return;
      setCursorId(next);
      const element = rowRefs.current.get(next);
      element?.scrollIntoView({ block: 'nearest' });
      element?.focus();
    },
    [pageRows, cursor],
  );

  const open = useCallback(
    (id: string) => {
      void navigate(id);
    },
    [navigate],
  );

  // `J`/`K` move the cursor, `/` focuses the search. Scoped to this page
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

  const changeFilters = useCallback((next: readonly PowerSearchFilter[]) => {
    setFilters([...next]);
  }, []);

  const toggleRow = useCallback((id: string) => {
    setRawSelected((current) => toggleSelected(current, id));
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setRawSelected(checked ? new Set(pageRows.map((row) => row.id)) : new Set());
    },
    [pageRows],
  );

  /** A status change has to land in the list's own copy of the row. */
  const applyInvoiceChange = useCallback((updated: Invoice) => {
    setInvoices((current) =>
      current === null
        ? current
        : current.map((invoice) => (invoice.id === updated.id ? { ...invoice, ...updated } : invoice)),
    );
  }, []);

  const markSelectedPaid = useCallback(async () => {
    setIsActing(true);
    setActionError(null);
    try {
      for (const id of selected) {
        const updated = await window.api.invoke('invoices:setStatus', { id, status: 'paid' });
        applyInvoiceChange(updated);
      }
      setRawSelected(new Set());
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsActing(false);
    }
  }, [selected, applyInvoiceChange]);

  const exportSelected = useCallback(async () => {
    const [id] = [...selected];
    if (id === undefined) return;
    setIsActing(true);
    setActionError(null);
    try {
      await window.api.invoke('invoices:exportPdf', { id });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsActing(false);
    }
  }, [selected]);

  const hasActiveFilters = filters.length > 0 || search.trim() !== '' || segment !== 'all';
  const headerLine =
    invoices === null
      ? 'Loading…'
      : `${String(matching.length)} in this workspace`;

  return (
    <Page maxWidth={CONTENT_MAX_WIDTH}>
      {error === null ? null : <Banner status="error" title={error} isDismissable />}
      {actionError === null ? null : (
        <Banner
          status="error"
          title={actionError}
          isDismissable
          onDismiss={() => {
            setActionError(null);
          }}
        />
      )}

      {/* The card is the whole screen: header, tiles, tabs, table and footer
          are sections of it separated by 1px rules, not free-floating blocks.
          `overflow: hidden` is what lets the 16px radius clip the recessed
          footer and header strips. */}
      <VStack
        ref={cardRef}
        gap={0}
        style={{
          border: CARD_BORDER,
          borderRadius: 'var(--radius-container)',
          overflow: 'hidden',
          background: 'var(--color-background-surface)',
        }}
      >
        <VStack
          gap={4}
          paddingInline={6}
          paddingBlock={5}
          style={{ borderBlockEnd: CARD_BORDER }}
        >
          <HStack justify="between" align="start" gap={4} wrap="wrap">
            <VStack gap={1}>
              {/* The page's only h1. The design draws it at 20px/600, which is
                  what `Heading level={1}` is here — the level is the document
                  outline, not a font size. */}
              <Heading level={1}>Invoices</Heading>
              <Text type="supporting" hasTabularNumbers>
                {headerLine}
              </Text>
            </VStack>
            <Button
              label="New invoice"
              variant="primary"
              onClick={() => {
                void navigate('new');
              }}
            />
          </HStack>

          <MoneyTiles
            tiles={tiles}
            columns={layout.tileColumns}
            openKey={openTile}
            onToggle={setOpenTile}
          />
        </VStack>

        <VStack
          gap={3}
          paddingInline={6}
          paddingBlock={3}
          style={{ borderBlockEnd: CARD_BORDER }}
        >
          <HStack justify="between" align="center" gap={3} wrap="wrap">
            <StatusTabs
              value={segment}
              counts={counts}
              onChange={(next) => {
                setSegment(next);
              }}
            />
            <HStack gap={2} align="center" wrap="wrap">
              <HStack gap={1} align="center" width={230}>
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
                    onChange={setSearch}
                  />
                </StackItem>
                <Kbd keys="/" />
              </HStack>
              {/* The dashed border is the design's mark for an empty slot: this
                  is the "add a filter" affordance, not a filter. */}
              <Button
                label={filters.length > 0 ? `Filter ${String(filters.length)}` : '+ Filter'}
                variant="ghost"
                size="sm"
                aria-expanded={isFilterBarOpen || filters.length > 0}
                style={{ borderStyle: 'dashed', borderWidth: 'var(--border-width)' }}
                onClick={() => {
                  setIsFilterBarOpen((current) => !current);
                }}
              />
              <Selector
                label="Sort invoices"
                isLabelHidden
                size="sm"
                value={sort}
                options={SORT_OPTIONS.map((option) => ({
                  value: option.key,
                  label: option.label,
                }))}
                onChange={(value) => {
                  setSort(value as SortKey);
                }}
              />
            </HStack>
          </HStack>

          {/* PowerSearch keeps the filter vocabulary — status, client, issued
              range, amount, invoice number — and still builds the backend
              request. It is one click behind `+ Filter` rather than always on
              screen, because the tabs and the search box are the two filters
              that earned permanent chrome. */}
          {isFilterBarOpen || filters.length > 0 ? (
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
                      // The tokenizer wrapper refocuses its input on any click
                      // inside it; keep the click to this button.
                      event.stopPropagation();
                      changeFilters([]);
                    }}
                  />
                ) : undefined
              }
              resultCount={invoices === null ? undefined : matching.length}
            />
          ) : null}
        </VStack>

        {invoices === null ? (
          <VStack gap={2} align="center" padding={8}>
            <Spinner size="lg" label="Loading invoices" />
          </VStack>
        ) : rows.length === 0 ? (
          <VStack padding={6}>
            <EmptyState
              title={hasActiveFilters ? 'Nothing here' : 'No invoices yet'}
              description={
                hasActiveFilters
                  ? 'Widen the search, the tab, or the filter tokens.'
                  : 'Create your first invoice to get started.'
              }
              headingLevel={2}
            />
          </VStack>
        ) : (
          <>
            <ColumnHeader
              columns={layout.columns}
              template={layout.gridTemplateColumns}
              selectAll={selectAllValue(selected, pageRows)}
              onSelectAll={toggleAll}
            />
            <VStack
              gap={0}
              isScrollable
              style={{ maxBlockSize: ROW_LIST_MAX_HEIGHT, scrollbarGutter: 'stable' }}
            >
              {pageRows.map((row, index) => (
                <InvoiceRow
                  key={row.id}
                  row={row}
                  columns={layout.columns}
                  template={layout.gridTemplateColumns}
                  showsStatusDate={layout.showsStatusDate}
                  isSelected={selected.has(row.id)}
                  isCursor={row.id === cursor}
                  isLast={index === pageRows.length - 1}
                  onOpen={open}
                  onToggle={toggleRow}
                  onFocus={setCursorId}
                  registerRef={(id, element) => {
                    if (element === null) rowRefs.current.delete(id);
                    else rowRefs.current.set(id, element);
                  }}
                />
              ))}
            </VStack>

            <HStack
              justify="between"
              align="center"
              gap={3}
              wrap="wrap"
              paddingInline={6}
              paddingBlock={3}
              style={{
                borderBlockStart: CARD_BORDER,
                background: 'var(--color-background-muted)',
              }}
            >
              <Text type="supporting" hasTabularNumbers>
                {footerSummary(rows.length, page, pageSize, sort)}
              </Text>
              <HStack gap={2} align="center">
                <Text type="supporting">Rows</Text>
                <Selector
                  label="Rows per page"
                  isLabelHidden
                  size="sm"
                  value={String(pageSize)}
                  options={PAGE_SIZE_OPTIONS.map((option) => ({
                    value: String(option),
                    label: String(option),
                  }))}
                  onChange={(value) => {
                    const next = Number(value);
                    if (Number.isFinite(next) && next > 0) setPageSize(next);
                  }}
                />
                <Pagination
                  page={page}
                  onChange={setPage}
                  totalItems={rows.length}
                  pageSize={pageSize}
                  variant="compact"
                  size="sm"
                />
              </HStack>
            </HStack>

            {selection.count === 0 ? null : (
              <BulkBar
                selection={selection}
                isBusy={isActing}
                onMarkPaid={() => void markSelectedPaid()}
                onExport={() => void exportSelected()}
                onClear={() => {
                  setRawSelected(new Set());
                }}
              />
            )}
          </>
        )}
      </VStack>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Money tiles
// ---------------------------------------------------------------------------

/**
 * Four figures before a single row. The overdue tile is the only coloured one,
 * exactly as the design has it — one tinted surface among four reads as an
 * alarm, four read as decoration.
 *
 * A tile with more than one currency behind it gets a disclosure rather than a
 * converted total, because this app has no exchange rate.
 */
function MoneyTiles({
  tiles,
  columns,
  openKey,
  onToggle,
}: {
  readonly tiles: readonly MoneyTile[];
  readonly columns: 1 | 2 | 4;
  readonly openKey: string | null;
  readonly onToggle: (key: string | null) => void;
}): React.JSX.Element {
  return (
    <Grid columns={columns} gap={2}>
      {tiles.map((tile) => {
        const tone = tile.tone === 'error' ? toneColours('error') : null;
        const extra = extraCurrencyLabel(tile.extraCurrencies);
        const isOpen = openKey === tile.key;
        return (
          <VStack
            key={tile.key}
            gap={1}
            paddingInline={4}
            paddingBlock={3}
            style={{
              border: `1px solid ${tone === null ? 'var(--color-border)' : tone.border}`,
              borderRadius: 'var(--radius-container)',
              background: tone === null ? 'var(--color-background-muted)' : tone.wash,
            }}
          >
            <Text
              type="supporting"
              weight="medium"
              style={tone === null ? undefined : { color: tone.text }}
            >
              {tile.label}
            </Text>
            <Text
              as="span"
              size="xl"
              weight="semibold"
              hasTabularNumbers
              style={tone === null ? undefined : { color: tone.text }}
            >
              {tile.figure}
            </Text>
            <Text type="supporting" hasTabularNumbers maxLines={1}>
              {tile.detail}
            </Text>
            {extra === null ? null : (
              <Button
                label={isOpen ? 'Hide currencies' : extra}
                variant="ghost"
                size="sm"
                aria-expanded={isOpen}
                onClick={() => {
                  onToggle(isOpen ? null : tile.key);
                }}
              />
            )}
            {isOpen ? (
              <Text type="supporting" hasTabularNumbers>
                {tile.full}
              </Text>
            ) : null}
          </VStack>
        );
      })}
    </Grid>
  );
}

// ---------------------------------------------------------------------------
// Status tabs
// ---------------------------------------------------------------------------

/**
 * The five status tabs with their counts, in one inset track.
 *
 * Not `SegmentedControl`: that control lays its segments out in a single
 * non-wrapping row, and the brief is that all five stay *reachable* at every
 * width rather than being clipped by whatever the container gives them. This
 * track wraps. Each segment is a real `<button>` with `aria-pressed`, so
 * keyboard and screen-reader access survive the swap.
 */
function StatusTabs({
  value,
  counts,
  onChange,
}: {
  readonly value: ListSegment;
  readonly counts: Record<ListSegment, number>;
  readonly onChange: (segment: ListSegment) => void;
}): React.JSX.Element {
  return (
    <HStack
      gap={0.5}
      wrap="wrap"
      align="center"
      padding={0.5}
      aria-label="Invoice status"
      role="group"
      style={{
        border: CARD_BORDER,
        borderRadius: 'var(--radius-element)',
        background: 'var(--color-background-muted)',
      }}
    >
      {LIST_SEGMENTS.map((item) => (
        <Button
          key={item.key}
          size="sm"
          variant={item.key === value ? 'secondary' : 'ghost'}
          aria-pressed={item.key === value}
          label={`${item.label} ${String(counts[item.key])}`}
          onClick={() => {
            onChange(item.key);
          }}
        />
      ))}
    </HStack>
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const COLUMN_LABELS: Record<ListColumnKey, string> = {
  select: '',
  client: 'Client',
  invoice: 'Invoice',
  status: 'Status & due',
  issued: 'Issued',
  total: 'Total',
  menu: '',
};

/** Which columns are right-aligned, per the design. */
const END_ALIGNED: ReadonlySet<ListColumnKey> = new Set<ListColumnKey>(['issued', 'total']);

/**
 * `VStack` renders a flex container; the table needs a grid, and the template
 * is computed per width so it cannot be a static `xstyle`. One shared style
 * factory keeps the header strip and every row on the exact same tracks — the
 * failure mode of a hand-built table is a header that drifts a pixel off its
 * body.
 */
function gridStyle(template: string): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: template,
    columnGap: COLUMN_GAP,
    alignItems: 'center',
  };
}

function ColumnHeader({
  columns,
  template,
  selectAll,
  onSelectAll,
}: {
  readonly columns: readonly ListColumnKey[];
  readonly template: string;
  readonly selectAll: boolean | 'indeterminate';
  readonly onSelectAll: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <VStack
      gap={0}
      paddingInline={6}
      paddingBlock={2}
      style={{
        ...gridStyle(template),
        borderBlockEnd: CARD_BORDER,
        background: 'var(--color-background-muted)',
      }}
    >
      {columns.map((column) =>
        column === 'select' ? (
          <CheckboxInput
            key={column}
            label="Select every invoice on this page"
            isLabelHidden
            size="sm"
            value={selectAll}
            onChange={onSelectAll}
          />
        ) : (
          <Text
            key={column}
            type="supporting"
            size="sm"
            weight="medium"
            maxLines={1}
            justify={END_ALIGNED.has(column) ? 'end' : 'start'}
            style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            {COLUMN_LABELS[column]}
          </Text>
        ),
      )}
    </VStack>
  );
}

/** The 6px status dot. A draft is a hollow ring — the absence of a state. */
function StateDot({
  tone,
  isHollow,
}: {
  readonly tone: RowTone;
  readonly isHollow: boolean;
}): React.JSX.Element {
  const colours = toneColours(tone);
  return (
    <VStack
      gap={0}
      width="var(--spacing-1-5)"
      height="var(--spacing-1-5)"
      style={{
        flex: 'none',
        borderRadius: 'var(--radius-full)',
        background: isHollow ? 'transparent' : colours.accent,
        border: isHollow ? '1px solid var(--color-border-emphasized)' : undefined,
      }}
    >
      {null}
    </VStack>
  );
}

/**
 * One ~48px row. The whole row is the click target — there is no `Open` button,
 * per the designer: *"the row is the target, hover reveals ⋯."*
 *
 * It is a `role="link"` with a keyboard handler rather than a `<button>`,
 * because a row contains a checkbox and a menu button and nesting those inside
 * a `<button>` is invalid HTML. Both stop propagation so ticking a box does not
 * also navigate.
 */
function InvoiceRow({
  row,
  columns,
  template,
  showsStatusDate,
  isSelected,
  isCursor,
  isLast,
  onOpen,
  onToggle,
  onFocus,
  registerRef,
}: {
  readonly row: ListRow;
  readonly columns: readonly ListColumnKey[];
  readonly template: string;
  readonly showsStatusDate: boolean;
  readonly isSelected: boolean;
  readonly isCursor: boolean;
  readonly isLast: boolean;
  readonly onOpen: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onFocus: (id: string) => void;
  readonly registerRef: (id: string, element: HTMLElement | null) => void;
}): React.JSX.Element {
  const tone = toneColours(row.tone);
  const isOverdue = row.state === 'overdue';

  const cell = (column: ListColumnKey): React.JSX.Element => {
    switch (column) {
      case 'select':
        return (
          <VStack
            key={column}
            gap={0}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
            }}
          >
            <CheckboxInput
              label={`Select ${row.invoice.number}`}
              isLabelHidden
              size="sm"
              value={isSelected}
              onChange={() => {
                onToggle(row.id);
              }}
            />
          </VStack>
        );
      case 'client':
        return (
          <HStack key={column} gap={2} align="center" style={{ minInlineSize: 0 }}>
            <VStack
              gap={0}
              align="center"
              justify="center"
              width={MONOGRAM_SIZE}
              height={MONOGRAM_SIZE}
              style={{
                flex: 'none',
                borderRadius: MONOGRAM_RADIUS,
                background: tone.chip,
              }}
            >
              <Text as="span" size="xsm" weight="semibold" style={{ color: tone.text }}>
                {row.monogram}
              </Text>
            </VStack>
            <StackItem size="fill">
              <Text maxLines={1} color={row.isMuted ? 'secondary' : 'primary'}>
                {row.clientName}
              </Text>
            </StackItem>
          </HStack>
        );
      case 'invoice':
        return (
          <Text key={column} type="code" size="sm" color="secondary" maxLines={1}>
            {row.invoice.number}
          </Text>
        );
      case 'status':
        return (
          <HStack key={column} gap={1.5} align="center" style={{ minInlineSize: 0 }}>
            <StateDot tone={row.tone} isHollow={row.isDotHollow} />
            <Text
              type="supporting"
              maxLines={1}
              color={isOverdue ? 'inherit' : row.isMuted ? 'secondary' : 'primary'}
              style={isOverdue ? { color: tone.text } : undefined}
            >
              {row.statusLabel}
            </Text>
            {row.statusDate === null || !showsStatusDate ? null : (
              <Text type="supporting" maxLines={1} hasTabularNumbers>
                {`· ${row.statusDate}`}
              </Text>
            )}
          </HStack>
        );
      case 'issued':
        return (
          <Text key={column} type="supporting" hasTabularNumbers justify="end" maxLines={1}>
            {row.issued}
          </Text>
        );
      case 'total':
        return (
          <Text
            key={column}
            hasTabularNumbers
            justify="end"
            maxLines={1}
            weight={row.isMuted ? 'normal' : 'semibold'}
            color={row.isMuted ? 'secondary' : 'primary'}
          >
            {row.amount}
          </Text>
        );
      case 'menu':
        return (
          <VStack
            key={column}
            gap={0}
            onClick={(event: React.MouseEvent) => {
              event.stopPropagation();
            }}
          >
            <MoreMenu
              label={`Actions for ${row.invoice.number}`}
              size="sm"
              items={[
                { label: 'Open', onClick: () => { onOpen(row.id); } },
                {
                  label: 'Edit',
                  onClick: () => {
                    onOpen(`${row.id}/edit`);
                  },
                },
              ]}
            />
          </VStack>
        );
    }
  };

  return (
    <VStack
      ref={(element: HTMLDivElement | null) => {
        registerRef(row.id, element);
      }}
      gap={0}
      paddingInline={6}
      paddingBlock={2}
      role="link"
      tabIndex={0}
      aria-label={`${row.clientName}, ${row.invoice.number}, ${row.statusLabel}, ${row.amount}`}
      onClick={() => {
        onOpen(row.id);
      }}
      onFocus={() => {
        onFocus(row.id);
      }}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        // Let the checkbox and the menu button keep their own keys.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onOpen(row.id);
      }}
      style={{
        ...gridStyle(template),
        cursor: 'pointer',
        borderBlockEnd: isLast ? undefined : CARD_BORDER,
        // Overdue rows carry a faint tint so they are findable while scrolling;
        // the cursor's own wash sits on top of it.
        background: isCursor
          ? 'var(--color-overlay-pressed)'
          : isOverdue
            ? tone.wash
            : undefined,
      }}
    >
      {columns.map(cell)}
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// Bulk action bar
// ---------------------------------------------------------------------------

/**
 * The strip below the pager, on an accent-tinted surface, that appears only
 * when the selection is non-empty.
 *
 * `Send reminder` is in the design and is not here: nothing in the frozen IPC
 * contract sends anything to a client, and a button that does nothing is worse
 * than an absent one. `Export` is `invoices:exportPdf`, which puts a save
 * dialog on screen per invoice, so it is offered for exactly one selected row.
 */
function BulkBar({
  selection,
  isBusy,
  onMarkPaid,
  onExport,
  onClear,
}: {
  readonly selection: ReturnType<typeof summariseSelection>;
  readonly isBusy: boolean;
  readonly onMarkPaid: () => void;
  readonly onExport: () => void;
  readonly onClear: () => void;
}): React.JSX.Element {
  const tone = toneColours('accent');
  const extra = extraCurrencyLabel(selection.extraCurrencies);
  return (
    <HStack
      justify="between"
      align="center"
      gap={3}
      wrap="wrap"
      paddingInline={6}
      paddingBlock={3}
      role="region"
      aria-label="Bulk actions"
      style={{ borderBlockStart: `1px solid ${tone.border}`, background: tone.wash }}
    >
      <HStack gap={2} align="center" wrap="wrap">
        <Text as="span" weight="semibold" style={{ color: tone.text }}>
          {selection.label}
        </Text>
        {selection.amount === '' ? null : (
          <Text as="span" hasTabularNumbers color="secondary">
            {extra === null ? selection.amount : `${selection.amount} (${extra})`}
          </Text>
        )}
      </HStack>
      <HStack gap={2} align="center" wrap="wrap">
        <Button
          label="Mark paid"
          variant="ghost"
          size="sm"
          // `Button` has no `disabledMessage`, and AGENTS.md forbids wrapping a
          // disabled control in `Tooltip` (it swallows the hover events), so the
          // reason rides in the accessible name.
          isDisabled={!selection.canMarkPaid || isBusy}
          aria-label={
            selection.canMarkPaid
              ? undefined
              : 'Mark paid — only issued, unsettled invoices can be marked paid'
          }
          onClick={onMarkPaid}
        />
        <Button
          label="Export PDF"
          variant="ghost"
          size="sm"
          isDisabled={!selection.canExport || isBusy}
          aria-label={
            selection.canExport
              ? undefined
              : 'Export PDF — writes one file at a time, so select a single invoice'
          }
          onClick={onExport}
        />
        <Button label="Clear" variant="ghost" size="sm" isDisabled={isBusy} onClick={onClear} />
      </HStack>
    </HStack>
  );
}
