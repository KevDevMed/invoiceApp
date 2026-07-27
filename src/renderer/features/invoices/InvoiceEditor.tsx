/**
 * Invoice editor: client, dates, currency, tax, notes, an editable line-item
 * grid with live totals, status transitions, and PDF export.
 *
 * Live totals use the exact same integer math the backend persists
 * (`computeInvoiceTotals` from src/shared/money.ts), so the preview and the
 * saved invoice can never disagree.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { DateInput } from '@astryxdesign/core/DateInput';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
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
import { STATUS_OPTIONS, money, todayIso } from './format';

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

export function InvoiceEditor(): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const isNew = id === undefined;

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clients, setClients] = useState<Client[]>([]);

  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null);
  const [status, setStatus] = useState<InvoiceStatus>('draft');
  const [clientId, setClientId] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(todayIso());
  const [currency, setCurrency] = useState('USD');
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const clientResult = await window.api.invoke('clients:list', { limit: 500, offset: 0 });
        if (cancelled) return;
        setClients(clientResult.items);

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
      const payload = { clientId, issueDate, dueDate, currency, taxRateBps, notes: notes || null, items };
      if (isNew) {
        const created = await window.api.invoke('invoices:create', payload);
        await navigate(`/invoices/${created.id}`, { replace: true });
      } else {
        const updated = await window.api.invoke('invoices:update', { id, patch: payload });
        setInvoiceNumber(updated.number);
        setNotice('Invoice saved.');
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
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
      <VStack gap={2} align="center" padding={6}>
        <Spinner size="lg" label="Loading invoice" />
      </VStack>
    );
  }
  if (loadError) {
    return (
      <VStack gap={4} padding={4}>
        <Banner status="error" title={loadError} />
        <HStack gap={2}>
          <Button label="Back to invoices" onClick={() => void navigate('/invoices')} />
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack gap={4} padding={4} maxWidth={960} isScrollable>
      <HStack gap={2} align="center" justify="between">
        <Heading level={1}>{isNew ? 'New invoice' : (invoiceNumber ?? 'Invoice')}</Heading>
        <HStack gap={2}>
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
          <Button label="Back" variant="ghost" onClick={() => void navigate('/invoices')} />
        </HStack>
      </HStack>

      {actionError ? <Banner status="error" title={actionError} isDismissable /> : null}
      {notice ? <Banner status="success" title={notice} isDismissable /> : null}

      <Card padding={4}>
        <VStack gap={3}>
          <Selector
            label="Client"
            placeholder="Choose a client"
            options={clients.map((client) => ({ value: client.id, label: client.name }))}
            value={clientId || null}
            hasSearch
            hasClear
            onChange={(value) => {
              setClientId(value ?? '');
            }}
          />
          <HStack gap={2}>
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
          <TextArea label="Notes" value={notes} rows={2} isOptional onChange={setNotes} />
        </VStack>
      </Card>

      <Card padding={4}>
        <VStack gap={2}>
          <Heading level={2}>Line items</Heading>
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
                <TextInput
                  label={index === 0 ? 'Description' : `Description ${index + 1}`}
                  isLabelHidden={index > 0}
                  value={line.description}
                  placeholder="What was delivered?"
                  onChange={(value) => updateLine(line.key, { description: value })}
                />
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
                <TextInput
                  label={index === 0 ? 'Unit price' : `Unit price ${index + 1}`}
                  isLabelHidden={index > 0}
                  value={line.unitPrice}
                  status={lineParsed && lineParsed.unitPriceCents === null ? { type: 'error' } : undefined}
                  onChange={(value) => updateLine(line.key, { unitPrice: value })}
                />
                <Text type="supporting">{amount}</Text>
                <IconButton
                  label={`Move line ${index + 1} up`}
                  icon={<span aria-hidden>↑</span>}
                  size="sm"
                  isDisabled={index === 0}
                  onClick={() => moveLine(index, -1)}
                />
                <IconButton
                  label={`Move line ${index + 1} down`}
                  icon={<span aria-hidden>↓</span>}
                  size="sm"
                  isDisabled={index === lines.length - 1}
                  onClick={() => moveLine(index, 1)}
                />
                <IconButton
                  label={`Remove line ${index + 1}`}
                  icon={<span aria-hidden>✕</span>}
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
              label="Add line"
              variant="secondary"
              size="sm"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
            />
          </HStack>

          <Divider />
          <VStack gap={1} align="end">
            <Text type="supporting">Subtotal: {money(totals.subtotalCents, currency)}</Text>
            <Text type="supporting">Tax: {money(totals.taxCents, currency)}</Text>
            <Text>Total: {money(totals.totalCents, currency)}</Text>
          </VStack>
        </VStack>
      </Card>

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
  );
}
