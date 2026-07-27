/**
 * Clients feature barrel: searchable table, create/edit dialog, guarded delete.
 */

import { useCallback, useEffect, useState } from 'react';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Client } from '../../../shared/types';
import { ClientForm } from './ClientForm';

interface ClientTableRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  client: Client;
}

function toRow(client: Client): ClientTableRow {
  return {
    id: client.id,
    name: client.name,
    email: client.email ?? '—',
    phone: client.phone ?? '—',
    location: [client.city, client.country].filter(Boolean).join(', ') || '—',
    client,
  };
}

export function ClientsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState<Client[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Client | null | 'new'>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async (term: string): Promise<void> => {
    setError(null);
    try {
      const result = await window.api.invoke('clients:list', {
        search: term.trim() === '' ? undefined : term.trim(),
        limit: 200,
        offset: 0,
      });
      setClients(result.items);
      setTotal(result.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setClients([]);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void load(search);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [search, load]);

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      await window.api.invoke('clients:delete', { id: deleting.id });
      setDeleting(null);
      void load(search);
    } catch (cause) {
      // Typically "client has N invoice(s)" — surfaced inline, not as a crash.
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const rows = (clients ?? []).map(toRow);

  return (
    <VStack gap={4} padding={4} height="100%" isScrollable>
      <HStack gap={2} align="center" justify="between">
        <Heading level={1}>Clients</Heading>
        <Button
          label="New client"
          variant="primary"
          onClick={() => {
            setEditing('new');
          }}
        />
      </HStack>

      <HStack gap={2} align="end">
        <TextInput
          label="Search"
          isLabelHidden
          placeholder="Search by name or email"
          value={search}
          onChange={setSearch}
        />
        <Text type="supporting">{total} client(s)</Text>
      </HStack>

      {error ? <Banner status="error" title={error} isDismissable /> : null}
      {deleteError ? <Banner status="error" title={deleteError} isDismissable /> : null}

      {clients === null ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading clients" />
        </VStack>
      ) : rows.length === 0 ? (
        <EmptyState
          title={search ? 'No clients match your search' : 'No clients yet'}
          description={
            search
              ? 'Try a different name or email.'
              : 'Create your first client to start invoicing.'
          }
          headingLevel={2}
        />
      ) : (
        <Table<ClientTableRow>
          data={rows}
          idKey="id"
          hasHover
          columns={[
            { key: 'name', header: 'Name', width: proportional(2) },
            { key: 'email', header: 'Email', width: proportional(2) },
            { key: 'phone', header: 'Phone', width: proportional(1) },
            { key: 'location', header: 'Location', width: proportional(1) },
            {
              key: 'actions',
              header: '',
              width: pixel(170),
              renderCell: (row: ClientTableRow) => (
                <HStack gap={1}>
                  <Button
                    label="Edit"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing(row.client);
                    }}
                  />
                  <Button
                    label="Delete"
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(row.client);
                    }}
                  />
                </HStack>
              ),
            },
          ]}
        />
      )}

      {editing !== null ? (
        <ClientForm
          client={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void load(search);
          }}
        />
      ) : null}

      {deleting ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title="Delete client"
          description={`This permanently deletes "${deleting.name}". A client with invoices cannot be deleted.`}
          actionLabel="Delete client"
          isActionLoading={isDeleting}
          onAction={() => {
            void confirmDelete();
          }}
        />
      ) : null}
    </VStack>
  );
}
