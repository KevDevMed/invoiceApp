/**
 * Main-process entry point.
 *
 * Boot order matters: harden the session, open and migrate the database, then
 * register IPC handlers, and only then show a window. The renderer can never
 * observe a half-initialised backend because it does not exist until the last
 * step.
 */

import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { closeDatabase, openDatabase, setDatabase } from '../db/client';
import { migrate } from '../db/migrate';
import { registerAll } from './ipc/registry';
import { databasePath, ensureDir } from './paths';
import { createMainWindow, hardenWebContents, installContentSecurityPolicy } from './window';

// Refuse to run a second copy: two processes writing the same SQLite file is a
// corruption hazard we simply opt out of.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  }
});

app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents);
});

function bootDatabase(): void {
  const file = databasePath();
  ensureDir(path.dirname(file));
  const db = openDatabase(file);
  setDatabase(db);
  const result = migrate(db);
  console.log(
    `[db] ${file} — applied: [${result.applied.join(', ')}], already applied: [${result.alreadyApplied.join(', ')}]`,
  );
}

async function boot(): Promise<void> {
  installContentSecurityPolicy();
  bootDatabase();
  await registerAll();
  createMainWindow();
}

app
  .whenReady()
  .then(boot)
  .then(() => {
    app.on('activate', () => {
      // macOS: clicking the dock icon with no windows open reopens one.
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  })
  .catch((error: unknown) => {
    console.error('[main] fatal error during startup:', error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  closeDatabase();
});
