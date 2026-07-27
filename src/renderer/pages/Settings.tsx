/**
 * Business settings page.
 *
 * Lifted out of routes.tsx so the route table has no page bodies in it and can
 * stay a file that nobody needs to edit again.
 */

import { useCallback, useEffect, useState } from 'react';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Heading } from '@astryxdesign/core/Heading';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import { SETTINGS_KEYS } from '../../shared/types';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'BRL'];

/**
 * Settings key the model downloader reads its Hugging Face token from.
 *
 * It is not in `SETTINGS_KEYS` — that lives in the frozen contract and covers
 * the business defaults only. The main process spells the same string in
 * `src/main/llm/extra-channels.ts` (`HF_TOKEN_SETTING_KEY`); the renderer cannot
 * import from `src/main`, so it is written out here.
 */
const HF_TOKEN_KEY = 'llm.hfToken';

interface BusinessSettings {
  businessName: string;
  businessAddress: string;
  defaultCurrency: string;
  defaultTaxRateBps: number;
  invoiceNumberPrefix: string;
  hfToken: string;
}

const DEFAULT_SETTINGS: BusinessSettings = {
  businessName: '',
  businessAddress: '',
  defaultCurrency: 'USD',
  defaultTaxRateBps: 0,
  invoiceNumberPrefix: 'INV-',
  hfToken: '',
};

async function readSetting(key: string): Promise<string | null> {
  const result = await window.api.invoke('settings:get', { key });
  return result.value;
}

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<BusinessSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [name, address, currency, taxRate, prefix, hfToken] = await Promise.all([
          readSetting(SETTINGS_KEYS.businessName),
          readSetting(SETTINGS_KEYS.businessAddress),
          readSetting(SETTINGS_KEYS.defaultCurrency),
          readSetting(SETTINGS_KEYS.defaultTaxRateBps),
          readSetting(SETTINGS_KEYS.invoiceNumberPrefix),
          readSetting(HF_TOKEN_KEY),
        ]);
        if (cancelled) return;

        const parsedTaxRate = Number.parseInt(taxRate ?? '', 10);
        setSettings({
          businessName: name ?? DEFAULT_SETTINGS.businessName,
          businessAddress: address ?? DEFAULT_SETTINGS.businessAddress,
          defaultCurrency: currency ?? DEFAULT_SETTINGS.defaultCurrency,
          defaultTaxRateBps: Number.isFinite(parsedTaxRate) ? parsedTaxRate : 0,
          invoiceNumberPrefix: prefix ?? DEFAULT_SETTINGS.invoiceNumberPrefix,
          hfToken: hfToken ?? DEFAULT_SETTINGS.hfToken,
        });
      } catch (error) {
        if (!cancelled) {
          setStatus({ kind: 'error', message: `Could not load settings: ${String(error)}` });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setIsSaving(true);
    setStatus(null);
    try {
      await Promise.all([
        window.api.invoke('settings:set', {
          key: SETTINGS_KEYS.businessName,
          value: settings.businessName,
        }),
        window.api.invoke('settings:set', {
          key: SETTINGS_KEYS.businessAddress,
          value: settings.businessAddress,
        }),
        window.api.invoke('settings:set', {
          key: SETTINGS_KEYS.defaultCurrency,
          value: settings.defaultCurrency,
        }),
        window.api.invoke('settings:set', {
          key: SETTINGS_KEYS.defaultTaxRateBps,
          value: String(settings.defaultTaxRateBps),
        }),
        window.api.invoke('settings:set', {
          key: SETTINGS_KEYS.invoiceNumberPrefix,
          value: settings.invoiceNumberPrefix,
        }),
        window.api.invoke('settings:set', {
          key: HF_TOKEN_KEY,
          value: settings.hfToken.trim(),
        }),
      ]);
      setStatus({ kind: 'success', message: 'Settings saved.' });
    } catch (error) {
      setStatus({ kind: 'error', message: `Could not save settings: ${String(error)}` });
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  return (
    <VStack gap={4} padding={4} maxWidth={720} isScrollable>
      <Heading level={1}>Settings</Heading>
      <Text type="supporting">
        These values are the defaults every new invoice starts from. They are stored locally in the
        app database.
      </Text>

      {status ? <Banner status={status.kind} title={status.message} isDismissable /> : null}

      <Card padding={4}>
        <FormLayout>
          <TextInput
            label="Business name"
            value={settings.businessName}
            isDisabled={isLoading}
            placeholder="Acme Consulting LLC"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, businessName: value }));
            }}
          />
          <TextArea
            label="Business address"
            value={settings.businessAddress}
            isDisabled={isLoading}
            rows={4}
            placeholder={'123 Market Street\nSuite 400\nSan Francisco, CA 94103'}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, businessAddress: value }));
            }}
          />
          <Selector
            label="Default currency"
            options={CURRENCIES}
            value={settings.defaultCurrency}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, defaultCurrency: value }));
            }}
          />
          <NumberInput
            label="Default tax rate"
            description="Basis points — 825 means 8.25%. Stored as an integer so tax math never uses floats."
            value={settings.defaultTaxRateBps}
            min={0}
            max={1000000}
            step={25}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, defaultTaxRateBps: Math.trunc(value) }));
            }}
          />
          <TextInput
            label="Invoice number prefix"
            description="Prepended to generated invoice numbers, e.g. INV-0001."
            value={settings.invoiceNumberPrefix}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, invoiceNumberPrefix: value }));
            }}
          />
          {/*
            Optional on purpose: every model in the catalog downloads without a
            token. This is only for gated or private repos, where Hugging Face
            answers 401/403 until a token from an account that accepted the
            licence is sent.
          */}
          <TextInput
            label="Hugging Face access token"
            type="password"
            isOptional
            description="Only needed for gated or private model repos. Leave empty otherwise. Stored locally in the app database, in plain text."
            placeholder="hf_..."
            value={settings.hfToken}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, hfToken: value }));
            }}
          />
        </FormLayout>
      </Card>

      <HStack gap={2}>
        <Button
          label="Save settings"
          variant="primary"
          isDisabled={isLoading}
          isLoading={isSaving}
          onClick={() => {
            void save();
          }}
        />
      </HStack>
    </VStack>
  );
}
