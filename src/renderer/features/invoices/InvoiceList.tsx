/**
 * Invoice list: inline filter tokens over a dense, paginated table.
 *
 * The filter bar is a `PowerSearch`; everything it produces is interpreted by
 * the pure helpers in ./filters — the part the backend understands goes into
 * the `invoices:list` request, the rest is applied over the fetched set here.
 * That fetched set is the *whole* matching set: `load` pages `invoices:list`
 * until it holds `total` rows, so the client-side filters and the footer count
 * both speak for every invoice, not for the first window of them.
 * Paging is client-side over that filtered set via the shared helpers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { Avatar } from '@astryxdesign/core/Avatar';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { PowerSearch } from '@astryxdesign/core/PowerSearch';
import type {
  PowerSearchComponents,
  PowerSearchConfig,
  PowerSearchFilter,
  PowerSearchTokenProps,
} from '@astryxdesign/core/PowerSearch';
import { Token } from '@astryxdesign/core/Token';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Table, pixel, proportional, useTableSelection, useTableSelectionState } from '@astryxdesign/core/Table';
import type { TableColumn } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Client, Invoice } from '../../../shared/types';
import { ListFooter } from '../../ui/ListFooter';
import { Page, PageHeader, PageToolbar } from '../../ui/Page';
import { pageSlice } from '../../ui/pagination';
import { isEffectivelyOverdue, money } from './format';
import {
  DEFAULT_SORT,
  FIELD_AMOUNT,
  FIELD_CLIENT,
  FIELD_ISSUED,
  FIELD_NUMBER,
  FIELD_STATUS,
  SORT_OPTIONS,
  applyClientFilters,
  buildInvoiceSearchConfig,
  sortInvoices,
  toListRequest,
} from './filters';
import type { InvoiceSortKey } from './filters';

/**
 * Rows per `invoices:list` request. The contract caps `limit` at 500
 * (src/shared/ipc-contract.ts, `Pagination`), so this is one round trip per 500
 * matching invoices — the whole matching set is pulled, never a prefix of it.
 * The database is local SQLite on the user's own machine, so this is cheap, and
 * it is the only way the footer count and the renderer-side filters can be
 * true: a filter that only sees the first page silently loses every match past
 * it, while the footer still prints an exact "of N".
 */
const PAGE_LIMIT = 500;

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
 * PowerSearch's own token (node_modules/@astryxdesign/core/src/PowerSearch/
 * PowerSearch.tsx:798-844) renders one flat `Field: operator` string and only
 * ever passes an `icon` for single-entity filters — a configured `field.icon`
 * reaches the typeahead list (PowerSearch.tsx:869-885) and nothing else. The
 * sanctioned way past that is the per-type `components.Token` override
 * (PowerSearch.tsx:778-796; PowerSearchToken.tsx:30-33 documents it), which is
 * what this is: the shipped `Token` with the icon slot filled and the three
 * parts kept as separate runs of text.
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

/** Only errors and overdue invoices earn a loud badge; the rest stay quiet. */
function statusBadge(invoice: Invoice): React.JSX.Element {
  if (isEffectivelyOverdue(invoice)) return <Badge variant="red" label="overdue" />;
  switch (invoice.status) {
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

interface InvoiceRow extends Record<string, unknown> {
  id: string;
  number: string;
  clientName: string;
  issueDate: string;
  dueDate: string;
  total: string;
  invoice: Invoice;
}

export function InvoiceList(): React.JSX.Element {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<readonly PowerSearchFilter[]>([]);
  const [sort, setSort] = useState<InvoiceSortKey>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Every load takes a ticket; only the newest one is allowed to write state.
  // Paging is several awaits long, so a load started by an earlier search term
  // can finish after a later one and would otherwise overwrite it.
  const loadTicket = useRef(0);

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
      // loop too, so a shrinking table cannot spin here.
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

  // Any change to what is being looked at sends the reader back to page one.
  // It also drops the row selection: filters, search and sort all change which
  // rows exist, so a selection made against the old set would survive unseen
  // and reappear later. Paging only moves a window over the same set, so it
  // keeps the selection.
  const changeSearch = useCallback((term: string) => {
    setSearch(term);
    setPage(1);
    setSelectedKeys(new Set());
  }, []);
  const changeFilters = useCallback((next: readonly PowerSearchFilter[]) => {
    setFilters([...next]);
    setPage(1);
    setSelectedKeys(new Set());
  }, []);
  const changeSort = useCallback((next: InvoiceSortKey) => {
    setSort(next);
    setPage(1);
    setSelectedKeys(new Set());
  }, []);
  const changePageSize = useCallback((next: number) => {
    setPageSize(next);
    setPage(1);
  }, []);

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

  const visible = useMemo(
    () => sortInvoices(applyClientFilters(invoices ?? [], filters), sort),
    [invoices, filters, sort],
  );

  const rows: InvoiceRow[] = useMemo(
    () =>
      pageSlice(visible, page, pageSize).map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        clientName: clientNames.get(invoice.clientId) ?? invoice.clientId,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        total: money(invoice.totalCents, invoice.currency),
        invoice,
      })),
    [visible, page, pageSize, clientNames],
  );

  const { selectionConfig } = useTableSelectionState<InvoiceRow>({
    data: rows,
    idKey: 'id',
    selectedKeys,
    setSelectedKeys,
  });
  const selectionPlugin = useTableSelection<InvoiceRow>(selectionConfig);

  const columns: TableColumn<InvoiceRow>[] = useMemo(
    () => [
      {
        key: 'clientName',
        header: 'Client',
        width: proportional(2),
        renderCell: (row: InvoiceRow) => (
          <HStack gap={2} align="center">
            <Avatar size="sm" name={row.clientName} />
            <Text>{row.clientName}</Text>
          </HStack>
        ),
      },
      { key: 'number', header: 'Invoice #', width: pixel(140) },
      { key: 'issueDate', header: 'Issued', width: pixel(120) },
      { key: 'dueDate', header: 'Due', width: pixel(120) },
      {
        key: 'status',
        header: 'Status',
        width: pixel(120),
        renderCell: (row: InvoiceRow) => statusBadge(row.invoice),
      },
      { key: 'total', header: 'Total', width: pixel(140), align: 'end' },
      {
        key: 'actions',
        header: '',
        width: pixel(90),
        align: 'end',
        renderCell: (row: InvoiceRow) => (
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
    ],
    [navigate],
  );

  const hasActiveFilters = filters.length > 0 || search.trim() !== '';
  const selectedCount = rows.filter((row) => selectedKeys.has(row.id)).length;

  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Every invoice in this workspace, filtered inline."
        actions={
          <Button
            label="New invoice"
            variant="primary"
            onClick={() => {
              void navigate('new');
            }}
          />
        }
      />

      <PageToolbar
        end={
          <>
            <TextInput
              label="Search invoices"
              isLabelHidden
              placeholder="Search"
              startIcon="search"
              hasClear
              value={search}
              onChange={changeSearch}
            />
            <Selector
              label="Sort order"
              isLabelHidden
              value={sort}
              options={SORT_OPTIONS.map((option) => ({ ...option }))}
              onChange={(value) => {
                changeSort(value as InvoiceSortKey);
              }}
            />
          </>
        }
      >
        {/* PowerSearch sizes to its tokens; as a bare flex item the tokens run
            into its own result count, so it gets a filling item to live in. */}
        <StackItem size="fill">
          <PowerSearch
            label="Filter invoices"
            config={config}
            components={SEARCH_COMPONENTS}
            filters={filters}
            onChange={changeFilters}
            placeholder="Add filter"
            // The built-in clear-all reports itself as a single token removal
            // (Tokenizer hands PowerSearch an empty array, PowerSearch throws it
            // away and recomputes filters minus one index), so one click only
            // ever drops one token. Own control, one click, every token.
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
            resultCount={invoices === null ? undefined : visible.length}
          />
        </StackItem>
      </PageToolbar>

      {error ? <Banner status="error" title={error} isDismissable /> : null}

      {invoices === null ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading invoices" />
        </VStack>
      ) : visible.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? 'No invoices match these filters' : 'No invoices yet'}
          description={
            hasActiveFilters
              ? 'Clear a filter token or the search term to widen the results.'
              : 'Create your first invoice to get started.'
          }
          headingLevel={2}
          actions={
            hasActiveFilters ? null : (
              <Button
                label="New invoice"
                variant="primary"
                onClick={() => {
                  void navigate('new');
                }}
              />
            )
          }
        />
      ) : (
        <VStack gap={3}>
          {selectedCount > 0 ? (
            <Text type="supporting">
              {selectedCount} selected on this page
            </Text>
          ) : null}
          <Table<InvoiceRow>
            data={rows}
            columns={columns}
            idKey="id"
            density="spacious"
            dividers="rows"
            hasHover
            textOverflow="truncate"
            plugins={{ selection: selectionPlugin }}
          />
          <ListFooter
            total={visible.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={changePageSize}
          />
        </VStack>
      )}
    </Page>
  );
}
