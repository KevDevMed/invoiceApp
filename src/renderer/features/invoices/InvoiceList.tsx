/**
 * Invoices, as design 3a: one bordered card that answers *what do I owe
 * attention to* before it shows a single row.
 *
 * The shape, top to bottom, is the design's: card header, four money tiles,
 * status tabs with counts beside the search box and a read-only sort pill, the
 * chip bar for whatever the column menus have filtered by, a column header
 * strip where each header is its own sort + filter menu, a dense ~48px row list
 * that scrolls *inside* the card so the page never grows, a footer pager, and a
 * bulk action bar that appears only when rows are selected.
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
 *     row phrases its status and draws its monogram (./listRows), what a header
 *     menu shows and what a chip means (./columnMenu, ./filters), how the
 *     currency bar and its pager are built (./currencyBreakdown), and what the
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
import { Divider } from '@astryxdesign/core/Divider';
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
  applyChips,
  applyClientFilters,
  buildInvoiceSearchConfig,
  isUnfilteredRequest,
  openClientIdsOf,
  toListRequest,
} from './filters';
import type { ChipContext, FilterChip } from './filters';
import {
  LIST_SEGMENTS,
  adjacentRowId,
  countSegments,
  extraCurrencyLabel,
  isOpenState,
  matchesSegment,
  rowStateOf,
  segmentShowing,
} from './listGrouping';
import type { ListSegment } from './listGrouping';
import { columnDef, listLayoutAt } from './listColumns';
import type {
  ColumnFilterPredicate,
  ListColumnDef,
  ListColumnKey,
  ListFilterOption,
  SortColumnKey,
} from './listColumns';
import {
  EMPTY_DRAFT,
  addChip,
  arrowRotation,
  buildChip,
  chevronRotation,
  chipKey,
  chipLabel,
  headerAccessibleName,
  inputFieldLabels,
  isSortChoiceActive,
  menuAnchor,
  menuFocusSelectors,
  menuHandlesArrowKeys,
  removeChip,
  retainOpenMenu,
  sortLabelsFor,
  sortPillLabel,
  toggleMenu,
  validateFilterInput,
} from './columnMenu';
import type { FilterInputDraft } from './columnMenu';
import {
  buildCurrencyBreakdown,
  currencyPageAt,
  stepCurrencyPage,
} from './currencyBreakdown';
import type { CurrencyBreakdown } from './currencyBreakdown';
import { buildMoneyTiles, tileSlotTakesClicks } from './moneyTiles';
import type { MoneyTile } from './moneyTiles';
import {
  DEFAULT_SORT,
  buildListRows,
  footerSummary,
  nextSortState,
  sortRows,
} from './listRows';
import type { ListRow, RowTone, SortDirection, SortState } from './listRows';
import {
  retainVisible,
  selectAllValue,
  setSelectedForRows,
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

/**
 * The sort arrow, at the design's 9x10. It points up for ascending and is
 * flipped for descending by a transform on its wrapper, so the direction is one
 * value read in one place and the arrow can never disagree with the label that
 * set it.
 */
function SortArrowIcon(): React.JSX.Element {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M4.5 9.2V1.3M1.4 4.2 4.5 1 7.6 4.2"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The 8x5 disclosure chevron the design puts on every header and on the pill. */
function ChevronIcon(): React.JSX.Element {
  return (
    <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M1 1.2 4 4 7 1.2"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The 5x8 pager chevrons. `back` flips the same path rather than duplicating it. */
function PagerChevronIcon({ isBack }: { readonly isBack: boolean }): React.JSX.Element {
  return (
    <svg width="5" height="8" viewBox="0 0 5 8" fill="none" aria-hidden="true" focusable="false">
      <path
        d={isBack ? 'M3.8 1 1 4l2.8 3' : 'M1.2 1 4 4 1.2 7'}
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [isFilterBarOpen, setIsFilterBarOpen] = useState(false);
  /**
   * The column-menu filters, as structured chips. Session-local like every
   * other piece of state on this screen: the design never mentions persistence,
   * and the SideNav double-persist bug (CLAUDE.md) is this repo's standing
   * warning against adding storage casually.
   */
  const [chips, setChips] = useState<readonly FilterChip[]>([]);
  const [openMenu, setOpenMenu] = useState<SortColumnKey | null>(null);
  /** First index of the Outstanding tile's three-up currency window. */
  const [currencyIndex, setCurrencyIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [rawSelected, setRawSelected] = useState<ReadonlySet<string>>(new Set());

  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  /**
   * Every invoice in the workspace, ignoring the search term and the filter
   * tokens. `Has open balance` is a fact about a client rather than about a row,
   * so it is the one predicate that cannot be answered from the narrowed set —
   * see `isUnfilteredRequest`. Nothing else reads this.
   */
  const [allInvoices, setAllInvoices] = useState<Invoice[]>([]);
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

      // `total` is the size of the set the backend filter matched. Keep asking
      // for the next window until we hold all of it; an empty page ends the
      // loop too, so a shrinking list cannot spin here.
      const drain = async (
        build: (offset: number) => ReturnType<typeof toListRequest>,
      ): Promise<Invoice[] | null> => {
        const firstPage = await window.api.invoke('invoices:list', build(0));
        if (isStale()) return null;
        const collected = [...firstPage.items];
        while (collected.length < firstPage.total) {
          const next = await window.api.invoke('invoices:list', build(collected.length));
          if (isStale()) return null;
          if (next.items.length === 0) break;
          collected.push(...next.items);
        }
        return collected;
      };

      // The list response carries clientId only — join names client-side.
      const clientResult = await window.api.invoke('clients:list', { limit: 500, offset: 0 });
      if (isStale()) return;

      const collected = await drain(request);
      if (collected === null) return;

      // The unfiltered set behind `Has open balance`. Skipped entirely when the
      // request already narrows nothing, which is the common case — then the set
      // just loaded *is* every invoice.
      const everything = isUnfilteredRequest(request(0))
        ? collected
        : await drain((offset) => ({ limit: PAGE_LIMIT, offset }));
      if (everything === null) return;

      setInvoices(collected);
      setAllInvoices(everything);
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
  }, [search, filters, chips, segment, sort, pageSize]);

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

  /** Everything the filter-bar tokens match, before the header chips narrow it. */
  const tokenMatched = useMemo(
    () => applyClientFilters(invoices ?? [], filters),
    [invoices, filters],
  );

  /**
   * `Has open balance` is a fact about a *client*, not about the row it is
   * tested against, so it is resolved once rather than per invoice — and over
   * `allInvoices`, never over the narrowed set. On the `Paid` tab, or under an
   * issue-date chip, the very invoice that gives a client an open balance is
   * the one that is not on screen.
   */
  const chipContext: ChipContext = useMemo(
    () => ({
      today,
      clientNames,
      openClientIds: openClientIdsOf(allInvoices, today),
    }),
    [today, clientNames, allInvoices],
  );

  /** The whole matching set, before the status tab narrows it. */
  const matching = useMemo(
    () => applyChips(tokenMatched, chips, chipContext),
    [tokenMatched, chips, chipContext],
  );

  const counts = useMemo(() => countSegments(matching, today), [matching, today]);
  // The tiles describe the filtered set, not the tab — the point of the tiles
  // is to tell you which tab to press.
  const tiles = useMemo(
    () => buildMoneyTiles(matching, today, clientNames),
    [matching, today, clientNames],
  );

  /**
   * The Outstanding tile's currency split. Built from the open receivables the
   * tile's own figure covers, so the bar and the figure are about one set.
   */
  const breakdown = useMemo(
    () =>
      buildCurrencyBreakdown(
        matching.filter((invoice) => isOpenState(rowStateOf(invoice, today))),
      ),
    [matching, today],
  );

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
  // field, a modifier, or an open column menu has the keystroke.
  useEffect(() => {
    // An open menu owns the keyboard. Excluding text fields alone was not
    // enough: with a menu open, `J`/`K` moved row focus *behind* it and `/`
    // jumped to the search box while the menu stayed on screen, both of which
    // leave focus and the visible surface pointing at different things. The
    // menu has its own ArrowUp/ArrowDown and Escape.
    if (openMenu !== null) return;
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
  }, [move, openMenu]);

  const changeFilters = useCallback((next: readonly PowerSearchFilter[]) => {
    setFilters([...next]);
  }, []);

  // One document-level listener closes whichever header menu is open. Every
  // handler inside a menu stops propagation, so a click that lands on the menu
  // never reaches this; the listener is torn down with the component.
  useEffect(() => {
    if (openMenu === null) return;
    const close = (): void => {
      setOpenMenu(null);
    };
    document.addEventListener('click', close);
    return () => {
      document.removeEventListener('click', close);
    };
  }, [openMenu]);

  /**
   * The columns the header strip actually drew. Empty while loading and empty
   * when nothing matched, because both of those branches render no strip at all.
   */
  const headerColumns = useMemo(
    () => (invoices !== null && rows.length > 0 ? layout.columns : []),
    [invoices, rows.length, layout.columns],
  );

  // A menu cannot outlive the header that owns it. Without this the state and
  // the document listener above both survive an empty result set or a narrower
  // tier dropping the active column, and the menu re-opens by itself the moment
  // the column comes back.
  useEffect(() => {
    setOpenMenu((current) => retainOpenMenu(current, headerColumns));
  }, [headerColumns]);

  const applyChip = useCallback((predicate: ColumnFilterPredicate, value?: string) => {
    setChips((current) => addChip(current, buildChip(predicate, value)));
    setOpenMenu(null);
  }, []);

  const chooseSort = useCallback((column: SortColumnKey, direction: SortDirection) => {
    setSort((current) => nextSortState(current, column, direction));
    setOpenMenu(null);
  }, []);

  /**
   * `Chase all N`: applies the Overdue filter and selects those rows.
   *
   * It does not send anything. Nothing in the frozen IPC contract mails a
   * client — the same reason the bulk bar has no "Send reminder" — so the
   * button does the part that is real: it puts the reader in front of exactly
   * the invoices to chase, selected and ready for a bulk action.
   *
   * It moves the tab too, to Overdue, from every starting segment. The chip
   * alone was not enough: on `Sent`, `Drafts` or `Paid` the segment excludes
   * every overdue row, so the list went empty, the selection was narrowed to
   * the visible rows and therefore to none, and the button silently did
   * nothing. Sparing a tab that already shows overdue rows was not enough
   * either: `All` shows everything, so Chase from `All` kept `All` pressed and
   * left `Overdue` at `aria-pressed="false"` — one button behaving two ways
   * depending on where it was pressed from. It lands on Overdue always.
   */
  const chaseOverdue = useCallback(() => {
    const overdueIds = matching
      .filter((invoice) => rowStateOf(invoice, today) === 'overdue')
      .map((invoice) => invoice.id);
    setSegment(segmentShowing('overdue'));
    setChips((current) => addChip(current, buildChip('status-overdue')));
    setRawSelected(new Set(overdueIds));
    setOpenMenu(null);
  }, [matching, today]);

  const toggleRow = useCallback((id: string) => {
    setRawSelected((current) => toggleSelected(current, id));
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setRawSelected((current) => setSelectedForRows(current, pageRows, checked));
    },
    [pageRows],
  );

  /**
   * A status change has to land in both of the list's copies of the row — the
   * narrowed one it renders and the unfiltered one `Has open balance` reads, or
   * marking an invoice paid would leave its client "open" until the next load.
   */
  const applyInvoiceChange = useCallback((updated: Invoice) => {
    const merge = (invoice: Invoice): Invoice =>
      invoice.id === updated.id ? { ...invoice, ...updated } : invoice;
    setInvoices((current) => (current === null ? current : current.map(merge)));
    setAllInvoices((current) => current.map(merge));
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

  const hasActiveFilters =
    filters.length > 0 || chips.length > 0 || search.trim() !== '' || segment !== 'all';

  /**
   * The subtitle leads with the number that needs acting on, not the inventory
   * count — the design's own change.
   *
   * What it does **not** say is the design's `USD equiv.`: there is no exchange
   * rate anywhere in this app, so a claim that every tile is one currency's
   * worth would be false. The currency *count* is true and is what the bar
   * above it is a picture of, so that is what rides here — and a
   * single-currency workspace says nothing at all rather than "1 currency".
   */
  const chasingCount = tiles.find((tile) => tile.key === 'overdue')?.count ?? 0;
  const workspaceCurrencies = new Set(matching.map((invoice) => invoice.currency)).size;
  const headerLine =
    invoices === null
      ? 'Loading…'
      : `${String(chasingCount)} ${chasingCount === 1 ? 'invoice needs' : 'invoices need'} chasing today${
          workspaceCurrencies > 1 ? ` · ${String(workspaceCurrencies)} currencies` : ''
        }`;

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
            breakdown={breakdown}
            currencyIndex={currencyIndex}
            onCurrencyIndex={setCurrencyIndex}
            onApply={applyChip}
            onChase={chaseOverdue}
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
              <SortPill sort={sort} />
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

        {/* The chip bar exists only while it has something in it, and it sits
            outside the loading/empty branch on purpose: a filter that emptied
            the list is exactly the one the reader needs to be able to remove. */}
        {chips.length === 0 ? null : (
          <FilterChipBar
            chips={chips}
            onRemove={(key) => {
              setChips((current) => removeChip(current, key));
            }}
            onClear={() => {
              setChips([]);
            }}
          />
        )}

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
              sort={sort}
              openMenu={openMenu}
              onToggleMenu={(column) => {
                setOpenMenu((current) => toggleMenu(current, column));
              }}
              onCloseMenu={() => {
                setOpenMenu(null);
              }}
              onSort={chooseSort}
              onApply={applyChip}
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
 * The tile grid. Outstanding gets the widest track because it is the only tile
 * carrying a bar and a pager; the rest step down from there. Structural
 * fractions, straight from the design — no spacing token expresses `1.55fr`.
 */
const TILE_TEMPLATES: Record<1 | 2 | 4, string> = {
  4: '1.55fr 1.15fr 1fr 1fr',
  2: '1fr 1fr',
  1: '1fr',
};

/** The proportion bar's height and a segment's floor width, both from the design. */
const BAR_HEIGHT = '4px';
const BAR_MIN_SEGMENT = '10px';

/**
 * Four figures before a single row. The overdue tile is the only coloured one,
 * exactly as the design has it — one tinted surface among four reads as an
 * alarm, four read as decoration.
 *
 * Every tile is a filter shortcut: clicking anywhere on the card applies the
 * filter it describes, producing the same chip the matching column-menu option
 * would.
 *
 * How the whole card can be pressable without any control being inside another:
 *
 * The card used to be a `role="button"` wrapping the Overdue tile's
 * `Chase all N` and the Outstanding tile's two pager buttons. Avoiding a nested
 * native `<button>` did not avoid nested interactive semantics — a control
 * inside a control is flattened or exposed inconsistently depending on the
 * assistive technology, so the reader either cannot reach `Chase all` or cannot
 * tell what it belongs to. Making only the label-and-figure region the control
 * fixed the tree and broke the affordance the other way: the header count, the
 * sub-line and the proportion bar all went inert, and a card that looks like one
 * target but answers on a third of itself is worse than either.
 *
 * So the card is plain `position: relative` layout, the filter region is a real
 * `<button>` that is deliberately `position: static`, and that button carries a
 * decorative absolutely-positioned child pinned to `inset: 0` — which therefore
 * resolves against the *card*, not the button, and stretches one hit area over
 * the whole tile. One control, the card's full bounds, nothing nested.
 *
 * Everything painted after that overlay has to say what it wants:
 *
 * - `Chase all N` and the currency pager sit above it (`position: relative`,
 *   `zIndex: 1`) and take their own clicks.
 * - The header count and the proportion bar are text and decoration; they let
 *   the click through (`pointerEvents: 'none'`) so the region under them still
 *   filters. `tileSlotTakesClicks` is the one place that decision is written.
 * - The sub-line and the extra-currency line are unpositioned, so the overlay
 *   already covers them.
 *
 * A tile with more than one currency behind it says how many rather than
 * converting: this app has no exchange rate.
 */
function MoneyTiles({
  tiles,
  columns,
  breakdown,
  currencyIndex,
  onCurrencyIndex,
  onApply,
  onChase,
}: {
  readonly tiles: readonly MoneyTile[];
  readonly columns: 1 | 2 | 4;
  readonly breakdown: CurrencyBreakdown;
  readonly currencyIndex: number;
  readonly onCurrencyIndex: (index: number) => void;
  readonly onApply: (predicate: ColumnFilterPredicate) => void;
  readonly onChase: () => void;
}): React.JSX.Element {
  return (
    <VStack
      gap={0}
      style={{
        display: 'grid',
        gridTemplateColumns: TILE_TEMPLATES[columns],
        gap: 'var(--spacing-2)',
        alignItems: 'stretch',
      }}
    >
      {tiles.map((tile) => {
        const tone = tile.tone === 'error' ? toneColours('error') : null;
        const extra = extraCurrencyLabel(tile.extraCurrencies);
        const isLead = tile.key === 'outstanding' || tile.key === 'overdue';
        const showsBreakdown = tile.key === 'outstanding' && breakdown.hasBreakdown;
        return (
          <VStack
            key={tile.key}
            gap={showsBreakdown ? 1.5 : 1}
            paddingInline={4}
            paddingBlock={3}
            style={{
              border: `1px solid ${tone === null ? 'var(--color-border)' : tone.border}`,
              borderRadius: 'var(--radius-container)',
              background: tone === null ? 'var(--color-background-muted)' : tone.wash,
              // The top-right slot hangs off this box.
              position: 'relative',
            }}
          >
            {/* The one control the tile's own click is. `position: static` and
                `transform: none` are both load-bearing: they are what hands the
                overlay below the *card* as its containing block, which is what
                makes the hit area the card rather than the button. Astryx's
                `Button` is `position: relative` with a `transform: scale(1)`
                press effect, and a transform establishes a containing block for
                absolutely-positioned descendants even when the element is
                static — so dropping only the `position` left the overlay
                exactly the size of the button and the sub-line still inert. */}
            <Button
              label={`Filter by ${tile.label}`}
              variant="ghost"
              width="100%"
              onClick={() => {
                onApply(tile.predicate);
              }}
              style={{
                position: 'static',
                transform: 'none',
                justifyContent: 'flex-start',
                textAlign: 'start',
                paddingInline: 0,
                paddingBlock: 0,
                blockSize: 'auto',
                background: 'transparent',
                borderColor: 'transparent',
              }}
            >
              <VStack gap={1} align="start" width="100%">
                <Text
                  type="supporting"
                  weight={tone === null ? 'medium' : 'semibold'}
                  style={tone === null ? undefined : { color: tone.text }}
                >
                  {tile.label}
                </Text>
                <Text
                  as="span"
                  size={isLead ? '2xl' : 'xl'}
                  weight="semibold"
                  hasTabularNumbers
                  style={tone === null ? undefined : { color: tone.text }}
                >
                  {tile.figure}
                </Text>
              </VStack>
              {/* The stretched hit area. Decorative and inside the button, so
                  it adds nothing to the tree and nothing to the name. */}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 'var(--radius-container)',
                }}
              />
            </Button>

            {/* A sibling of that control, never a descendant of it. It is drawn
                over the hit area, so it either takes the click or waives it. */}
            <VStack
              gap={0}
              align="end"
              style={{
                position: 'absolute',
                insetBlockStart: 'var(--spacing-3)',
                insetInlineEnd: 'var(--spacing-4)',
                zIndex: 1,
                pointerEvents: tileSlotTakesClicks(tile.key) ? undefined : 'none',
              }}
            >
              {tile.key === 'overdue' ? (
                <Button
                  label={`Chase all ${String(tile.count)}`}
                  variant="secondary"
                  size="sm"
                  isDisabled={tile.count === 0}
                  onClick={onChase}
                />
              ) : (
                <Text type="code" size="xsm" color="secondary" hasTabularNumbers>
                  {tile.headerCount}
                </Text>
              )}
            </VStack>

            {showsBreakdown ? (
              <CurrencyBar
                breakdown={breakdown}
                index={currencyIndex}
                onIndex={onCurrencyIndex}
              />
            ) : (
              <Text type="supporting" hasTabularNumbers maxLines={1}>
                {tile.detail}
              </Text>
            )}

            {extra === null || showsBreakdown ? null : (
              <Text type="supporting" hasTabularNumbers maxLines={1}>
                {extra}
              </Text>
            )}
          </VStack>
        );
      })}
    </VStack>
  );
}

/**
 * The Outstanding tile's proportion bar and currency pager.
 *
 * The bar's widths are shares of the invoice *count*, not of value: a count is
 * the only quantity comparable across currencies without a rate (see
 * ./currencyBreakdown). The pager prints each currency's own total beside its
 * code. It sits beside the tile's filter button rather than inside it, so
 * paging cannot fire click-to-filter and there is nothing to stop propagating.
 *
 * The bar and the pager sit on opposite sides of the tile's stretched hit area
 * (see `MoneyTiles`): the bar is decoration and waives its clicks so the region
 * still filters, the pager is a control and is lifted above the overlay so its
 * two arrows answer first.
 */
function CurrencyBar({
  breakdown,
  index,
  onIndex,
}: {
  readonly breakdown: CurrencyBreakdown;
  readonly index: number;
  readonly onIndex: (next: number) => void;
}): React.JSX.Element {
  const page = currencyPageAt(breakdown.segments, index);
  return (
    <VStack gap={1.5}>
      <HStack
        gap={0.5}
        align="stretch"
        aria-hidden="true"
        style={{ blockSize: BAR_HEIGHT, pointerEvents: 'none' }}
      >
        {breakdown.segments.map((segment) => (
          <VStack
            key={segment.currency}
            gap={0}
            style={{
              flex: `${String(Math.round(segment.share * 1000))} 1 0`,
              minInlineSize: BAR_MIN_SEGMENT,
              borderRadius: 'var(--radius-full)',
              background: toneColours('accent').accent,
              opacity: segment.opacity,
            }}
          >
            {null}
          </VStack>
        ))}
      </HStack>

      <HStack
        gap={2}
        align="center"
        role="group"
        aria-label="Outstanding by currency"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <Button
          label="Previous currencies"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<PagerChevronIcon isBack />}
          isDisabled={!page.canPrevious}
          onClick={() => {
            onIndex(stepCurrencyPage(breakdown.segments, index, -1));
          }}
        />
        <StackItem size="fill">
          <HStack gap={3} align="center" style={{ overflow: 'hidden' }}>
            {page.entries.map((segment) => (
              <Text
                key={segment.currency}
                type="code"
                size="xsm"
                color="secondary"
                hasTabularNumbers
                style={{ whiteSpace: 'nowrap' }}
              >
                {`${segment.currency} ${segment.amount}`}
              </Text>
            ))}
          </HStack>
        </StackItem>
        <Button
          label="More currencies"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<PagerChevronIcon isBack={false} />}
          isDisabled={!page.canNext}
          onClick={() => {
            onIndex(stepCurrencyPage(breakdown.segments, index, 1));
          }}
        />
      </HStack>
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// The read-only sort pill
// ---------------------------------------------------------------------------

/**
 * The toolbar's old sort dropdown, now a read-out.
 *
 * Sorting moved onto the column headers, so a second control that could set it
 * would be a second source of truth. This is the same arrow the active header
 * shows, rotating with the direction, plus the column's name — and it is not
 * focusable, because there is nothing here to operate.
 */
function SortPill({ sort }: { readonly sort: SortState }): React.JSX.Element {
  return (
    <HStack
      gap={1.5}
      align="center"
      paddingInline={3}
      paddingBlock={2}
      role="status"
      style={{
        border: CARD_BORDER,
        borderRadius: 'var(--radius-element)',
        background: 'var(--color-background-muted)',
      }}
    >
      <HStack
        gap={0}
        align="center"
        style={{
          color: toneColours('accent').accent,
          transform: arrowRotation(sort.direction),
          transition: 'transform 140ms ease',
        }}
      >
        <SortArrowIcon />
      </HStack>
      <Text type="supporting" color="secondary">
        Sorted:
      </Text>
      <Text type="supporting" color="primary">
        {sortPillLabel(sort.column)}
      </Text>
      <HStack gap={0} align="center" style={{ opacity: 0.5 }}>
        <ChevronIcon />
      </HStack>
    </HStack>
  );
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

/**
 * The chip bar, directly above the header row.
 *
 * A chip prints a label derived from its structured identity, which is also
 * what decides whether it is a duplicate — the design's flat strings could not
 * tell `TOTAL: Between 1,000 – 5,000` from the same range typed without commas.
 */
function FilterChipBar({
  chips,
  onRemove,
  onClear,
}: {
  readonly chips: readonly FilterChip[];
  readonly onRemove: (key: string) => void;
  readonly onClear: () => void;
}): React.JSX.Element {
  return (
    <HStack
      gap={2}
      align="center"
      wrap="wrap"
      paddingInline={6}
      paddingBlock={2}
      role="group"
      aria-label="Active column filters"
      style={{
        borderBlockEnd: CARD_BORDER,
        background: 'var(--color-background-muted)',
      }}
    >
      <Text type="code" size="xsm" color="secondary" style={{ letterSpacing: '0.06em' }}>
        FILTERS
      </Text>
      {chips.map((chip) => {
        const key = chipKey(chip);
        return (
          <Token
            key={key}
            label={chipLabel(chip)}
            onRemove={() => {
              onRemove(key);
            }}
          />
        );
      })}
      <Button label="Clear all" variant="ghost" size="sm" onClick={onClear} />
    </HStack>
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

/** The design's `top:26px` drop and `min-width:206px` menu. Structural. */
const MENU_TOP = '26px';
const MENU_MIN_WIDTH = '206px';
/** The design's 4px radio dot. */
const RADIO_DOT = '4px';

/**
 * The header strip: one sort + filter menu per column.
 *
 * The ARIA is this file's own — the mock has none. Each header is a real
 * `<button>` with `aria-haspopup="menu"` and `aria-expanded`, and that is the
 * whole of it: no `role="table"`, no `row`, no `columnheader`, no `aria-sort`.
 *
 * Those were here, and they described something that did not exist. The strip
 * was a one-row `table` while the data rows below were `role="link"` siblings
 * *outside* it, so assistive technology met a table of column headers with no
 * rows and then an unassociated pile of links; the `aria-sort` on those headers
 * was syntactically valid and structurally meaningless. Making the rows real
 * cells is not available — the row is the click target and carries a checkbox
 * and a menu button, none of which survives a cell tree — so the scaffolding is
 * gone rather than half-built, and the sort state is announced where it is
 * operated: in each header button's own accessible name (`headerAccessibleName`
 * in ./columnMenu). `group` is what this strip actually is.
 */
function ColumnHeader({
  columns,
  template,
  selectAll,
  onSelectAll,
  sort,
  openMenu,
  onToggleMenu,
  onCloseMenu,
  onSort,
  onApply,
}: {
  readonly columns: readonly ListColumnKey[];
  readonly template: string;
  readonly selectAll: boolean | 'indeterminate';
  readonly onSelectAll: (checked: boolean) => void;
  readonly sort: SortState;
  readonly openMenu: SortColumnKey | null;
  readonly onToggleMenu: (column: SortColumnKey) => void;
  readonly onCloseMenu: () => void;
  readonly onSort: (column: SortColumnKey, direction: SortDirection) => void;
  readonly onApply: (predicate: ColumnFilterPredicate, value?: string) => void;
}): React.JSX.Element {
  return (
    <VStack
      gap={0}
      role="group"
      aria-label="Invoice columns"
      paddingInline={6}
      paddingBlock={2}
      style={{
        borderBlockEnd: CARD_BORDER,
        background: 'var(--color-background-muted)',
        // The menus drop out of this strip and must paint over the rows below.
        position: 'relative',
        zIndex: 5,
      }}
    >
      <VStack gap={0} style={gridStyle(template)}>
        {columns.map((column) => {
          const definition = columnDef(column);
          if (column === 'select') {
            return (
              <VStack key={column} gap={0}>
                <CheckboxInput
                  label="Select every invoice on this page"
                  isLabelHidden
                  size="sm"
                  value={selectAll}
                  onChange={onSelectAll}
                />
              </VStack>
            );
          }
          if (!definition.sortable) {
            // The ⋯ gutter: a track with nothing in it, announced as nothing.
            return (
              <VStack key={column} gap={0}>
                {null}
              </VStack>
            );
          }
          return (
            <ColumnHeaderCell
              key={column}
              definition={definition}
              sort={sort}
              isOpen={openMenu === definition.key}
              onToggle={onToggleMenu}
              onClose={onCloseMenu}
              onSort={onSort}
              onApply={onApply}
            />
          );
        })}
      </VStack>
    </VStack>
  );
}

/**
 * One header cell: the label, the arrow the active column alone shows, the
 * chevron every column shows, and the menu that drops from it.
 *
 * Focus returns to the button when the menu closes, whichever way it closed —
 * a menu that leaves focus on a removed node drops the reader back to the top
 * of the document.
 */
function ColumnHeaderCell({
  definition,
  sort,
  isOpen,
  onToggle,
  onClose,
  onSort,
  onApply,
}: {
  readonly definition: ListColumnDef;
  readonly sort: SortState;
  readonly isOpen: boolean;
  readonly onToggle: (column: SortColumnKey) => void;
  readonly onClose: () => void;
  readonly onSort: (column: SortColumnKey, direction: SortDirection) => void;
  readonly onApply: (predicate: ColumnFilterPredicate, value?: string) => void;
}): React.JSX.Element {
  const column = definition.key as SortColumnKey;
  const isActive = sort.column === column;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !isOpen) buttonRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);

  return (
    <VStack
      gap={0}
      style={{
        position: 'relative',
        minInlineSize: 0,
        alignItems: definition.align === 'end' ? 'flex-end' : 'flex-start',
      }}
    >
      <Button
        ref={buttonRef}
        // The sort state rides in the accessible name because there is no table
        // for `aria-sort` to belong to — see the strip's own comment.
        label={headerAccessibleName(definition, sort)}
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(event) => {
          // Keep this click away from the document listener that closes menus,
          // or opening one would immediately close it again.
          event.stopPropagation();
          onToggle(column);
        }}
        style={{ paddingInline: 'var(--spacing-1)', maxInlineSize: '100%' }}
        endContent={
          <HStack
            gap={0}
            align="center"
            style={{
              opacity: 0.5,
              transform: chevronRotation(isOpen),
              transition: 'transform 140ms ease',
            }}
          >
            <ChevronIcon />
          </HStack>
        }
      >
        <HStack gap={1} align="center" style={{ minInlineSize: 0 }}>
          <Text
            type="supporting"
            size="sm"
            weight="medium"
            maxLines={1}
            color={isActive ? 'primary' : 'secondary'}
            style={{ letterSpacing: '0.04em' }}
          >
            {definition.label}
          </Text>
          {/* Only the active column carries an arrow — an arrow on every header
              says nothing about which one the list is actually in. */}
          {isActive ? (
            <HStack
              gap={0}
              align="center"
              style={{
                flex: 'none',
                color: toneColours('accent').accent,
                transform: arrowRotation(sort.direction),
                transition: 'transform 140ms ease',
              }}
            >
              <SortArrowIcon />
            </HStack>
          ) : null}
        </HStack>
      </Button>

      {isOpen ? (
        <ColumnMenu
          definition={definition}
          sort={sort}
          onSort={onSort}
          onApply={onApply}
          onClose={onClose}
        />
      ) : null}
    </VStack>
  );
}

/**
 * The menu itself: a SORT section of two radio rows, a divider, and a FILTER
 * section of one row per option.
 *
 * Choosing an ellipsis option swaps this body in place for an input step rather
 * than opening a second floating surface. Astryx's `usePopover` traps focus
 * unconditionally (CLAUDE.md), so a popover inside a popover would leave the
 * reader unable to Tab out of either; one surface has one focus context.
 */
function ColumnMenu({
  definition,
  sort,
  onSort,
  onApply,
  onClose,
}: {
  readonly definition: ListColumnDef;
  readonly sort: SortState;
  readonly onSort: (column: SortColumnKey, direction: SortDirection) => void;
  readonly onApply: (predicate: ColumnFilterPredicate, value?: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const column = definition.key as SortColumnKey;
  const anchor = menuAnchor(definition.align);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<ListFilterOption | null>(null);
  const [draft, setDraft] = useState<FilterInputDraft>(EMPTY_DRAFT);

  // Opening a menu with the mouse should still land the keyboard inside it —
  // and the value step has to land it in the *field*, which is the only thing
  // on that page there is anything to do with. `button` alone put it on Cancel.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    for (const selector of menuFocusSelectors(pending !== null)) {
      const target = surface.querySelector<HTMLElement>(selector);
      if (target !== null) {
        target.focus();
        return;
      }
    }
  }, [pending]);

  const items = (): HTMLButtonElement[] =>
    [...(surfaceRef.current?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    // Up/Down belong to the caret once a field has the focus.
    if (!menuHandlesArrowKeys(pending !== null)) return;
    const all = items();
    const here = all.indexOf(document.activeElement as HTMLButtonElement);
    if (all.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = here === -1 ? 0 : (here + step + all.length) % all.length;
    all[next]?.focus();
  };

  const commit = (option: ListFilterOption): void => {
    if (option.input === 'none') {
      onApply(option.predicate);
      return;
    }
    setDraft(EMPTY_DRAFT);
    setPending(option);
  };

  const result = pending === null ? null : validateFilterInput(pending.input, draft);
  const fields = pending === null ? [] : inputFieldLabels(pending.input);

  return (
    <VStack
      ref={surfaceRef}
      gap={0}
      padding={1}
      role="menu"
      aria-label={`${definition.label} sort and filter`}
      onClick={(event: React.MouseEvent) => {
        event.stopPropagation();
      }}
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute',
        insetBlockStart: MENU_TOP,
        insetInlineStart: anchor.insetInlineStart,
        insetInlineEnd: anchor.insetInlineEnd,
        minInlineSize: MENU_MIN_WIDTH,
        background: 'var(--color-background-surface)',
        border: '1px solid var(--color-border-emphasized)',
        borderRadius: 'var(--radius-container)',
        boxShadow: 'var(--shadow-lg, 0 18px 44px rgba(0,0,0,0.35))',
        zIndex: 40,
        letterSpacing: 0,
        cursor: 'default',
      }}
    >
      {pending === null ? (
        <>
          <MenuSectionLabel>SORT</MenuSectionLabel>
          {sortLabelsFor(definition.kind).map((choice) => (
            <Button
              key={choice.direction}
              label={choice.label}
              variant="ghost"
              size="sm"
              role="menuitemradio"
              aria-checked={isSortChoiceActive(sort, column, choice.direction)}
              width="100%"
              // A menu row reads down a left edge; `Button` centres its content
              // by default, which turns the list into a ragged column.
              style={{ justifyContent: 'flex-start' }}
              icon={
                <VStack
                  gap={0}
                  width={RADIO_DOT}
                  height={RADIO_DOT}
                  style={{
                    flex: 'none',
                    borderRadius: 'var(--radius-full)',
                    background: isSortChoiceActive(sort, column, choice.direction)
                      ? toneColours('accent').accent
                      : 'transparent',
                  }}
                >
                  {null}
                </VStack>
              }
              onClick={(event) => {
                event.stopPropagation();
                onSort(column, choice.direction);
              }}
            />
          ))}
          {definition.filterOptions.length === 0 ? null : (
            <>
              <VStack paddingBlock={1} paddingInline={0.5}>
                <Divider />
              </VStack>
              <MenuSectionLabel>FILTER</MenuSectionLabel>
              {definition.filterOptions.map((option) => (
                <Button
                  key={option.predicate}
                  label={option.label}
                  variant="ghost"
                  size="sm"
                  role="menuitem"
                  width="100%"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={(event) => {
                    event.stopPropagation();
                    commit(option);
                  }}
                />
              ))}
            </>
          )}
        </>
      ) : (
        <VStack gap={2} padding={2}>
          <Text type="supporting" weight="medium">
            {pending.label.replace('…', '')}
          </Text>
          {fields.map((field, index) => (
            <TextInput
              key={field}
              label={field}
              size="sm"
              value={index === 0 ? draft.from : draft.to}
              onChange={(value) => {
                setDraft((current) =>
                  index === 0 ? { ...current, from: value } : { ...current, to: value },
                );
              }}
            />
          ))}
          {result === null || result.error === null ? null : (
            <Text type="supporting" color="secondary">
              {result.error}
            </Text>
          )}
          <HStack gap={2} justify="end">
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setPending(null);
              }}
            />
            <Button
              label="Apply"
              variant="primary"
              size="sm"
              isDisabled={result === null || !result.isValid}
              onClick={(event) => {
                event.stopPropagation();
                if (result === null || !result.isValid) return;
                onApply(pending.predicate, result.value);
              }}
            />
          </HStack>
        </VStack>
      )}
    </VStack>
  );
}

/** `SORT` / `FILTER` — the menu's two monospace section headings. */
function MenuSectionLabel({
  children,
}: {
  readonly children: string;
}): React.JSX.Element {
  return (
    <VStack paddingInline={2} paddingBlock={1}>
      <Text type="code" size="2xs" color="secondary" style={{ letterSpacing: '0.06em' }}>
        {children}
      </Text>
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
