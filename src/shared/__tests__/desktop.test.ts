import { describe, expect, it } from 'vitest';

import { resolveDesktopInfo } from '../desktop';

describe('resolveDesktopInfo', () => {
  it('passes known platforms through', () => {
    expect(resolveDesktopInfo('darwin').platform).toBe('darwin');
    expect(resolveDesktopInfo('win32').platform).toBe('win32');
    expect(resolveDesktopInfo('linux').platform).toBe('linux');
    expect(resolveDesktopInfo('web').platform).toBe('web');
  });

  it('resolves unknown platforms to web without throwing', () => {
    expect(resolveDesktopInfo('freebsd')).toEqual({
      platform: 'web',
      hasOverlayWindowControls: false,
    });
    expect(resolveDesktopInfo('')).toEqual({
      platform: 'web',
      hasOverlayWindowControls: false,
    });
  });

  it('reports overlay window controls only on darwin', () => {
    expect(resolveDesktopInfo('darwin').hasOverlayWindowControls).toBe(true);
    for (const raw of ['win32', 'linux', 'web', 'freebsd', '']) {
      expect(resolveDesktopInfo(raw).hasOverlayWindowControls).toBe(false);
    }
  });
});
