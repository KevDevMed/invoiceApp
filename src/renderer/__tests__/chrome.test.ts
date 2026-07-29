import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_RAIL_MIN_PX,
  collapsedRailInlineEndPx,
  collapsedRailWidth,
  DEFAULT_COLLAPSED_RAIL_PX,
  DEFAULT_COLLAPSED_RAIL_WIDTH,
  isSectionSelected,
  NO_TITLE_BAR_INSET,
  OVERLAY_COLLAPSED_RAIL_WIDTH,
  OVERLAY_TITLE_BAR_INSET,
  PANEL_INSET,
  PANEL_INSET_PX,
  PANEL_INSET_TOTAL,
  PANEL_INSET_TOTAL_PX,
  readDesktopInfo,
  SECTION_ROUTES,
  RESIZABLE_STORAGE_PREFIX,
  SIDE_NAV_CONTROL_ROW_MIN_HEIGHT,
  SIDE_NAV_CONTROL_ROW_MIN_PX,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  SIDE_NAV_WIDTH_STORAGE_KEY,
  sideNavControlRowHeight,
  sideNavPanelGeometry,
  titleBarInset,
  TRAFFIC_LIGHT_ZONE_END_PX,
  wasSideNavCollapsed,
  WEB_DESKTOP_INFO,
} from '../chrome';

const DARWIN = { platform: 'darwin', hasOverlayWindowControls: true } as const;

// Same reasoning as APPROVED_OVERLAY_INSET below: asserting the fallback
// against WEB_DESKTOP_INFO only proves readDesktopInfo returns whatever that
// constant happens to hold. A fallback of `{ platform: 'darwin',
// hasOverlayWindowControls: true }` would reserve a 44px band in the browser
// preview and still pass. Written out so the fallback itself is pinned.
const APPROVED_WEB_FALLBACK = { platform: 'web', hasOverlayWindowControls: false };

describe('readDesktopInfo', () => {
  it('falls back to web when window.desktop is missing', () => {
    expect(readDesktopInfo({})).toEqual(APPROVED_WEB_FALLBACK);
    expect(readDesktopInfo(undefined)).toEqual(APPROVED_WEB_FALLBACK);
    expect(readDesktopInfo(null)).toEqual(APPROVED_WEB_FALLBACK);
  });

  it('exports the approved web fallback', () => {
    expect(WEB_DESKTOP_INFO).toEqual(APPROVED_WEB_FALLBACK);
  });

  it('reads a well-formed global', () => {
    expect(readDesktopInfo({ desktop: { platform: 'darwin', hasOverlayWindowControls: true } })).toEqual(
      { platform: 'darwin', hasOverlayWindowControls: true },
    );
    expect(readDesktopInfo({ desktop: { platform: 'win32', hasOverlayWindowControls: false } })).toEqual(
      { platform: 'win32', hasOverlayWindowControls: false },
    );
  });

  it('rejects an unknown platform', () => {
    expect(readDesktopInfo({ desktop: { platform: 'beos', hasOverlayWindowControls: true } })).toEqual(
      APPROVED_WEB_FALLBACK,
    );
    expect(readDesktopInfo({ desktop: 'darwin' })).toEqual(APPROVED_WEB_FALLBACK);
  });

  it('treats a non-boolean overlay flag as false', () => {
    expect(readDesktopInfo({ desktop: { platform: 'darwin', hasOverlayWindowControls: 'yes' } })).toEqual(
      { platform: 'darwin', hasOverlayWindowControls: false },
    );
    expect(readDesktopInfo({ desktop: { platform: 'linux' } })).toEqual({
      platform: 'linux',
      hasOverlayWindowControls: false,
    });
  });
});

// These are the approved values, written out rather than imported from the
// module under test. Comparing against OVERLAY_TITLE_BAR_INSET would only
// re-assert the implementation against itself: --spacing-1 (4px, lights
// overlap the shell again) or --spacing-10 (a 40px dead gap in the browser
// preview) would both keep the suite green while shipping the bug this file
// exists to prevent. --spacing-11 measures 44px, which clears the tallest
// traffic light at y 12-32; changing either constant must fail here.
const APPROVED_OVERLAY_INSET = 'var(--spacing-11)';
const APPROVED_NO_INSET = 'var(--spacing-0)';

describe('titleBarInset', () => {
  it('reserves the approved 44px band when the OS overlays window controls', () => {
    expect(titleBarInset({ platform: 'darwin', hasOverlayWindowControls: true })).toBe(
      APPROVED_OVERLAY_INSET,
    );
  });

  it('reserves nothing on web, Windows and Linux', () => {
    expect(titleBarInset(WEB_DESKTOP_INFO)).toBe(APPROVED_NO_INSET);
    expect(titleBarInset({ platform: 'win32', hasOverlayWindowControls: false })).toBe(
      APPROVED_NO_INSET,
    );
    expect(titleBarInset({ platform: 'linux', hasOverlayWindowControls: false })).toBe(
      APPROVED_NO_INSET,
    );
  });

  it('exports the approved spacing tokens, never raw pixels', () => {
    expect(OVERLAY_TITLE_BAR_INSET).toBe(APPROVED_OVERLAY_INSET);
    expect(NO_TITLE_BAR_INSET).toBe(APPROVED_NO_INSET);
  });
});

describe('SIDE_NAV_WIDTH', () => {
  // The traffic lights occupy roughly x 13-70. An expanded sidebar must own
  // that zone at every width the user can drag it to.
  it('cannot be narrowed under the traffic lights', () => {
    expect(SIDE_NAV_WIDTH.min).toBeGreaterThan(78);
  });

  it('keeps default between min and max', () => {
    expect(SIDE_NAV_WIDTH.default).toBeGreaterThanOrEqual(SIDE_NAV_WIDTH.min);
    expect(SIDE_NAV_WIDTH.default).toBeLessThanOrEqual(SIDE_NAV_WIDTH.max);
  });
});

describe('isSectionSelected', () => {
  it('matches the section path and anything nested under it', () => {
    expect(isSectionSelected('/invoices', '/invoices')).toBe(true);
    expect(isSectionSelected('/invoices/new', '/invoices')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    expect(isSectionSelected('/invoices-archive', '/invoices')).toBe(false);
    expect(isSectionSelected('/clients', '/invoices')).toBe(false);
  });
});

// The spacing scale astryx.css writes onto :root, copied here so the tokens the
// rail is built from can be resolved to real pixels in a node test. Asserting
// only the string 'calc(var(--spacing-11) * 2)' would pass just as happily for
// --spacing-2 (8px), which is the bug this suite exists to prevent.
const SPACING_PX: Readonly<Record<string, number>> = {
  '--spacing-2': 8,
  '--spacing-4': 16,
  '--spacing-9': 36,
  '--spacing-11': 44,
  '--spacing-12': 48,
};

/** Resolves the two shapes chrome.ts emits: `var(--x)` and `calc(var(--x) * n)`. */
function resolvePx(length: string): number {
  const plain = /^var\((--spacing-[\d-]+)\)$/.exec(length);
  if (plain !== null) return SPACING_PX[plain[1] ?? ''] ?? Number.NaN;

  const scaled = /^calc\(var\((--spacing-[\d-]+)\) \* (\d+)\)$/.exec(length);
  if (scaled !== null) return (SPACING_PX[scaled[1] ?? ''] ?? Number.NaN) * Number(scaled[2]);

  return Number.NaN;
}

describe('collapsedRailWidth', () => {
  it('clears the traffic-light zone when the OS overlays window controls', () => {
    const width = collapsedRailWidth({ platform: 'darwin', hasOverlayWindowControls: true });
    expect(resolvePx(width)).toBeGreaterThanOrEqual(COLLAPSED_RAIL_MIN_PX);
    expect(resolvePx(width)).toBeGreaterThanOrEqual(88);
  });

  it('keeps the design system width where there are no overlay controls', () => {
    expect(collapsedRailWidth(WEB_DESKTOP_INFO)).toBe(DEFAULT_COLLAPSED_RAIL_WIDTH);
    expect(collapsedRailWidth({ platform: 'win32', hasOverlayWindowControls: false })).toBe(
      DEFAULT_COLLAPSED_RAIL_WIDTH,
    );
    expect(collapsedRailWidth({ platform: 'linux', hasOverlayWindowControls: false })).toBe(
      DEFAULT_COLLAPSED_RAIL_WIDTH,
    );
  });

  it('is built from spacing tokens, never raw pixels', () => {
    expect(OVERLAY_COLLAPSED_RAIL_WIDTH).toMatch(/^calc\(var\(--spacing-\d+\) \* \d+\)$/);
    expect(DEFAULT_COLLAPSED_RAIL_WIDTH).toMatch(/^var\(--spacing-\d+\)$/);
  });

  // 48px ends inside the lights' x 13-70 zone, which is exactly the collision
  // the wider rail exists to fix.
  it('is wider than the design system default it replaces', () => {
    expect(resolvePx(OVERLAY_COLLAPSED_RAIL_WIDTH)).toBeGreaterThan(
      resolvePx(DEFAULT_COLLAPSED_RAIL_WIDTH),
    );
  });
});

/**
 * A localStorage double. `entries` is what the store holds; `failOn` makes
 * `getItem` throw the way a Safari private window does.
 */
function fakeStorage(entries: Record<string, string>, failing = false) {
  return {
    getItem(key: string): string | null {
      if (failing) throw new DOMException('denied', 'SecurityError');
      return entries[key] ?? null;
    },
  };
}

describe('wasSideNavCollapsed', () => {
  // The prefix is not exported by the design system, so it is copied into
  // chrome.ts. Pinned literally: derive the expected key from the constant and
  // a typo in the constant passes its own test while silently reading a key
  // nothing ever writes.
  it('reads the key useResizable actually writes', () => {
    expect(RESIZABLE_STORAGE_PREFIX).toBe('astryx-resizable:');
    expect(SIDE_NAV_WIDTH_STORAGE_KEY).toBe(`astryx-resizable:${SIDE_NAV_WIDTH_STORAGE_ID}`);
  });

  // useResizable persists `isCollapsed ? 0 : size`, so 0 is the collapse flag.
  it('is collapsed when the persisted width is 0', () => {
    expect(wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: '0' }))).toBe(true);
  });

  it('is expanded at a persisted normal width', () => {
    expect(wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: '264' }))).toBe(false);
    expect(
      wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: String(SIDE_NAV_WIDTH.min) })),
    ).toBe(false);
  });

  it('is expanded when the key is absent', () => {
    expect(wasSideNavCollapsed(fakeStorage({}))).toBe(false);
    expect(wasSideNavCollapsed(fakeStorage({ 'some-other-key': '0' }))).toBe(false);
  });

  it('is expanded on malformed JSON', () => {
    expect(wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: '{oops' }))).toBe(false);
    expect(wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: '' }))).toBe(false);
  });

  // The hook requires `typeof parsed === 'number'`, so a stringy or null 0 is
  // not collapse to it either. Disagreeing here is the whole bug.
  it('is expanded on a non-number value', () => {
    for (const raw of ['"0"', 'null', 'false', '{"width":0}', '[0]', '"264"']) {
      expect(wasSideNavCollapsed(fakeStorage({ [SIDE_NAV_WIDTH_STORAGE_KEY]: raw }))).toBe(false);
    }
  });

  it('is expanded when storage is unusable', () => {
    expect(wasSideNavCollapsed(fakeStorage({}, true))).toBe(false);
    expect(wasSideNavCollapsed(null)).toBe(false);
  });

  // Called as a React lazy initializer — React invokes it with no arguments,
  // and under `environment: 'node'` there is no localStorage to fall back on.
  it('defaults to expanded with no arguments', () => {
    expect(wasSideNavCollapsed()).toBe(false);
  });
});

// The approved inset, written out rather than imported. Comparing the geometry
// against PANEL_INSET would only re-assert the module against itself.
const APPROVED_PANEL_INSET = 'var(--spacing-2)';

describe('sideNavPanelGeometry', () => {
  it('insets the panel equally on all four edges', () => {
    const geometry = sideNavPanelGeometry(DARWIN);
    expect(geometry.marginBlock).toBe(APPROVED_PANEL_INSET);
    expect(geometry.marginInline).toBe(APPROVED_PANEL_INSET);
    expect(PANEL_INSET).toBe(APPROVED_PANEL_INSET);
  });

  // The bug this pins: add a fourth-side inset, forget the block-size calc, and
  // the panel's margin box runs past its parent — which is a scroll container.
  it('subtracts exactly both block insets from the panel height', () => {
    expect(PANEL_INSET_TOTAL_PX).toBe(PANEL_INSET_PX * 2);
    expect(resolvePx(PANEL_INSET_TOTAL)).toBe(resolvePx(PANEL_INSET) * 2);
    expect(sideNavPanelGeometry(DARWIN).blockSize).toBe(`calc(100% - ${PANEL_INSET_TOTAL})`);
  });

  it('keeps the collapsed-rail floor as the only width lever', () => {
    expect(sideNavPanelGeometry(DARWIN).minInlineSize).toBe(OVERLAY_COLLAPSED_RAIL_WIDTH);
    expect(sideNavPanelGeometry(WEB_DESKTOP_INFO).minInlineSize).toBe(DEFAULT_COLLAPSED_RAIL_WIDTH);
  });

  // Radius, background, shadow and border belong to the theme. An inline style
  // beats a theme rule, so a stray one here silently overrides the theme.
  it('carries no appearance properties', () => {
    for (const info of [DARWIN, WEB_DESKTOP_INFO]) {
      expect(Object.keys(sideNavPanelGeometry(info)).sort()).toEqual([
        'blockSize',
        'marginBlock',
        'marginInline',
        'minInlineSize',
      ]);
    }
  });

  it('is built from spacing tokens, never raw pixels', () => {
    const geometry = sideNavPanelGeometry(DARWIN);
    expect(geometry.marginBlock).toMatch(/^var\(--spacing-[\d-]+\)$/);
    expect(geometry.marginInline).toMatch(/^var\(--spacing-[\d-]+\)$/);
    expect(geometry.blockSize).toMatch(/^calc\(100% - var\(--spacing-[\d-]+\)\)$/);
  });
});

describe('collapsedRailInlineEndPx', () => {
  // The inset moved the rail's start edge off x=0, eating into the clearance
  // the rail width was picked for. Rail and inset must be checked together.
  it('still clears the traffic lights once the panel is inset', () => {
    expect(collapsedRailInlineEndPx(DARWIN)).toBeGreaterThan(TRAFFIC_LIGHT_ZONE_END_PX);
    expect(collapsedRailInlineEndPx(DARWIN)).toBe(PANEL_INSET_PX + COLLAPSED_RAIL_MIN_PX);
  });

  it('pins the traffic-light zone rather than deriving it', () => {
    expect(TRAFFIC_LIGHT_ZONE_END_PX).toBe(70);
  });

  it('uses the design system rail where there are no overlay controls', () => {
    expect(collapsedRailInlineEndPx(WEB_DESKTOP_INFO)).toBe(
      PANEL_INSET_PX + DEFAULT_COLLAPSED_RAIL_PX,
    );
    expect(resolvePx(DEFAULT_COLLAPSED_RAIL_WIDTH)).toBe(DEFAULT_COLLAPSED_RAIL_PX);
  });
});

describe('sideNavControlRowHeight', () => {
  // On macOS the buttons share the band with the lights, so it is the same
  // 44px `titleBarInset` already reserves.
  it('matches the reserved title-bar band on macOS', () => {
    expect(sideNavControlRowHeight(DARWIN)).toBe(titleBarInset(DARWIN));
    expect(resolvePx(sideNavControlRowHeight(DARWIN))).toBe(44);
  });

  // The bug this pins: `titleBarInset` is 0 off macOS. Reuse it for the control
  // row and the row collapses to nothing, hiding the only collapse toggle.
  it('never collapses to zero where there is no title-bar band', () => {
    for (const info of [
      WEB_DESKTOP_INFO,
      { platform: 'win32', hasOverlayWindowControls: false } as const,
      { platform: 'linux', hasOverlayWindowControls: false } as const,
    ]) {
      expect(titleBarInset(info)).toBe(NO_TITLE_BAR_INSET);
      expect(sideNavControlRowHeight(info)).not.toBe(NO_TITLE_BAR_INSET);
      expect(resolvePx(sideNavControlRowHeight(info))).toBeGreaterThanOrEqual(
        SIDE_NAV_CONTROL_ROW_MIN_PX,
      );
    }
  });

  it('is tall enough for an icon button, from spacing tokens', () => {
    expect(SIDE_NAV_CONTROL_ROW_MIN_PX).toBeGreaterThanOrEqual(32);
    expect(resolvePx(SIDE_NAV_CONTROL_ROW_MIN_HEIGHT)).toBe(SIDE_NAV_CONTROL_ROW_MIN_PX);
    expect(SIDE_NAV_CONTROL_ROW_MIN_HEIGHT).toMatch(/^var\(--spacing-[\d-]+\)$/);
  });
});

describe('SECTION_ROUTES', () => {
  it('keeps the nav order the routes depend on', () => {
    expect(SECTION_ROUTES.map((route) => route.path)).toEqual([
      '/invoices',
      '/clients',
      '/reports',
      '/models',
      '/assistant',
      '/settings',
    ]);
  });

  it('anchors only Settings in the footer', () => {
    expect(SECTION_ROUTES.filter((route) => route.group === undefined).map((r) => r.label)).toEqual([
      'Settings',
    ]);
  });
});
