/**
 * In-app updates for the packaged macOS build.
 *
 * All of the updater's logic lives here rather than in the IPC module so it can
 * be driven by a test with no Electron app behind it: everything this file needs
 * from the outside world arrives through `electron` and `electron-updater`, both
 * of which a test can replace wholesale.
 *
 * The shape of the feature:
 *   - one `UpdateState` is the whole truth. Every transition rewrites it and
 *     pushes it to every live window, so the UI never has to merge a response
 *     with a stream.
 *   - nothing happens without the user asking, except the check. Downloads and
 *     installs are ~200 MB and a relaunch respectively; neither is something to
 *     spring on someone.
 *   - `unsupported` is a phase, not an error. A development run and a non-macOS
 *     build cannot update themselves, and saying so plainly beats a stack trace.
 */

import { app, BrowserWindow } from 'electron';
import * as electronUpdater from 'electron-updater';
import type { AppUpdater } from 'electron-updater';

import type { UpdateState } from '../shared/ipc-contract';

/**
 * Wait before the first check.
 *
 * Boot already opens the database, runs migrations and paints a window; a
 * network round trip competing with that buys nothing, and an update found ten
 * seconds later is just as useful as one found immediately.
 */
export const STARTUP_CHECK_DELAY_MS = 10_000;

/**
 * Re-check four times a day.
 *
 * Releases are rare, so anything faster is pure noise against GitHub. But this
 * is a desktop app people leave open for weeks, and a session that only checks
 * at launch would never notice a release at all.
 */
export const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Shown when a failure carries no message of its own. */
const GENERIC_FAILURE = 'The update could not be completed. Please try again later.';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: UpdateState | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let listenersAttached = false;
let installRequested = false;

/**
 * Why this build cannot update itself, or null if it can.
 *
 * Both cases are permanent for the life of the process, so this is answered once
 * and baked into the initial state.
 */
function unsupportedReason(): string | null {
  if (!app.isPackaged) {
    return 'Updates are only available in the installed app — this is a development run.';
  }
  if (process.platform !== 'darwin') {
    return `Updates are only published for macOS, and this is ${process.platform}.`;
  }
  return null;
}

function initialState(): UpdateState {
  const reason = unsupportedReason();
  return {
    phase: reason === null ? 'idle' : 'unsupported',
    currentVersion: app.getVersion(),
    availableVersion: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    message: reason,
  };
}

function current(): UpdateState {
  state ??= initialState();
  return state;
}

/**
 * Apply a transition and tell every window about it.
 *
 * A window can be torn down between `getAllWindows()` handing it over and the
 * send landing, and its `webContents` can outlive neither, so both are checked
 * and a throw from `send` is swallowed. A closing window must never take an
 * updater transition down with it.
 */
function setState(patch: Partial<UpdateState>): UpdateState {
  const next: UpdateState = { ...current(), ...patch };
  state = next;

  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (window.isDestroyed()) continue;
      const contents = window.webContents;
      if (!contents || contents.isDestroyed()) continue;
      contents.send('updates:state', next);
    } catch (error) {
      console.warn('[updates] could not deliver state to a window:', error);
    }
  }

  return next;
}

/**
 * Land any failure in the `error` phase.
 *
 * electron-updater's messages are already written for humans ("Cannot find
 * latest-mac.yml", "net::ERR_INTERNET_DISCONNECTED") and reference only this
 * app's own release feed, so they pass through — capped in length, because a
 * differential-download failure can quote a whole JSON body.
 */
function fail(error: unknown): UpdateState {
  console.error('[updates] failed:', error);
  return setState({ phase: 'error', progressPercent: null, message: describe(error) });
}

function describe(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  if (raw.length === 0) return GENERIC_FAILURE;
  return raw.length > 300 ? `${raw.slice(0, 299)}…` : raw;
}

/** The contract caps this at 0..100, and electron-updater has been seen to overshoot. */
function toPercent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

/** The contract wants non-negative integers; the wire gives floats on resume. */
function toByteCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

// ---------------------------------------------------------------------------
// electron-updater
// ---------------------------------------------------------------------------

/**
 * Get the updater, wiring its events the first time.
 *
 * `electronUpdater.autoUpdater` is a lazy getter that constructs a platform
 * updater on first access, so it is reached through a namespace and only ever
 * touched on a supported build. Nothing above this line accesses it, which is
 * why an `unsupported` run never constructs one at all.
 */
function updater(): AppUpdater {
  const instance = electronUpdater.autoUpdater;
  if (listenersAttached) return instance;
  listenersAttached = true;

  // A ~200 MB transfer never starts on its own...
  instance.autoDownload = false;
  // ...and an update never installs itself behind someone who just quit.
  instance.autoInstallOnAppQuit = false;

  instance.on('checking-for-update', () => {
    setState({ phase: 'checking', message: null });
  });

  instance.on('update-available', (info) => {
    setState({
      phase: 'available',
      availableVersion: info.version,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: null,
    });
  });

  instance.on('update-not-available', () => {
    setState({
      phase: 'idle',
      availableVersion: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: null,
    });
  });

  instance.on('download-progress', (progress) => {
    setState({
      phase: 'downloading',
      progressPercent: toPercent(progress.percent),
      transferredBytes: toByteCount(progress.transferred),
      totalBytes: toByteCount(progress.total),
      message: null,
    });
  });

  instance.on('update-downloaded', (info) => {
    setState({
      phase: 'downloaded',
      availableVersion: info.version,
      progressPercent: 100,
      message: null,
    });
  });

  // Background checks fail all the time — a closed laptop lid is enough. This is
  // the only place that turns such a failure into something visible, and it is
  // never a throw.
  instance.on('error', (error) => {
    fail(error);
  });

  return instance;
}

// ---------------------------------------------------------------------------
// Public surface — one function per contract channel, plus lifecycle
// ---------------------------------------------------------------------------

/** The current snapshot. Cheap, total, and never throws. */
export function getUpdateState(): UpdateState {
  return current();
}

/**
 * Start the background schedule.
 *
 * Called from `register()` in the IPC module, which runs before the first window
 * exists. No transition can be missed by starting this early: the renderer pulls
 * `updates:getState` when it mounts and gets whatever happened in the meantime.
 */
export function startUpdater(): void {
  const snapshot = current();
  if (snapshot.phase === 'unsupported') {
    console.log(`[updates] disabled — ${snapshot.message ?? 'unsupported build'}`);
    return;
  }
  if (startupTimer !== null || periodicTimer !== null) return;

  startupTimer = setTimeout(() => {
    startupTimer = null;
    void checkForUpdates();
  }, STARTUP_CHECK_DELAY_MS);

  periodicTimer = setInterval(() => {
    void checkForUpdates();
  }, BACKGROUND_CHECK_INTERVAL_MS);
}

/**
 * Check for an update and resolve once the check has settled.
 *
 * Re-entrant calls are ignored rather than queued: a check already in flight will
 * broadcast the same answer, and re-checking on top of a finished download would
 * knock the state back from `downloaded` to `available` for no reason.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const snapshot = current();
  if (
    snapshot.phase === 'unsupported' ||
    snapshot.phase === 'checking' ||
    snapshot.phase === 'downloading' ||
    snapshot.phase === 'downloaded'
  ) {
    return snapshot;
  }

  try {
    await updater().checkForUpdates();
  } catch (error) {
    return fail(error);
  }
  return current();
}

/**
 * Begin downloading the available update.
 *
 * Returns as soon as the transfer is under way — waiting for ~200 MB would hold
 * the IPC call open for minutes — so the caller learns the outcome from
 * `updates:state`. Anything other than a settled `update-available` has no file
 * behind it, so it is a no-op that hands back the state unchanged.
 */
export function downloadUpdate(): UpdateState {
  const snapshot = current();
  if (snapshot.phase !== 'available') return snapshot;

  const instance = updater();
  const started = setState({
    phase: 'downloading',
    progressPercent: 0,
    transferredBytes: 0,
    totalBytes: null,
    message: null,
  });

  // The transfer outlives this call; progress and completion arrive as events.
  void instance.downloadUpdate().catch((error: unknown) => {
    fail(error);
  });

  return started;
}

/**
 * Hand a downloaded update to the OS and let the app quit into it.
 *
 * What `MacUpdater.quitAndInstall()` actually does, because it decides the shape
 * of this function (electron-updater 6.8.9, `out/MacUpdater.js`):
 *
 *   1. With `autoInstallOnAppQuit = false`, the download step served the zip from
 *      a local proxy server but never told Squirrel about it, so
 *      `squirrelDownloadedUpdate` is false. `quitAndInstall()` therefore takes the
 *      second branch: it subscribes to the *native* `update-downloaded` and calls
 *      `nativeUpdater.checkForUpdates()`. That is asynchronous — Squirrel fetches
 *      the zip from the proxy server first — so this function must not block, and
 *      the proxy server must stay up, which is why nothing here shuts anything
 *      down.
 *   2. When Squirrel has it, `handleUpdateDownloaded()` calls Electron's native
 *      `autoUpdater.quitAndInstall()`, which launches ShipIt and terminates the
 *      app through the normal `NSApp terminate:` path.
 *
 * Step 2 is the sharp edge: that terminate fires `before-quit`, which
 * `src/main/index.ts` intercepts with `preventDefault()`, drains the shutdown
 * hooks, and then calls `app.quit()` a second time behind a `shuttingDown` flag.
 * That existing dance is exactly what is wanted here and needs no change:
 *
 *   - the hooks run once, because the flag makes the second `before-quit` a
 *     pass-through;
 *   - the database still closes, because `will-quit` fires on the real quit;
 *   - the quit is not swallowed, because the deferred `app.quit()` still ends the
 *     process, and ShipIt is already waiting for it to exit before swapping the
 *     bundle in.
 *
 * The one thing this function must not do is quit by itself. Calling `app.quit()`
 * or `app.exit()` here would either race Squirrel or bypass `before-quit`
 * entirely, skipping the shutdown hooks and leaving the database open. So it
 * delegates and returns, exactly once.
 */
export function installUpdate(): UpdateState {
  const snapshot = current();
  if (snapshot.phase !== 'downloaded' || installRequested) return snapshot;

  installRequested = true;
  try {
    updater().quitAndInstall();
  } catch (error) {
    // The install never started, so let the user try again.
    installRequested = false;
    return fail(error);
  }
  return snapshot;
}

/**
 * Drop the timers so they cannot keep the process alive.
 *
 * Deliberately does not cancel a requested install: by the time this runs on
 * `before-quit`, Squirrel may already be mid-handover, and there is nothing here
 * worth interrupting it for.
 */
export function shutdownUpdater(): void {
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
