/**
 * The persistent application frame: identity sidebar and the content outlet
 * every route renders into.
 *
 * Layout note — why there is no `topNav`. On macOS `src/main/window.ts` sets
 * `titleBarStyle: 'hiddenInset'`, so the OS paints the traffic lights over the
 * renderer's top-left corner. AppShell renders `topNav` above *both* columns,
 * starting at x=0, which puts the lights on top of the bar's first element.
 * Instead the sidebar owns the top-left corner (SideNavHeading carries the app
 * identity) and both columns open with a reserved band that keeps the lights
 * over empty, draggable surface. There is no breadcrumb bar: the nav says where
 * you are, and the page's own heading says it again. See `./chrome` for the
 * geometry and `styles/global.css` for the drag regions and the sidebar panel.
 *
 * Downstream builders replace route *elements* (see routes.tsx). They do not
 * change this file — the shell is the same on every screen. Page-level layout
 * lives in `./ui/Page`.
 */

import { useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { Icon, type IconName, type IconType } from '@astryxdesign/core/Icon';
import { NavIcon } from '@astryxdesign/core/NavIcon';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StackItem, VStack } from '@astryxdesign/core/Stack';
import {
  SideNav,
  SideNavCollapseButton,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';

import type { ThemeMode } from '../shared/types';
import {
  collapsedRailWidth,
  isSectionSelected,
  NAV_GROUPS,
  readDesktopInfo,
  SECTION_ROUTES,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  titleBarInset,
  type NavGroup,
} from './chrome';
import { isDockVisible } from './ui/dockVisibility';
import { updateBadge } from './ui/updateBadge';
import { useThemeMode } from './ui/themeMode';
import { AssistantDock } from './ui/AssistantDock';
import { AssistantProvider } from './features/assistant/useAssistant';
import { useUpdates } from './features/updates/useUpdates';

export type { NavGroup } from './chrome';

/*
  The appearance context moved to `./ui/themeMode` so `ui/beam` can read it
  without importing this file — see that module's header for the cycle it
  breaks. These re-exports keep `App.tsx`'s existing import path working.
*/
export {
  ThemeModeContext,
  useThemeMode,
  type ThemeModeContextValue,
} from './ui/themeMode';

/**
 * Nav icons.
 *
 * The design system ships 26 semantic icon names (`npx astryx docs icons`) and
 * none of them mean "invoice", "client", "report", "model" or "assistant". The
 * Icon docs sanction the escape hatch we use here: "For any icon not in this
 * list, pass an SVG component directly." No icon library is installed and this
 * is an offline app, so these SVGs match the fallback set's own conventions —
 * 24x24 viewBox, currentColor, 1.5 stroke — and Icon sizes and colours them.
 * `/settings` uses the semantic `wrench` name.
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

/**
 * The design system asks for a distinct icon variant on the selected item.
 * These are line icons with no filled twin, so the selected variant is the same
 * glyph at a heavier stroke — the same trick the semantic set uses, and it
 * reads at 16px where a filled version of a receipt outline would not.
 */
function selectedVariant(Base: React.ComponentType<NavIconProps>): IconType {
  function Selected(props: NavIconProps): React.JSX.Element {
    return <Base strokeWidth={2.25} {...props} />;
  }
  return Selected;
}

function AppMarkIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M5 3.5h14v17l-3.5-2-3.5 2-3.5-2-3.5 2z" />
      <path d="M9 9h6" />
      <path d="M9 13h4" />
    </svg>
  );
}

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

/** Download-into-tray: the update indicator's glyph on the collapsed rail. */
function UpdateIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M12 3v11" />
      <path d="M8 10.5l4 4 4-4" />
      <path d="M4.5 18.5h15" />
    </svg>
  );
}

interface NavIconPair {
  readonly icon: IconType | IconName;
  readonly selectedIcon: IconType | IconName;
}

/** One icon pair per section path. Membership and order live in `./chrome`. */
const NAV_ICONS: Readonly<Record<string, NavIconPair>> = {
  '/invoices': { icon: InvoicesIcon, selectedIcon: selectedVariant(InvoicesIcon) },
  '/clients': { icon: ClientsIcon, selectedIcon: selectedVariant(ClientsIcon) },
  '/reports': { icon: ReportsIcon, selectedIcon: selectedVariant(ReportsIcon) },
  '/models': { icon: ModelsIcon, selectedIcon: selectedVariant(ModelsIcon) },
  '/assistant': { icon: AssistantIcon, selectedIcon: selectedVariant(AssistantIcon) },
  '/settings': { icon: 'wrench', selectedIcon: 'wrench' },
};

export interface NavItem {
  readonly path: string;
  readonly label: string;
  /** Semantic icon name or SVG component, passed straight to SideNavItem. */
  readonly icon: IconType | IconName;
  readonly selectedIcon: IconType | IconName;
  /** Sidebar section. Omitted means bottom-anchored in the SideNav footer. */
  readonly group?: NavGroup;
}

/**
 * The nav is the app's contract with itself: one entry per top-level route.
 * routes.tsx renders an element for each of these paths.
 */
/** A section added to `./chrome` without an icon renders, rather than crashing. */
const FALLBACK_ICONS: NavIconPair = { icon: 'wrench', selectedIcon: 'wrench' };

export const NAV_ITEMS: readonly NavItem[] = SECTION_ROUTES.map((route) => ({
  ...route,
  ...(NAV_ICONS[route.path] ?? FALLBACK_ICONS),
}));

function navItem(item: NavItem, pathname: string): React.JSX.Element {
  return (
    <SideNavItem
      key={item.path}
      label={item.label}
      icon={item.icon}
      selectedIcon={item.selectedIcon}
      // HashRouter: a plain `#/path` href navigates in-place without
      // reloading the document, which is what we need under file://.
      href={`#${item.path}`}
      isSelected={isSectionSelected(pathname, item.path)}
    />
  );
}

/**
 * Compact appearance control, in the sidebar footer beside Settings.
 *
 * It stays a SegmentedControl with exactly these three labels: the screenshot
 * harness in `preview/screenshots.mjs` drives appearance through
 * `getByRole('radio', { name: 'Light' | 'Dark' })`, and any other control shape
 * breaks that gate. Writes through useThemeMode().
 */
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

/**
 * The band the OS window controls sit in. Empty by construction and draggable,
 * because `hiddenInset` leaves the window with no title bar to grab. Collapses
 * to zero height off macOS, so the preview and the Windows/Linux builds have no
 * dead space at the top.
 */
function TitleBarInset({ height }: { height: string }): React.JSX.Element {
  return (
    // size="static" so the band keeps its exact height: it is a flex child of a
    // full-height column and would otherwise shrink under the content's demands.
    <StackItem size="static">
      <VStack className="app-drag-region" height={height} aria-hidden />
    </StackItem>
  );
}

export function AppShell(): React.JSX.Element {
  const { pathname } = useLocation();
  const desktop = readDesktopInfo();
  const inset = titleBarInset(desktop);
  const footerItems = NAV_ITEMS.filter((item) => item.group === undefined);
  /*
    Collapse is controlled here for one reason: `headerEndContent` is hidden
    while the rail is collapsed, so the toggle that lives on the heading row
    cannot also be the way back out. Knowing the state lets the collapsed rail
    render its own expand button in `footerIcons` and lets the theme control —
    which cannot shrink to an icon — sit out the collapsed state entirely.
  */
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { state: updateState } = useUpdates();
  const badge = updateBadge(updateState);

  /*
    The sidebar as an inset, rounded panel rather than a column welded to the
    window edge. Inline styles, in tokens: SideNav's own width/height come from
    the design system's StyleX classes, which carry specificity hacks that
    author CSS cannot outrank, and `minInlineSize` is precisely the property
    that widens the collapsed rail past the traffic lights (see `./chrome`)
    without fighting either the collapsed width or the resizable one.
  */
  const sideNavPanel: React.CSSProperties = {
    minInlineSize: collapsedRailWidth(desktop),
    boxSizing: 'border-box',
    marginBlock: 'var(--spacing-2)',
    marginInlineStart: 'var(--spacing-2)',
    blockSize: 'calc(100% - var(--spacing-4))',
    borderRadius: 'var(--radius-container)',
    background: 'var(--color-background-surface)',
  };

  return (
    /*
      One assistant, two surfaces. The provider sits above `<Outlet/>` so the
      `/assistant` page and the floating dock read the *same* state — same
      threads, same transcript, same stream. Two `useAssistant()` calls would be
      two chats that disagree about history.
    */
    <AssistantProvider>
      <AstryxAppShell
        height="fill"
        contentPadding={0}
        /*
          `section` draws a divider down the sidebar's inline-end edge, and that
          divider runs to y=0 — straight past the green traffic light. `elevated`
          separates the columns with background instead, which is what lets the
          sidebar read as the inset panel `sideNavPanel` shapes.
        */
        variant="elevated"
        sideNav={
          <SideNav
            className="app-side-nav"
            style={sideNavPanel}
            header={
              <VStack gap={0}>
                <TitleBarInset height={inset} />
                <SideNavHeading
                  icon={<NavIcon icon={<Icon icon={AppMarkIcon} size="sm" />} />}
                  heading="InvoiceApp"
                  headingHref="#/invoices"
                  /* A1: the toggle belongs on the identity row, not orphaned
                     under Settings. Hidden while collapsed — `footerIcons`
                     below is the way back. */
                  headerEndContent={<SideNavCollapseButton />}
                />
              </VStack>
            }
            footer={
              <VStack gap={1}>
                {badge.isVisible ? (
                  <SideNavItem
                    label={badge.label}
                    icon={UpdateIcon}
                    selectedIcon={selectedVariant(UpdateIcon)}
                    // The full update UI already lives on Settings; this is a
                    // pointer to it, not a second copy of it.
                    href="#/settings"
                  />
                ) : null}
                {footerItems.map((item) => navItem(item, pathname))}
                {isCollapsed ? null : <ThemeControl />}
              </VStack>
            }
            /* Only while collapsed: expanded, the heading row owns the toggle,
               and two of them would be the orphan chevron all over again. */
            footerIcons={isCollapsed ? <SideNavCollapseButton /> : undefined}
            collapsible={{
              isCollapsed,
              onCollapsedChange: setIsCollapsed,
              hasButton: false,
            }}
            resizable={{
              defaultWidth: SIDE_NAV_WIDTH.default,
              minWidth: SIDE_NAV_WIDTH.min,
              maxWidth: SIDE_NAV_WIDTH.max,
              autoSaveId: SIDE_NAV_WIDTH_STORAGE_ID,
            }}
          >
            {NAV_GROUPS.map((group) => (
              <SideNavSection key={group} title={group}>
                {NAV_ITEMS.filter((item) => item.group === group).map((item) =>
                  navItem(item, pathname),
                )}
              </SideNavSection>
            ))}
          </SideNav>
        }
      >
        <VStack gap={0} height="100%">
          {/*
            Kept even though the bar that used to sit under it is gone: this is
            the content half of the window's drag surface. Delete it and the
            top-right of the window cannot be grabbed at all.
          */}
          <TitleBarInset height={inset} />
          <StackItem size="fill">
            <Outlet />
          </StackItem>
          {/*
            Deliberately a sibling of the content outlet and *outside* both
            `.app-drag-region` bands above it. An element inside a drag region
            stops receiving clicks unless it appears in the `:where(...)` opt-out
            list in `styles/global.css`; the launcher is a fixed-position element
            in the bottom-right corner, nowhere near the draggable top bands, so
            it never has to opt back out.
          */}
          {isDockVisible(pathname) ? <AssistantDock /> : null}
        </VStack>
      </AstryxAppShell>
    </AssistantProvider>
  );
}
