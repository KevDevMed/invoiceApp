/**
 * IPC surface for in-app updates.
 *
 * Discovered automatically by `registry.ts` — there is no list to edit. Every
 * channel here is declared in the frozen contract and validated by
 * `registerHandler` before this file sees a payload.
 *
 * Intentionally thin: all of the behaviour lives in `../updater`, which knows
 * nothing about IPC and can therefore be tested without an Electron app.
 */

import { IPC_CONTRACT } from '../../shared/ipc-contract';
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  shutdownUpdater,
  startUpdater,
} from '../updater';
import { registerHandler } from './registry';

export function register(): void {
  registerHandler('updates:getState', IPC_CONTRACT['updates:getState'].request, () =>
    getUpdateState(),
  );

  registerHandler('updates:check', IPC_CONTRACT['updates:check'].request, () => checkForUpdates());

  registerHandler('updates:download', IPC_CONTRACT['updates:download'].request, () =>
    downloadUpdate(),
  );

  registerHandler('updates:install', IPC_CONTRACT['updates:install'].request, () => installUpdate());

  // Safe to start before any window exists: the renderer pulls `updates:getState`
  // on mount, so nothing broadcast in the meantime is lost.
  startUpdater();
}

/**
 * The teardown `registry.ts` drains on `before-quit`, before the database closes.
 *
 * Discovered by name, like `register()` — nothing has to list it anywhere.
 */
export function shutdown(): void {
  shutdownUpdater();
}
