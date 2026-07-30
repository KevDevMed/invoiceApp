import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_RAIL_MIN_PX,
  collapsedRailInlineEndPx,
  collapsedRailWidth,
  CONTENT_TITLE_BAR_MIN_HEIGHT,
  contentTitleBarHeight,
  DEFAULT_COLLAPSED_RAIL_PX,
  DEFAULT_COLLAPSED_RAIL_WIDTH,
  hasPlaceholderWindowControls,
  isSectionSelected,
  NO_TITLE_BAR_INSET,
  OVERLAY_COLLAPSED_RAIL_WIDTH,
  OVERLAY_TITLE_BAR_INSET,
  PANEL_BORDER_PX,
  PANEL_INSET,
  PANEL_INSET_PX,
  PANEL_INSET_TOTAL,
  PANEL_INSET_TOTAL_PX,
  placeholderClusterPx,
  readDesktopInfo,
  reservesTrafficLightBand,
  SECTION_ROUTES,
  RESIZABLE_STORAGE_PREFIX,
  SIDE_NAV_CONTROL_ROW_MIN_HEIGHT,
  SIDE_NAV_CONTROL_ROW_MIN_PX,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  SIDE_NAV_WIDTH_STORAGE_KEY,
  sideNavControlRowHeight,
  sideNavPanelGeometry,
  SIDE_NAV_HEADER_PADDING_INLINE_PX,
  titleBarInset,
  TRAFFIC_LIGHT_DOT_COUNT,
  TRAFFIC_LIGHT_DOT_GAP_PX,
  TRAFFIC_LIGHT_DOT_SIZE_PX,
  TRAFFIC_LIGHT_ZONE_END_PX,
  wasSideNavCollapsed,
  WEB_DESKTOP_INFO,
} from '../chrome';

const DARWIN = { platform: 'darwin', hasOverlayWindowControls: true } as const;
const WIN32 = { platform: 'win32', hasOverlayWindowControls: false } as const;
const LINUX = { platform: 'linux', hasOverlayWindowControls: false } as const;

/**
 * The two platforms the OS gives a real title bar to (`src/main/window.ts` only
 * applies `hiddenInset` on darwin). They are the *only* two that reserve
 * nothing: darwin has real lights, and web paints placeholders for them.
 */
const REAL_TITLE_BAR = [WIN32, LINUX] as const;

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

describe('hasPlaceholderWindowControls', () => {
  it('paints fake lights in the browser preview and nowhere else', () => {
    expect(hasPlaceholderWindowControls(WEB_DESKTOP_INFO)).toBe(true);
    expect(hasPlaceholderWindowControls(DARWIN)).toBe(false);
    // The bug this pins: gating on `!hasOverlayWindowControls` instead of on the
    // platform. win32 and linux also have no overlay controls — they have a real
    // OS title bar — so they would get three macOS dots under a Windows frame.
    expect(hasPlaceholderWindowControls(WIN32)).toBe(false);
    expect(hasPlaceholderWindowControls(LINUX)).toBe(false);
  });

  it('paints them even when the web info claims overlay controls', () => {
    // Only the platform decides. `hasOverlayWindowControls` is about who paints
    // the *real* lights, and in a browser nobody does.
    expect(hasPlaceholderWindowControls({ platform: 'web', hasOverlayWindowControls: true })).toBe(
      true,
    );
  });
});

describe('reservesTrafficLightBand', () => {
  it('is true wherever a cluster is painted, by macOS or by us', () => {
    expect(reservesTrafficLightBand(DARWIN)).toBe(true);
    expect(reservesTrafficLightBand(WEB_DESKTOP_INFO)).toBe(true);
  });

  it('is false where the OS draws its own title bar', () => {
    for (const info of REAL_TITLE_BAR) expect(reservesTrafficLightBand(info)).toBe(false);
  });
});

describe('placeholderClusterPx', () => {
  // The whole point of the placeholders: they have to land where macOS's own
  // lights land, or the preview is a picture of a layout that never ships.
  it('starts near the real cluster and ends inside its zone', () => {
    const { startPx, endPx } = placeholderClusterPx();
    expect(startPx).toBe(PANEL_INSET_PX + PANEL_BORDER_PX + SIDE_NAV_HEADER_PADDING_INLINE_PX);
    expect(startPx).toBeGreaterThanOrEqual(8);
    expect(startPx).toBeLessThanOrEqual(20);
    expect(endPx).toBeLessThanOrEqual(TRAFFIC_LIGHT_ZONE_END_PX);
  });

  it('is three 12px dots with 8px gaps, matching macOS', () => {
    expect(TRAFFIC_LIGHT_DOT_COUNT).toBe(3);
    expect(TRAFFIC_LIGHT_DOT_SIZE_PX).toBe(12);
    expect(TRAFFIC_LIGHT_DOT_GAP_PX).toBe(8);
    const { startPx, endPx } = placeholderClusterPx();
    expect(endPx - startPx).toBe(3 * 12 + 2 * 8);
  });

  // The cluster sits inside the collapsed rail, not merely inside the window.
  it('fits inside the collapsed rail', () => {
    expect(placeholderClusterPx().endPx).toBeLessThan(collapsedRailInlineEndPx(WEB_DESKTOP_INFO));
  });
});

describe('titleBarInset', () => {
  it('reserves the approved 44px band when the OS overlays window controls', () => {
    expect(titleBarInset({ platform: 'darwin', hasOverlayWindowControls: true })).toBe(
      APPROVED_OVERLAY_INSET,
    );
  });

  // The band is where the lights go, and on web *we* put lights there. Reserving
  // nothing would paint 12px dots into a 0px band.
  it('reserves the same band on web, so the preview mirrors macOS', () => {
    expect(titleBarInset(WEB_DESKTOP_INFO)).toBe(APPROVED_OVERLAY_INSET);
    expect(titleBarInset(WEB_DESKTOP_INFO)).toBe(titleBarInset(DARWIN));
  });

  it('reserves nothing on Windows and Linux, which have a real title bar', () => {
    for (const info of REAL_TITLE_BAR) expect(titleBarInset(info)).toBe(APPROVED_NO_INSET);
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

  // A 48px rail with a 12px cluster in it is the bug: the dots would straddle
  // the panel's edge in the preview exactly as they used to on macOS.
  it('widens the same rail on web, so the placeholders have the room macOS needs', () => {
    expect(collapsedRailWidth(WEB_DESKTOP_INFO)).toBe(OVERLAY_COLLAPSED_RAIL_WIDTH);
    expect(resolvePx(collapsedRailWidth(WEB_DESKTOP_INFO))).toBe(
      resolvePx(collapsedRailWidth(DARWIN)),
    );
  });

  it('keeps the design system width where the OS draws its own title bar', () => {
    for (const info of REAL_TITLE_BAR) {
      expect(collapsedRailWidth(info)).toBe(DEFAULT_COLLAPSED_RAIL_WIDTH);
    }
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
    expect(sideNavPanelGeometry(WEB_DESKTOP_INFO).minInlineSize).toBe(OVERLAY_COLLAPSED_RAIL_WIDTH);
    expect(sideNavPanelGeometry(WIN32).minInlineSize).toBe(DEFAULT_COLLAPSED_RAIL_WIDTH);
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

  it('clears the placeholder cluster in the browser preview too', () => {
    expect(collapsedRailInlineEndPx(WEB_DESKTOP_INFO)).toBe(PANEL_INSET_PX + COLLAPSED_RAIL_MIN_PX);
    expect(collapsedRailInlineEndPx(WEB_DESKTOP_INFO)).toBeGreaterThan(TRAFFIC_LIGHT_ZONE_END_PX);
  });

  it('uses the design system rail where the OS draws its own title bar', () => {
    for (const info of REAL_TITLE_BAR) {
      expect(collapsedRailInlineEndPx(info)).toBe(PANEL_INSET_PX + DEFAULT_COLLAPSED_RAIL_PX);
    }
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

  // The third of the three geometry values the preview has to agree with darwin
  // on: a 12px cluster in a 36px band is not the 44px band that ships.
  it('gives web the same band as macOS, not the shorter fallback', () => {
    expect(sideNavControlRowHeight(WEB_DESKTOP_INFO)).toBe(sideNavControlRowHeight(DARWIN));
    expect(resolvePx(sideNavControlRowHeight(WEB_DESKTOP_INFO))).toBe(44);
  });

  // The bug this pins: `titleBarInset` is 0 where the OS draws its own title
  // bar. Reuse it for the control row and the row collapses to nothing, hiding
  // the only collapse toggle.
  it('never collapses to zero where there is no title-bar band', () => {
    for (const info of REAL_TITLE_BAR) {
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

describe('contentTitleBarHeight', () => {
  it('is the reserved light band wherever there is a cluster to clear', () => {
    for (const info of [DARWIN, WEB_DESKTOP_INFO] as const) {
      for (const hasContent of [false, true]) {
        expect(contentTitleBarHeight(info, hasContent)).toBe(titleBarInset(info));
        expect(resolvePx(contentTitleBarHeight(info, hasContent))).toBe(44);
      }
    }
  });

  it('stays flat zero on win32/linux while the band is empty', () => {
    // The band with nothing in it is reserved space and nothing else. Giving it
    // a height where the OS already paints a title bar is dead space at the top
    // of every page.
    for (const info of REAL_TITLE_BAR) {
      expect(contentTitleBarHeight(info, false)).toBe(NO_TITLE_BAR_INSET);
      expect(contentTitleBarHeight(info, false)).toBe('var(--spacing-0)');
    }
  });

  it('grows to a real control height on win32/linux once tabs are open', () => {
    // The bug this pins: `titleBarInset` is 0 there, so a tab strip rendered
    // into that band is invisible — zero height, nothing to see or click.
    for (const info of REAL_TITLE_BAR) {
      expect(contentTitleBarHeight(info, true)).not.toBe(NO_TITLE_BAR_INSET);
      expect(resolvePx(contentTitleBarHeight(info, true))).toBeGreaterThanOrEqual(
        SIDE_NAV_CONTROL_ROW_MIN_PX,
      );
    }
  });

  it('reserves the full 44px the sm Toolbar occupies, not the sidebar’s 36px', () => {
    // A `size="sm"` Toolbar is a 28px element plus 8px of block padding above
    // and below it. 36px would clip the pills the band exists to show.
    expect(resolvePx(CONTENT_TITLE_BAR_MIN_HEIGHT)).toBe(44);
    expect(resolvePx(CONTENT_TITLE_BAR_MIN_HEIGHT)).toBeGreaterThan(SIDE_NAV_CONTROL_ROW_MIN_PX);
    expect(CONTENT_TITLE_BAR_MIN_HEIGHT).toBe(OVERLAY_TITLE_BAR_INSET);
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

/*
 * These read AppShell.tsx as *text* rather than rendering it. The root vitest
 * project is `environment: 'node'` with no DOM harness, so the component cannot
 * be mounted here — and every test above proves only that the helpers return
 * the right values, not that the shell still calls them. Drop the geometry
 * spread, or hand the sidebar's control row `titleBarInset` (0px off macOS,
 * which hides the only collapse toggle), and everything above stays green.
 *
 * Deliberately loose: each assertion pins one *usage*, not a line, a shape or a
 * formatting choice, so ordinary edits to the file do not fail them.
 */
describe('AppShell consumes the chrome helpers', () => {
  const source = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8');

  it('spreads the panel geometry instead of inlining lengths', () => {
    expect(source).toMatch(/\.\.\.sideNavPanelGeometry\(/);
  });

  it('sizes the sidebar control row from its own helper, not the title-bar inset', () => {
    expect(source).toMatch(/sideNavControlRowHeight\(/);
    // The bug: `height={inset}` on the sidebar's band. `inset` is the content
    // column's, and it is `var(--spacing-0)` everywhere but macOS.
    expect(source).toMatch(/height=\{controlRowHeight\}/);
  });

  it('keeps the toggle name fixed and moves its state to aria-expanded', () => {
    expect(source).toMatch(/SIDE_NAV_TOGGLE_LABEL = 'Toggle sidebar'/);
    expect(source).toMatch(/aria-expanded=\{!isCollapsed\}/);
  });

  it('gates the traffic-light placeholders on the platform predicate', () => {
    // The bug: rendering them unconditionally, or on `!hasOverlayWindowControls`
    // — which would paint macOS dots under a real Windows title bar.
    expect(source).toMatch(/hasPlaceholderWindowControls\(desktop\)/);
    expect(source).not.toMatch(/!\s*desktop\.hasOverlayWindowControls/);
  });

  it('renders the update control unconditionally', () => {
    // The regression: `badge.isVisible ? <IconButton .../> : null`, which is how
    // the top row used to change shape under the user.
    expect(source).toMatch(/const updateButton = \(\s*<IconButton/);
    expect(source).not.toMatch(/badge\.isVisible/);
    // ...and the highlight is the class, not a hardcoded colour.
    expect(source).toMatch(/badge\.isHighlighted \? 'app-update-button-pending' : undefined/);
  });

  it('has no footerIcons bar left to hide the top controls in', () => {
    // The prop, not the word: the comment explaining its removal may stay.
    expect(source).not.toMatch(/footerIcons=/);
  });

  it('puts all three controls in the title band, panel toggle last', () => {
    // Order asserted as one match so a reshuffle fails: update, appearance,
    // panel toggle, ending at the row's inline end.
    expect(source).toMatch(
      /\{updateButton\}\s*<ThemeToggleButton \/>\s*\{collapseToggle\}/,
    );
  });

  it('keeps the collapse toggle first in reading order on the collapsed rail', () => {
    // Collapsed, the rows are below the light band and the way out is topmost.
    const collapsedRows = source.slice(source.indexOf('{isCollapsed ? ('));
    expect(collapsedRows.indexOf('{collapseToggle}')).toBeLessThan(
      collapsedRows.indexOf('{updateButton}'),
    );
  });
});
