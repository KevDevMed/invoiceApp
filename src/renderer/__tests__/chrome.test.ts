import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  APP_NAME,
  BRAND_BAND_HEIGHT,
  BREADCRUMB_BAND_HEIGHT,
  COLLAPSED_RAIL_PX,
  COLLAPSED_RAIL_WIDTH,
  isSectionSelected,
  NAV_GROUP_CAPTION_HEIGHT,
  NAV_GROUP_CAPTION_PX,
  NO_TITLE_BAR_INSET,
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
  sectionLabel,
  RESIZABLE_STORAGE_PREFIX,
  SECTION_CONTAINER_PADDING_PX,
  SHELL_GUTTER,
  SHELL_GUTTER_PX,
  SHELL_GUTTER_STEP,
  shellBandInsetsPx,
  TAB_STRIP_EXTRA_INSET_PX,
  SIDE_NAV_WIDTH,
  SIDE_NAV_WIDTH_STORAGE_ID,
  SIDE_NAV_WIDTH_STORAGE_KEY,
  sideNavControlRowHeight,
  sideNavPanelGeometry,
  SIDE_NAV_HEADER_PADDING_INLINE_PX,
  TAB_STRIP_BAND_HEIGHT,
  tabStripBandHeight,
  titleBarInset,
  TRAFFIC_LIGHT_DOT_COUNT,
  TRAFFIC_LIGHT_DOT_GAP_PX,
  TRAFFIC_LIGHT_DOT_SIZE_PX,
  TRAFFIC_LIGHT_RESERVE_PX,
  TRAFFIC_LIGHT_RESERVE_WIDTH,
  TRAFFIC_LIGHT_ZONE_END_PX,
  UNIFIED_TITLE_BAR_HEIGHT,
  UNIFIED_TITLE_BAR_PADDING_INLINE,
  UNIFIED_TITLE_BAR_PADDING_INLINE_PX,
  unifiedTitleBarClusterPx,
  unifiedTitleBarContentStartPx,
  wasSideNavCollapsed,
  WEB_DESKTOP_INFO,
  windowTitle,
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
// hasOverlayWindowControls: true }` would reserve a band in the browser
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

// The approved values, written out rather than imported from the module under
// test. Comparing against OVERLAY_TITLE_BAR_INSET would only re-assert the
// implementation against itself: --spacing-1 (4px, lights overlap the shell
// again) or --spacing-2 (an 8px band a 12px dot does not fit in) would both
// keep the suite green while shipping the bug this file exists to prevent.
// --spacing-10 measures 40px, which clears the tallest traffic light at
// y 12-32; changing either constant must fail here.
const APPROVED_OVERLAY_INSET = 'var(--spacing-10)';
const APPROVED_NO_INSET = 'var(--spacing-0)';

describe('reservesTrafficLightBand', () => {
  it('is true only where macOS paints a real cluster over the renderer', () => {
    expect(reservesTrafficLightBand(DARWIN)).toBe(true);
    // No fake lights: the browser preview reserves nothing and draws nothing.
    expect(reservesTrafficLightBand(WEB_DESKTOP_INFO)).toBe(false);
  });

  it('is false where the OS draws its own title bar', () => {
    for (const info of REAL_TITLE_BAR) expect(reservesTrafficLightBand(info)).toBe(false);
  });
});

describe('titleBarInset', () => {
  it('reserves the approved 40px band when the OS overlays window controls', () => {
    expect(titleBarInset(DARWIN)).toBe(APPROVED_OVERLAY_INSET);
  });

  // No fake lights in the preview, so nothing to reserve for.
  it('reserves nothing on web', () => {
    expect(titleBarInset(WEB_DESKTOP_INFO)).toBe(APPROVED_NO_INSET);
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

  // The width the design measures its row rhythm against. Written out rather
  // than compared to itself.
  it('opens at the 240px the design is drawn at', () => {
    expect(SIDE_NAV_WIDTH.default).toBe(240);
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

describe('sectionLabel and windowTitle', () => {
  it('names the section a route belongs to', () => {
    expect(sectionLabel('/invoices')).toBe('Invoices');
    expect(sectionLabel('/invoices/abc/edit')).toBe('Invoices');
    expect(sectionLabel('/settings')).toBe('Settings');
  });

  it('has no label off the nav', () => {
    expect(sectionLabel('/nowhere')).toBeNull();
  });

  // The collapsed rail throws the nav labels away, so the title bar is the only
  // thing left saying where you are.
  it('titles the collapsed frame with the product and the page', () => {
    expect(windowTitle('/reports')).toBe('InvoiceApp — Reports');
    expect(windowTitle('/nowhere')).toBe('InvoiceApp');
    expect(APP_NAME).toBe('InvoiceApp');
  });
});

// The spacing scale astryx.css writes onto :root, copied here so the tokens the
// chrome is built from can be resolved to real pixels in a node test. Asserting
// only the string 'calc(var(--spacing-12) + var(--spacing-2))' would pass just
// as happily for --spacing-0-5, which is the bug this suite exists to prevent.
const SPACING_PX: Readonly<Record<string, number>> = {
  '--spacing-0': 0,
  '--spacing-2': 8,
  '--spacing-3': 12,
  '--spacing-4': 16,
  '--spacing-6': 24,
  '--spacing-9': 36,
  '--spacing-10': 40,
  '--spacing-11': 44,
  '--spacing-12': 48,
};

/** Resolves the three shapes chrome.ts emits: `var(--x)`, `calc(var(--x) * n)`
 *  and `calc(var(--x) + var(--y))`. */
function resolvePx(length: string): number {
  const token = (name: string | undefined): number => SPACING_PX[name ?? ''] ?? Number.NaN;

  const plain = /^var\((--spacing-[\d-]+)\)$/.exec(length);
  if (plain !== null) return token(plain[1]);

  const scaled = /^calc\(var\((--spacing-[\d-]+)\) \* (\d+)\)$/.exec(length);
  if (scaled !== null) return token(scaled[1]) * Number(scaled[2]);

  const summed = /^calc\(var\((--spacing-[\d-]+)\) \+ var\((--spacing-[\d-]+)\)\)$/.exec(length);
  if (summed !== null) return token(summed[1]) + token(summed[2]);

  return Number.NaN;
}

/**
 * The chrome's band heights, as one grid.
 *
 * The whole point of 3a's metrics is that the traffic-light band, the brand row
 * beneath it, the tab strip at the top of the content column and the collapsed
 * unified title bar are the *same* height, so the two columns read as one grid
 * rather than four near-misses. Asserted together, because that is the property
 * — no single one of them is right or wrong on its own.
 */
describe('band heights', () => {
  it('puts every 40px chrome band on the same step', () => {
    for (const band of [
      OVERLAY_TITLE_BAR_INSET,
      BRAND_BAND_HEIGHT,
      TAB_STRIP_BAND_HEIGHT,
      UNIFIED_TITLE_BAR_HEIGHT,
    ]) {
      expect(resolvePx(band)).toBe(40);
      expect(band).toMatch(/^var\(--spacing-[\d-]+\)$/);
    }
  });

  // Lighter than the strip above it on purpose: it holds one line of supporting
  // text, and two equal bars would read as a double title bar.
  it('keeps the breadcrumb bar shorter than the tab strip', () => {
    expect(resolvePx(BREADCRUMB_BAND_HEIGHT)).toBe(36);
    expect(resolvePx(BREADCRUMB_BAND_HEIGHT)).toBeLessThan(resolvePx(TAB_STRIP_BAND_HEIGHT));
  });

  // A 12px dot in the band, with room above and below it.
  it('leaves the light band taller than the cluster in it', () => {
    expect(resolvePx(OVERLAY_TITLE_BAR_INSET)).toBeGreaterThan(TRAFFIC_LIGHT_DOT_SIZE_PX);
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

  // The cluster sits inside the *expanded* sidebar, which is never narrower
  // than SIDE_NAV_WIDTH.min. It no longer has to fit in the collapsed rail —
  // that is what the unified title bar is for.
  it('fits inside the narrowest sidebar the user can drag to', () => {
    expect(placeholderClusterPx().endPx).toBeLessThan(PANEL_INSET_PX + SIDE_NAV_WIDTH.min);
  });
});

describe('the collapsed unified title bar', () => {
  it('is 40px of full-width bar with 12px of inline padding', () => {
    expect(resolvePx(UNIFIED_TITLE_BAR_HEIGHT)).toBe(40);
    expect(resolvePx(UNIFIED_TITLE_BAR_PADDING_INLINE)).toBe(UNIFIED_TITLE_BAR_PADDING_INLINE_PX);
    expect(UNIFIED_TITLE_BAR_PADDING_INLINE_PX).toBe(12);
  });

  // The bug this pins: dropping the reserved slot, or sizing it off the
  // placeholders. On macOS there are no placeholders to size it off — the OS
  // paints over the renderer — and the expand toggle then lands under the
  // green light.
  it('keeps everything after the reserve clear of the real lights', () => {
    expect(resolvePx(TRAFFIC_LIGHT_RESERVE_WIDTH)).toBe(TRAFFIC_LIGHT_RESERVE_PX);
    expect(unifiedTitleBarContentStartPx()).toBeGreaterThan(TRAFFIC_LIGHT_ZONE_END_PX);
  });

  it('lands the placeholder cluster where macOS lands its own, inside the reserve', () => {
    const { startPx, endPx } = unifiedTitleBarClusterPx();
    expect(startPx).toBe(UNIFIED_TITLE_BAR_PADDING_INLINE_PX);
    // macOS starts its cluster at x=13; one pixel out is as close as a padding
    // step gets.
    expect(Math.abs(startPx - 13)).toBeLessThanOrEqual(1);
    expect(endPx).toBeLessThanOrEqual(unifiedTitleBarContentStartPx());
  });

  it('pins the traffic-light zone rather than deriving it', () => {
    expect(TRAFFIC_LIGHT_ZONE_END_PX).toBe(70);
  });
});

describe('COLLAPSED_RAIL_WIDTH', () => {
  // 56px: a 40px rail glyph inside SideNav's 8px of inline padding either side.
  // Written out rather than derived — the point of the number is that it is
  // narrow, and a rail that quietly grew back to 88 would pass a derived test.
  it('is the 56px the design draws, from spacing tokens', () => {
    expect(resolvePx(COLLAPSED_RAIL_WIDTH)).toBe(56);
    expect(COLLAPSED_RAIL_PX).toBe(56);
    expect(resolvePx(COLLAPSED_RAIL_WIDTH)).toBe(COLLAPSED_RAIL_PX);
    expect(COLLAPSED_RAIL_WIDTH).toMatch(/^calc\(var\(--spacing-[\d-]+\) \+ var\(--spacing-[\d-]+\)\)$/);
  });

  // The regression this guards: the rail used to be 88px *because* the traffic
  // lights lived in it. They do not any more, and a rail wide enough to hold
  // them is a rail that has quietly gone back to the old frame.
  it('is too narrow to hold the traffic lights, which is why they moved out', () => {
    expect(PANEL_INSET_PX + COLLAPSED_RAIL_PX).toBeLessThan(TRAFFIC_LIGHT_ZONE_END_PX);
  });

  it('is the same width on every platform', () => {
    for (const info of [DARWIN, WEB_DESKTOP_INFO, ...REAL_TITLE_BAR]) {
      expect(sideNavPanelGeometry().minInlineSize).toBe(COLLAPSED_RAIL_WIDTH);
      expect(reservesTrafficLightBand(info)).toBe(reservesTrafficLightBand(info));
    }
  });
});

describe('NAV_GROUP_CAPTION_HEIGHT', () => {
  // Collapsing narrows, it does not rearrange: the rail draws a band of exactly
  // this height where each caption was, so every nav row keeps its Y.
  it('matches the caption block it stands in for', () => {
    expect(resolvePx(NAV_GROUP_CAPTION_HEIGHT)).toBe(NAV_GROUP_CAPTION_PX);
    expect(NAV_GROUP_CAPTION_PX).toBe(24);
    expect(NAV_GROUP_CAPTION_HEIGHT).toMatch(/^var\(--spacing-[\d-]+\)$/);
  });
});

/**
 * A localStorage double. `entries` is what the store holds; `failing` makes
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

// The approved inset, written out rather than imported from the module under
// test. Comparing the geometry against PANEL_INSET would only re-assert the
// module against itself.
const APPROVED_PANEL_INSET = 'var(--spacing-2)';

describe('sideNavPanelGeometry', () => {
  it('insets the panel equally on all four edges', () => {
    const geometry = sideNavPanelGeometry();
    expect(geometry.marginBlock).toBe(APPROVED_PANEL_INSET);
    expect(geometry.marginInline).toBe(APPROVED_PANEL_INSET);
    expect(PANEL_INSET).toBe(APPROVED_PANEL_INSET);
  });

  // The bug this pins: add a fourth-side inset, forget the block-size calc, and
  // the panel's margin box runs past its parent — which is a scroll container.
  it('subtracts exactly both block insets from the panel height', () => {
    expect(PANEL_INSET_TOTAL_PX).toBe(PANEL_INSET_PX * 2);
    expect(resolvePx(PANEL_INSET_TOTAL)).toBe(resolvePx(PANEL_INSET) * 2);
    expect(sideNavPanelGeometry().blockSize).toBe(`calc(100% - ${PANEL_INSET_TOTAL})`);
  });

  it('keeps the collapsed-rail floor as the only width lever', () => {
    expect(sideNavPanelGeometry().minInlineSize).toBe(COLLAPSED_RAIL_WIDTH);
  });

  // Radius, background, shadow and border belong to the theme. An inline style
  // beats a theme rule, so a stray one here silently overrides the theme.
  it('carries no appearance properties', () => {
    expect(Object.keys(sideNavPanelGeometry()).sort()).toEqual([
      'blockSize',
      'marginBlock',
      'marginInline',
      'minInlineSize',
    ]);
  });

  it('is built from spacing tokens, never raw pixels', () => {
    const geometry = sideNavPanelGeometry();
    expect(geometry.marginBlock).toMatch(/^var\(--spacing-[\d-]+\)$/);
    expect(geometry.marginInline).toMatch(/^var\(--spacing-[\d-]+\)$/);
    expect(geometry.blockSize).toMatch(/^calc\(100% - var\(--spacing-[\d-]+\)\)$/);
  });
});

describe('sideNavControlRowHeight', () => {
  // Reserved in both sidebar states: with no unified title bar the OS paints
  // the lights over this corner whether the rail is collapsed or not.
  it('is the reserved light band wherever there is a cluster to clear', () => {
    expect(sideNavControlRowHeight(DARWIN)).toBe(titleBarInset(DARWIN));
    expect(resolvePx(sideNavControlRowHeight(DARWIN))).toBe(40);
  });

  // Nothing interactive lives in this band — the collapse toggle and the
  // utility glyphs are elsewhere — so a zero-height band where there is no
  // cluster hides nothing. Web included: the preview draws no fake lights.
  it('reserves nothing where there is no real cluster', () => {
    for (const info of [WEB_DESKTOP_INFO, ...REAL_TITLE_BAR]) {
      expect(sideNavControlRowHeight(info)).toBe(NO_TITLE_BAR_INSET);
    }
  });
});

describe('tabStripBandHeight', () => {
  it('is a full band wherever there is a cluster to clear, tabs or not', () => {
    for (const hasTabs of [false, true]) {
      expect(tabStripBandHeight(DARWIN, hasTabs)).toBe(TAB_STRIP_BAND_HEIGHT);
      expect(resolvePx(tabStripBandHeight(DARWIN, hasTabs))).toBe(40);
    }
  });

  it('stays flat zero on win32/linux while the strip is empty', () => {
    // The band with nothing in it is reserved space and nothing else. Giving it
    // a height where the OS already paints a title bar is dead space at the top
    // of every page.
    for (const info of REAL_TITLE_BAR) {
      expect(tabStripBandHeight(info, false)).toBe(NO_TITLE_BAR_INSET);
      expect(tabStripBandHeight(info, false)).toBe('var(--spacing-0)');
    }
  });

  it('grows to the full band on win32/linux once tabs are open', () => {
    // The bug this pins: a tab strip rendered into a zero-height band is
    // invisible — nothing to see and nothing to click.
    for (const info of REAL_TITLE_BAR) {
      expect(tabStripBandHeight(info, true)).toBe(TAB_STRIP_BAND_HEIGHT);
      expect(resolvePx(tabStripBandHeight(info, true))).toBe(40);
    }
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

  // The grouping the design draws: Billing, then Insights, then Local AI.
  it('groups the sections the way the sidebar captions them', () => {
    expect(
      SECTION_ROUTES.filter((route) => route.group !== undefined).map(
        (route) => [route.group, route.label] as const,
      ),
    ).toEqual([
      ['Billing', 'Invoices'],
      ['Billing', 'Clients'],
      ['Insights', 'Reports'],
      ['Local AI', 'Models'],
      ['Local AI', 'Assistant'],
    ]);
  });
});

/*
 * These read AppShell.tsx as *text* rather than rendering it. The root vitest
 * project is `environment: 'node'` with no DOM harness, so the component cannot
 * be mounted here — and every test above proves only that the helpers return
 * the right values, not that the shell still calls them. Drop the geometry
 * spread, or leave the sidebar reserving a light band it no longer holds, and
 * everything above stays green.
 *
 * Deliberately loose: each assertion pins one *usage*, not a line, a shape or a
 * formatting choice, so ordinary edits to the file do not fail them.
 */
describe('AppShell consumes the chrome helpers', () => {
  const source = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8');

  it('spreads the panel geometry instead of inlining lengths', () => {
    expect(source).toMatch(/\.\.\.sideNavPanelGeometry\(/);
  });

  it('keeps the toggle name fixed and moves its state to aria-expanded', () => {
    expect(source).toMatch(/SIDE_NAV_TOGGLE_LABEL = 'Toggle sidebar'/);
    expect(source).toMatch(/aria-expanded=\{!isCollapsed\}/);
  });

  it('renders the update control unconditionally', () => {
    // The regression: `badge.isVisible ? <IconButton .../> : null`, which is how
    // the row it sits in used to change shape under the user.
    expect(source).toMatch(/const updateButton = \(\s*<IconButton/);
    expect(source).not.toMatch(/badge\.isVisible/);
    // ...and the highlight is the class, not a hardcoded colour.
    expect(source).toMatch(/badge\.isHighlighted \? 'app-update-button-pending' : undefined/);
  });

  it('moves the utility glyphs into the footer, beside Settings', () => {
    // The regression: putting them back in the traffic-light band, which is the
    // alignment problem 3a exists to fix. `footerItems` is the Settings row.
    const footer = source.slice(source.indexOf('footer={'), source.indexOf('collapsible={'));
    expect(footer).toMatch(/footerItems\.map/);
    expect(footer).toMatch(/\{updateButton\}/);
    expect(footer).toMatch(/<ThemeToggleButton \/>/);
  });

  it('keeps the light band in the collapsed header, gated on the platform', () => {
    // Collapsed, the header holds only the traffic-light band — macOS paints
    // the cluster over this corner in both states. Where there is no real
    // cluster the header is omitted: an empty one still costs SideNav's
    // sticky-top padding.
    expect(source).toMatch(
      /header=\{\s*isCollapsed \? \(\s*reservesTrafficLightBand\(desktop\) \? \(/,
    );
    expect(source).toMatch(/sideNavControlRowHeight\(desktop\)/);
    expect(source).toMatch(/height=\{controlRowHeight\}/);
  });

  it('keeps every nav row at its Y across the collapse toggle', () => {
    // The rule 3a is built on: collapsing narrows, it does not rearrange.
    expect(source).toMatch(/isCollapsed \? <NavGroupCaptionRule hasRule=\{index > 0\} \/> : null/);
  });

  it('renders the breadcrumb bar under the tab strip', () => {
    const bandIndex = source.indexOf('height={contentBandHeight}');
    expect(bandIndex).toBeGreaterThan(-1);
    expect(source.indexOf('<ShellBreadcrumbs')).toBeGreaterThan(bandIndex);
  });

  /*
   * The assistant launcher belongs to the shell's own chrome, not to the corner
   * of the window. The regression this pins is the one that was shipped: the
   * dock as a sibling of `<Outlet/>`, floating over whatever the page had put
   * in its bottom-right — which on the invoices cockpit is `Export PDF`.
   */
  it('hands the assistant launcher to the breadcrumb bar, not to the page', () => {
    const bar = source.slice(source.indexOf('<ShellBreadcrumbs'), source.lastIndexOf('<Outlet'));
    expect(bar).toMatch(/action=\{isDockVisible\(pathname\) \? <AssistantDock \/> : undefined\}/);
    // Nothing renders the dock anywhere else — in particular not beside the
    // outlet, which is where it used to be.
    expect(source.match(/<AssistantDock \/>/g)).toHaveLength(1);
  });
});

/*
 * The three bands' left edges, read out of the files that set them.
 *
 * `shellBandInsetsPx` says what the relationship is; these say the shell still
 * expresses it. The staircase this replaced (strip 280, trail 272, heading 324
 * at a 1440 window) was three files each doing something individually
 * defensible, so the invariant has to be checked across all three or it is not
 * being checked at all.
 */
describe('the shell gutter holds across the files that use it', () => {
  const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('is the same 16px in both of the shapes it is written in', () => {
    expect(SHELL_GUTTER).toBe(`var(--spacing-${SHELL_GUTTER_STEP})`);
    expect(resolvePx(SHELL_GUTTER)).toBe(SHELL_GUTTER_PX);
  });

  // The property, in one line: every band in the content column starts at the
  // same inline inset.
  it('puts the tab strip, the breadcrumb trail and the page column on one edge', () => {
    const insets = shellBandInsetsPx();
    expect(insets.tabStrip).toBe(SHELL_GUTTER_PX);
    expect(insets.breadcrumbs).toBe(SHELL_GUTTER_PX);
    expect(insets.pageMin).toBe(SHELL_GUTTER_PX);
  });

  it('leaves the tab strip on the container padding Toolbar already carries', () => {
    // The bug: adding padding on top of Section's own, which is exactly how the
    // strip ended up 8px right of the trail beneath it.
    expect(TAB_STRIP_EXTRA_INSET_PX).toBe(0);
    expect(SECTION_CONTAINER_PADDING_PX).toBe(SHELL_GUTTER_PX);
    const css = read('../styles/global.css');
    const rule = css.slice(css.indexOf('.app-invoice-tabs {'), css.indexOf('.app-invoice-tabs ['));
    expect(rule).toMatch(/padding-inline-start:\s*0;/);
    expect(rule).not.toMatch(/padding-inline-start:\s*var\(/);
  });

  it('pads the breadcrumb bar and the page column from the same constant', () => {
    for (const file of ['../ui/ShellBreadcrumbs.tsx', '../ui/Page.tsx']) {
      const source = read(file);
      expect(source).toMatch(/SHELL_GUTTER_STEP/);
      expect(source).toMatch(/paddingInline=\{SHELL_GUTTER_STEP\}/);
    }
  });

  /*
   * The page column is the one that does *not* simply sit on the gutter, and
   * that is deliberate: `Page` caps its column and centres it, so on a wide
   * window it steps in from the gutter by half of whatever the cap leaves over.
   * The cap is load-bearing — the screenshot harness asserts equal gutters on
   * Clients and Settings at 1600 — so what the shell can guarantee is the
   * minimum, and that a step away from the gutter is a whole gutter rather than
   * the 8px that read as a mistake.
   */
  it('keeps the page column capped and centred', () => {
    const source = read('../ui/Page.tsx');
    expect(source).toMatch(/maxWidth = 1120/);
    expect(source).toMatch(/align="center"/);
  });
});
