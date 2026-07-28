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
 *   - a background check that finds something says so out loud, once. Settings is
 *     the only screen that shows update state and nobody opens it speculatively,
 *     so without a notification a found release can go unnoticed forever.
 */

import { app, BrowserWindow, Notification } from 'electron';
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

/**
 * Everything the renderer is ever allowed to be told about a failure.
 *
 * `src/main/ipc/registry.ts:51-62` draws this line for every other channel: a
 * message only reaches the renderer if it was written for a person. An
 * electron-updater message was not — it interpolates the cache path (`Cannot
 * pipe "/Users/alice/Library/…"`), the feed URL, and whole response bodies. So
 * the raw text is classified into one of these and never forwarded; the detail
 * goes to the main-process log, where debugging wants it anyway.
 */
const FAILURE_MESSAGES = {
  offline: 'InvoiceApp could not reach the update server. Check your internet connection and try again.',
  busy: 'The update server is busy right now. Please try again in a few minutes.',
  signature:
    'The update could not be verified, so it was not installed. Please try again, or download the latest version from the InvoiceApp website.',
  diskFull: 'There is not enough free disk space for the update. Free up some space and try again.',
  unknown: 'The update could not be completed. Please try again later.',
} as const;

type FailureCause = keyof typeof FAILURE_MESSAGES;

/** Notification copy. One line of body: name the version, say where to go. */
const NOTIFICATION_TITLE = 'Update available';
const notificationBody = (version: string): string =>
  `InvoiceApp ${version} is ready to download — open Settings to install it.`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: UpdateState | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let listenersAttached = false;
let installRequested = false;

/**
 * True only while a check started by the timers is in flight.
 *
 * `update-available` fires from inside `checkForUpdates()`, and by then the state
 * looks identical whoever asked — so the caller's intent has to be carried, not
 * reconstructed. Someone who just pressed "Check for updates" is already reading
 * the answer; a toast on top of it is noise.
 */
let backgroundCheckInFlight = false;

/**
 * The version a notification has already been posted for.
 *
 * `update-available` re-fires on every check, and the interval is six hours, so
 * without this the same release would be announced four times a day for as long
 * as the app stays open. Process-wide and deliberately not cleared on shutdown.
 */
let announcedVersion: string | null = null;

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
 * The full error — message, stack, whatever it carries — is logged here and only
 * here. What crosses to the renderer is one of `FAILURE_MESSAGES`, chosen by
 * `classify`, because the renderer renders `message` straight to the user and
 * electron-updater's own text quotes paths, URLs and response bodies.
 */
function fail(error: unknown): UpdateState {
  console.error('[updates] failed:', error);
  return setState({ phase: 'error', progressPercent: null, message: describe(error) });
}

/**
 * Everything `classify` reads. The `code` matters as much as the message:
 * electron-updater tags its own failures (`ERR_UPDATER_*`, `ERR_CHECKSUM_MISMATCH`)
 * and Node tags the OS ones (`ENOSPC`, `ENOTFOUND`), and those tags are stable
 * where the prose around them is not.
 */
function signature(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
  } else {
    parts.push(String(error));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Sort a failure into the handful of things a person can act on.
 *
 * Order matters: a rejected signature and a full disk are specific and worth
 * saying out loud, while "the network is unhappy" is the common case that
 * everything else falls back through. Anything unrecognised is `unknown` — a
 * wrong-but-safe guess is worse than an honest generic line.
 */
function classify(error: unknown): FailureCause {
  const text = signature(error);
  if (text.length === 0) return 'unknown';

  if (
    /err_updater_invalid_signature|err_checksum_mismatch|checksum mismatch|signature|did not pass validation|code sign/.test(
      text,
    )
  ) {
    return 'signature';
  }
  if (/enospc|no space left|not enough (free )?(disk )?space|disk (is )?full/.test(text)) {
    return 'diskFull';
  }
  if (
    /err_internet_disconnected|err_name_not_resolved|err_network_changed|err_connection_|err_address_unreachable|enotfound|eai_again|econnrefused|econnreset|etimedout|enetunreach|ehostunreach|network is unreachable|socket hang up/.test(
      text,
    )
  ) {
    return 'offline';
  }
  if (/\b(429|502|503)\b|rate limit|too many requests|service unavailable|bad gateway/.test(text)) {
    return 'busy';
  }
  return 'unknown';
}

function describe(error: unknown): string {
  return FAILURE_MESSAGES[classify(error)];
}

/**
 * Whether an install handoff is outstanding right now.
 *
 * Both halves are needed. `installRequested` alone would be released by an error
 * that has nothing to do with the install; the `downloaded` phase is what says
 * the install is the only thing this module currently has in flight, because
 * `checkForUpdates` and `downloadUpdate` both refuse to start from that phase.
 * Once `fail` has moved the phase to `error` this is false again, so the release
 * happens once and a genuinely running handoff is never disturbed.
 */
function handoffInFlight(): boolean {
  return installRequested && current().phase === 'downloaded';
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
// Notification
// ---------------------------------------------------------------------------

/**
 * Bring the app forward, the same way a second launch does.
 *
 * `src/main/index.ts:26-32` already answers `second-instance` with restore-then-
 * focus; a click on the toast means the same thing ("show me the app"), so it
 * gets the same two lines rather than a second idiom.
 */
function focusMainWindow(): void {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
}

/**
 * Tell the user, once, that a background check found something.
 *
 * Every reason to stay quiet is checked here rather than at the call site, and
 * the whole thing is wrapped: a toast is a courtesy, and a courtesy that fails
 * must not drag the update flow into `error`. `Notification` is only touched
 * after the unsupported guard, so a development run never constructs one.
 */
function announceUpdate(version: string): void {
  if (!backgroundCheckInFlight) return;
  if (unsupportedReason() !== null) return;
  if (announcedVersion === version) return;

  try {
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title: NOTIFICATION_TITLE,
      body: notificationBody(version),
    });
    notification.on('click', () => {
      try {
        focusMainWindow();
      } catch (error) {
        console.warn('[updates] could not focus a window from the notification:', error);
      }
    });
    notification.show();

    announcedVersion = version;
  } catch (error) {
    console.warn('[updates] could not post the update notification:', error);
  }
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
    // After the broadcast: the UI is the primary surface, the toast is the nudge.
    announceUpdate(info.version);
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
    // An error that arrives while a handoff is outstanding is the handoff dying;
    // see `installUpdate`. Read the guard before `fail` moves the phase.
    if (handoffInFlight()) installRequested = false;
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

  // Both timer paths are background: nobody asked, so a find has to announce
  // itself. The IPC path calls `checkForUpdates()` with no argument and stays
  // silent by default.
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void checkForUpdates({ background: true });
  }, STARTUP_CHECK_DELAY_MS);

  periodicTimer = setInterval(() => {
    void checkForUpdates({ background: true });
  }, BACKGROUND_CHECK_INTERVAL_MS);
}

/**
 * Check for an update and resolve once the check has settled.
 *
 * Re-entrant calls are ignored rather than queued: a check already in flight will
 * broadcast the same answer, and re-checking on top of a finished download would
 * knock the state back from `downloaded` to `available` for no reason.
 *
 * `background` is the timers' claim that nobody is watching, and is the only
 * thing that lets a find post a notification. It defaults to false so the IPC
 * path — a user standing in Settings — is silent without having to say so.
 */
export async function checkForUpdates(
  options: { background?: boolean } = {},
): Promise<UpdateState> {
  const snapshot = current();
  if (
    snapshot.phase === 'unsupported' ||
    snapshot.phase === 'checking' ||
    snapshot.phase === 'downloading' ||
    snapshot.phase === 'downloaded'
  ) {
    return snapshot;
  }

  const outer = backgroundCheckInFlight;
  backgroundCheckInFlight = options.background === true;
  try {
    await updater().checkForUpdates();
  } catch (error) {
    return fail(error);
  } finally {
    backgroundCheckInFlight = outer;
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
 *
 * Exactly once — but not once per process. Step 1 is asynchronous, and on macOS
 * that is where the real failures live: Squirrel pulling the zip from the proxy
 * server, or refusing its code signature. Those surface as an `error` event, not
 * a throw, so the synchronous `catch` below never sees them and a guard released
 * only there would stay set for the life of the app: check, download and
 * `downloaded` would all work again while `updates:install` quietly did nothing.
 *
 * The `error` handler therefore releases the guard too, under `handoffInFlight()`.
 * That is narrow on purpose. After `quitAndInstall()` returns, the only
 * electron-updater work left is `nativeUpdater.checkForUpdates()` and the proxy
 * server serving it, and the only thing still able to emit `error` is the
 * `nativeUpdater.on("error", …)` forwarder set up in `MacUpdater`'s constructor —
 * every other emitter belongs to a check or a download, and this module starts
 * neither from the `downloaded` phase. So an `error` in that window *is* Squirrel
 * saying the handoff is dead, and releasing on it cannot let a second
 * `quitAndInstall()` race a handoff that is still running. A handoff that is
 * merely slow emits nothing, the guard stays set, and a second press is ignored.
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
