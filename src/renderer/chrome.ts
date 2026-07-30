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
 * shim; unit tests and any pre-integration build see nothing at all.
 *
 * The fallback platform is `'web'`, which now also means "paint traffic-light
 * placeholders" (see `hasPlaceholderWindowControls`). That is deliberate: the
 * fallback's whole claim is "this is a plain browser", and a plain browser is
 * exactly where the placeholders belong. Electron always installs the global,
 * so nothing that ships in the desktop app can reach this value.
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
 * Does this build draw *fake* macOS traffic lights?
 *
 * Only the browser preview does. Gated on the platform being exactly `'web'`
 * rather than on `!hasOverlayWindowControls`, because win32 and linux also have
 * no overlay controls — they get a real OS title bar
 * (`src/main/window.ts`, `titleBarStyle: 'default'`), and three macOS dots
 * under a Windows title bar would be a lie about the window they sit in.
 *
 * The preview exists so the design can be judged in a browser, and the layout
 * being judged has to be the layout that ships: on macOS the lights are real
 * and the shell reserves space for them, so on web the same space is reserved
 * and the same three dots are painted into it.
 */
export function hasPlaceholderWindowControls(info: DesktopInfo): boolean {
  return info.platform === 'web';
}

/**
 * Does the top-left corner of this window hold a traffic-light cluster at all —
 * painted by macOS, or by us?
 *
 * The single predicate every piece of geometry keys off, so the preview cannot
 * drift from darwin: a 12px dot cluster reserved a 36px band on a 48px rail
 * would make the reference worthless. Everything below that used to read
 * `hasOverlayWindowControls` directly now reads this instead.
 */
export function reservesTrafficLightBand(info: DesktopInfo): boolean {
  return info.hasOverlayWindowControls || hasPlaceholderWindowControls(info);
}

/**
 * Vertical band reserved above the shell's top row when the OS paints window
 * controls over the renderer. macOS puts the traffic lights at roughly
 * x 13–70, y 12–32 under `titleBarStyle: 'hiddenInset'`; --spacing-11 (44px)
 * clears the tallest of them with a few pixels to spare.
 */
export const OVERLAY_TITLE_BAR_INSET = 'var(--spacing-11)';

/** No overlay controls, no dead space — the preview must look intentional. */
export const NO_TITLE_BAR_INSET = 'var(--spacing-0)';

/**
 * Height of the reserved band, as a CSS length.
 *
 * The band spans the sidebar *and* the content column, not just the sidebar.
 * The lights are anchored to the window, not to the sidebar: collapse the
 * sidebar to its icon rail (~64px) or drag it to `SIDE_NAV_WIDTH.min` and the
 * lights stay at x 13–70, spilling past a narrow rail into the content column.
 * Reserving the band on both columns is the only rule that holds at every
 * sidebar width, including collapsed, so no nav icon, collapse button or
 * breadcrumb can ever sit under a light.
 */
export function titleBarInset(info: DesktopInfo): string {
  return reservesTrafficLightBand(info) ? OVERLAY_TITLE_BAR_INSET : NO_TITLE_BAR_INSET;
}

/**
 * Sidebar width budget, in px (SideNav's `resizable` takes numbers).
 * `min` stays well clear of the 78px the traffic lights occupy, so an expanded
 * sidebar always owns the whole light zone; `default` sits in the 240–280
 * band the layout docs recommend for a nav rail.
 */
export const SIDE_NAV_WIDTH = {
  default: 264,
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

/**
 * Narrowest the collapsed icon rail may be when the OS overlays window
 * controls, in px.
 *
 * The traffic lights occupy roughly x 13-70. The design system's own collapsed
 * width is --spacing-12 (48px), which ends *inside* that zone: the lights then
 * straddle the rail's inline-end edge and the divider runs between the yellow
 * and the green light. 88px puts the whole light cluster inside the rail with
 * room to spare, even once the panel is inset from the window edge by
 * --spacing-2 (8px): the rail then spans x 8-96 and the lights end at 70.
 */
export const COLLAPSED_RAIL_MIN_PX = 88;

/** 44 * 2 = 88px, expressed on the spacing scale rather than as a raw length. */
export const OVERLAY_COLLAPSED_RAIL_WIDTH = 'calc(var(--spacing-11) * 2)';

/** No overlay controls, no light zone to clear — the design system's own width. */
export const DEFAULT_COLLAPSED_RAIL_WIDTH = 'var(--spacing-12)';

/** --spacing-12, in px. Paired with the token above so the two cannot drift. */
export const DEFAULT_COLLAPSED_RAIL_PX = 48;

/**
 * Minimum width of the collapsed icon rail, as a CSS length.
 *
 * Applied as `min-inline-size`, not `width`: SideNav owns its collapsed width
 * and its expanded (resizable) width, and a floor is the one thing that widens
 * the rail without fighting either.
 */
export function collapsedRailWidth(info: DesktopInfo): string {
  return reservesTrafficLightBand(info)
    ? OVERLAY_COLLAPSED_RAIL_WIDTH
    : DEFAULT_COLLAPSED_RAIL_WIDTH;
}

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
 * `collapsedRailWidth` for why a floor, rather than a width, is the right lever.
 */
export function sideNavPanelGeometry(info: DesktopInfo): SideNavPanelGeometry {
  return {
    marginBlock: PANEL_INSET,
    marginInline: PANEL_INSET,
    blockSize: `calc(100% - ${PANEL_INSET_TOTAL})`,
    minInlineSize: collapsedRailWidth(info),
  };
}

/**
 * Inline-end edge of the collapsed rail, in px, measured from the window edge.
 *
 * The rail no longer starts at x=0 — it starts at `PANEL_INSET_PX`. That inset
 * eats into the clearance the rail's width was chosen to provide, so the two
 * have to be checked together against the traffic lights rather than apart.
 */
export function collapsedRailInlineEndPx(info: DesktopInfo): number {
  const width = reservesTrafficLightBand(info) ? COLLAPSED_RAIL_MIN_PX : DEFAULT_COLLAPSED_RAIL_PX;
  return PANEL_INSET_PX + width;
}

/**
 * Rightmost pixel the macOS traffic lights reach under `hiddenInset`. The
 * cluster spans roughly x 13-70; the collapsed rail has to end past this or the
 * green light straddles the panel's edge.
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

/** Where the placeholder cluster lands, so the reference can be checked in a test. */
export function placeholderClusterPx(): TrafficLightClusterPx {
  const startPx = PANEL_INSET_PX + PANEL_BORDER_PX + SIDE_NAV_HEADER_PADDING_INLINE_PX;
  const dots = TRAFFIC_LIGHT_DOT_COUNT * TRAFFIC_LIGHT_DOT_SIZE_PX;
  const gaps = (TRAFFIC_LIGHT_DOT_COUNT - 1) * TRAFFIC_LIGHT_DOT_GAP_PX;
  return { startPx, endPx: startPx + dots + gaps };
}

/**
 * Height of the sidebar's title band — the band holding the traffic lights (real
 * or placeholder) and, while expanded, the three ghost icon buttons.
 *
 * Where there is a light cluster this is the same 44px band `titleBarInset`
 * reserves, so the expanded buttons sit beside the lights rather than below
 * them. On win32/linux `titleBarInset` is zero — the OS draws its own title bar
 * and there are no lights to clear — but the row still has to be tall enough to
 * *show the buttons*, so it falls back to a real control height instead of
 * collapsing to nothing and hiding the only collapse toggle.
 */
export const SIDE_NAV_CONTROL_ROW_MIN_HEIGHT = 'var(--spacing-9)';

/** --spacing-9, in px. Comfortably clears a `size="sm"` icon button. */
export const SIDE_NAV_CONTROL_ROW_MIN_PX = 36;

export function sideNavControlRowHeight(info: DesktopInfo): string {
  return reservesTrafficLightBand(info)
    ? OVERLAY_TITLE_BAR_INSET
    : SIDE_NAV_CONTROL_ROW_MIN_HEIGHT;
}

/**
 * Height of the *content* column's band — the one that used to be reserved
 * space and nothing else, and now holds the open-invoice tab strip.
 *
 * Same shape of decision as `sideNavControlRowHeight`, and it exists for the
 * same reason: `titleBarInset` is 44px where there is a light cluster to clear
 * and 0px on win32/linux, where the OS paints a real title bar — and a strip
 * inside a zero-height band is a strip nobody can see or click.
 *
 * So the fallback is conditional on the band having something in it. With tabs
 * open it is a real control height; with none it stays flat 0, which is what
 * keeps a win32 build free of dead space above the page and keeps the band on
 * Settings exactly the empty drag surface it is today.
 *
 * The fallback is the same 44px, not the sidebar's 36px, because the strip is a
 * `size="sm"` Toolbar: a 28px element plus the 8px of block padding Toolbar puts
 * above and below it. A 36px band would clip the pills it exists to show.
 */
export const CONTENT_TITLE_BAR_MIN_HEIGHT = OVERLAY_TITLE_BAR_INSET;

export function contentTitleBarHeight(info: DesktopInfo, hasContent: boolean): string {
  if (reservesTrafficLightBand(info)) return OVERLAY_TITLE_BAR_INSET;
  return hasContent ? CONTENT_TITLE_BAR_MIN_HEIGHT : NO_TITLE_BAR_INSET;
}
