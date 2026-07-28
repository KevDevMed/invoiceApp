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
  return info.hasOverlayWindowControls ? OVERLAY_TITLE_BAR_INSET : NO_TITLE_BAR_INSET;
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

/**
 * Minimum width of the collapsed icon rail, as a CSS length.
 *
 * Applied as `min-inline-size`, not `width`: SideNav owns its collapsed width
 * and its expanded (resizable) width, and a floor is the one thing that widens
 * the rail without fighting either.
 */
export function collapsedRailWidth(info: DesktopInfo): string {
  return info.hasOverlayWindowControls
    ? OVERLAY_COLLAPSED_RAIL_WIDTH
    : DEFAULT_COLLAPSED_RAIL_WIDTH;
}
