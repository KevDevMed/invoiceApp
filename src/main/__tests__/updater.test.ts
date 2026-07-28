/**
 * The updater is the one piece of this app that cannot be exercised by hand
 * without a signed, notarised, installed build and a real GitHub release, so it
 * is the piece that has to be pinned down here instead.
 *
 * `electron` and `electron-updater` are both replaced wholesale. The module under
 * test holds process-wide state, so every test re-imports it after
 * `vi.resetModules()` and drives a fresh copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UpdaterModule from '../updater';

type Listener = (...args: never[]) => void;

const h = vi.hoisted(() => {
  const listeners = new Map<string, Listener[]>();

  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event: string, listener: Listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return autoUpdater;
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(() => undefined),
  };

  const app = {
    isPackaged: true,
    getVersion: () => '1.2.3',
    quit: vi.fn(() => undefined),
    exit: vi.fn(() => undefined),
  };

  interface FakeWindow {
    isDestroyed: () => boolean;
    isMinimized: () => boolean;
    restore: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
  }

  const windows: FakeWindow[] = [];

  /** How the fake `Notification` should behave for the test in hand. */
  const notificationState = {
    supported: true,
    throwOnConstruct: false,
    throwOnShow: false,
  };

  const notifications: FakeNotification[] = [];

  class FakeNotification {
    static isSupported = vi.fn(() => notificationState.supported);

    readonly options: { title?: string; body?: string };
    readonly show = vi.fn(() => {
      if (notificationState.throwOnShow) throw new Error('NSUserNotificationCenter refused');
    });

    private readonly handlers = new Map<string, Listener[]>();

    constructor(options: { title?: string; body?: string }) {
      if (notificationState.throwOnConstruct) throw new Error('Notification could not be created');
      this.options = options;
      notifications.push(this);
    }

    on(event: string, listener: Listener) {
      const bucket = this.handlers.get(event) ?? [];
      bucket.push(listener);
      this.handlers.set(event, bucket);
      return this;
    }

    /** Fire what the OS would fire when the toast is clicked. */
    click() {
      for (const listener of [...(this.handlers.get('click') ?? [])]) {
        (listener as () => void)();
      }
    }
  }

  return {
    autoUpdater,
    app,
    windows,
    notifications,
    notificationState,
    Notification: FakeNotification,
    /** Fire an electron-updater event at whatever the module under test wired up. */
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    },
    clearListeners() {
      listeners.clear();
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
});

vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: h.Notification,
}));

vi.mock('electron-updater', () => ({ autoUpdater: h.autoUpdater }));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The only four sentences a failure is allowed to put in front of a user, plus
 * the fallback. Spelled out here rather than imported so that changing the copy
 * in the module is a deliberate act with a test to match, not a silent edit.
 */
const OFFLINE =
  'InvoiceApp could not reach the update server. Check your internet connection and try again.';
const BUSY = 'The update server is busy right now. Please try again in a few minutes.';
const SIGNATURE =
  'The update could not be verified, so it was not installed. Please try again, or download the latest version from the InvoiceApp website.';
const DISK_FULL =
  'There is not enough free disk space for the update. Free up some space and try again.';
const UNKNOWN = 'The update could not be completed. Please try again later.';
const HANDOFF =
  'The update was downloaded but could not be installed. Quit InvoiceApp and open it again to finish installing — the update is already downloaded, so there is nothing to download again.';

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function fakeWindow(
  options: { destroyed?: boolean; contentsDestroyed?: boolean; minimized?: boolean } = {},
) {
  return {
    isDestroyed: () => options.destroyed === true,
    isMinimized: () => options.minimized === true,
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: () => options.contentsDestroyed === true,
      send: vi.fn(),
    },
  };
}

/** A fresh copy of the module, with its process-wide state reset. */
async function load(): Promise<typeof UpdaterModule> {
  vi.resetModules();
  return import('../updater');
}

/** The nth posted notification, asserted to exist so the test reads about behaviour. */
function posted(index = 0) {
  const toast = h.notifications[index];
  if (!toast) throw new Error(`expected a notification at index ${index}`);
  return toast;
}

/** Drive a check that finds `version`, the way electron-updater would. */
function respondWithUpdate(version: string): void {
  h.autoUpdater.checkForUpdates.mockImplementation(async () => {
    h.emit('checking-for-update');
    h.emit('update-available', { version });
    return null;
  });
}

beforeEach(() => {
  h.clearListeners();
  h.windows.length = 0;
  h.autoUpdater.autoDownload = true;
  h.autoUpdater.autoInstallOnAppQuit = true;
  h.autoUpdater.checkForUpdates.mockReset();
  h.autoUpdater.checkForUpdates.mockImplementation(async () => {
    h.emit('checking-for-update');
    h.emit('update-not-available', { version: '1.2.3' });
    return null;
  });
  h.autoUpdater.downloadUpdate.mockReset();
  h.autoUpdater.downloadUpdate.mockImplementation(async () => []);
  h.autoUpdater.quitAndInstall.mockReset();
  h.notifications.length = 0;
  h.notificationState.supported = true;
  h.notificationState.throwOnConstruct = false;
  h.notificationState.throwOnShow = false;
  h.Notification.isSupported.mockReset();
  h.Notification.isSupported.mockImplementation(() => h.notificationState.supported);
  h.app.isPackaged = true;
  h.app.quit.mockReset();
  h.app.exit.mockReset();
  setPlatform('darwin');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('unsupported builds', () => {
  it('reports a development run as unsupported and never constructs an updater', async () => {
    h.app.isPackaged = false;
    const updater = await load();

    const state = updater.getUpdateState();
    expect(state.phase).toBe('unsupported');
    expect(state.currentVersion).toBe('1.2.3');
    expect(state.message).toMatch(/development run/i);
    // Touching `electronUpdater.autoUpdater` at all would have wired listeners.
    expect(h.listenerCount('error')).toBe(0);
  });

  it('reports a non-macOS build as unsupported and names the platform', async () => {
    setPlatform('win32');
    const updater = await load();

    const state = updater.getUpdateState();
    expect(state.phase).toBe('unsupported');
    expect(state.message).toContain('win32');
  });

  it('makes check, download and install no-ops that return the state', async () => {
    h.app.isPackaged = false;
    const updater = await load();

    await expect(updater.checkForUpdates()).resolves.toMatchObject({ phase: 'unsupported' });
    expect(updater.downloadUpdate()).toMatchObject({ phase: 'unsupported' });
    expect(updater.installUpdate()).toMatchObject({ phase: 'unsupported' });

    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not schedule any background work', async () => {
    vi.useFakeTimers();
    h.app.isPackaged = false;
    const updater = await load();

    updater.startUpdater();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('supported builds', () => {
  it('refuses to download or install anything on its own', async () => {
    const updater = await load();
    await updater.checkForUpdates();

    expect(h.autoUpdater.autoDownload).toBe(false);
    expect(h.autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('starts idle on the current version', async () => {
    const updater = await load();
    expect(updater.getUpdateState()).toEqual({
      phase: 'idle',
      currentVersion: '1.2.3',
      availableVersion: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: null,
    });
  });

  it('goes back to idle when there is nothing new', async () => {
    const updater = await load();
    const state = await updater.checkForUpdates();
    expect(state.phase).toBe('idle');
    expect(state.availableVersion).toBeNull();
  });

  it('walks check -> available -> downloading -> downloaded', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();

    const checked = await updater.checkForUpdates();
    expect(checked.phase).toBe('available');
    expect(checked.availableVersion).toBe('2.0.0');

    const started = updater.downloadUpdate();
    expect(started.phase).toBe('downloading');
    expect(started.progressPercent).toBe(0);
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    h.emit('download-progress', { percent: 12.5, transferred: 1_000, total: 8_000 });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloading',
      progressPercent: 12.5,
      transferredBytes: 1_000,
      totalBytes: 8_000,
    });

    h.emit('download-progress', { percent: 100.4, transferred: 8_000.6, total: 8_000 });
    expect(updater.getUpdateState()).toMatchObject({
      // The contract caps the percentage at 100 and wants integer byte counts.
      progressPercent: 100,
      transferredBytes: 8_001,
    });

    h.emit('update-downloaded', { version: '2.0.0' });
    expect(updater.getUpdateState()).toMatchObject({
      phase: 'downloaded',
      availableVersion: '2.0.0',
      progressPercent: 100,
    });
  });

  it('ignores a re-check once an update is already downloaded', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates();
    updater.downloadUpdate();
    h.emit('update-downloaded', { version: '2.0.0' });

    h.autoUpdater.checkForUpdates.mockClear();
    const state = await updater.checkForUpdates();

    expect(state.phase).toBe('downloaded');
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('broadcasting', () => {
  it('sends every transition to live windows and skips torn-down ones', async () => {
    const live = fakeWindow();
    const closed = fakeWindow({ destroyed: true });
    const gutted = fakeWindow({ contentsDestroyed: true });
    h.windows.push(live, closed, gutted);

    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates();

    // `checking-for-update` then `update-available`.
    expect(live.webContents.send).toHaveBeenCalledTimes(2);
    expect(live.webContents.send).toHaveBeenLastCalledWith('updates:state', {
      phase: 'available',
      currentVersion: '1.2.3',
      availableVersion: '2.0.0',
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: null,
    });
    expect(closed.webContents.send).not.toHaveBeenCalled();
    expect(gutted.webContents.send).not.toHaveBeenCalled();

    updater.downloadUpdate();
    h.emit('download-progress', { percent: 40, transferred: 4, total: 10 });
    h.emit('update-downloaded', { version: '2.0.0' });
    expect(live.webContents.send).toHaveBeenCalledTimes(5);
    expect(live.webContents.send).toHaveBeenLastCalledWith(
      'updates:state',
      expect.objectContaining({ phase: 'downloaded' }),
    );
  });

  it('survives a window that throws mid-send', async () => {
    const angry = fakeWindow();
    angry.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const live = fakeWindow();
    h.windows.push(angry, live);

    const updater = await load();
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ phase: 'idle' });
    expect(live.webContents.send).toHaveBeenCalled();
  });
});

describe('failures', () => {
  it('turns a rejected check into the error phase instead of a throw', async () => {
    h.autoUpdater.checkForUpdates.mockImplementation(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    const updater = await load();

    const state = await updater.checkForUpdates();
    expect(state.phase).toBe('error');
    expect(state.message).toBe(OFFLINE);
  });

  it('turns an emitted error into the error phase', async () => {
    const updater = await load();
    await updater.checkForUpdates();

    h.emit('error', new Error('Cannot find latest-mac.yml in the latest release'));
    const state = updater.getUpdateState();
    expect(state.phase).toBe('error');
    expect(state.message).toBe(UNKNOWN);
  });

  it('turns a rejected download into the error phase', async () => {
    respondWithUpdate('2.0.0');
    h.autoUpdater.downloadUpdate.mockImplementation(async () => {
      throw new Error('sha512 checksum mismatch');
    });
    const updater = await load();
    await updater.checkForUpdates();

    expect(() => updater.downloadUpdate()).not.toThrow();
    await vi.waitFor(() => {
      expect(updater.getUpdateState().phase).toBe('error');
    });
    expect(updater.getUpdateState().message).toBe(SIGNATURE);
  });

  it('recovers from an error on the next check', async () => {
    const updater = await load();
    await updater.checkForUpdates();
    h.emit('error', new Error('transient'));
    expect(updater.getUpdateState().phase).toBe('error');

    respondWithUpdate('2.0.0');
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ phase: 'available' });
  });
});

describe('download guards', () => {
  it('is a no-op returning the current state when there is nothing to download', async () => {
    const updater = await load();
    await updater.checkForUpdates();

    expect(updater.getUpdateState().phase).toBe('idle');
    expect(updater.downloadUpdate()).toMatchObject({ phase: 'idle' });
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not start a second transfer while one is in flight', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates();

    updater.downloadUpdate();
    updater.downloadUpdate();
    expect(h.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('install', () => {
  async function readyToInstall() {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates();
    updater.downloadUpdate();
    h.emit('update-downloaded', { version: '2.0.0' });
    return updater;
  }

  it('refuses to install before anything is downloaded', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates();

    expect(updater.installUpdate()).toMatchObject({ phase: 'available' });
    expect(h.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('delegates to quitAndInstall exactly once, however often it is asked', async () => {
    const updater = await readyToInstall();

    expect(updater.installUpdate()).toMatchObject({ phase: 'downloaded' });
    updater.installUpdate();
    updater.installUpdate();

    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  /**
   * The contract with `src/main/index.ts`: the only quit is the one Squirrel
   * triggers, which lands on the `before-quit` handler there. That handler is
   * guarded by `shuttingDown`, so the shutdown hooks — and therefore the database
   * close — run exactly once. Quitting from here would either race Squirrel or
   * bypass `before-quit` entirely and skip both.
   */
  it('never quits the app itself', async () => {
    const updater = await readyToInstall();
    updater.installUpdate();

    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.app.exit).not.toHaveBeenCalled();
  });

  it('leaves the install alone when the shutdown hook runs behind it', async () => {
    const updater = await readyToInstall();
    updater.installUpdate();

    expect(() => {
      updater.shutdownUpdater();
      updater.shutdownUpdater();
    }).not.toThrow();
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.getUpdateState().phase).toBe('downloaded');
  });

  /**
   * F3. The reason none of the tests below ever expect a second call:
   * `MacUpdater.quitAndInstall()` subscribes to the native `update-downloaded`
   * (electron-updater 6.8.9, `out/MacUpdater.js:247`) and never unsubscribes. A
   * second handoff that succeeded would therefore run Electron's native
   * `quitAndInstall()` once per surviving listener, racing two ShipIt handovers
   * during termination. One attempt per process is the only safe number.
   */
  it('parks the feature instead of retrying when quitAndInstall throws', async () => {
    const updater = await readyToInstall();
    h.autoUpdater.quitAndInstall.mockImplementation(() => {
      throw new Error('ShipIt could not be launched');
    });

    expect(updater.installUpdate()).toMatchObject({ phase: 'unsupported', message: HANDOFF });

    h.autoUpdater.quitAndInstall.mockImplementation(() => undefined);
    h.emit('update-downloaded', { version: '2.0.0' });
    updater.installUpdate();

    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  /**
   * `quitAndInstall()` returns immediately and the handoff runs on inside
   * Squirrel — fetching the zip from the proxy server, checking the signature.
   * When that dies it arrives as an `error` event, never as a throw. It must not
   * put an installable state back on screen.
   */
  it('does not hand off a second time when the handoff dies asynchronously', async () => {
    const updater = await readyToInstall();

    updater.installUpdate();
    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);

    // Squirrel's own checkForUpdates() giving up on the proxy server.
    h.emit('error', new Error('Error: Could not get code signature for running application'));
    expect(updater.getUpdateState().phase).toBe('unsupported');

    // Whatever arrives next, and whatever the user presses.
    h.emit('update-downloaded', { version: '2.0.0' });
    updater.installUpdate();
    updater.installUpdate();

    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('tells the user, in sanitised copy, that a restart is what retries it', async () => {
    const window = fakeWindow();
    h.windows.push(window);
    const updater = await readyToInstall();

    updater.installUpdate();
    h.emit(
      'error',
      new Error('Cannot pipe "/Users/alice/Library/Caches/InvoiceApp/update.zip": Error: EPIPE'),
    );

    const state = updater.getUpdateState();
    expect(state.message).toBe(HANDOFF);
    expect(state.message).not.toContain('/Users/alice');
    expect(state.message).toMatch(/quit invoiceapp and open it again/i);
    // The user is told the retry is cheap, because the bytes are already on disk.
    expect(state.message).toMatch(/nothing to download again/i);

    // And it is the same text every window was handed.
    const broadcast = window.webContents.send.mock.calls.at(-1);
    expect((broadcast?.[1] as { message: string }).message).toBe(HANDOFF);
  });

  /**
   * The state a failed handoff lands in has to be one the renderer already draws
   * correctly. `unsupported` is the only phase `actionView` in
   * `src/renderer/features/updates/updateRows.ts` renders with `kind: 'none'` —
   * no button — which is the truth here, since nothing this process can be asked
   * to do will install anything. (That file belongs to the other side of the IPC
   * boundary and cannot be imported into a main-process test, so the phase is
   * what is pinned.)
   */
  it('leaves no control to press after a failed handoff', async () => {
    const updater = await readyToInstall();

    updater.installUpdate();
    h.emit('error', new Error('ENOTFOUND 127.0.0.1'));

    const state = updater.getUpdateState();
    expect(state.phase).toBe('unsupported');

    // Every remaining entry point agrees with that button: nothing happens.
    h.autoUpdater.checkForUpdates.mockClear();
    h.autoUpdater.downloadUpdate.mockClear();
    await expect(updater.checkForUpdates()).resolves.toMatchObject({ phase: 'unsupported' });
    expect(updater.downloadUpdate()).toMatchObject({ phase: 'unsupported' });
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  /**
   * The other side of the guard: a handoff that is merely slow — a ~200 MB zip
   * over a local socket is not instant — emits nothing at all. Silence must not
   * be read as failure, so the phase stays `downloaded` and the copy stays quiet.
   */
  it('does not restart, or bury, a handoff that is still in flight', async () => {
    const updater = await readyToInstall();

    updater.installUpdate();
    // Squirrel re-dispatching `update-downloaded` is not a fresh installable state.
    h.emit('update-downloaded', { version: '2.0.0' });
    updater.installUpdate();
    updater.installUpdate();

    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.getUpdateState()).toMatchObject({ phase: 'downloaded', message: null });
  });

  it('calls quitAndInstall at most once across any sequence of events', async () => {
    const updater = await readyToInstall();

    // Every order the outside world can put these in, on one instance.
    for (const step of [
      () => updater.installUpdate(),
      () => h.emit('error', new Error('ENOTFOUND 127.0.0.1')),
      () => h.emit('update-downloaded', { version: '2.0.0' }),
      () => updater.installUpdate(),
      () => h.emit('update-available', { version: '2.1.0' }),
      () => updater.downloadUpdate(),
      () => h.emit('download-progress', { percent: 50, transferred: 5, total: 10 }),
      () => h.emit('update-downloaded', { version: '2.1.0' }),
      () => updater.installUpdate(),
      () => updater.shutdownUpdater(),
      () => updater.installUpdate(),
    ]) {
      step();
    }
    await updater.checkForUpdates();
    updater.installUpdate();

    expect(h.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

/**
 * F2. `src/main/ipc/registry.ts:51-62` refuses to forward the message of an
 * unplanned error because it may quote SQL, a schema or a path. electron-updater
 * errors are exactly that kind of error — `MacUpdater.updateDownloaded()` builds
 * `Cannot pipe "<cache path>": …` out of the user's home directory — and the
 * renderer renders `message` straight to the screen. So nothing raw crosses, and
 * the full text lives in the main-process log instead.
 */
describe('error messages crossing to the renderer', () => {
  const PIPE_FAILURE =
    'Cannot pipe "/Users/alice/Library/Application Support/InvoiceApp/pending/update.zip": Error: EPIPE';

  it('never lets a filesystem path reach the broadcast state', async () => {
    const window = fakeWindow();
    h.windows.push(window);
    const updater = await load();
    await updater.checkForUpdates();

    h.emit('error', new Error(PIPE_FAILURE));

    const state = updater.getUpdateState();
    expect(state.message).not.toContain('/Users/alice');
    expect(state.message).not.toContain('update.zip');
    expect(state.message).toBe(UNKNOWN);

    // The same text is what every window was handed.
    const broadcast = window.webContents.send.mock.calls.at(-1);
    expect(broadcast?.[0]).toBe('updates:state');
    expect((broadcast?.[1] as { message: string }).message).toBe(UNKNOWN);
  });

  it('still gives the main-process log the whole error', async () => {
    const updater = await load();
    await updater.checkForUpdates();

    const raw = new Error(PIPE_FAILURE);
    h.emit('error', raw);

    expect(console.error).toHaveBeenCalledWith('[updates] failed:', raw);
  });

  it.each([
    ['net::ERR_INTERNET_DISCONNECTED', OFFLINE],
    ['getaddrinfo EAI_AGAIN github.com', OFFLINE],
    ['connect ECONNREFUSED 127.0.0.1:52341', OFFLINE],
    ['Cannot download "https://github.com/…/latest-mac.yml", status 503 Service Unavailable', BUSY],
    ['HTTP 429 too many requests: {"message":"API rate limit exceeded for 203.0.113.7"}', BUSY],
    ['sha512 checksum mismatch, expected abc, got def', SIGNATURE],
    ['Code signature at URL file:///… did not pass validation', SIGNATURE],
    [PIPE_FAILURE, UNKNOWN],
    ['Cannot find latest-mac.yml in the latest release', UNKNOWN],
    ['', UNKNOWN],
  ])('classifies %j as a message written for a person', async (raw, expected) => {
    const updater = await load();
    await updater.checkForUpdates();

    h.emit('error', new Error(raw));
    expect(updater.getUpdateState().message).toBe(expected);
  });

  it('reads the error code as well as the message', async () => {
    const updater = await load();
    await updater.checkForUpdates();

    const full = Object.assign(new Error('Cannot write to /Users/alice/Library/Caches/x.zip'), {
      code: 'ENOSPC',
    });
    h.emit('error', full);

    expect(updater.getUpdateState().message).toBe(DISK_FULL);
  });

  it('leaves the unsupported copy alone, which is written for a person already', async () => {
    h.app.isPackaged = false;
    const updater = await load();

    expect(updater.getUpdateState().message).toMatch(/development run/i);
  });
});

describe('scheduling', () => {
  it('checks shortly after start and then on an interval', async () => {
    vi.useFakeTimers();
    const updater = await load();

    updater.startUpdater();
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(updater.STARTUP_CHECK_DELAY_MS);
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(updater.BACKGROUND_CHECK_INTERVAL_MS);
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('is idempotent, so a double register does not double the checks', async () => {
    vi.useFakeTimers();
    const updater = await load();

    updater.startUpdater();
    updater.startUpdater();
    await vi.advanceTimersByTimeAsync(updater.STARTUP_CHECK_DELAY_MS);
    expect(h.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('clears its timers on shutdown so nothing keeps the process alive', async () => {
    vi.useFakeTimers();
    const updater = await load();

    updater.startUpdater();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    updater.shutdownUpdater();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(updater.BACKGROUND_CHECK_INTERVAL_MS * 2);
    expect(h.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('announces a find from the startup timer, so the toast is the timers own', async () => {
    vi.useFakeTimers();
    respondWithUpdate('2.0.0');
    const updater = await load();

    updater.startUpdater();
    await vi.advanceTimersByTimeAsync(updater.STARTUP_CHECK_DELAY_MS);

    expect(h.notifications).toHaveLength(1);
    expect(posted().options.body).toContain('2.0.0');
  });

  it('does not let a failing background check escape', async () => {
    vi.useFakeTimers();
    h.autoUpdater.checkForUpdates.mockImplementation(async () => {
      throw new Error('EAI_AGAIN api.github.com');
    });
    const updater = await load();

    updater.startUpdater();
    await vi.advanceTimersByTimeAsync(updater.STARTUP_CHECK_DELAY_MS);

    expect(updater.getUpdateState()).toMatchObject({ phase: 'error', message: OFFLINE });
  });
});

/**
 * Settings is the only screen that shows update state, and nobody opens it on
 * spec. A background find therefore has to speak up — but only a background one,
 * only once per version, and never at the cost of the update itself.
 */
describe('notifications', () => {
  it('posts exactly one notification naming the version on a background find', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();

    await updater.checkForUpdates({ background: true });

    expect(h.notifications).toHaveLength(1);
    const toast = posted();
    expect(toast.options.title).toBe('Update available');
    expect(toast.options.body).toBe(
      'InvoiceApp 2.0.0 is ready to download — open Settings to install it.',
    );
    expect(toast.show).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when a later background check finds the same version again', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();

    await updater.checkForUpdates({ background: true });
    await updater.checkForUpdates({ background: true });
    await updater.checkForUpdates({ background: true });

    expect(h.notifications).toHaveLength(1);
  });

  it('speaks again once a genuinely newer version turns up', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates({ background: true });

    respondWithUpdate('2.1.0');
    await updater.checkForUpdates({ background: true });

    expect(h.notifications).toHaveLength(2);
    expect(posted(1).options.body).toContain('2.1.0');
  });

  it('says nothing for a user-initiated check, which is what the IPC path does', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();

    // No argument: exactly how `src/main/ipc/updates.ts` calls it.
    const state = await updater.checkForUpdates();

    expect(state.phase).toBe('available');
    expect(h.notifications).toHaveLength(0);
    expect(h.Notification.isSupported).not.toHaveBeenCalled();
  });

  it('leaves a user-initiated find un-announced, then announces it in the background', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();

    await updater.checkForUpdates();
    expect(h.notifications).toHaveLength(0);

    await updater.checkForUpdates({ background: true });
    expect(h.notifications).toHaveLength(1);
  });

  it('never notifies on an unsupported run', async () => {
    h.app.isPackaged = false;
    respondWithUpdate('2.0.0');
    const updater = await load();

    await updater.checkForUpdates({ background: true });

    expect(h.notifications).toHaveLength(0);
    expect(h.Notification.isSupported).not.toHaveBeenCalled();
  });

  it('does nothing when notifications are unsupported, and does not disturb the update', async () => {
    h.notificationState.supported = false;
    respondWithUpdate('2.0.0');
    const updater = await load();

    const state = await updater.checkForUpdates({ background: true });

    expect(h.Notification.isSupported).toHaveBeenCalled();
    expect(h.notifications).toHaveLength(0);
    expect(state).toMatchObject({ phase: 'available', availableVersion: '2.0.0' });
  });

  it('swallows a throwing constructor and still reaches available', async () => {
    h.notificationState.throwOnConstruct = true;
    respondWithUpdate('2.0.0');
    const updater = await load();

    await expect(updater.checkForUpdates({ background: true })).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '2.0.0',
    });
    expect(h.notifications).toHaveLength(0);
  });

  it('swallows a throwing show() and still reaches available', async () => {
    h.notificationState.throwOnShow = true;
    respondWithUpdate('2.0.0');
    const updater = await load();

    await expect(updater.checkForUpdates({ background: true })).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '2.0.0',
    });
    expect(h.notifications).toHaveLength(1);
  });

  it('restores a minimised window and focuses it when the toast is clicked', async () => {
    const window = fakeWindow({ minimized: true });
    h.windows.push(window);
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates({ background: true });

    posted().click();

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('only focuses a window that is not minimised', async () => {
    const window = fakeWindow();
    h.windows.push(window);
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates({ background: true });

    posted().click();

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('survives a click with no window left to focus', async () => {
    respondWithUpdate('2.0.0');
    const updater = await load();
    await updater.checkForUpdates({ background: true });

    expect(() => posted().click()).not.toThrow();
  });
});
