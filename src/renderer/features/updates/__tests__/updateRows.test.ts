import { describe, expect, it } from 'vitest';

import type { UpdateState } from '../../../../shared/ipc-contract';
import {
  actionView,
  bannerView,
  formatBytes,
  formatCurrentVersion,
  progressView,
  statusView,
} from '../updateRows';

function state(overrides: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '1.2.3',
    availableVersion: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    message: null,
    ...overrides,
  };
}

const PHASES: UpdateState['phase'][] = [
  'unsupported',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'error',
];

describe('statusView', () => {
  it('answers every phase with a non-empty headline', () => {
    for (const phase of PHASES) {
      expect(statusView(state({ phase })).headline.length).toBeGreaterThan(0);
    }
  });

  it('surfaces the reason from main for unsupported rather than inventing one', () => {
    const reason = 'Updates are only available in the installed app — this is a development run.';
    expect(statusView(state({ phase: 'unsupported', message: reason })).detail).toBe(reason);
  });

  it('falls back to honest copy when unsupported carries no reason', () => {
    expect(statusView(state({ phase: 'unsupported' })).detail).toBe(
      'Updates are only available in the installed macOS app.',
    );
  });

  it('surfaces the failure from main for error', () => {
    expect(statusView(state({ phase: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })).detail).toBe(
      'net::ERR_INTERNET_DISCONNECTED',
    );
  });

  it('names the offered version when one is available', () => {
    const view = statusView(state({ phase: 'available', availableVersion: '2.0.0' }));
    expect(view.headline).toBe('2.0.0 is available.');
  });

  it('does not claim a version number it was not given', () => {
    expect(statusView(state({ phase: 'available' })).headline).toBe('A new version is available.');
  });

  it('warns about the download size before it is started', () => {
    expect(statusView(state({ phase: 'available' })).detail).toMatch(/hundred megabytes/);
  });

  it('says installing quits the app', () => {
    expect(statusView(state({ phase: 'downloaded', availableVersion: '2.0.0' })).detail).toMatch(
      /quits this app immediately/,
    );
  });

  it('colours the dot per phase', () => {
    expect(statusView(state({ phase: 'unsupported' })).dot).toBe('neutral');
    expect(statusView(state({ phase: 'idle' })).dot).toBe('success');
    expect(statusView(state({ phase: 'checking' })).dot).toBe('accent');
    expect(statusView(state({ phase: 'available' })).dot).toBe('warning');
    expect(statusView(state({ phase: 'downloading' })).dot).toBe('accent');
    expect(statusView(state({ phase: 'downloaded' })).dot).toBe('success');
    expect(statusView(state({ phase: 'error' })).dot).toBe('error');
  });
});

describe('bannerView', () => {
  it('banners only the error phase', () => {
    for (const phase of PHASES) {
      const view = bannerView(state({ phase, message: 'boom' }));
      if (phase === 'error') expect(view).not.toBeNull();
      else expect(view).toBeNull();
    }
  });

  it('carries the message from main as the description', () => {
    expect(bannerView(state({ phase: 'error', message: 'Cannot find latest-mac.yml' }))).toEqual({
      status: 'error',
      title: 'The update failed',
      description: 'Cannot find latest-mac.yml',
    });
  });
});

describe('actionView', () => {
  it('renders no control on a build that cannot update', () => {
    expect(actionView(state({ phase: 'unsupported' })).kind).toBe('none');
  });

  it('renders no control while bytes are moving', () => {
    expect(actionView(state({ phase: 'downloading' })).kind).toBe('none');
  });

  it('offers a check when idle', () => {
    const view = actionView(state({ phase: 'idle' }));
    expect(view.kind).toBe('check');
    expect(view.label).toBe('Check for updates');
    expect(view.isLoading).toBe(false);
  });

  it('shows the check button loading while checking, whatever the local flag says', () => {
    expect(actionView(state({ phase: 'checking' })).isLoading).toBe(true);
  });

  it('offers the download when an update is available, and warns in the tooltip', () => {
    const view = actionView(state({ phase: 'available', availableVersion: '2.0.0' }));
    expect(view.kind).toBe('download');
    expect(view.label).toBe('Download update');
    expect(view.tooltip).toMatch(/hundred megabytes/);
  });

  it('offers the install once downloaded, and says it quits the app', () => {
    const view = actionView(state({ phase: 'downloaded' }));
    expect(view.kind).toBe('install');
    expect(view.label).toBe('Restart and install');
    expect(view.tooltip).toMatch(/Quits this app now/);
  });

  it('retries through the check channel after a failure', () => {
    const view = actionView(state({ phase: 'error', message: 'boom' }));
    expect(view.kind).toBe('check');
    expect(view.label).toBe('Try again');
  });

  it('shows the in-flight call as loading', () => {
    expect(actionView(state({ phase: 'available' }), true).isLoading).toBe(true);
    expect(actionView(state({ phase: 'downloaded' }), true).isLoading).toBe(true);
  });

  it('never disables a control it also renders', () => {
    for (const phase of PHASES) {
      const view = actionView(state({ phase }));
      if (view.kind !== 'none') expect(view.isDisabled).toBe(false);
    }
  });
});

describe('progressView', () => {
  it('is null in every phase but downloading', () => {
    for (const phase of PHASES) {
      const view = progressView(state({ phase, progressPercent: 50 }));
      if (phase === 'downloading') expect(view).not.toBeNull();
      else expect(view).toBeNull();
    }
  });

  it('reads the percent main sends', () => {
    const view = progressView(
      state({ phase: 'downloading', progressPercent: 42.7, transferredBytes: 1, totalBytes: 2 }),
    );
    expect(view?.percent).toBe(43);
  });

  it('derives a percent from the byte counts when main has not sent one', () => {
    const view = progressView(
      state({
        phase: 'downloading',
        progressPercent: null,
        transferredBytes: 250_000_000,
        totalBytes: 1_000_000_000,
      }),
    );
    expect(view?.percent).toBe(25);
  });

  it('goes indeterminate when neither a percent nor a total is known', () => {
    const view = progressView(
      state({ phase: 'downloading', transferredBytes: 12_000_000, totalBytes: null }),
    );
    expect(view?.percent).toBeNull();
    expect(view?.transferred).toBe('12 MB downloaded');
  });

  it('does not divide by a zero total', () => {
    const view = progressView(
      state({ phase: 'downloading', transferredBytes: 0, totalBytes: 0, progressPercent: null }),
    );
    expect(view?.percent).toBeNull();
  });

  it('reads transferred against total when both are known', () => {
    const view = progressView(
      state({
        phase: 'downloading',
        progressPercent: 30,
        transferredBytes: 142_000_000,
        totalBytes: 517_000_000,
      }),
    );
    expect(view?.transferred).toBe('142 MB of 517 MB');
  });

  it('clamps a percent outside 0..100', () => {
    expect(progressView(state({ phase: 'downloading', progressPercent: 100 }))?.percent).toBe(100);
    expect(progressView(state({ phase: 'downloading', progressPercent: 0 }))?.percent).toBe(0);
  });
});

describe('formatBytes', () => {
  it('formats each magnitude a human reads', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(12_000)).toBe('12 kB');
    expect(formatBytes(9_400)).toBe('9.4 kB');
    expect(formatBytes(517_000_000)).toBe('517 MB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
  });

  it('says so plainly when the size is unknown', () => {
    expect(formatBytes(null)).toBe('an unknown amount');
    expect(formatBytes(Number.NaN)).toBe('an unknown amount');
  });
});

describe('formatCurrentVersion', () => {
  it('names the running version', () => {
    expect(formatCurrentVersion(state({ currentVersion: '1.2.3' }))).toBe('Version 1.2.3');
  });

  it('does not print an empty version string', () => {
    expect(formatCurrentVersion(state({ currentVersion: '' }))).toBe('Unknown version');
  });
});
