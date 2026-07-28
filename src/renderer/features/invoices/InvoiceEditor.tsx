/**
 * Invoice editor: a two-column maker. The left column is a single "Invoice
 * details" card — client, derived billing address, dates with derived payment
 * terms, currency, tax, an editable line-item grid, live totals, and notes.
 * The right column is a live preview: the same `InvoiceDocument` the detail
 * page renders, rebuilt from the draft on every keystroke, floating on a
 * recessed surface. The columns stack when the window is narrow.
 *
 * Live totals use the exact same integer math the backend persists
 * (`computeInvoiceTotals` from src/shared/money.ts), so the preview and the
 * saved invoice can never disagree.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Card } from '@astryxdesign/core/Card';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Divider } from '@astryxdesign/core/Divider';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import {
  computeInvoiceTotals,
  formatCents,
  formatMilli,
  parseAmountToCents,
  parseQuantityToMilli,
} from '../../../shared/money';
import type { Client, InvoiceItemInput, InvoiceStatus } from '../../../shared/types';
import { SETTINGS_KEYS } from '../../../shared/types';
import { Page, PageHeader } from '../../ui/Page';
import { normaliseNotes } from './detail';
import { buildDocumentModel, netTermDays } from './document';
import { STATUS_OPTIONS, money, todayIso } from './format';
import { InvoiceDocument } from './InvoiceDocument';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'BRL'];

interface LineDraft {
  key: number;
  description: string;
  quantity: string; // decimal text, parsed to milli
  unitPrice: string; // decimal text, parsed to cents
}

interface ParsedLine {
  description: string;
  quantityMilli: number | null;
  unitPriceCents: number | null;
}

function parseLine(line: LineDraft): ParsedLine {
  let quantityMilli: number | null = null;
  let unitPriceCents: number | null = null;
  try {
    quantityMilli = parseQuantityToMilli(line.quantity);
  } catch {
    quantityMilli = null;
  }
  try {
    unitPriceCents = parseAmountToCents(line.unitPrice);
  } catch {
    unitPriceCents = null;
  }
  return { description: line.description, quantityMilli, unitPriceCents };
}

let nextKey = 1;
function emptyLine(): LineDraft {
  return { key: nextKey++, description: '', quantity: '1', unitPrice: '0.00' };
}

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

/** One line of the read-only billing address, joined from the client's non-blank fields. */
function billingAddressFor(client: Client | null): string | null {
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

/** Derived payment-terms label for the date row: `Net 14`, `Due on receipt`, or an em dash. */
function paymentTermsLabel(issueDate: string, dueDate: string): string {
  const days = netTermDays(issueDate, dueDate);
  if (days === null || days < 0) return '—';
  if (days === 0) return 'Due on receipt';
  return `Net ${String(days)}`;
}

function FieldValue({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {label}
      </Text>
      {children}
    </VStack>
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
          setLines(
            invoice.items.map((item) => ({
              key: nextKey++,
              description: item.description,
              quantity: formatMilli(item.quantityMilli),
              unitPrice: formatCents(item.unitPriceCents),
            })),
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
  const validItems = useMemo(
    () =>
      parsed.filter(
        (line): line is ParsedLine & { quantityMilli: number; unitPriceCents: number } =>
          line.quantityMilli !== null && line.quantityMilli > 0 && line.unitPriceCents !== null,
      ),
    [parsed],
  );
  const totals = useMemo(
    () =>
      computeInvoiceTotals(
        validItems.map((line) => ({
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
        })),
        taxRateBps,
      ),
    [validItems, taxRateBps],
  );

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === clientId) ?? null,
    [clients, clientId],
  );
  const billingAddress = useMemo(() => billingAddressFor(selectedClient), [selectedClient]);

  // Rebuilt on every keystroke — only valid lines feed it, so a half-typed
  // quantity never throws; that row simply has not appeared in the preview yet.
  const documentModel = useMemo(
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
        items: validItems,
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
      validItems,
      totals,
      selectedClient,
      businessName,
      businessAddress,
    ],
  );

  const updateLine = (key: number, patch: Partial<LineDraft>): void => {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };
  const moveLine = (index: number, delta: -1 | 1): void => {
    setLines((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [line] = next.splice(index, 1);
      if (line) next.splice(target, 0, line);
      return next;
    });
  };
  const removeLine = (key: number): void => {
    setLines((prev) => (prev.length > 1 ? prev.filter((line) => line.key !== key) : prev));
  };

  const buildItems = (): InvoiceItemInput[] | string => {
    if (clientId === '') return 'Pick a client before saving.';
    const items: InvoiceItemInput[] = [];
    for (const [index, line] of parsed.entries()) {
      if (line.description.trim() === '') return `Line ${index + 1} needs a description.`;
      if (line.quantityMilli === null || line.quantityMilli <= 0) {
        return `Line ${index + 1} needs a positive quantity.`;
      }
      if (line.unitPriceCents === null) return `Line ${index + 1} has an invalid unit price.`;
      items.push({
        description: line.description.trim(),
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        position: index,
      });
    }
    if (items.length === 0) return 'An invoice needs at least one line item.';
    return items;
  };

  const save = async (): Promise<void> => {
    const items = buildItems();
    if (typeof items === 'string') {
      setActionError(items);
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
        items,
      };
      if (isNew) {
        const created = await window.api.invoke('invoices:create', payload);
        // Lands on the read-only detail page; this component unmounts mid-flight.
        await navigate(`/invoices/${created.id}`, { replace: true });
      } else {
        const updated = await window.api.invoke('invoices:update', { id, patch: payload });
        if (!isMounted.current) return;
        setInvoiceNumber(updated.number);
        setNotice('Invoice saved.');
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

  return (
    <Page maxWidth={1440}>
      <PageHeader
        title={isNew ? 'New invoice' : (invoiceNumber ?? 'Invoice')}
        description={
          isNew
            ? 'Pick a client, add line items, and the preview follows along.'
            : 'Edit the invoice, change its status, or export it as a PDF.'
        }
        actions={
          <>
            <Button
              label="Back"
              variant="ghost"
              onClick={() => void navigate(isNew ? '/invoices' : `/invoices/${id}`)}
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

      <Grid columns={{ minWidth: 460, max: 2 }} gap={4} align="start">
        <Card padding={4}>
          <VStack gap={3}>
            <Heading level={2}>Invoice details</Heading>

            <Selector
              label="Customer"
              placeholder="Choose a client"
              options={clients.map((client) => ({ value: client.id, label: client.name }))}
              value={clientId || null}
              hasSearch
              hasClear
              onChange={(value) => {
                setClientId(value ?? '');
              }}
            />

            <FieldValue label="Billing address">
              {billingAddress ? (
                <Text type="supporting">{billingAddress}</Text>
              ) : (
                <Text type="supporting" color="placeholder">
                  {selectedClient ? 'No address on file for this client' : 'Choose a client to see their address'}
                </Text>
              )}
            </FieldValue>

            <HStack gap={2} align="start" wrap="wrap">
              <DateInput
                label="Issue date"
                value={issueDate as ISODateString}
                onChange={(value) => {
                  if (value) setIssueDate(value);
                }}
              />
              <DateInput
                label="Due date"
                value={dueDate as ISODateString}
                onChange={(value) => {
                  if (value) setDueDate(value);
                }}
              />
              <FieldValue label="Payment terms">
                <Text>{paymentTermsLabel(issueDate, dueDate)}</Text>
              </FieldValue>
            </HStack>

            {/* Aligned to the end: the NumberInput's description line makes it
                taller than the Selector, so only a bottom-aligned row puts the
                two inputs themselves on one baseline. */}
            <HStack gap={2} align="end" wrap="wrap">
              <Selector label="Currency" options={CURRENCIES} value={currency} onChange={setCurrency} />
              <NumberInput
                label="Tax rate (bps)"
                description="825 = 8.25%"
                value={taxRateBps}
                min={0}
                max={1_000_000}
                step={25}
                isIntegerOnly
                onChange={(value) => {
                  setTaxRateBps(Math.max(0, Math.trunc(value)));
                }}
              />
            </HStack>

            <Divider />
            <Heading level={3}>Item details</Heading>
            {lines.map((line, index) => {
              const lineParsed = parsed[index];
              const amount =
                lineParsed &&
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
              return (
                <HStack key={line.key} gap={2} align="end">
                  <StackItem size="fill">
                    <TextInput
                      label={index === 0 ? 'Item' : `Item ${index + 1}`}
                      isLabelHidden={index > 0}
                      value={line.description}
                      placeholder="What was delivered?"
                      onChange={(value) => updateLine(line.key, { description: value })}
                    />
                  </StackItem>
                  <VStack width={72}>
                    <TextInput
                      label={index === 0 ? 'Qty' : `Qty ${index + 1}`}
                      isLabelHidden={index > 0}
                      value={line.quantity}
                      status={
                        lineParsed && (lineParsed.quantityMilli === null || lineParsed.quantityMilli <= 0)
                          ? { type: 'error' }
                          : undefined
                      }
                      onChange={(value) => updateLine(line.key, { quantity: value })}
                    />
                  </VStack>
                  <VStack width={104}>
                    <TextInput
                      label={index === 0 ? 'Cost' : `Cost ${index + 1}`}
                      isLabelHidden={index > 0}
                      value={line.unitPrice}
                      status={lineParsed && lineParsed.unitPriceCents === null ? { type: 'error' } : undefined}
                      onChange={(value) => updateLine(line.key, { unitPrice: value })}
                    />
                  </VStack>
                  <VStack width={88} hAlign="end" paddingBlock={1}>
                    <Text type="supporting" hasTabularNumbers>
                      {amount}
                    </Text>
                  </VStack>
                  <IconButton
                    label={`Move line ${index + 1} up`}
                    icon={<Icon icon="arrowUp" size="sm" />}
                    size="sm"
                    isDisabled={index === 0}
                    onClick={() => moveLine(index, -1)}
                  />
                  <IconButton
                    label={`Move line ${index + 1} down`}
                    icon={<Icon icon="arrowDown" size="sm" />}
                    size="sm"
                    isDisabled={index === lines.length - 1}
                    onClick={() => moveLine(index, 1)}
                  />
                  <IconButton
                    label={`Remove line ${index + 1}`}
                    icon={<Icon icon="close" size="sm" />}
                    size="sm"
                    variant="ghost"
                    isDisabled={lines.length === 1}
                    onClick={() => removeLine(line.key)}
                  />
                </HStack>
              );
            })}
            <HStack gap={2}>
              <Button
                label="Add item"
                variant="secondary"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              />
            </HStack>

            <Divider />
            <HStack gap={5} justify="end" wrap="wrap">
              <FieldValue label="Subtotal">
                <Text type="supporting" hasTabularNumbers>
                  {money(totals.subtotalCents, currency)}
                </Text>
              </FieldValue>
              <FieldValue label="Tax">
                <Text type="supporting" hasTabularNumbers>
                  {money(totals.taxCents, currency)}
                </Text>
              </FieldValue>
              <FieldValue label="Total">
                <Text weight="semibold" hasTabularNumbers>
                  {money(totals.totalCents, currency)}
                </Text>
              </FieldValue>
            </HStack>

            <TextArea label="Notes to customer" value={notes} rows={2} isOptional onChange={setNotes} />

            <HStack gap={2}>
              <Button
                label={isNew ? 'Create invoice' : 'Save changes'}
                variant="primary"
                isLoading={isSaving}
                onClick={() => {
                  void save();
                }}
              />
            </HStack>
          </VStack>
        </Card>

        <Card padding={4}>
          <VStack gap={3}>
            <Heading level={2}>Preview</Heading>
            <Section variant="muted" padding={4}>
              <InvoiceDocument model={documentModel} />
            </Section>
          </VStack>
        </Card>
      </Grid>
    </Page>
  );
}
