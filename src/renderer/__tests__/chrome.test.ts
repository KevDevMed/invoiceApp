import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_RAIL_MIN_PX,
  collapsedRailWidth,
  DEFAULT_COLLAPSED_RAIL_WIDTH,
  isSectionSelected,
  NO_TITLE_BAR_INSET,
  OVERLAY_COLLAPSED_RAIL_WIDTH,
  OVERLAY_TITLE_BAR_INSET,
  readDesktopInfo,
  SECTION_ROUTES,
  SIDE_NAV_WIDTH,
  titleBarInset,
  WEB_DESKTOP_INFO,
} from '../chrome';

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
