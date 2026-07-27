/**
 * The persistent application frame: sidebar, theme toggle, and the content
 * outlet every route renders into.
 *
 * Downstream builders replace route *elements* (see routes.tsx). They do not
 * change this file — the shell is the same on every screen.
 */

import { createContext, useContext } from 'react';
import { Outlet, useLocation } from 'react-router';

import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { ThemeMode } from '../shared/types';

export interface NavItem {
  readonly path: string;
  readonly label: string;
}

/**
 * The nav is the app's contract with itself: one entry per top-level route.
 * routes.tsx renders an element for each of these paths.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/invoices', label: 'Invoices' },
  { path: '/clients', label: 'Clients' },
  { path: '/reports', label: 'Reports' },
  { path: '/models', label: 'Models' },
  { path: '/assistant', label: 'Assistant' },
  { path: '/settings', label: 'Settings' },
];

export interface ThemeModeContextValue {
  readonly mode: ThemeMode;
  readonly setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'system',
  setMode: () => undefined,
});

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

function ThemeToggle(): React.JSX.Element {
  const { mode, setMode } = useThemeMode();
  return (
    <VStack gap={1} padding={2}>
      <Text type="supporting">Appearance</Text>
      <SegmentedControl
        label="Appearance"
        size="sm"
        layout="fill"
        value={mode}
        onChange={(next) => {
          setMode(next as ThemeMode);
        }}
      >
        <SegmentedControlItem value="light" label="Light" />
        <SegmentedControlItem value="dark" label="Dark" />
        <SegmentedControlItem value="system" label="Auto" />
      </SegmentedControl>
    </VStack>
  );
}

export function AppShell(): React.JSX.Element {
  const { pathname } = useLocation();

  return (
    <AstryxAppShell
      height="fill"
      contentPadding={0}
      sideNav={
        <SideNav
          header={<SideNavHeading heading="InvoiceApp" subheading="Offline billing" />}
          footer={<ThemeToggle />}
          collapsible
        >
          <SideNavSection title="Workspace">
            {NAV_ITEMS.map((item) => (
              <SideNavItem
                key={item.path}
                label={item.label}
                // HashRouter: a plain `#/path` href navigates in-place without
                // reloading the document, which is what we need under file://.
                href={`#${item.path}`}
                isSelected={pathname === item.path || pathname.startsWith(`${item.path}/`)}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
      <Outlet />
    </AstryxAppShell>
  );
}
