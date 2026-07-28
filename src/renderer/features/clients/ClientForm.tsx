/**
 * Create/edit client form, rendered inside a Dialog.
 */

import { useState } from 'react';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { Client } from '../../../shared/types';
import { toDraft, toInput, validateDraft, type ClientDraft, type DraftErrors } from './clientDraft';

export interface ClientFormProps {
  /** Existing client when editing, null when creating. */
  readonly client: Client | null;
  readonly onClose: () => void;
  readonly onSaved: (client: Client) => void;
}

export function ClientForm({ client, onClose, onSaved }: ClientFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<ClientDraft>(() => toDraft(client));
  const [fieldErrors, setFieldErrors] = useState<DraftErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof ClientDraft) => (value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    if (key === 'name' || key === 'email') {
      setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  };

  const fieldStatus = (
    key: keyof DraftErrors,
  ): { type: 'error'; message: string } | undefined => {
    const message = fieldErrors[key];
    return message ? { type: 'error', message } : undefined;
  };

  const save = async (): Promise<void> => {
    const errors = validateDraft(draft);
    if (errors.name !== undefined || errors.email !== undefined) {
      setFieldErrors(errors);
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
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={640}>
      <Layout
        header={
          <DialogHeader
            title={client ? `Edit ${client.name}` : 'New client'}
            subtitle="Only the name is required."
            onOpenChange={(open) => !open && onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error ? <Banner status="error" title={error} /> : null}
              <VStack gap={3}>
                <Heading level={3} accessibilityLevel={3}>
                  Contact
                </Heading>
                <FormLayout>
                  <TextInput
                    label="Name"
                    value={draft.name}
                    isRequired
                    status={fieldStatus('name')}
                    onChange={set('name')}
                  />
                  <FormLayout direction="horizontal">
                    <TextInput
                      label="Email"
                      type="email"
                      value={draft.email}
                      status={fieldStatus('email')}
                      onChange={set('email')}
                    />
                    <TextInput label="Phone" value={draft.phone} onChange={set('phone')} />
                  </FormLayout>
                </FormLayout>
              </VStack>
              <Divider />
              <VStack gap={3}>
                <Heading level={3} accessibilityLevel={3}>
                  Address
                </Heading>
                <FormLayout>
                  <TextInput
                    label="Address line 1"
                    value={draft.addressLine1}
                    onChange={set('addressLine1')}
                  />
                  <TextInput
                    label="Address line 2"
                    value={draft.addressLine2}
                    onChange={set('addressLine2')}
                  />
                  <FormLayout direction="horizontal">
                    <TextInput label="City" value={draft.city} onChange={set('city')} />
                    <TextInput label="Region" value={draft.region} onChange={set('region')} />
                  </FormLayout>
                  <FormLayout direction="horizontal">
                    <TextInput
                      label="Postal code"
                      value={draft.postalCode}
                      onChange={set('postalCode')}
                    />
                    <TextInput label="Country" value={draft.country} onChange={set('country')} />
                  </FormLayout>
                </FormLayout>
              </VStack>
              <Divider />
              <VStack gap={3}>
                <Heading level={3} accessibilityLevel={3}>
                  Other details
                </Heading>
                <FormLayout>
                  <TextInput label="Tax ID" value={draft.taxId} onChange={set('taxId')} />
                  <TextArea label="Notes" value={draft.notes} rows={3} onChange={set('notes')} />
                </FormLayout>
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="secondary" isDisabled={isSaving} onClick={onClose} />
              <Button
                label={client ? 'Save changes' : 'Create client'}
                variant="primary"
                isLoading={isSaving}
                onClick={() => {
                  void save();
                }}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
