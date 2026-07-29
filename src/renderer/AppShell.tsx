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
import { Outlet, useLocation, useNavigate } from 'react-router';

import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { Icon, type IconName, type IconType } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { NavIcon } from '@astryxdesign/core/NavIcon';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import {
  SideNav,
  SideNavCollapseButton,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from '@astryxdesign/core/SideNav';

import {
  hasPlaceholderWindowControls,
  isSectionSelected,
  NAV_GROUPS,
  readDesktopInfo,
  SECTION_ROUTES,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  sideNavControlRowHeight,
  sideNavPanelGeometry,
  titleBarInset,
  wasSideNavCollapsed,
  type NavGroup,
} from './chrome';
import { isDockVisible } from './ui/dockVisibility';
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
      icon={<Icon icon={next === 'dark' ? MoonIcon : SunIcon} size="sm" />}
      onClick={() => {
        setMode(next);
      }}
    />
  );
}

/**
 * The three macOS traffic lights, faked — browser preview only.
 *
 * macOS paints nothing into a browser, so the layout the design is reviewed in
 * would otherwise be a layout that never ships: no cluster in the corner, and
 * (before `reservesTrafficLightBand`) no band and no 88px rail either. These
 * are the cluster half of that mirror. See `chrome.ts` for the geometry and
 * `styles/global.css` for why a disc is a class rather than a component.
 *
 * Non-interactive by construction — no button, no href, no tabindex, no title —
 * so they are not a focus stop and need no drag-region opt-out: they sit inside
 * `.app-drag-region` precisely so the corner stays draggable. `aria-hidden` on
 * the cluster because they are decoration standing in for OS chrome; a screen
 * reader gains nothing from three unnamed dots.
 */
function WindowControlPlaceholders(): React.JSX.Element {
  return (
    <HStack className="app-window-controls" gap={2} align="center" aria-hidden>
      <HStack className="app-window-control-dot app-window-control-dot-close" />
      <HStack className="app-window-control-dot app-window-control-dot-minimize" />
      <HStack className="app-window-control-dot app-window-control-dot-zoom" />
    </HStack>
  );
}

/**
 * The band the window controls sit in, and the window's drag surface —
 * `hiddenInset` leaves no title bar to grab.
 *
 * With no children it is empty and `aria-hidden`: pure reserved space, and it
 * collapses to zero height on win32/linux, where the OS draws a real title bar,
 * so those builds have no dead space at the top. The sidebar's copy passes
 * children — the traffic lights at the start of the row, the controls at its end
 * — and then it must *not* be `aria-hidden`, or the controls inside it disappear
 * from the accessibility tree while staying clickable.
 *
 * `isDecorative` is the third case, and it exists because of the placeholders:
 * the collapsed rail's band has children on web (three dots) and none on macOS,
 * yet neither version holds anything interactive — the collapsed control glyphs
 * are in their own rows *below* the band. So the caller says so explicitly
 * rather than this inferring accessibility from `children === undefined`, which
 * would leave the web band exposed as an empty group for no reason.
 *
 * Anything interactive in here has to opt out of the drag region or it stops
 * receiving clicks entirely; `<button>` is in the `:where(...)` list in
 * `styles/global.css`, which is what all three controls below render as.
 */
function TitleBarInset({
  height,
  isDecorative = false,
  children,
}: {
  height: string;
  isDecorative?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  // size="static" so the band keeps its exact height: it is a flex child of a
  // full-height column and would otherwise shrink under the content's demands.
  return (
    <StackItem size="static">
      <HStack
        className="app-drag-region"
        height={height}
        /*
          The band claims the whole column rather than shrink-wrapping its
          content. SideNav's collapsed header lays its children out centred, so a
          shrink-wrapped band is as wide as whatever happens to be inside it —
          which moved the light cluster sideways every time the controls under it
          changed shape. Full width pins it to the panel's own left edge.
        */
        width="100%"
        align="center"
        justify="end"
        gap={0.5}
        /*
          No inline padding of its own. SideNav's header wrapper already carries
          8px, which is what puts the light cluster at x=17 — level with the nav
          pills below and one pixel inside the 70px the real lights end at. Add
          8px here and the cluster starts at 25 and ends at 77, past the green
          light and past the collapsed rail's usable width.
        */
        paddingInline={0}
        aria-hidden={children === undefined || isDecorative ? true : undefined}
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
  const inset = titleBarInset(desktop);
  const controlRowHeight = sideNavControlRowHeight(desktop);
  const footerItems = NAV_ITEMS.filter((item) => item.group === undefined);
  /*
    Collapse is controlled here for one reason: `headerEndContent` is hidden
    while the rail is collapsed, so the toggle that lives on the heading row
    cannot also be the way back out. Knowing the state is what lets the collapsed
    rail lay the same three controls out differently — below the reserved light
    band instead of beside the lights — rather than losing any of them.

    Seeded from the *same* localStorage byte `resizable.autoSaveId` persists
    below, because controlled collapse and the resizable width are two views of
    one saved state. Seed it `false` instead and a collapsed restart renders the
    expanded sidebar at the hook's width of 0. See `wasSideNavCollapsed`.
  */
  const [isCollapsed, setIsCollapsed] = useState(wasSideNavCollapsed);
  const { state: updateState } = useUpdates();
  const badge = updateBadge(updateState);

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

    It used to render `null` unless an update was pending, which made the top row
    change shape under the user. Permanence is the point — this is where you go
    to ask about updates, so it has to be somewhere you can look. Which phases
    highlight, and what each phase is called, are `ui/updateBadge`'s decision;
    the blue itself is `--color-icon-update-pending` (see `theme/appTheme.ts` for
    why not `color="accent"`), applied through a class because Icon's own
    `color` prop has no value that resolves to it.
  */
  const updateButton = (
    <IconButton
      label={badge.label}
      tooltip={badge.label}
      variant="ghost"
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
    Painted only in the browser preview, and only ever inside the sidebar's own
    title band: the lights belong to the window's top-left corner, which the
    panel owns at every width (see `SIDE_NAV_WIDTH.min` and the 88px rail).
  */
  const windowControls = hasPlaceholderWindowControls(desktop) ? (
    <StackItem size="fill">
      <WindowControlPlaceholders />
    </StackItem>
  ) : null;

  /*
    `aria-expanded` carries the state the fixed label cannot. SideNavCollapseButton
    does not set it itself (only SideNavItem does), and it spreads its rest props
    into Button, which spreads them onto the rendered `<button>` — so this lands
    on the real element. `label` still wins the accessible name: Button applies
    its own `aria-label` *after* the spread. State comes from `isCollapsed`, the
    controlled value SideNav is driven by, so the attribute cannot disagree with
    what the rail is doing.
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
            className="app-side-nav"
            style={sideNavPanel}
            header={
              /*
                `width="100%"` because SideNav's collapsed header wrapper centres
                its children: without it this column is only as wide as its widest
                child, and the light band — and so the light cluster — slides
                sideways whenever the controls beneath it change shape.
              */
              <VStack gap={0} width="100%">
                {/*
                  The title band: window controls at the start, app controls at
                  the end. `justify="end"` ends the controls; the placeholders
                  ride a `size="fill"` item, so on macOS — where there is no
                  element under the lights at all — the row is unchanged.

                  Expanded order, left to right: update, appearance, panel
                  toggle. The panel toggle is last because it is closest to the
                  pane it hides, which is what the reference does too.
                */}
                <TitleBarInset height={controlRowHeight} isDecorative={isCollapsed}>
                  {windowControls}
                  {isCollapsed ? null : (
                    <>
                      {updateButton}
                      <ThemeToggleButton />
                      {collapseToggle}
                    </>
                  )}
                </TitleBarInset>
                {/*
                  Collapsed, the same three controls move *below* the reserved
                  light band. They cannot sit beside the lights: the rail is 88px
                  wide and starts at x=8, and the cluster ends at x=70 — and they
                  cannot all share one row either, since three `md` buttons are
                  96px against the ~70px of content width an 88px rail leaves.

                  So: two rows. The panel toggle takes the first one alone —
                  it is the way back out of the collapsed state, so it is the
                  topmost and first-in-reading-order thing under the lights — and
                  the two occasional glyphs share the second (2 x 32px = 64px,
                  inside the 70px of content an 88px rail leaves; measured at
                  x 20-84 against a content box of 17-87). Two rows rather than
                  three stacked glyphs so the chrome reads as its own cluster
                  instead of extending the nav column above the app mark.
                */}
                {isCollapsed ? (
                  /* `paddingBlock` so the first glyph clears the light band
                     rather than butting straight onto its bottom edge. */
                  <VStack gap={0} align="center" paddingBlock={0.5}>
                    {collapseToggle}
                    <HStack gap={0} justify="center">
                      {updateButton}
                      <ThemeToggleButton />
                    </HStack>
                  </VStack>
                ) : null}
                <SideNavHeading
                  icon={<NavIcon icon={<Icon icon={AppMarkIcon} size="sm" />} />}
                  heading="InvoiceApp"
                  headingHref="#/invoices"
                />
              </VStack>
            }
            /*
              Settings, and nothing else. The appearance toggle used to share
              this row; it now lives in the title band with the other two
              glyphs, which is what the reference asks for — one thing at the
              foot of the panel, all the window chrome at its head. No wrapper
              either: an HStack around a single child is a row that does nothing.

              `footerIcons` is gone for the same reason. It existed only to hold
              the three controls the collapsed rail had nowhere else to put, and
              the collapsed rail now puts them at the top, where the user asked
              for them.
            */
            footer={<VStack gap={1}>{footerItems.map((item) => navItem(item, pathname))}</VStack>}
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
