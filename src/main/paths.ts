/**
 * Every filesystem location the app writes to. Nothing else builds paths by
 * hand, so relocating user data is a one-file change.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

/** Root for all user-writable state: `~/Library/Application Support/InvoiceApp` on macOS. */
export function userDataDir(): string {
  return app.getPath('userData');
}

/**
 * The SQLite database. `INVOICEAPP_DB_PATH` overrides it so smoke runs and
 * headless boots never touch a real user's data.
 */
export function databasePath(): string {
  const override = process.env.INVOICEAPP_DB_PATH;
  if (override) return override;
  return path.join(userDataDir(), 'invoiceapp.db');
}

/** Where downloaded model weights live. Owned by the LLM builder. */
export function modelsDir(): string {
  return ensureDir(path.join(userDataDir(), 'models'));
}

/** Where generated invoice PDFs are staged before the user picks a destination. */
export function exportsDir(): string {
  return ensureDir(path.join(userDataDir(), 'exports'));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
