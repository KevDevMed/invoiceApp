/**
 * Business settings page.
 *
 * Lifted out of routes.tsx so the route table has no page bodies in it and can
 * stay a file that nobody needs to edit again.
 *
 * Layout is the shared page language: grouped rows of `label + control` under a
 * section heading, hairline separators between rows, controls right-aligned.
 * No card per setting.
 */

import { useCallback, useEffect, useState } from 'react';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import { Selector } from '@astryxdesign/core/Selector';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';

import { SETTINGS_KEYS } from '../../shared/types';
import { Page, PageHeader } from '../ui/Page';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'BRL'];

/** Width of the control column, so every row's control lines up. */
const CONTROL_WIDTH = 340;

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
    <Page maxWidth={860}>
      <PageHeader
        title="Settings"
        description="These values are the defaults every new invoice starts from. They are stored locally in the app database."
        actions={
          <Button
            label="Save settings"
            variant="primary"
            isDisabled={isLoading}
            isLoading={isSaving}
            onClick={() => {
              void save();
            }}
          />
        }
      />

      {status ? <Banner status={status.kind} title={status.message} isDismissable /> : null}

      <SettingsGroup title="Business">
        <SettingsRow label="Business name" description="Printed at the top of every invoice.">
          <TextInput
            label="Business name"
            isLabelHidden
            value={settings.businessName}
            isDisabled={isLoading}
            placeholder="Acme Consulting LLC"
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, businessName: value }));
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Business address"
          description="Free text, one line per line. Printed under the business name."
        >
          <TextArea
            label="Business address"
            isLabelHidden
            value={settings.businessAddress}
            isDisabled={isLoading}
            rows={4}
            placeholder={'123 Market Street\nSuite 400\nSan Francisco, CA 94103'}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, businessAddress: value }));
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Invoice defaults">
        <SettingsRow label="Default currency" description="Every new invoice starts here.">
          <Selector
            label="Default currency"
            isLabelHidden
            options={CURRENCIES}
            value={settings.defaultCurrency}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, defaultCurrency: value }));
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Default tax rate"
          description="Basis points — 825 means 8.25%. Stored as an integer so tax math never uses floats."
        >
          <NumberInput
            label="Default tax rate"
            isLabelHidden
            value={settings.defaultTaxRateBps}
            min={0}
            max={1000000}
            step={25}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, defaultTaxRateBps: Math.trunc(value) }));
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="Invoice number prefix"
          description="Prepended to generated invoice numbers, e.g. INV-0001."
        >
          <TextInput
            label="Invoice number prefix"
            isLabelHidden
            value={settings.invoiceNumberPrefix}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, invoiceNumberPrefix: value }));
            }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Model downloads">
        {/*
          Optional on purpose: every model in the catalog downloads without a
          token. This is only for gated or private repos, where Hugging Face
          answers 401/403 until a token from an account that accepted the
          licence is sent.
        */}
        <SettingsRow
          label="Hugging Face access token"
          description="Only needed for gated or private model repos. Leave empty otherwise. Stored locally in the app database, in plain text."
        >
          <TextInput
            label="Hugging Face access token"
            isLabelHidden
            type="password"
            isOptional
            placeholder="hf_..."
            value={settings.hfToken}
            isDisabled={isLoading}
            onChange={(value) => {
              setSettings((prev) => ({ ...prev, hfToken: value }));
            }}
          />
        </SettingsRow>
      </SettingsGroup>
    </Page>
  );
}

// ---------------------------------------------------------------------------

/** A muted section label over a hairline-separated stack of setting rows. */
function SettingsGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={2}>
      {/* Visually quiet, semantically the page's h2 — see the Models page. */}
      <Heading level={3} accessibilityLevel={2}>
        {title}
      </Heading>
      <Divider />
      {children}
    </VStack>
  );
}

/** One row: label and supporting copy on the left, the control on the right. */
function SettingsRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={0}>
      <HStack gap={4} justify="between" align="start" paddingBlock={3} wrap="wrap">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Text weight="medium">{label}</Text>
            <Text type="supporting" display="block">
              {description}
            </Text>
          </VStack>
        </StackItem>
        <VStack width={CONTROL_WIDTH} maxWidth="100%">
          {children}
        </VStack>
      </HStack>
      <Divider />
    </VStack>
  );
}
