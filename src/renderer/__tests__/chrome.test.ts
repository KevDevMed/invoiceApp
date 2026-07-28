import { describe, expect, it } from 'vitest';

import {
  breadcrumbTrail,
  isSectionSelected,
  NO_TITLE_BAR_INSET,
  OVERLAY_TITLE_BAR_INSET,
  readDesktopInfo,
  SECTION_ROUTES,
  SIDE_NAV_WIDTH,
  titleBarInset,
  WEB_DESKTOP_INFO,
} from '../chrome';

describe('readDesktopInfo', () => {
  it('falls back to web when window.desktop is missing', () => {
    expect(readDesktopInfo({})).toEqual(WEB_DESKTOP_INFO);
    expect(readDesktopInfo(undefined)).toEqual(WEB_DESKTOP_INFO);
    expect(readDesktopInfo(null)).toEqual(WEB_DESKTOP_INFO);
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
      WEB_DESKTOP_INFO,
    );
    expect(readDesktopInfo({ desktop: 'darwin' })).toEqual(WEB_DESKTOP_INFO);
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

describe('titleBarInset', () => {
  it('reserves a band only when the OS overlays window controls', () => {
    expect(titleBarInset({ platform: 'darwin', hasOverlayWindowControls: true })).toBe(
      OVERLAY_TITLE_BAR_INSET,
    );
  });

  it('reserves nothing on web, Windows and Linux', () => {
    expect(titleBarInset(WEB_DESKTOP_INFO)).toBe(NO_TITLE_BAR_INSET);
    expect(titleBarInset({ platform: 'win32', hasOverlayWindowControls: false })).toBe(
      NO_TITLE_BAR_INSET,
    );
    expect(titleBarInset({ platform: 'linux', hasOverlayWindowControls: false })).toBe(
      NO_TITLE_BAR_INSET,
    );
  });

  it('uses spacing tokens, never raw pixels', () => {
    expect(OVERLAY_TITLE_BAR_INSET).toMatch(/^var\(--spacing-/);
    expect(NO_TITLE_BAR_INSET).toMatch(/^var\(--spacing-/);
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

describe('breadcrumbTrail', () => {
  it('shows the section alone on a top-level route', () => {
    expect(breadcrumbTrail('/invoices')).toEqual([{ label: 'Invoices', isCurrent: true }]);
    expect(breadcrumbTrail('/settings')).toEqual([{ label: 'Settings', isCurrent: true }]);
  });

  it('never emits a leading InvoiceApp crumb', () => {
    expect(breadcrumbTrail('/reports').map((crumb) => crumb.label)).toEqual(['Reports']);
  });

  it('links the section and marks the leaf current on a nested route', () => {
    expect(breadcrumbTrail('/invoices/new')).toEqual([
      { label: 'Invoices', href: '#/invoices', isCurrent: false },
      { label: 'New', isCurrent: true },
    ]);
  });

  it('builds cumulative hrefs for deeper paths', () => {
    expect(breadcrumbTrail('/clients/42/edit-details')).toEqual([
      { label: 'Clients', href: '#/clients', isCurrent: false },
      { label: '42', href: '#/clients/42', isCurrent: false },
      { label: 'Edit details', isCurrent: true },
    ]);
  });

  it('ignores a trailing slash', () => {
    expect(breadcrumbTrail('/models/')).toEqual([{ label: 'Models', isCurrent: true }]);
  });

  it('returns an empty trail for an unknown path', () => {
    expect(breadcrumbTrail('/nonexistent')).toEqual([]);
    expect(breadcrumbTrail('/')).toEqual([]);
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
