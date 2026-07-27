/**
 * Clients feature barrel: searchable table, create/edit dialog, guarded delete.
 */

import { useCallback, useEffect, useState } from 'react';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Table, proportional, pixel } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Client } from '../../../shared/types';
import { ListFooter } from '../../ui/ListFooter';
import { Page, PageHeader, PageToolbar } from '../../ui/Page';
import { pageSlice } from '../../ui/pagination';
import { ClientForm } from './ClientForm';
import { toRow, type ClientTableRow } from './rows';

export function ClientsPage(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Client | null | 'new'>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const load = useCallback(async (term: string): Promise<void> => {
    setError(null);
    try {
      const result = await window.api.invoke('clients:list', {
        search: term.trim() === '' ? undefined : term.trim(),
        limit: 200,
        offset: 0,
      });
      setClients(result.items);
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

  useEffect(() => {
    setPage(1);
  }, [search]);

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
  const pagedRows = pageSlice(rows, page, pageSize);

  return (
    <Page>
      <PageHeader
        title="Clients"
        description="The people and companies you invoice."
        actions={
          <Button
            label="New client"
            variant="primary"
            onClick={() => {
              setEditing('new');
            }}
          />
        }
      />

      <PageToolbar>
        <TextInput
          label="Search clients"
          isLabelHidden
          placeholder="Search by name or email"
          value={search}
          onChange={setSearch}
        />
      </PageToolbar>

      {error ? <Banner status="error" title={error} isDismissable /> : null}
      {deleteError ? <Banner status="error" title={deleteError} isDismissable /> : null}

      {clients === null ? (
        <VStack gap={2} align="center" padding={6}>
          <Spinner size="lg" label="Loading clients" />
        </VStack>
      ) : rows.length === 0 ? (
        <EmptyState
          title={search ? 'Nothing matches this search' : 'No clients yet'}
          description={
            search
              ? 'No client name or email matches. Try a shorter term.'
              : 'Create your first client to start invoicing.'
          }
          headingLevel={2}
        />
      ) : (
        <VStack gap={0}>
          <Table<ClientTableRow>
            data={pagedRows}
            idKey="id"
            hasHover
            density="compact"
            columns={[
              {
                key: 'name',
                header: 'Name',
                width: proportional(2),
                renderCell: (row: ClientTableRow) => (
                  <HStack gap={2} align="center">
                    <Avatar size="sm" name={row.name} />
                    <Text weight="medium">{row.name}</Text>
                  </HStack>
                ),
              },
              { key: 'email', header: 'Email', width: proportional(2) },
              { key: 'phone', header: 'Phone', width: proportional(1) },
              { key: 'location', header: 'Location', width: proportional(1) },
              {
                key: 'actions',
                header: '',
                width: pixel(56),
                align: 'end',
                renderCell: (row: ClientTableRow) => (
                  <MoreMenu
                    label={`Actions for ${row.name}`}
                    size="sm"
                    items={[
                      {
                        label: 'Edit',
                        onClick: () => {
                          setEditing(row.client);
                        },
                      },
                      { type: 'divider' },
                      {
                        label: 'Delete',
                        onClick: () => {
                          setDeleteError(null);
                          setDeleting(row.client);
                        },
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
          <ListFooter
            total={rows.length}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </VStack>
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
    </Page>
  );
}
