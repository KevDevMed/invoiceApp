/**
 * The persistent application frame: identity sidebar and the content outlet
 * every route renders into.
 *
 * Layout note — window controls. On macOS `src/main/window.ts` sets
 * `titleBarStyle: 'hiddenInset'`, so the OS paints the traffic lights over the
 * renderer's top-left corner and the sidebar's first band reserves that space
 * in both states — empty, a drag surface and nothing else. The band exists
 * only where the lights are real (`reservesTrafficLightBand`, darwin-only):
 * the browser preview and win32/linux get no band and no placeholder dots,
 * and their sidebar opens directly with its first control.
 *
 * The content column opens with the open-invoice tab strip and, under it, a
 * breadcrumb bar. The shell used to argue no breadcrumb was needed — the nav
 * says where you are and the heading says it again. The strip is what changed
 * that: it puts a row of sibling documents above the heading, and the collapsed
 * rail drops the nav labels entirely, so the trail is the only thing left that
 * states the path. Its inline end carries the live status line and the
 * assistant launcher: the band is the shell's own, so it is the one strip of
 * the content column where a shell-wide control cannot land on top of a page's.
 * See `./ui/breadcrumbTrail` for what the trail says, `./chrome` for the
 * geometry — including `SHELL_GUTTER`, the single inline inset the strip, the
 * trail and `./ui/Page` all begin at — and `styles/global.css` for the drag
 * regions and the panel.
 *
 * Downstream builders replace route *elements* (see routes.tsx). They do not
 * change this file — the shell is the same on every screen. Page-level layout
 * lives in `./ui/Page`.
 */

import { Fragment, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { Icon, type IconName, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NavIcon } from '@astryxdesign/core/NavIcon';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import {
  SideNav,
  SideNavCollapseButton,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';

import {
  BRAND_BAND_HEIGHT,
  isSectionSelected,
  NAV_GROUP_CAPTION_HEIGHT,
  NAV_GROUPS,
  readDesktopInfo,
  reservesTrafficLightBand,
  SECTION_ROUTES,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  sideNavControlRowHeight,
  sideNavPanelGeometry,
  tabStripBandHeight,
  wasSideNavCollapsed,
  type NavGroup,
} from './chrome';
import { breadcrumbTrail } from './ui/breadcrumbTrail';
import { isDockVisible } from './ui/dockVisibility';
import { InvoiceTabs, useInvoiceTabs } from './ui/InvoiceTabs';
import { DRAFT_TAB_ID, INVOICES_ROUTE, tabIdForPath } from './ui/invoiceTabsState';
import { ShellBreadcrumbs } from './ui/ShellBreadcrumbs';
import { invoiceCountLabel, invoiceStatusLine, useInvoiceCounts } from './ui/shellStatus';
import { updateBadge } from './ui/updateBadge';
import {
  nextThemeMode,
  themeToggleLabel,
  usePrefersDarkScheme,
  useThemeMode,
} from './ui/themeMode';
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

/**
 * Panel toggle: a rounded rectangle with its left column filled — the sidebar
 * seen from above, not a directional chevron. A chevron says "this moves left";
 * this glyph says "this pane hides", which is what the button actually does and
 * why it reads the same whether the rail is open or shut. The filled column
 * traces the outline's own left edge and radius, so the two never disagree.
 */
function PanelToggleIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <path d="M9.5 4.5H6A3 3 0 0 0 3 7.5v9A3 3 0 0 0 6 19.5h3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Appearance toggle, dark destination: a crescent, cut from one disc by another. */
function MoonIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
  );
}

/** Appearance toggle, light destination: disc plus eight rays. */
function SunIcon(props: NavIconProps): React.JSX.Element {
  return (
    <svg {...svgProps} {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2" />
      <path d="M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
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

function navItem(
  item: NavItem,
  pathname: string,
  endContent?: React.ReactNode,
): React.JSX.Element {
  return (
    <SideNavItem
      key={item.path}
      label={item.label}
      icon={item.icon}
      selectedIcon={item.selectedIcon}
      // 32px rows with 8px of inline padding — the design system's own `md`,
      // which is exactly the macOS sidebar metric the design asks for. Stated
      // rather than left to the default so the row height is a decision this
      // file made and `data-size="md"` is on the element for the theme to see.
      size="md"
      // HashRouter: a plain `#/path` href navigates in-place without
      // reloading the document, which is what we need under file://.
      href={`#${item.path}`}
      isSelected={isSectionSelected(pathname, item.path)}
      endContent={endContent}
    />
  );
}

/**
 * Trailing content on a nav row. One row has any: Invoices carries the number
 * of unpaid invoices.
 *
 * A quiet number rather than a Badge. A Badge is a filled pill and would be the
 * loudest thing in the panel — louder than the selected row it sits on — for a
 * figure that is context, not an alert. It is `supporting` type in secondary
 * ink with tabular figures, so it does not reflow as the count changes.
 *
 * The design also puts a status dot on Models. There is no honest source for it
 * here: model readiness lives behind the `llm:*` channels, which the browser
 * preview does not serve and which the shell would otherwise have to poll on
 * every boot for a six-pixel dot. Omitted rather than faked.
 */
function navEndContent(item: NavItem, openCount: string | null): React.ReactNode {
  if (item.path !== INVOICES_ROUTE || openCount === null) return undefined;
  return (
    <Text type="supporting" hasTabularNumbers>
      {openCount}
    </Text>
  );
}

/**
 * The blank a group caption leaves behind on the collapsed rail.
 *
 * Collapsing narrows; it does not rearrange. SideNavSection takes its caption
 * out of flow when collapsed, which slides every row below it upwards — so the
 * rail renders a band of the caption's exact height in its place, empty above
 * the first group and a centred 16px hairline above every later one. The toggle
 * then reads as a slide rather than a reshuffle, and the rule still says "a new
 * group starts here" without saying which.
 *
 * `aria-hidden`, because the grouping itself is not lost: SideNavSection keeps
 * its `role="group"` and its caption as visually-hidden text in both states.
 */
function NavGroupCaptionRule({ hasRule }: { hasRule: boolean }): React.JSX.Element {
  return (
    <VStack height={NAV_GROUP_CAPTION_HEIGHT} justify="center" align="center" aria-hidden>
      {hasRule ? <HStack className="app-nav-group-rule" /> : null}
    </VStack>
  );
}

/**
 * Appearance toggle, in the sidebar's title band between the update control and
 * the panel toggle.
 *
 * A glyph, not a three-state control: the full Light/Dark/Auto choice moved to
 * Settings > Appearance, and what is left here is the one-press flip a user
 * wants from a sidebar. The cycle (light <-> dark, `system` resolving to its
 * effective mode first) and the label wording live in `ui/themeMode` so they can
 * be unit-tested without a DOM — see `nextThemeMode`.
 *
 * The glyph shows the *destination*, matching the label: moon while the app is
 * light and about to go dark, sun while it is dark.
 */
function ThemeToggleButton(): React.JSX.Element {
  const { mode, setMode } = useThemeMode();
  const prefersDark = usePrefersDarkScheme();
  const next = nextThemeMode(mode, prefersDark);
  const label = themeToggleLabel(next);
  return (
    <IconButton
      label={label}
      tooltip={label}
      variant="ghost"
      // 28px, the same as the update glyph it sits beside in the footer.
      size="sm"
      icon={<Icon icon={next === 'dark' ? MoonIcon : SunIcon} size="sm" />}
      onClick={() => {
        setMode(next);
      }}
    />
  );
}

/**
 * A reserved band, and the window's drag surface — `hiddenInset` leaves no
 * title bar to grab.
 *
 * One caller: the content column's tab strip, the column's first row. It
 * collapses to zero height where the OS paints a real title bar and there is
 * nothing in it (see `./chrome`), so a win32 build carries no dead space above
 * its pages.
 *
 * Anything interactive in here has to opt out of the drag region or it stops
 * receiving clicks entirely; `<button>` and `<a>` are in the `:where(...)` list
 * in `styles/global.css`.
 */
function TitleBarInset({
  height,
  children,
}: {
  height: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  // size="static" so the band keeps its exact height: it is a flex child of a
  // full-height column and would otherwise shrink under the content's demands.
  return (
    <StackItem size="static">
      <HStack
        className="app-drag-region"
        height={height}
        width="100%"
        align="center"
        justify="start"
        gap={0.5}
        paddingInline={0}
        aria-hidden={children === undefined ? true : undefined}
      >
        {children}
      </HStack>
    </StackItem>
  );
}

/**
 * Accessible name of the collapse/expand toggle. One string for both states on
 * purpose: the screenshot harness asserts it, and the glyph does not change
 * between states either. Not derived from anything — a computed name is a name
 * that can drift out from under the harness.
 *
 * A fixed name would otherwise cost a screen-reader user the state the design
 * system's own default name carried ("Expand sidebar" / "Collapse sidebar"), so
 * the state moves to `aria-expanded` instead — see `collapseToggle` below.
 */
const SIDE_NAV_TOGGLE_LABEL = 'Toggle sidebar';

export function AppShell(): React.JSX.Element {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const desktop = readDesktopInfo();
  /*
    Collapse is controlled here because the two frames are not the same layout:
    the expanded header carries the brand row, the collapsed one only the
    traffic-light band. Only the owner of the state can render two different
    frames from it.

    Seeded from the *same* localStorage byte `resizable.autoSaveId` persists
    below, because controlled collapse and the resizable width are two views of
    one saved state. Seed it `false` instead and a collapsed restart renders the
    expanded sidebar at the hook's width of 0. See `wasSideNavCollapsed`.
  */
  const [isCollapsed, setIsCollapsed] = useState(wasSideNavCollapsed);
  const controlRowHeight = sideNavControlRowHeight(desktop);
  /*
    Open-invoice tabs. The state lives here — the shell is the only thing that
    outlives a route change — and every decision it makes is in `ui/invoiceTabsState`.
    The band's height depends on whether the strip has anything to draw, because
    there is nothing to reserve on win32/linux, where the OS paints a real title
    bar; see `tabStripBandHeight`.
  */
  const invoiceTabs = useInvoiceTabs();
  const contentBandHeight = tabStripBandHeight(desktop, invoiceTabs.tabs.length > 0);
  const footerItems = NAV_ITEMS.filter((item) => item.group === undefined);
  const { state: updateState } = useUpdates();
  const badge = updateBadge(updateState);

  /*
    The two live numbers the shell states: the count on the Invoices row and the
    breadcrumb's status line. One fetch feeds both, so they cannot disagree on
    screen — see `ui/shellStatus` for why the shell asks rather than the list
    page telling it.
  */
  const counts = useInvoiceCounts(pathname);
  const openCount = invoiceCountLabel(counts);

  /*
    The open invoice's number, for the deepest breadcrumb step. It comes from
    the tab strip's label cache rather than a second fetch: the strip already
    asked, and a trail that says `Invoice` while the pill beside it says
    `INV-0047` is two components disagreeing about one document.
  */
  const openTabId = tabIdForPath(pathname);
  const trail = breadcrumbTrail(
    pathname,
    openTabId === null || openTabId === DRAFT_TAB_ID
      ? undefined
      : invoiceTabs.labels[openTabId],
  );

  /*
    The sidebar as a floating panel rather than a column welded to the window
    edge: inset on all four sides, so there is a gap above, below, outside and
    between it and the content column. Inline styles, in tokens, because
    SideNav's own width/height come from the design system's StyleX classes,
    which carry specificity hacks that author CSS cannot outrank.

    Geometry only. Radius, background, shadow and border live in the theme —
    an inline style here would beat any rule the theme writes. The numbers
    themselves (and why `blockSize` must subtract exactly both block insets)
    are in `./chrome`, where they are unit-tested.
  */
  const sideNavPanel: React.CSSProperties = {
    boxSizing: 'border-box',
    ...sideNavPanelGeometry(desktop),
  };

  /*
    The update control: always on screen, blue only when something is waiting.

    It used to render `null` unless an update was pending, which made the row it
    sits in change shape under the user. Permanence is the point — this is where
    you go to ask about updates, so it has to be somewhere you can look. Which
    phases highlight, and what each phase is called, are `ui/updateBadge`'s
    decision; the blue itself is `--color-icon-update-pending` (see
    `theme/appTheme.ts` for why not `color="accent"`), applied through a class
    because Icon's own `color` prop has no value that resolves to it.

    `size="sm"` — a 28px glyph button, which is what the footer row has room for
    beside a 32px nav row without making the row taller than the ones above it.
  */
  const updateButton = (
    <IconButton
      label={badge.label}
      tooltip={badge.label}
      variant="ghost"
      size="sm"
      className={badge.isHighlighted ? 'app-update-button-pending' : undefined}
      icon={<Icon icon={UpdateIcon} size="sm" />}
      // The full update UI already lives on Settings; this is a pointer to it,
      // not a second copy of it. An IconButton has no href, so this navigates
      // the same HashRouter the nav items' `#/path` hrefs drive.
      onClick={() => {
        void navigate('/settings');
      }}
    />
  );

  /*
    `aria-expanded` carries the state the fixed label cannot. SideNavCollapseButton
    does not set it itself (only SideNavItem does), and it spreads its rest props
    into Button, which spreads them onto the rendered `<button>` — so this lands
    on the real element. `label` still wins the accessible name: Button applies
    its own `aria-label` *after* the spread. State comes from `isCollapsed`, the
    controlled value SideNav is driven by, so the attribute cannot disagree with
    what the rail is doing.

    One button, two homes, never both on screen: expanded it sits in the brand
    row; collapsed it sits at the top of the rail, above the first nav item.
    Both placements are inside the SideNav, so it always reads the collapse
    context directly.
  */
  const collapseToggle = (
    <SideNavCollapseButton label={SIDE_NAV_TOGGLE_LABEL} aria-expanded={!isCollapsed}>
      <Icon icon={PanelToggleIcon} size="sm" />
    </SideNavCollapseButton>
  );

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
            className={isCollapsed ? 'app-side-nav app-side-nav-collapsed' : 'app-side-nav'}
            style={sideNavPanel}
            /*
              The header's first band clears the real traffic lights: on macOS
              (`hiddenInset`) the OS paints them over this corner in *both*
              sidebar states, so the band is reserved in both — empty, a drag
              surface and nothing else; no placeholder dots anywhere.
              `reservesTrafficLightBand` is darwin-only, so on web and
              win32/linux the band is zero and the sidebar opens directly with
              its first control. Collapsed on those platforms the header is
              omitted outright — an empty one still costs SideNav's 16px of
              sticky-top padding.

              Expanded, the band is followed by the brand row: the lockup with
              the collapse toggle at the row's inline end. Also a drag surface —
              its only two children are a link and a button, both covered by the
              `:where(...)` opt-out in `styles/global.css`.
            */
            header={
              isCollapsed ? (
                reservesTrafficLightBand(desktop) ? (
                  <VStack gap={0} width="100%">
                    <TitleBarInset height={controlRowHeight} />
                  </VStack>
                ) : undefined
              ) : (
                <VStack gap={0} width="100%">
                  <TitleBarInset height={controlRowHeight} />
                  <HStack
                    className="app-drag-region"
                    height={BRAND_BAND_HEIGHT}
                    width="100%"
                    align="center"
                    justify="start"
                    gap={1}
                  >
                    <StackItem size="fill">
                      <SideNavHeading
                        icon={<NavIcon icon={<Icon icon={AppMarkIcon} size="sm" />} />}
                        heading="InvoiceApp"
                        headingHref="#/invoices"
                      />
                    </StackItem>
                    {collapseToggle}
                  </HStack>
                </VStack>
              )
            }
            /*
              Settings, and the two utility glyphs beside it — one row, which is
              where the design puts them and why they are here rather than in
              SideNav's own `footerIcons` slot: that slot renders its contents
              on a row of their own *below* the footer, which is two rows for
              what the design draws as one.

              Collapsed, the same three stack as rail glyphs. The reference
              folds the two utilities behind an overflow button at that width;
              stacking them keeps every control one press away instead of two,
              and the rail has the height for it.
            */
            footer={
              isCollapsed ? (
                <VStack gap={0.5} align="center">
                  {footerItems.map((item) => navItem(item, pathname))}
                  {updateButton}
                  <ThemeToggleButton />
                </VStack>
              ) : (
                <HStack gap={1} align="center">
                  <StackItem size="fill">
                    {footerItems.map((item) => navItem(item, pathname))}
                  </StackItem>
                  {updateButton}
                  <ThemeToggleButton />
                </HStack>
              )
            }
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
            {/*
              Collapsed, the rail's first control is the expand toggle, sitting
              above the first nav item. Inside the SideNav it reads the collapse
              context directly, so no `handleRef` indirection is needed.
            */}
            {isCollapsed ? (
              <VStack align="center" paddingBlock={0.5}>
                {collapseToggle}
              </VStack>
            ) : null}
            {NAV_GROUPS.map((group, index) => (
              <Fragment key={group}>
                {isCollapsed ? <NavGroupCaptionRule hasRule={index > 0} /> : null}
                <SideNavSection title={group}>
                  {NAV_ITEMS.filter((item) => item.group === group).map((item) =>
                    navItem(item, pathname, navEndContent(item, openCount)),
                  )}
                </SideNavSection>
              </Fragment>
            ))}
          </SideNav>
        }
      >
        <VStack gap={0} height="100%">
          {/*
            The content half of the window's drag surface — and the strip of
            open invoices, which is what the reserved band was being kept for.
            Delete it and the top-right of the window cannot be grabbed at all.

            With no tabs open `InvoiceTabs` renders null, so this is the same
            empty, `aria-hidden`, fully draggable band it has always been: no
            stray `+` on Settings. With tabs open the band is not decorative and
            must not be `aria-hidden`, or the strip inside it would be clickable
            but invisible to a screen reader.
          */}
          <TitleBarInset height={contentBandHeight}>
            {invoiceTabs.tabs.length === 0 ? undefined : (
              /* `size="fill"` so the strip owns the band's width and its own
                 scroller decides what fits, rather than shrink-wrapping the
                 pills and letting them push the band wider. */
              <StackItem size="fill">
                <InvoiceTabs state={invoiceTabs} />
              </StackItem>
            )}
          </TitleBarInset>
          {/*
            The trail, directly under the strip. Not part of the drag band above
            it: it is a row of links, and every one of them would otherwise have
            to opt back out of `-webkit-app-region`.

            It also carries the assistant launcher, at its inline end. The dock
            used to be a bubble fixed to the bottom-right of the window, which
            is where the invoice pane puts `Export PDF` and where Reports runs
            its table — so it covered the primary action of the app's busiest
            page. Reserving a safe area for it would have meant a dead band
            under every page including the full-bleed cockpit; putting it in a
            band the shell already owns means no page can be under it at all.
            This bar is not a drag region either, so the button needs no
            `-webkit-app-region` opt-out.
          */}
          <ShellBreadcrumbs
            trail={trail}
            status={invoiceStatusLine(counts)}
            action={isDockVisible(pathname) ? <AssistantDock /> : undefined}
          />
          <StackItem size="fill">
            <Outlet />
          </StackItem>
        </VStack>
      </AstryxAppShell>
    </AssistantProvider>
  );
}
