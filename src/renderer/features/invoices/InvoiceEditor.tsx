/**
 * Invoice editor: a form on the left, the paper it produces on the right.
 *
 * The form is deliberately quiet. A line item is text on a hairline grid, not a
 * row of boxes — a cell only draws itself as a control when it has focus — so
 * ten lines read as a table instead of thirty inputs. There is no "Add item"
 * button: one blank ghost row always waits at the bottom, Enter commits a row
 * and opens the next, and Backspace on an already-empty row deletes it. The
 * per-row icon cluster is gone too: a drag handle on the left and an overflow
 * menu on the right, both near-invisible until the row is hovered or focused.
 *
 * A row that is not finished never leaves the form. `completeLines`
 * (./editorLines) is the single gate in front of both the document and the
 * money math, which is what stops the preview filling up with $0.00 lines as
 * rows are added. The math itself is untouched: `computeInvoiceTotals` from
 * src/shared/money.ts is the same integer arithmetic the backend persists, so
 * the preview and the saved invoice cannot disagree.
 *
 * The right column is a fixed-width rail holding one sheet of A4 (see
 * ./editorPreviewRail): it never grows and never scrolls sideways, the row being
 * edited lights up on the paper, and the save actions sit at its foot.
 *
 * Dates run the other way round from the old form. The user picks a payment
 * term and the due date is *derived* from it and rendered as a derived value —
 * which is how an invoice is actually written.
 *
 * A client can be created without leaving the page: the Customer field opens the
 * clients feature's own `ClientForm` in a dialog and folds the saved client into
 * the local list, so no draft field is lost and nothing is re-fetched.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Avatar } from '@astryxdesign/core/Avatar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Card } from '@astryxdesign/core/Card';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Divider } from '@astryxdesign/core/Divider';
import { DropdownMenu } from '@astryxdesign/core/DropdownMenu';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { InputGroup, InputGroupText } from '@astryxdesign/core/InputGroup';
import { Item } from '@astryxdesign/core/Item';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import { computeInvoiceTotals, formatCents, formatMilli } from '../../../shared/money';
import type { Client, InvoiceStatus } from '../../../shared/types';
import { SETTINGS_KEYS } from '../../../shared/types';
import { ClientForm } from '../clients/ClientForm';
import { Page, PageHeader } from '../../ui/Page';
import { normaliseNotes } from './detail';
import type { InvoiceDocumentModel } from './document';
import { buildDocumentModel, formatDocumentDate } from './document';
import {
  bpsToPercent,
  draftCaption,
  dueDateFor,
  isNotesOverBudget,
  notesCounter,
  paymentTermLabel,
  paymentTermOf,
  paymentTermOptions,
  percentToBps,
} from './editorFields';
import {
  ITEM_LIST_MAX_HEIGHT,
  LINE_AMOUNT_WIDTH,
  LINE_GUTTER_WIDTH,
  LINE_MENU_WIDTH,
  LINE_QTY_WIDTH,
  LINE_RATE_WIDTH,
  PREVIEW_RAIL_WIDTH,
} from './editorLayout';
import type { LineDraft } from './editorLines';
import {
  buildItemInputs,
  commitLineAt,
  completeLines,
  countedLines,
  duplicateLineAt,
  emptyLine,
  isBlankLine,
  moveLine,
  nextLineKey,
  parseLine,
  removeBlankLineAt,
  removeLineAt,
  withTrailingBlank,
} from './editorLines';
import { PreviewRail } from './editorPreviewRail';
import { STATUS_OPTIONS, money, todayIso } from './format';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'BRL'];

/** The keyboard contract, said once above the list instead of in a tooltip. */
const KEYBOARD_HINT = '⏎ new row · ⌫ on empty removes';

export type { LineDraft } from './editorLines';

/** Every editable field of the draft, in one shape. */
export interface InvoiceDraft {
  invoiceNumber: string | null;
  status: InvoiceStatus;
  clientId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  taxRateBps: number;
  notes: string;
  lines: LineDraft[];
}

/**
 * The blank form, as one value. Both the initial state and the reset at the top
 * of the load effect come from here, so "empty" cannot drift between the two —
 * a field added to the editor is either in this object or it is in neither.
 *
 * Fresh on every call: the line it carries needs its own `key`, and `todayIso()`
 * has to be read when the form opens, not when the module loads.
 */
export function emptyDraft(): InvoiceDraft {
  const today = todayIso();
  return {
    invoiceNumber: null,
    status: 'draft',
    clientId: '',
    issueDate: today,
    dueDate: today,
    currency: 'USD',
    taxRateBps: 0,
    notes: '',
    lines: [emptyLine()],
  };
}

/**
 * The client list with `saved` in it — replacing the entry of the same id, or
 * inserted in the list's own order.
 *
 * A client created from inside the invoice must appear in the Customer list
 * without a re-fetch: refetching would be a second source of truth for a list
 * the dialog already returned, and any in-flight draft field would be racing it.
 * The order matches the repository's `ORDER BY name COLLATE NOCASE, id`
 * (src/domain/clients/repository.ts), so the inserted row sits exactly where a
 * reload would later put it.
 */
export function upsertClient(clients: readonly Client[], saved: Client): Client[] {
  const existing = clients.findIndex((client) => client.id === saved.id);
  if (existing >= 0) {
    const next = [...clients];
    next[existing] = saved;
    return next;
  }
  const isAfter = (client: Client): boolean => {
    const byName = client.name.toLowerCase().localeCompare(saved.name.toLowerCase());
    return byName === 0 ? client.id > saved.id : byName > 0;
  };
  const at = clients.findIndex(isAfter);
  const next = [...clients];
  next.splice(at < 0 ? next.length : at, 0, saved);
  return next;
}

/** One line of the read-only billing address, joined from the client's non-blank fields. */
export function billingAddressFor(client: Client | null): string | null {
  if (!client) return null;
  const parts = [
    client.addressLine1,
    client.addressLine2,
    client.city,
    client.region,
    client.postalCode,
    client.country,
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The term two dates describe: `Net 14`, `Due on receipt`, or an em dash for an
 * interval that is not a term at all (a due date before the issue date).
 */
export function paymentTermsLabel(issueDate: string, dueDate: string): string {
  const days = paymentTermOf(issueDate, dueDate);
  return days === null ? '—' : paymentTermLabel(days);
}

/** Six dots: the universal "pick this row up" glyph, which has no semantic name. */
function GripIcon(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  );
}

function FieldValue({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={1}>
      <HStack gap={1} vAlign="center">
        <Text type="label" color="secondary">
          {label}
        </Text>
        {hint !== undefined ? (
          <Text type="label" color="disabled">
            {hint}
          </Text>
        ) : null}
      </HStack>
      {children}
    </VStack>
  );
}

/** The three cells of a line row that the user can type into. */
type CellField = 'description' | 'quantity' | 'unitPrice';

/**
 * A borderless line-item cell.
 *
 * The whole point of the 2a table: at rest the input paints nothing — no border,
 * no fill — so the row reads as a line of text; the cell that has focus is the
 * only one that draws itself as a control. Both looks are inline because they
 * are driven by React state rather than `:focus-within`: an inline style is the
 * only thing that outranks the component's own focus styling, and the row needs
 * to know which cell is focused anyway (it highlights itself, and the document
 * highlights the matching line).
 */
function LineCell({
  label,
  value,
  placeholder,
  align,
  isFocused,
  hasError,
  inputRef,
  onChange,
  onFocus,
  onBlur,
  onKeyDown,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly align: 'start' | 'end';
  readonly isFocused: boolean;
  readonly hasError: boolean;
  readonly inputRef: (node: HTMLInputElement | null) => void;
  readonly onChange: (value: string) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}): React.JSX.Element {
  const borderColor = hasError
    ? 'var(--color-border-red)'
    : isFocused
      ? 'var(--color-border-blue)'
      : 'transparent';
  return (
    <TextInput
      label={label}
      isLabelHidden
      size="sm"
      value={value}
      placeholder={placeholder}
      ref={inputRef}
      onChange={onChange}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      style={{
        background: isFocused ? 'var(--color-background-surface)' : 'transparent',
        borderColor,
        borderRadius: 'var(--radius-inner)',
        boxShadow: 'none',
        textAlign: align,
      }}
    />
  );
}

export function InvoiceEditor(): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined;

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [businessName, setBusinessName] = useState<string | null>(null);
  const [businessAddress, setBusinessAddress] = useState<string | null>(null);

  const [blank] = useState(emptyDraft);
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(blank.invoiceNumber);
  const [status, setStatus] = useState<InvoiceStatus>(blank.status);
  const [clientId, setClientId] = useState(blank.clientId);
  const [issueDate, setIssueDate] = useState(blank.issueDate);
  const [dueDate, setDueDate] = useState(blank.dueDate);
  const [currency, setCurrency] = useState(blank.currency);
  const [taxRateBps, setTaxRateBps] = useState(blank.taxRateBps);
  const [notes, setNotes] = useState(blank.notes);
  const [lines, setLines] = useState<LineDraft[]>(blank.lines);
  const [isDirty, setIsDirty] = useState(false);

  // Row chrome: which row the caret is in, which cell of it, and which row the
  // pointer is over. All three only decide what is drawn, never what is saved.
  const [focusedCell, setFocusedCell] = useState<{
    readonly key: number;
    readonly field: CellField;
  } | null>(null);
  const [hoverKey, setHoverKey] = useState<number | null>(null);
  const [draggingKey, setDraggingKey] = useState<number | null>(null);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  // null when the dialog is closed; `client` null inside it means "create".
  const [clientDialog, setClientDialog] = useState<{ readonly client: Client | null } | null>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // The description input of every row, so a keyboard transition can put the
  // caret in the row it just created. Keyed by draft key: an index would point
  // at the wrong row the moment one is inserted above it.
  const descriptionInputs = useRef(new Map<number, HTMLInputElement | null>());

  useEffect(() => {
    if (pendingFocus === null) return;
    descriptionInputs.current.get(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus, lines]);

  useEffect(() => {
    let cancelled = false;

    // The route table keys this component by invoice id, so in practice this
    // effect runs once per mount. It still clears the form itself: its own
    // dependencies say it handles an `id` change, and a component whose loader
    // only half-populates the form is a trap for the next caller that mounts it
    // without a key. Everything the previous invoice could have left behind —
    // draft fields, banners, the spinner — goes first, before the await.
    const draft = emptyDraft();
    setInvoiceNumber(draft.invoiceNumber);
    setStatus(draft.status);
    setClientId(draft.clientId);
    setIssueDate(draft.issueDate);
    setDueDate(draft.dueDate);
    setCurrency(draft.currency);
    setTaxRateBps(draft.taxRateBps);
    setNotes(draft.notes);
    setLines(draft.lines);
    setIsDirty(false);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    setIsLoading(true);

    void (async () => {
      try {
        const [clientResult, nameRow, addressRow] = await Promise.all([
          window.api.invoke('clients:list', { limit: 500, offset: 0 }),
          window.api.invoke('settings:get', { key: SETTINGS_KEYS.businessName }),
          window.api.invoke('settings:get', { key: SETTINGS_KEYS.businessAddress }),
        ]);
        if (cancelled) return;
        setClients(clientResult.items);
        setBusinessName(nameRow.value);
        setBusinessAddress(addressRow.value);

        if (isNew) {
          const [currencyRow, taxRow] = await Promise.all([
            window.api.invoke('settings:get', { key: SETTINGS_KEYS.defaultCurrency }),
            window.api.invoke('settings:get', { key: SETTINGS_KEYS.defaultTaxRateBps }),
          ]);
          if (cancelled) return;
          if (currencyRow.value) setCurrency(currencyRow.value);
          const bps = Number.parseInt(taxRow.value ?? '', 10);
          if (Number.isSafeInteger(bps) && bps >= 0) setTaxRateBps(bps);
        } else {
          const invoice = await window.api.invoke('invoices:get', { id });
          if (cancelled) return;
          if (!invoice) {
            setLoadError('This invoice no longer exists.');
            return;
          }
          setInvoiceNumber(invoice.number);
          setStatus(invoice.status);
          setClientId(invoice.clientId);
          setIssueDate(invoice.issueDate);
          setDueDate(invoice.dueDate);
          setCurrency(invoice.currency);
          setTaxRateBps(invoice.taxRateBps);
          setNotes(invoice.notes ?? '');
          // The ghost row is an invariant of the list, so a saved invoice gets
          // one the moment it lands in the form.
          setLines(
            withTrailingBlank(
              invoice.items.map((item) => ({
                key: nextLineKey(),
                description: item.description,
                quantity: formatMilli(item.quantityMilli),
                unitPrice: formatCents(item.unitPriceCents),
              })),
            ),
          );
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  const parsed = useMemo(() => lines.map(parseLine), [lines]);
  const items = useMemo(() => completeLines(lines), [lines]);
  const totals = useMemo(
    () =>
      computeInvoiceTotals(
        items.map((line) => ({
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
        })),
        taxRateBps,
      ),
    [items, taxRateBps],
  );

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === clientId) ?? null,
    [clients, clientId],
  );
  const billingAddress = useMemo(() => billingAddressFor(selectedClient), [selectedClient]);

  const termDays = paymentTermOf(issueDate, dueDate);
  const termOptions = useMemo(() => paymentTermOptions(termDays), [termDays]);

  // Rebuilt on every keystroke — only complete lines feed it, so a half-typed
  // quantity never throws and a blank row never appears on the paper.
  const documentModel: InvoiceDocumentModel = useMemo(
    () =>
      buildDocumentModel({
        number: invoiceNumber,
        status,
        issueDate,
        dueDate,
        currency,
        taxRateBps,
        // Same normalisation the save below uses, so the preview can never
        // promise a document without a Notes block and then store one.
        notes: normaliseNotes(notes),
        items,
        totals,
        client: selectedClient,
        business: { name: businessName, address: businessAddress },
      }),
    [
      invoiceNumber,
      status,
      issueDate,
      dueDate,
      currency,
      taxRateBps,
      notes,
      items,
      totals,
      selectedClient,
      businessName,
      businessAddress,
    ],
  );

  /**
   * Which line of the *document* the caret is in, if any.
   *
   * The map runs through `items`, not `lines`, because a blank or half-typed row
   * has no line on the paper to light up — the document's keys are positions in
   * what it actually renders.
   */
  const activeLineKey = useMemo(() => {
    if (focusedCell === null) return null;
    const index = items.findIndex((line) => line.key === focusedCell.key);
    return index >= 0 ? `line-${String(index)}` : null;
  }, [focusedCell, items]);

  const editLines = (next: LineDraft[]): void => {
    setIsDirty(true);
    setLines(withTrailingBlank(next));
  };
  const updateLine = (key: number, patch: Partial<LineDraft>): void => {
    editLines(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  /**
   * Enter commits the row and opens the next one; Backspace on a row that is
   * already empty deletes it. Both are list transformations in ./editorLines —
   * the component only decides that the keystroke was one of them, and only
   * claims Backspace when the caret has nothing left to delete in the cell it is
   * in, so ordinary editing is never intercepted.
   */
  const handleCellKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    index: number,
    cellValue: string,
  ): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const result = commitLineAt(lines, index);
      setIsDirty(true);
      setLines(result.lines);
      if (result.focusKey !== null) setPendingFocus(result.focusKey);
      return;
    }
    if (event.key === 'Backspace' && cellValue === '') {
      const result = removeBlankLineAt(lines, index);
      if (!result) return;
      event.preventDefault();
      setIsDirty(true);
      setLines(result.lines);
      if (result.focusKey !== null) setPendingFocus(result.focusKey);
    }
  };

  /**
   * A client saved from the dialog folds straight into the list and becomes the
   * invoice's customer. Nothing else in the draft is touched, and nothing is
   * re-fetched: the dialog already returned the saved row.
   */
  const acceptClient = (saved: Client): void => {
    setClients((prev) => upsertClient(prev, saved));
    setClientId(saved.id);
    setIsDirty(true);
    setClientDialog(null);
  };

  /**
   * `mode` is where the user lands: `stay` keeps them in the form with the saved
   * invoice open, `open` hands them the finished document. A new invoice can be
   * saved either way, which is what makes "Save draft" and "Create invoice" two
   * different buttons rather than one button and a lie.
   */
  const save = async (mode: 'stay' | 'open'): Promise<void> => {
    if (clientId === '') {
      setActionError('Pick a client before saving.');
      return;
    }
    const built = buildItemInputs(lines);
    if (typeof built === 'string') {
      setActionError(built);
      return;
    }
    setIsSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const payload = {
        clientId,
        issueDate,
        dueDate,
        currency,
        taxRateBps,
        notes: normaliseNotes(notes),
        items: built,
      };
      if (isNew) {
        const created = await window.api.invoke('invoices:create', payload);
        // Either way this component unmounts mid-flight: both routes remount the
        // editor (or leave it) under a new key.
        await navigate(mode === 'open' ? `/invoices/${created.id}` : `/invoices/${created.id}/edit`, {
          replace: true,
        });
      } else {
        const updated = await window.api.invoke('invoices:update', { id, patch: payload });
        if (!isMounted.current) return;
        setInvoiceNumber(updated.number);
        setIsDirty(false);
        setNotice('Invoice saved.');
        if (mode === 'open') await navigate(`/invoices/${String(id)}`);
      }
    } catch (cause) {
      if (isMounted.current) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isMounted.current) setIsSaving(false);
    }
  };

  const changeStatus = async (next: InvoiceStatus): Promise<void> => {
    if (isNew || id === undefined) {
      setStatus(next);
      return;
    }
    setActionError(null);
    try {
      const updated = await window.api.invoke('invoices:setStatus', { id, status: next });
      setStatus(updated.status);
      setNotice(`Status changed to ${updated.status}.`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const exportPdf = async (): Promise<void> => {
    if (isNew || id === undefined) return;
    setActionError(null);
    setNotice(null);
    try {
      const result = await window.api.invoke('invoices:exportPdf', { id });
      if (result.path === '') return; // user closed the save dialog
      setNotice(`PDF written to ${result.path} (${result.bytes} bytes).`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (isLoading) {
    return (
      <Page maxWidth={1440}>
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading invoice" />
        </VStack>
      </Page>
    );
  }
  if (loadError) {
    return (
      <Page maxWidth={1440}>
        <Banner status="error" title={loadError} />
        <HStack gap={2}>
          <Button label="Back to invoices" onClick={() => void navigate('/invoices')} />
        </HStack>
      </Page>
    );
  }

  const itemCount = countedLines(lines);

  return (
    <Page maxWidth={1440}>
      <PageHeader
        title={isNew ? 'New invoice' : (invoiceNumber ?? 'Invoice')}
        actions={
          <>
            <Button
              label="Back"
              variant="ghost"
              onClick={() => void navigate(isNew ? '/invoices' : `/invoices/${String(id)}`)}
            />
            {!isNew ? (
              <Selector
                label="Status"
                isLabelHidden
                options={STATUS_OPTIONS}
                value={status}
                onChange={(value) => {
                  void changeStatus(value as InvoiceStatus);
                }}
              />
            ) : null}
            {!isNew ? <Button label="Export PDF" onClick={() => void exportPdf()} /> : null}
          </>
        }
      />

      {actionError ? <Banner status="error" title={actionError} isDismissable /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable /> : null}

      {/* Form left, paper right. The rail is a fixed width — it holds a page, and
          a page is a fixed shape — so only the form column takes up the slack.
          `wrap` puts the rail under the form when the window cannot hold both. */}
      <HStack gap={4} align="stretch" wrap="wrap">
        <StackItem size="fill">
          <Card padding={4} height="100%">
            <VStack gap={4} height="100%">
              <HStack gap={2} vAlign="center">
                <StackItem size="fill">
                  <Heading level={2}>Invoice details</Heading>
                </StackItem>
                <Text type="supporting" color="secondary">
                  {draftCaption({
                    number: invoiceNumber,
                    status,
                    isNew,
                    isSaving,
                    hasUnsavedChanges: isDirty,
                  })}
                </Text>
              </HStack>

              {/* Who — the client, as an identity row once one is chosen. */}
              <HStack gap={2} align="end" wrap="wrap">
                <StackItem size="fill">
                  {selectedClient ? (
                    <FieldValue label="Customer">
                      {/* Card, not Section: Section is a page region and bleeds
                          to its container's edges, which inside this card reads
                          as a full-width grey band rather than one identity row. */}
                      <Card variant="muted" padding={2}>
                        <VStack gap={1}>
                          <Item
                            startContent={<Avatar size="sm" name={selectedClient.name} />}
                            label={selectedClient.name}
                            description={selectedClient.email ?? 'No email on file'}
                            density="compact"
                            endContent={
                              <HStack gap={1} vAlign="center">
                                <Button
                                  label="Edit"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setClientDialog({ client: selectedClient })}
                                />
                                <Button
                                  label="Change"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setIsDirty(true);
                                    setClientId('');
                                  }}
                                />
                              </HStack>
                            }
                          />
                          {/* Inside the identity block, not below it: the address
                              belongs to the client shown above it, and when there
                              is no address the row simply is not rendered — an
                              empty "choose a client to see their address" line is
                              dead vertical space in the state the form is
                              usually in. */}
                          {billingAddress ? (
                            <Text type="supporting" color="secondary">
                              {billingAddress}
                            </Text>
                          ) : null}
                        </VStack>
                      </Card>
                    </FieldValue>
                  ) : (
                    <Selector
                      label="Customer"
                      placeholder="Choose a client"
                      options={clients.map((client) => ({
                        value: client.id,
                        label: client.name,
                      }))}
                      value={clientId || null}
                      hasSearch
                      hasClear
                      onChange={(value) => {
                        setIsDirty(true);
                        setClientId(value ?? '');
                      }}
                    />
                  )}
                </StackItem>
                <Button
                  label="New client"
                  variant="secondary"
                  onClick={() => setClientDialog({ client: null })}
                />
              </HStack>

              {/* When — the user picks a term and the due date follows from it.
                  The derived field is drawn differently (dashed, dimmer) so it
                  reads as a consequence rather than a third thing to fill in. */}
              <HStack gap={2} align="start" wrap="wrap">
                <StackItem size="fill">
                  <Selector
                    label="Payment terms"
                    placeholder="Choose terms"
                    options={termOptions}
                    value={termDays === null ? undefined : String(termDays)}
                    onChange={(value) => {
                      const days = Number.parseInt(value, 10);
                      if (!Number.isFinite(days)) return;
                      setIsDirty(true);
                      setDueDate(dueDateFor(issueDate, days));
                    }}
                  />
                </StackItem>
                <StackItem size="fill">
                  <DateInput
                    label="Issue date"
                    value={issueDate as ISODateString}
                    onChange={(value) => {
                      if (!value) return;
                      setIsDirty(true);
                      setIssueDate(value);
                      // The term is what the user chose; the dates move under it.
                      if (termDays !== null) setDueDate(dueDateFor(value, termDays));
                    }}
                  />
                </StackItem>
                <StackItem size="fill">
                  <FieldValue label="Due" hint="· auto">
                    <VStack
                      justify="center"
                      style={{
                        minHeight: 'var(--size-element-md)',
                        paddingInline: 'var(--spacing-2)',
                        borderRadius: 'var(--radius-element)',
                        border: 'var(--border-width) dashed var(--color-border-emphasized)',
                        background: 'var(--color-background-muted)',
                      }}
                    >
                      <Text color="secondary" hasTabularNumbers>
                        {formatDocumentDate(dueDate)}
                      </Text>
                    </VStack>
                  </FieldValue>
                </StackItem>
              </HStack>

              <HStack gap={2} align="start" wrap="wrap">
                <StackItem size="fill">
                  <Selector
                    label="Currency"
                    options={CURRENCIES}
                    value={currency}
                    onChange={(value) => {
                      setIsDirty(true);
                      setCurrency(value);
                    }}
                  />
                </StackItem>
                <StackItem size="fill">
                  {/* Basis points are how the invoice stores tax; per cent is how
                      people say it. The split control puts the unit in the field
                      instead of in a hint under it. */}
                  <InputGroup label="Sales tax">
                    <NumberInput
                      label="Sales tax rate"
                      isLabelHidden
                      value={bpsToPercent(taxRateBps)}
                      min={0}
                      max={100}
                      step={0.25}
                      onChange={(value) => {
                        setIsDirty(true);
                        setTaxRateBps(percentToBps(value));
                      }}
                    />
                    <InputGroupText>%</InputGroupText>
                  </InputGroup>
                </StackItem>
              </HStack>

              <Divider />

              {/* What — a table, not a stack of controls. */}
              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <HStack gap={1} vAlign="center">
                      <Heading level={3}>Items</Heading>
                      <Text color="secondary">{`· ${String(itemCount)}`}</Text>
                    </HStack>
                  </StackItem>
                  <Text
                    type="supporting"
                    color="secondary"
                    style={{ fontFamily: 'var(--font-family-code)' }}
                  >
                    {KEYBOARD_HINT}
                  </Text>
                </HStack>

                {/* The list scrolls, the page doesn't: forty lines must not push
                    the notes field and the action row off the window. */}
                <VStack style={{ maxHeight: ITEM_LIST_MAX_HEIGHT, overflowY: 'auto' }}>
                  <HStack
                    gap={2}
                    vAlign="center"
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                      background: 'var(--color-background-card)',
                      paddingBottom: 'var(--spacing-1)',
                      borderBottom: 'var(--border-width) solid var(--color-border)',
                    }}
                  >
                    <VStack width={LINE_GUTTER_WIDTH} />
                    <StackItem size="fill">
                      <Text type="label" color="secondary">
                        Description
                      </Text>
                    </StackItem>
                    <VStack width={LINE_QTY_WIDTH} hAlign="end">
                      <Text type="label" color="secondary">
                        Qty
                      </Text>
                    </VStack>
                    <VStack width={LINE_RATE_WIDTH} hAlign="end">
                      <Text type="label" color="secondary">
                        Rate
                      </Text>
                    </VStack>
                    <VStack width={LINE_AMOUNT_WIDTH} hAlign="end">
                      <Text type="label" color="secondary">
                        Amount
                      </Text>
                    </VStack>
                    <VStack width={LINE_GUTTER_WIDTH} />
                  </HStack>

                  {lines.map((line, index) => {
                    const lineParsed = parsed[index];
                    const isGhost = isBlankLine(line);
                    const isLast = index === lines.length - 1;
                    const isActive = focusedCell?.key === line.key;
                    const isRevealed = isActive || hoverKey === line.key;
                    const amount =
                      lineParsed &&
                      lineParsed.description.trim() !== '' &&
                      lineParsed.quantityMilli !== null &&
                      lineParsed.quantityMilli > 0 &&
                      lineParsed.unitPriceCents !== null
                        ? money(
                            computeInvoiceTotals(
                              [
                                {
                                  quantityMilli: lineParsed.quantityMilli,
                                  unitPriceCents: lineParsed.unitPriceCents,
                                },
                              ],
                              0,
                            ).subtotalCents,
                            currency,
                          )
                        : '—';
                    const cell = (field: CellField): boolean =>
                      focusedCell?.key === line.key && focusedCell.field === field;
                    const onCellFocus = (field: CellField) => () => {
                      setFocusedCell({ key: line.key, field });
                    };
                    const onCellBlur = (field: CellField) => () => {
                      setFocusedCell((prev) =>
                        prev?.key === line.key && prev.field === field ? null : prev,
                      );
                    };

                    return (
                      <HStack
                        key={line.key}
                        gap={2}
                        vAlign="center"
                        draggable={draggingKey === line.key}
                        onMouseEnter={() => setHoverKey(line.key)}
                        onMouseLeave={() => setHoverKey(null)}
                        onDragOver={(event) => {
                          if (draggingKey === null) return;
                          event.preventDefault();
                        }}
                        onDrop={(event) => {
                          if (draggingKey === null) return;
                          event.preventDefault();
                          const from = lines.findIndex((row) => row.key === draggingKey);
                          setDraggingKey(null);
                          if (from < 0 || from === index) return;
                          editLines(moveLine(lines, from, index));
                        }}
                        onDragEnd={() => setDraggingKey(null)}
                        style={{
                          paddingBlock: 'var(--spacing-0-5)',
                          borderRadius: 'var(--radius-inner)',
                          borderBottom: isLast
                            ? 'var(--border-width) solid transparent'
                            : 'var(--border-width) solid var(--color-border)',
                          background: isActive ? 'var(--color-overlay-hover)' : 'transparent',
                        }}
                      >
                        <VStack
                          width={LINE_GUTTER_WIDTH}
                          hAlign="center"
                          style={{ opacity: isRevealed || isGhost ? 1 : 0.15 }}
                        >
                          {isGhost ? (
                            // The ghost row is not a row you can pick up — it is
                            // the invitation to start one, so it carries the
                            // gesture's mark instead of its handle.
                            <Text color="disabled">+</Text>
                          ) : (
                            /* The handle arms the row for a pointer drag and
                               reorders it from the keyboard, so the same control
                               works for both. */
                            <IconButton
                              label={`Move line ${String(index + 1)}`}
                              icon={<Icon icon={GripIcon} size="sm" />}
                              size="sm"
                              variant="ghost"
                              onPointerDown={() => setDraggingKey(line.key)}
                              // A press that never became a drag still has to
                              // disarm the row: `dragend` only fires for a drag
                              // that actually happened.
                              onPointerUp={() => setDraggingKey(null)}
                              onKeyDown={(event) => {
                                if (event.key === 'ArrowUp') {
                                  event.preventDefault();
                                  editLines(moveLine(lines, index, index - 1));
                                }
                                if (event.key === 'ArrowDown') {
                                  event.preventDefault();
                                  editLines(moveLine(lines, index, index + 1));
                                }
                              }}
                            />
                          )}
                        </VStack>
                        <StackItem size="fill">
                          <LineCell
                            label={`Description, line ${String(index + 1)}`}
                            value={line.description}
                            placeholder={isGhost ? 'Add another item…' : 'What was delivered?'}
                            align="start"
                            isFocused={cell('description')}
                            hasError={false}
                            inputRef={(node) => {
                              if (node) descriptionInputs.current.set(line.key, node);
                              else descriptionInputs.current.delete(line.key);
                            }}
                            onChange={(value) => updateLine(line.key, { description: value })}
                            onFocus={onCellFocus('description')}
                            onBlur={onCellBlur('description')}
                            onKeyDown={(event) => handleCellKeyDown(event, index, line.description)}
                          />
                        </StackItem>
                        <VStack width={LINE_QTY_WIDTH}>
                          <LineCell
                            label={`Quantity, line ${String(index + 1)}`}
                            value={line.quantity}
                            align="end"
                            isFocused={cell('quantity')}
                            hasError={
                              !isGhost &&
                              lineParsed !== undefined &&
                              (lineParsed.quantityMilli === null || lineParsed.quantityMilli <= 0)
                            }
                            inputRef={() => undefined}
                            onChange={(value) => updateLine(line.key, { quantity: value })}
                            onFocus={onCellFocus('quantity')}
                            onBlur={onCellBlur('quantity')}
                            onKeyDown={(event) => handleCellKeyDown(event, index, line.quantity)}
                          />
                        </VStack>
                        <VStack width={LINE_RATE_WIDTH}>
                          <LineCell
                            label={`Rate, line ${String(index + 1)}`}
                            value={line.unitPrice}
                            align="end"
                            isFocused={cell('unitPrice')}
                            hasError={
                              !isGhost &&
                              lineParsed !== undefined &&
                              lineParsed.unitPriceCents === null
                            }
                            inputRef={() => undefined}
                            onChange={(value) => updateLine(line.key, { unitPrice: value })}
                            onFocus={onCellFocus('unitPrice')}
                            onBlur={onCellBlur('unitPrice')}
                            onKeyDown={(event) => handleCellKeyDown(event, index, line.unitPrice)}
                          />
                        </VStack>
                        <VStack width={LINE_AMOUNT_WIDTH} hAlign="end">
                          <Text
                            hasTabularNumbers
                            color={amount === '—' ? 'secondary' : undefined}
                          >
                            {amount}
                          </Text>
                        </VStack>
                        <VStack
                          width={LINE_GUTTER_WIDTH}
                          hAlign="center"
                          style={{ opacity: isRevealed && !isGhost ? 1 : 0.15 }}
                        >
                          {isGhost ? null : (
                            <DropdownMenu
                              hasChevron={false}
                              menuWidth={LINE_MENU_WIDTH}
                              button={{
                                label: `Line ${String(index + 1)} actions`,
                                icon: <Icon icon="moreHorizontal" size="sm" />,
                                isIconOnly: true,
                                variant: 'ghost',
                                size: 'sm',
                              }}
                              items={[
                                {
                                  label: 'Move up',
                                  isDisabled: index === 0,
                                  onClick: () => editLines(moveLine(lines, index, index - 1)),
                                },
                                {
                                  label: 'Move down',
                                  isDisabled: index >= lines.length - 2,
                                  onClick: () => editLines(moveLine(lines, index, index + 1)),
                                },
                                { label: 'Duplicate', onClick: () => editLines(duplicateLineAt(lines, index)) },
                                { type: 'divider' },
                                { label: 'Remove', onClick: () => editLines(removeLineAt(lines, index)) },
                              ]}
                            />
                          )}
                        </VStack>
                      </HStack>
                    );
                  })}
                </VStack>

                <HStack
                  gap={2}
                  vAlign="center"
                  style={{
                    paddingTop: 'var(--spacing-1-5)',
                    borderTop: 'var(--border-width) solid var(--color-border)',
                  }}
                >
                  <StackItem size="fill">
                    <Text type="supporting" color="secondary">
                      Blank rows never appear on the invoice.
                    </Text>
                  </StackItem>
                  <Text type="supporting" color="secondary" hasTabularNumbers>
                    {`${String(items.length)} on the invoice · ${money(totals.totalCents, currency)}`}
                  </Text>
                </HStack>
              </VStack>

              <Divider />

              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <HStack gap={1} vAlign="center">
                      <Text type="label" color="secondary">
                        Notes to customer
                      </Text>
                      <Text type="label" color="disabled">
                        · optional, prints on the invoice
                      </Text>
                    </HStack>
                  </StackItem>
                  <Text
                    type="supporting"
                    color="secondary"
                    hasTabularNumbers
                    // Over budget the note still saves — the database allows far
                    // more — it just stops fitting the printed block, so the
                    // counter warns rather than the field erroring.
                    style={
                      isNotesOverBudget(notes) ? { color: 'var(--color-text-yellow)' } : undefined
                    }
                  >
                    {notesCounter(notes)}
                  </Text>
                </HStack>
                <TextArea
                  label="Notes to customer"
                  isLabelHidden
                  value={notes}
                  rows={2}
                  onChange={(value) => {
                    setIsDirty(true);
                    setNotes(value);
                  }}
                />
              </VStack>

              <StackItem size="fill" />
            </VStack>
          </Card>
        </StackItem>

        <VStack width={PREVIEW_RAIL_WIDTH}>
          <Card padding={4} height="100%">
            <PreviewRail
              model={documentModel}
              activeLineKey={activeLineKey}
              actions={
                isNew ? (
                  <>
                    <StackItem size="fill">
                      <Button
                        label="Save draft"
                        variant="secondary"
                        width="100%"
                        isLoading={isSaving}
                        onClick={() => {
                          void save('stay');
                        }}
                      />
                    </StackItem>
                    <StackItem size="fill">
                      <Button
                        label="Create invoice"
                        variant="primary"
                        width="100%"
                        isLoading={isSaving}
                        onClick={() => {
                          void save('open');
                        }}
                      />
                    </StackItem>
                  </>
                ) : (
                  <StackItem size="fill">
                    <Button
                      label="Save changes"
                      variant="primary"
                      width="100%"
                      isLoading={isSaving}
                      onClick={() => {
                        void save('stay');
                      }}
                    />
                  </StackItem>
                )
              }
            />
          </Card>
        </VStack>
      </HStack>

      {clientDialog ? (
        <ClientForm
          client={clientDialog.client}
          onClose={() => setClientDialog(null)}
          onSaved={acceptClient}
        />
      ) : null}
    </Page>
  );
}
