/**
 * The persistent application frame: top bar (breadcrumb + theme control),
 * grouped sidebar, and the content outlet every route renders into.
 *
 * Downstream builders replace route *elements* (see routes.tsx). They do not
 * change this file — the shell is the same on every screen. Page-level layout
 * lives in `./ui/Page`.
 */

import { Fragment, createContext, useContext } from 'react';
import { Outlet, useLocation } from 'react-router';

import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import { Divider } from '@astryxdesign/core/Divider';
import type { IconName, IconType } from '@astryxdesign/core/Icon';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { VStack } from '@astryxdesign/core/Stack';
import { TopNav } from '@astryxdesign/core/TopNav';

import type { ThemeMode } from '../shared/types';

/**
 * Nav icons.
 *
 * The design system ships 26 semantic icon names (`npx astryx docs icons`) and
 * none of them mean "invoice", "client", "report", "model" or "assistant". The
 * Icon docs sanction the escape hatch we use here: "For any icon not in this
 * list, pass an SVG component directly." No icon library is installed and this
 * is an offline app, so these five minimal SVGs match the fallback set's own
 * conventions — 24x24 viewBox, currentColor, 1.5 stroke — and Icon sizes and
 * colours them. `/settings` uses the semantic `wrench` name.
 */
type NavIconProps = React.SVGProps<SVGSVGElement>;

const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function InvoicesIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h6" />
      <path d="M9 16h4" />
    </svg>
  );
}

function ClientsIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.6A3 3 0 1 1 17 11" />
      <path d="M20.5 20a5.5 5.5 0 0 0-3.3-5" />
    </svg>
  );
}

function ReportsIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M3 20h18" />
      <path d="M6 20v-7" />
      <path d="M12 20V5" />
      <path d="M18 20v-10" />
    </svg>
  );
}

function ModelsIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}

function AssistantIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z" />
      <path d="M9 10h6" />
    </svg>
  );
}

/** Sidebar group a nav item belongs to. Items without a group sit in the footer. */
export type NavGroup = 'Billing' | 'Insights' | 'Local AI';

export interface NavItem {
  readonly path: string;
  readonly label: string;
  /** Semantic icon name or SVG component, passed straight to SideNavItem. */
  readonly icon: IconType | IconName;
  /** Sidebar section. Omitted means bottom-anchored in the SideNav footer. */
  readonly group?: NavGroup;
}

/**
 * The nav is the app's contract with itself: one entry per top-level route.
 * routes.tsx renders an element for each of these paths.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/invoices', label: 'Invoices', icon: InvoicesIcon, group: 'Billing' },
  { path: '/clients', label: 'Clients', icon: ClientsIcon, group: 'Billing' },
  { path: '/reports', label: 'Reports', icon: ReportsIcon, group: 'Insights' },
  { path: '/models', label: 'Models', icon: ModelsIcon, group: 'Local AI' },
  { path: '/assistant', label: 'Assistant', icon: AssistantIcon, group: 'Local AI' },
  { path: '/settings', label: 'Settings', icon: 'wrench' },
];

const NAV_GROUPS: readonly NavGroup[] = ['Billing', 'Insights', 'Local AI'];

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

function isSelected(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function navItem(item: NavItem, pathname: string): React.JSX.Element {
  return (
    <SideNavItem
      key={item.path}
      label={item.label}
      icon={item.icon}
      // HashRouter: a plain `#/path` href navigates in-place without
      // reloading the document, which is what we need under file://.
      href={`#${item.path}`}
      isSelected={isSelected(pathname, item.path)}
    />
  );
}

/** Compact appearance control for the top bar. Writes through useThemeMode(). */
function ThemeControl(): React.JSX.Element {
  const { mode, setMode } = useThemeMode();
  return (
    <SegmentedControl
      label="Appearance"
      size="sm"
      value={mode}
      onChange={(next) => {
        setMode(next as ThemeMode);
      }}
    >
      <SegmentedControlItem value="light" label="Light" />
      <SegmentedControlItem value="dark" label="Dark" />
      <SegmentedControlItem value="system" label="Auto" />
    </SegmentedControl>
  );
}

/** `InvoiceApp / <section>`, derived from the route. */
function sectionLabel(pathname: string): string | null {
  const match = NAV_ITEMS.find((item) => isSelected(pathname, item.path));
  return match?.label ?? null;
}

export function AppShell(): React.JSX.Element {
  const { pathname } = useLocation();
  const section = sectionLabel(pathname);
  const footerItems = NAV_ITEMS.filter((item) => item.group === undefined);

  return (
    <AstryxAppShell
      height="fill"
      contentPadding={0}
      variant="section"
      topNav={
        <TopNav
          label="Application"
          startContent={
            <Breadcrumbs>
              <BreadcrumbItem href="#/invoices" isCurrent={section === null}>
                InvoiceApp
              </BreadcrumbItem>
              {section === null ? null : <BreadcrumbItem isCurrent>{section}</BreadcrumbItem>}
            </Breadcrumbs>
          }
          endContent={<ThemeControl />}
        />
      }
      sideNav={
        <SideNav
          footer={
            <VStack gap={0} paddingBlock={1}>
              <Divider />
              {footerItems.map((item) => navItem(item, pathname))}
            </VStack>
          }
          collapsible
        >
          {NAV_GROUPS.map((group, index) => (
            <Fragment key={group}>
              {index === 0 ? null : <Divider />}
              <SideNavSection title={group}>
                {NAV_ITEMS.filter((item) => item.group === group).map((item) =>
                  navItem(item, pathname),
                )}
              </SideNavSection>
            </Fragment>
          ))}
        </SideNav>
      }
    >
      <Outlet />
    </AstryxAppShell>
  );
}
