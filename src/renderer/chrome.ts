/**
 * Window-chrome decisions for the app shell, as pure functions.
 *
 * AppShell.tsx is a React file the test runner cannot mount — the root vitest
 * project is `environment: 'node'` and there is no DOM harness. Everything the
 * shell *decides* (what the platform is, how much space the traffic lights
 * need, how wide the collapsed rail has to be to clear them) therefore lives
 * here, free of React and of the design system, so it can be unit-tested
 * directly.
 */

/**
 * The shape of `window.desktop` has exactly one owner: `src/shared/desktop.ts`.
 * These are type-only imports, so nothing here is coupled to the preload at
 * runtime — `import type` is erased entirely, and the module is shared code,
 * not preload code. Re-exported because chrome.ts's own consumers name them.
 */
import type { DesktopInfo, DesktopPlatform } from '../shared/desktop';

export type { DesktopInfo, DesktopPlatform };

/**
 * What we assume when `window.desktop` is missing or malformed: a plain browser
 * with real OS window controls, so no reserved space and no drag surface.
 * `window.desktop` is installed by the Electron preload and by the preview
 * shim; unit tests and any pre-integration build see nothing at all. Electron
 * always installs the global, so nothing that ships in the desktop app can
 * reach this value.
 */
export const WEB_DESKTOP_INFO: DesktopInfo = {
  platform: 'web',
  hasOverlayWindowControls: false,
};

const PLATFORMS: readonly string[] = ['darwin', 'win32', 'linux', 'web'];

/**
 * The single place this renderer reads `window.desktop`. The global is owned by
 * the preload, is untyped from here, and may be absent — so it is validated,
 * never trusted, and always resolves to a usable DesktopInfo.
 */
export function readDesktopInfo(scope: unknown = globalThis): DesktopInfo {
  const candidate = (scope as { desktop?: unknown } | null | undefined)?.desktop;
  if (typeof candidate !== 'object' || candidate === null) return WEB_DESKTOP_INFO;

  const { platform, hasOverlayWindowControls } = candidate as {
    platform?: unknown;
    hasOverlayWindowControls?: unknown;
  };
  if (typeof platform !== 'string' || !PLATFORMS.includes(platform)) return WEB_DESKTOP_INFO;

  return {
    platform: platform as DesktopPlatform,
    hasOverlayWindowControls: hasOverlayWindowControls === true,
  };
}

/**
 * Does the top-left corner of this window hold a *real* traffic-light cluster?
 *
 * Only macOS under `titleBarStyle: 'hiddenInset'` does — the OS paints the
 * lights over the renderer there, and the shell has to reserve space so its
 * own controls do not sit underneath them. Everywhere else the band is zero:
 * win32/linux get a real OS title bar, and the browser preview draws no fake
 * cluster at all — there is no window to control, and placeholder dots were a
 * lie about the surface they sat on.
 */
export function reservesTrafficLightBand(info: DesktopInfo): boolean {
  return info.hasOverlayWindowControls;
}

/**
 * Vertical band reserved for the traffic lights, as a CSS length.
 *
 * macOS puts them at roughly x 13–70, y 12–32 under
 * `titleBarStyle: 'hiddenInset'`; --spacing-10 (40px) clears the tallest of
 * them with eight pixels to spare, and 40px is the band height every other
 * chrome row in this shell is measured against — the brand row, the tab strip
 * and the collapsed unified title bar are all the same height, which is what
 * makes the three of them read as one grid rather than three near-misses.
 */
export const OVERLAY_TITLE_BAR_INSET = 'var(--spacing-10)';

/** No overlay controls, no dead space — the preview must look intentional. */
export const NO_TITLE_BAR_INSET = 'var(--spacing-0)';

/**
 * Height of the band the traffic lights sit in, wherever it is drawn.
 *
 * Expanded, that band is the top row of the sidebar: the sidebar is never
 * narrower than `SIDE_NAV_WIDTH.min`, so it owns the whole light zone on its
 * own. Collapsed, the rail is 56px and the lights cannot fit in it at all, so
 * they move to a full-width unified title bar (`UNIFIED_TITLE_BAR_HEIGHT`)
 * spanning both columns — the standard macOS move, and the reason no piece of
 * geometry here has to reserve a light zone inside a narrow rail any more.
 */
export function titleBarInset(info: DesktopInfo): string {
  return reservesTrafficLightBand(info) ? OVERLAY_TITLE_BAR_INSET : NO_TITLE_BAR_INSET;
}

/**
 * The brand row: app mark, wordmark, and the collapse toggle at its inline end.
 *
 * Its own band, directly under the traffic lights and the same height as them,
 * rather than a 44px avatar row that outweighs the nav beneath it. Unlike the
 * light band this one is *not* conditional: it carries the only collapse
 * toggle, so on win32/linux — where there are no lights and the band above is
 * zero — it is still the sidebar's first visible row.
 */
export const BRAND_BAND_HEIGHT = 'var(--spacing-10)';

/**
 * The content column's tab-strip band, and the breadcrumb bar under it.
 *
 * 40 + 36. The strip is the taller of the two because it holds 28px pills; the
 * breadcrumb holds one line of supporting text and is deliberately lighter, so
 * the eye reads strip-then-trail rather than two equal bars.
 */
export const TAB_STRIP_BAND_HEIGHT = 'var(--spacing-10)';
export const BREADCRUMB_BAND_HEIGHT = 'var(--spacing-9)';

/**
 * The shell gutter: the one inline inset every band in the content column
 * starts at.
 *
 * The bands used to disagree. The tab strip sat at 24px (the design system's
 * own container padding, plus 8px this app added on top), the breadcrumb trail
 * at 16px, and the page column wherever its centred cap put it — three left
 * edges within 8px of each other down the top-left of the window, which reads
 * as three near-misses rather than three decisions. Each was individually
 * defensible and the staircase was not.
 *
 * 16px, because it is already two of the three: the breadcrumb bar's padding,
 * and `Section`'s `--container-padding-inline-start` default, which is what
 * indents the Toolbar the tab strip is built from. So the strip lands on the
 * gutter by *removing* its extra 8px, not by adding anything.
 *
 * The step is exported beside the token because Astryx layout components take a
 * spacing *step* (`paddingInline={4}`) while CSS takes the custom property; the
 * two are one decision and `shellBandInsetsPx` is what keeps them one.
 */
export const SHELL_GUTTER_STEP = 4;
export const SHELL_GUTTER = 'var(--spacing-4)';

/** --spacing-4, in px. Paired with the token so the two cannot drift. */
export const SHELL_GUTTER_PX = 16;

/**
 * Inline padding `Section` applies from the theme default, and so the inset
 * `Toolbar` — and the tab strip built on it — already carries before this app
 * adds anything (`Layout/container.stylex.ts`: the section padding chain
 * terminates at `--spacing-4`).
 *
 * Measured from the design system rather than declared by us, which is why it
 * is a plain number: if the theme ever moves it, the constant below is the one
 * line that has to change, and the test that pins the three bands together is
 * what will say so.
 */
export const SECTION_CONTAINER_PADDING_PX = 16;

/**
 * Extra inline-start padding `.app-invoice-tabs` adds on top of Section's own.
 *
 * Zero — and that is the fix. It used to be 8px, on the theory that Toolbar's
 * edge compensation pulled the first item back by that much; it does not, since
 * compensation only applies when the slot's first child carries
 * `data-astryx-edge-comp` and the strip's first child is a scroller.
 */
export const TAB_STRIP_EXTRA_INSET_PX = SHELL_GUTTER_PX - SECTION_CONTAINER_PADDING_PX;

/** Where each band in the content column puts its first element, in px from
 *  the content region's own inline start. */
export interface ShellBandInsetsPx {
  readonly tabStrip: number;
  readonly breadcrumbs: number;
  /**
   * The page column's *minimum* inset. `ui/Page` caps its column and centres
   * it, so on a window wide enough for the cap to bite the column steps further
   * in than this — deliberately, and by a whole gutter rather than by the 8px
   * that made the old three edges look accidental.
   */
  readonly pageMin: number;
}

/**
 * The three insets, so a unit test can assert they are one number.
 *
 * This is the whole of defect 2 expressed as code: the bands are aligned if and
 * only if these three agree, and no screenshot is needed to find out.
 */
export function shellBandInsetsPx(): ShellBandInsetsPx {
  return {
    tabStrip: SECTION_CONTAINER_PADDING_PX + TAB_STRIP_EXTRA_INSET_PX,
    breadcrumbs: SHELL_GUTTER_PX,
    pageMin: SHELL_GUTTER_PX,
  };
}

/**
 * The collapsed unified title bar: traffic lights, expand toggle, centred
 * `InvoiceApp — <page>` title, spanning both columns.
 */
export const UNIFIED_TITLE_BAR_HEIGHT = 'var(--spacing-10)';

/**
 * Sidebar width budget, in px (SideNav's `resizable` takes numbers).
 * `min` stays well clear of the 78px the traffic lights occupy, so an expanded
 * sidebar always owns the whole light zone; `default` is the 240px the design
 * measures its rhythm against.
 */
export const SIDE_NAV_WIDTH = {
  default: 240,
  min: 224,
  max: 360,
} as const;

/** localStorage key SideNav uses to persist the user's dragged width. */
export const SIDE_NAV_WIDTH_STORAGE_ID = 'invoiceapp.sidenav.width';

/**
 * Prefix the design system's `useResizable` puts in front of an `autoSaveId`
 * before touching localStorage (`Resizable/useResizable.ts`, `STORAGE_PREFIX`).
 * Duplicated here because the hook does not export it, and reading the same key
 * the hook writes is the whole point of `wasSideNavCollapsed` below.
 */
export const RESIZABLE_STORAGE_PREFIX = 'astryx-resizable:';

/** Full localStorage key the sidebar's persisted width is stored under. */
export const SIDE_NAV_WIDTH_STORAGE_KEY = `${RESIZABLE_STORAGE_PREFIX}${SIDE_NAV_WIDTH_STORAGE_ID}`;

/** The one method of `Storage` this module needs, so tests can inject a double. */
export interface StorageReader {
  getItem(key: string): string | null;
}

/**
 * localStorage, or null wherever it is unusable.
 *
 * Absent under `environment: 'node'` in the unit tests and in the main process;
 * *present but throwing on access* in a Safari private window. Both degrade to
 * "no persisted state" rather than taking the shell down on first render.
 */
function defaultStorage(): StorageReader | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Was the sidebar left collapsed at the end of the last session?
 *
 * The collapsed flag is *not* persisted separately: `useResizable` writes
 * `isCollapsed ? 0 : size` under one key and re-derives collapse on the next
 * mount as `persisted === 0`. AppShell drives SideNav's collapse in controlled
 * mode, so its initial state has to be derived from that same byte — a bare
 * `useState(false)` disagrees with the hook after a collapsed restart, and
 * SideNav then renders *expanded* content at `resizableHook.size`, which is 0.
 *
 * Mirrors the hook's own parse exactly (`JSON.parse`, number-typed, `=== 0`).
 * Anything missing, unparseable or not the number 0 means expanded, because
 * that is what the hook will decide too.
 */
export function wasSideNavCollapsed(
  storage: StorageReader | null | undefined = defaultStorage(),
  storageId: string = SIDE_NAV_WIDTH_STORAGE_ID,
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(`${RESIZABLE_STORAGE_PREFIX}${storageId}`);
    if (raw == null) return false;
    return (JSON.parse(raw) as unknown) === 0;
  } catch {
    return false;
  }
}

/** Sidebar group a nav item belongs to. Items without a group sit in the footer. */
export type NavGroup = 'Billing' | 'Insights' | 'Local AI';

export const NAV_GROUPS: readonly NavGroup[] = ['Billing', 'Insights', 'Local AI'];

export interface SectionRoute {
  readonly path: string;
  readonly label: string;
  /** Sidebar section. Omitted means bottom-anchored in the SideNav footer. */
  readonly group?: NavGroup;
}

/**
 * The app's top-level sections, in nav order. routes.tsx renders an element for
 * each of these paths; AppShell.tsx attaches an icon to each and renders them
 * as nav items.
 */
export const SECTION_ROUTES: readonly SectionRoute[] = [
  { path: '/invoices', label: 'Invoices', group: 'Billing' },
  { path: '/clients', label: 'Clients', group: 'Billing' },
  { path: '/reports', label: 'Reports', group: 'Insights' },
  { path: '/models', label: 'Models', group: 'Local AI' },
  { path: '/assistant', label: 'Assistant', group: 'Local AI' },
  { path: '/settings', label: 'Settings' },
];

/** A section is current for its own path and for anything nested under it. */
export function isSectionSelected(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** The product name, as the window title and the sidebar wordmark spell it. */
export const APP_NAME = 'InvoiceApp';

/** Label of the section the given route belongs to, or null off the nav. */
export function sectionLabel(pathname: string): string | null {
  return SECTION_ROUTES.find((route) => isSectionSelected(pathname, route.path))?.label ?? null;
}

/**
 * The collapsed title bar's centred title.
 *
 * `InvoiceApp — Invoices`, falling back to the bare product name off the nav.
 * Pure, because the collapsed rail is the one state where the shell has to
 * *say* where you are: the nav labels are gone and only the glyphs are left.
 */
export function windowTitle(pathname: string): string {
  const section = sectionLabel(pathname);
  return section === null ? APP_NAME : `${APP_NAME} — ${section}`;
}

/**
 * Width of the collapsed icon rail, as a CSS length.
 *
 * 56px: a 40px rail item centred in the 8px of inline padding SideNav puts on
 * either side of its scroll region. Only where there is no traffic-light
 * cluster to clear — see `COLLAPSED_RAIL_WITH_LIGHTS_WIDTH`.
 *
 * Applied as `min-inline-size`, not `width`: SideNav owns its collapsed width
 * and its expanded (resizable) width, and a floor is the one thing that widens
 * the rail without fighting either.
 */
export const COLLAPSED_RAIL_WIDTH = 'calc(var(--spacing-12) + var(--spacing-2))';

/** --spacing-12 + --spacing-2, in px. Paired with the token so the two cannot drift. */
export const COLLAPSED_RAIL_PX = 56;

/**
 * The collapsed rail where macOS paints real traffic lights over the corner.
 *
 * The cluster is pinned at window x 24 and is ~54px wide (`trafficLightPosition`
 * in `src/main/window.ts`), so it ends around x 78. The panel starts at x 8; a
 * 56px rail ends at 64 and cuts the cluster in half. 88px puts the panel edge
 * at 96 — the cluster sits inside the rail's own light band with 18px to spare,
 * which is the 88px the rail measured before the band ever left it.
 */
export const COLLAPSED_RAIL_WITH_LIGHTS_WIDTH = 'calc(var(--spacing-10) + var(--spacing-12))';

/** --spacing-10 + --spacing-12, in px. Paired with the token so the two cannot drift. */
export const COLLAPSED_RAIL_WITH_LIGHTS_PX = 88;

/**
 * Height of a group caption, and so of the blank that stands in for one on the
 * collapsed rail.
 *
 * Collapsing narrows; it does not rearrange. SideNavSection hides its caption
 * outright when collapsed (absolutely positioned, zero height), which slides
 * every row below it upwards and makes the toggle read as a reshuffle. The rail
 * therefore renders a band of exactly this height in the caption's place — empty
 * before the first group, a centred hairline before every later one — so each
 * nav row keeps the Y it had while the labels were showing.
 *
 * 24px is the caption's own block: --spacing-1 of padding above and below
 * SideNavSection's header, around one 20px line of --text-supporting.
 */
export const NAV_GROUP_CAPTION_HEIGHT = 'var(--spacing-6)';

/** --spacing-6, in px. Paired with the token so the two cannot drift. */
export const NAV_GROUP_CAPTION_PX = 24;

/**
 * The sidebar's inset budget — how far the floating panel sits from each window
 * edge, and from the content column.
 *
 * One value on all four edges, so the panel reads as a pill rather than a column
 * that happens to have rounded corners. The block-axis total is what the panel's
 * `blockSize` has to subtract: the panel is a 100%-height flex item, and a
 * margin on a `border-box` element is *outside* the box, so
 * `blockSize: 100%` plus `marginBlock` overflows its parent by exactly the two
 * margins. `PANEL_INSET_TOTAL` is that pair, named once so the margin and the
 * size calc cannot drift apart — the drift is invisible until it pushes a
 * scrollbar onto the shell.
 */
export const PANEL_INSET = 'var(--spacing-2)';

/** --spacing-2, in px. Paired with the token so the two cannot drift. */
export const PANEL_INSET_PX = 8;

/** Both block-axis insets, as one token: --spacing-4 is exactly 2 x --spacing-2. */
export const PANEL_INSET_TOTAL = 'var(--spacing-4)';

/** --spacing-4, in px. Must stay equal to `2 * PANEL_INSET_PX`. */
export const PANEL_INSET_TOTAL_PX = 16;

/** The floating panel's geometry. Purely size and position — never appearance. */
export interface SideNavPanelGeometry {
  readonly marginBlock: string;
  readonly marginInline: string;
  readonly blockSize: string;
  readonly minInlineSize: string;
}

/**
 * Geometry for the inset sidebar panel.
 *
 * Radius, background, shadow and border are deliberately absent: those are the
 * theme's, and a value set here would win over the theme by virtue of being an
 * inline style. `minInlineSize` is the one width property this may set — see
 * `COLLAPSED_RAIL_WIDTH` for why a floor, rather than a width, is the right
 * lever. The floor is wider where macOS paints a real cluster over the corner,
 * so the collapsed rail contains the lights instead of being cut through by
 * them.
 */
export function sideNavPanelGeometry(info: DesktopInfo): SideNavPanelGeometry {
  return {
    marginBlock: PANEL_INSET,
    marginInline: PANEL_INSET,
    blockSize: `calc(100% - ${PANEL_INSET_TOTAL})`,
    minInlineSize: reservesTrafficLightBand(info)
      ? COLLAPSED_RAIL_WITH_LIGHTS_WIDTH
      : COLLAPSED_RAIL_WIDTH,
  };
}

/**
 * Rightmost pixel the macOS traffic lights reach under `hiddenInset`. The
 * cluster spans roughly x 13-70; nothing interactive may start before this in
 * any band that begins at the window's own inline start.
 */
export const TRAFFIC_LIGHT_ZONE_END_PX = 70;

/**
 * The placeholder cluster, in px, measured from the *window* edge.
 *
 * macOS puts its own cluster at x 13–70. The placeholders cannot be positioned
 * absolutely — they live inside the sidebar's title band, which is inside the
 * inset panel — so their left edge is the sum of what is to their left: the
 * panel's margin, the panel's 1px border, and the padding SideNav's own header
 * wrapper carries (measured at 8px in Chromium; the band adds none of its own,
 * which is exactly why it passes `paddingInline={0}`). 8 + 1 + 8 = 17, four
 * pixels right of the real cluster and level with the nav pills below it, which
 * is as close as the panel's own geometry allows without hand-positioning them.
 *
 * The end is the number that matters: three 12px dots with two 8px gaps put the
 * cluster's right edge at 69, one pixel inside `TRAFFIC_LIGHT_ZONE_END_PX`, so
 * the preview's dots occupy no more of the rail than macOS's lights do.
 */
export const TRAFFIC_LIGHT_DOT_SIZE_PX = 12;
export const TRAFFIC_LIGHT_DOT_GAP_PX = 8;
export const TRAFFIC_LIGHT_DOT_COUNT = 3;

/** --border-width on the panel, in px. Part of the cluster's start offset. */
export const PANEL_BORDER_PX = 1;

/** SideNav's own header padding, in px. The rest of that offset. */
export const SIDE_NAV_HEADER_PADDING_INLINE_PX = 8;

export interface TrafficLightClusterPx {
  readonly startPx: number;
  readonly endPx: number;
}

/** Where the expanded sidebar's placeholder cluster lands, so the reference can
 *  be checked in a test. */
export function placeholderClusterPx(): TrafficLightClusterPx {
  const startPx = PANEL_INSET_PX + PANEL_BORDER_PX + SIDE_NAV_HEADER_PADDING_INLINE_PX;
  return { startPx, endPx: startPx + trafficLightClusterWidthPx() };
}

/** Three 12px dots with two 8px gaps: 52px, wherever the cluster is drawn. */
function trafficLightClusterWidthPx(): number {
  const dots = TRAFFIC_LIGHT_DOT_COUNT * TRAFFIC_LIGHT_DOT_SIZE_PX;
  const gaps = (TRAFFIC_LIGHT_DOT_COUNT - 1) * TRAFFIC_LIGHT_DOT_GAP_PX;
  return dots + gaps;
}

/**
 * Inline padding of the collapsed unified title bar.
 *
 * The bar starts at the window's own edge — it spans both columns — so this
 * padding alone decides where the placeholder cluster begins. 12px lands it one
 * pixel left of the 13px macOS itself uses.
 */
export const UNIFIED_TITLE_BAR_PADDING_INLINE = 'var(--spacing-3)';
export const UNIFIED_TITLE_BAR_PADDING_INLINE_PX = 12;

/**
 * Width of the slot the unified title bar keeps free for the traffic lights.
 *
 * Reserved rather than measured, because on macOS there is nothing to measure:
 * the OS paints the cluster over the renderer and the bar's first *element* is
 * the expand toggle. A fixed leading slot is what puts that toggle in the same
 * place in both builds — and past `TRAFFIC_LIGHT_ZONE_END_PX` in the one where
 * a real green light is sitting there.
 *
 * 12px of bar padding + 60px of slot = 72px, two clear of the 70 the lights end
 * at, and roomy enough for the 52px the placeholders occupy inside it.
 */
export const TRAFFIC_LIGHT_RESERVE_WIDTH = 'calc(var(--spacing-12) + var(--spacing-3))';
export const TRAFFIC_LIGHT_RESERVE_PX = 60;

/** Where the unified title bar's placeholder cluster lands. */
export function unifiedTitleBarClusterPx(): TrafficLightClusterPx {
  const startPx = UNIFIED_TITLE_BAR_PADDING_INLINE_PX;
  return { startPx, endPx: startPx + trafficLightClusterWidthPx() };
}

/** Inline start of everything after the reserved slot in the unified title bar. */
export function unifiedTitleBarContentStartPx(): number {
  return UNIFIED_TITLE_BAR_PADDING_INLINE_PX + TRAFFIC_LIGHT_RESERVE_PX;
}

/**
 * Height of the sidebar's traffic-light band.
 *
 * Nothing else is in it — that is the point. The band is the window's drag
 * surface and the lights' home, and putting a right-aligned cluster of ghost
 * buttons beside them (which is what this used to do) aligned those buttons to
 * nothing. They now live in the sidebar footer, and the collapse toggle in the
 * brand row below.
 *
 * Reserved in both sidebar states: with no unified title bar, the OS paints the
 * lights over the top-left corner whether the rail is collapsed or not, so the
 * rail must clear them or its first control sits underneath the cluster. Zero
 * on win32/linux — the OS paints a real title bar there and there is no cluster
 * to clear.
 */
export function sideNavControlRowHeight(info: DesktopInfo): string {
  return titleBarInset(info);
}

/**
 * Height of the *content* column's first band — the open-invoice tab strip.
 *
 * It is kept at its full height even with no tabs open wherever there is a
 * light cluster, because the band is also the content column's half of the
 * window's drag surface: `hiddenInset` leaves no title bar to grab, and the
 * sidebar's own band only covers the first 240px of the window. Where the OS
 * paints a real title bar there is nothing to reserve, so an empty strip
 * collapses to nothing rather than leaving dead space above every page.
 */
export function tabStripBandHeight(info: DesktopInfo, hasTabs: boolean): string {
  if (reservesTrafficLightBand(info)) return TAB_STRIP_BAND_HEIGHT;
  return hasTabs ? TAB_STRIP_BAND_HEIGHT : NO_TITLE_BAR_INSET;
}
