/**
 * SQLite connection management.
 *
 * Every connection opened through here has `foreign_keys = ON` and
 * `journal_mode = WAL`. Nothing else in the app is allowed to call
 * `new Database(...)` directly.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * better-sqlite3 is a native module. `postinstall` builds it twice: once for
 * Node's ABI (kept at build/node-abi, used by vitest) and once for Electron's
 * ABI (the default build/Release, used by the app). Outside Electron we point
 * the loader at the Node build; inside Electron the default is already correct.
 */
function resolveNativeBinding(): string | undefined {
  const override = process.env.INVOICEAPP_SQLITE_BINDING;
  if (override) return override;
  if (process.versions.electron) return undefined;

  const nodeAbiBuild = path.resolve(
    process.cwd(),
    'node_modules/better-sqlite3/build/node-abi/better_sqlite3.node',
  );
  return existsSync(nodeAbiBuild) ? nodeAbiBuild : undefined;
}

export interface OpenDatabaseOptions {
  readonly readonly?: boolean;
  /** Passed straight through to better-sqlite3 for debugging. */
  readonly verbose?: (message?: unknown, ...args: unknown[]) => void;
}

/** Open (or create) a database file. Use `':memory:'` for tests. */
export function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Db {
  const db = new Database(filePath, {
    readonly: options.readonly ?? false,
    verbose: options.verbose,
    nativeBinding: resolveNativeBinding(),
  });

  // Order matters: foreign_keys is a per-connection setting and is a no-op
  // inside a transaction, so it goes first, before anything can open one.
  db.pragma('foreign_keys = ON');
  // WAL is persistent on-disk state; in-memory databases silently stay in
  // 'memory' journal mode, which is what we want for tests anyway.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  return db;
}

let singleton: Db | null = null;

/** Process-wide connection used by the main process. */
export function setDatabase(db: Db): void {
  singleton = db;
}

export function getDatabase(): Db {
  if (!singleton) {
    throw new Error('Database has not been opened yet — call setDatabase() during app startup.');
  }
  return singleton;
}

export function closeDatabase(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
