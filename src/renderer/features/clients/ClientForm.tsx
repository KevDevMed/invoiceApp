/**
 * Create/edit client form, rendered inside a Dialog.
 */

import { useState } from 'react';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Client, ClientInput } from '../../../shared/types';

export interface ClientFormProps {
  /** Existing client when editing, null when creating. */
  readonly client: Client | null;
  readonly onClose: () => void;
  readonly onSaved: (client: Client) => void;
}

interface Draft {
  name: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  taxId: string;
  notes: string;
}

function toDraft(client: Client | null): Draft {
  return {
    name: client?.name ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    addressLine1: client?.addressLine1 ?? '',
    addressLine2: client?.addressLine2 ?? '',
    city: client?.city ?? '',
    region: client?.region ?? '',
    postalCode: client?.postalCode ?? '',
    country: client?.country ?? '',
    taxId: client?.taxId ?? '',
    notes: client?.notes ?? '',
  };
}

function toInput(draft: Draft): ClientInput {
  const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    name: draft.name.trim(),
    email: orNull(draft.email),
    phone: orNull(draft.phone),
    addressLine1: orNull(draft.addressLine1),
    addressLine2: orNull(draft.addressLine2),
    city: orNull(draft.city),
    region: orNull(draft.region),
    postalCode: orNull(draft.postalCode),
    country: orNull(draft.country),
    taxId: orNull(draft.taxId),
    notes: orNull(draft.notes),
  };
}

export function ClientForm({ client, onClose, onSaved }: ClientFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => toDraft(client));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (): Promise<void> => {
    if (draft.name.trim() === '') {
      setError('A client needs a name.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const saved = client
        ? await window.api.invoke('clients:update', { id: client.id, patch: toInput(draft) })
        : await window.api.invoke('clients:create', toInput(draft));
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsSaving(false);
    }
  };

  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={520}>
      <DialogHeader
        title={client ? `Edit ${client.name}` : 'New client'}
        onOpenChange={(open) => !open && onClose()}
      />
      <VStack gap={3} padding={4}>
        {error ? <Banner status="error" title={error} /> : null}
        <FormLayout>
          <TextInput label="Name" value={draft.name} isRequired onChange={set('name')} />
          <TextInput label="Email" value={draft.email} isOptional onChange={set('email')} />
          <TextInput label="Phone" value={draft.phone} isOptional onChange={set('phone')} />
          <TextInput
            label="Address line 1"
            value={draft.addressLine1}
            isOptional
            onChange={set('addressLine1')}
          />
          <TextInput
            label="Address line 2"
            value={draft.addressLine2}
            isOptional
            onChange={set('addressLine2')}
          />
          <HStack gap={2}>
            <TextInput label="City" value={draft.city} isOptional onChange={set('city')} />
            <TextInput label="Region" value={draft.region} isOptional onChange={set('region')} />
            <TextInput
              label="Postal code"
              value={draft.postalCode}
              isOptional
              onChange={set('postalCode')}
            />
          </HStack>
          <TextInput label="Country" value={draft.country} isOptional onChange={set('country')} />
          <TextInput label="Tax ID" value={draft.taxId} isOptional onChange={set('taxId')} />
          <TextArea label="Notes" value={draft.notes} rows={3} isOptional onChange={set('notes')} />
        </FormLayout>
        <HStack gap={2}>
          <Button
            label={client ? 'Save changes' : 'Create client'}
            variant="primary"
            isLoading={isSaving}
            onClick={() => {
              void save();
            }}
          />
          <Button label="Cancel" variant="secondary" isDisabled={isSaving} onClick={onClose} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
