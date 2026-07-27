/**
 * Route table.
 *
 * DOWNSTREAM BUILDERS: replace the `element` for your feature's path with your
 * real page component. Do not change the shell route or the nav — `AppShell`
 * wraps every route and reads `NAV_ITEMS` from AppShell.tsx.
 *
 * Settings is implemented here rather than under pages/ because this piece owns
 * a fixed file list; it is a real page, not a placeholder.
 */

import { useCallback, useEffect, useState } from 'react';
import { Navigate, useRoutes, type RouteObject } from 'react-router';

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

import { SETTINGS_KEYS } from '../shared/types';
import { AppShell } from './AppShell';
import { Placeholder } from './pages/Placeholder';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'BRL'];

interface BusinessSettings {
  businessName: string;
  businessAddress: string;
  defaultCurrency: string;
  defaultTaxRateBps: number;
  invoiceNumberPrefix: string;
}

const DEFAULT_SETTINGS: BusinessSettings = {
  businessName: '',
  businessAddress: '',
  defaultCurrency: 'USD',
  defaultTaxRateBps: 0,
  invoiceNumberPrefix: 'INV-',
};

async function readSetting(key: string): Promise<string | null> {
  const result = await window.api.invoke('settings:get', { key });
  return result.value;
}

function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = useState<BusinessSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [name, address, currency, taxRate, prefix] = await Promise.all([
          readSetting(SETTINGS_KEYS.businessName),
          readSetting(SETTINGS_KEYS.businessAddress),
          readSetting(SETTINGS_KEYS.defaultCurrency),
          readSetting(SETTINGS_KEYS.defaultTaxRateBps),
          readSetting(SETTINGS_KEYS.invoiceNumberPrefix),
        ]);
        if (cancelled) return;

        const parsedTaxRate = Number.parseInt(taxRate ?? '', 10);
        setSettings({
          businessName: name ?? DEFAULT_SETTINGS.businessName,
          businessAddress: address ?? DEFAULT_SETTINGS.businessAddress,
          defaultCurrency: currency ?? DEFAULT_SETTINGS.defaultCurrency,
          defaultTaxRateBps: Number.isFinite(parsedTaxRate) ? parsedTaxRate : 0,
          invoiceNumberPrefix: prefix ?? DEFAULT_SETTINGS.invoiceNumberPrefix,
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

      {status ? (
        <Banner status={status.kind} title={status.message} isDismissable />
      ) : null}

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

const ROUTES: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/invoices" replace /> },
      { path: 'invoices', element: <Placeholder name="Invoices" /> },
      { path: 'clients', element: <Placeholder name="Clients" /> },
      { path: 'reports', element: <Placeholder name="Reports" /> },
      { path: 'models', element: <Placeholder name="Models" /> },
      { path: 'assistant', element: <Placeholder name="Assistant" /> },
      { path: 'settings', element: <SettingsPage /> },
      {
        path: '*',
        element: <Placeholder name="Not found" description="That route does not exist." />,
      },
    ],
  },
];

export function AppRoutes(): React.ReactElement | null {
  return useRoutes(ROUTES);
}
