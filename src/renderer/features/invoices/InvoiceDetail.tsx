/**
 * `/invoices/:id` — one invoice on its own.
 *
 * The triage cockpit (./InvoiceList) is where invoices are normally read, but
 * this route stays: it is what the shell's invoice tabs point at
 * (ui/invoiceTabsState.ts `tabRoute`) and what a deep link opens, and the
 * editor navigates back to it after a create. So it keeps its route and gives
 * up its layout — it renders the *same* `InvoicePane` the cockpit renders, at
 * full width, rather than a second arrangement of the same facts that would
 * drift from it. The list is the only thing missing, so the `1 of 66` counter
 * and the `J`/`K` chips are not shown: there is nothing here to move through.
 *
 * The stat-tile grid, the in-page Invoice/History/Notes tabs and the pinned
 * paper preview that used to live here are gone with that layout. The paper is
 * still one click away — `Edit` shows the live preview, and the pane's own
 * Export PDF renders the same document.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';

import type { Invoice, InvoiceWithItems } from '../../../shared/types';
import { todayIso } from './format';
import { fetchClientInvoices } from './listData';
import { InvoicePane } from './listPaneView';

export function InvoiceDetail(): React.JSX.Element {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [invoice, setInvoice] = useState<InvoiceWithItems | null>(null);
  const [clientInvoices, setClientInvoices] = useState<readonly Invoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Drop the previous invoice before fetching the next one, so moving
      // between two tabs shows the spinner rather than stale numbers.
      setInvoice(null);
      setClientInvoices(null);
      setLoadError(null);
      if (id === undefined) {
        setLoadError('This invoice no longer exists.');
        return;
      }
      try {
        const full = await window.api.invoke('invoices:get', { id });
        if (cancelled) return;
        if (full === null) {
          setLoadError('This invoice no longer exists.');
          return;
        }
        setInvoice(full);
        // The balance fact is a nice-to-have: a failed sweep leaves it out
        // rather than taking the whole page down with it.
        try {
          const siblings = await fetchClientInvoices(full.clientId);
          if (!cancelled) setClientInvoices(siblings);
        } catch {
          if (!cancelled) setClientInvoices(null);
        }
      } catch (cause) {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <VStack height="100%" gap={0}>
      <HStack
        gap={2}
        align="center"
        paddingInline={5}
        paddingBlock={2}
        style={{ borderBlockEnd: '1px solid var(--color-border)' }}
      >
        <Button
          label="All invoices"
          variant="ghost"
          size="sm"
          onClick={() => void navigate('/invoices')}
        />
      </HStack>

      {loadError !== null ? (
        <VStack gap={3} padding={5}>
          <Banner status="error" title={loadError} />
        </VStack>
      ) : invoice === null ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading invoice" />
        </VStack>
      ) : (
        <StackItem size="fill">
          <InvoicePane
            invoice={invoice}
            clientInvoices={clientInvoices}
            today={todayIso()}
            headingLevel={1}
            position={null}
            onPrevious={null}
            onNext={null}
            onShowClientInvoices={null}
            onOpenInTab={null}
            onInvoiceChanged={(updated) => {
              setInvoice((current) =>
                current === null || current.id !== updated.id ? current : { ...current, ...updated },
              );
            }}
          />
        </StackItem>
      )}
    </VStack>
  );
}
