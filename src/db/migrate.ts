/**
 * Migration runner.
 *
 * Migrations are numbered SQL files in `src/db/migrations/`, imported as raw
 * strings so they are bundled into the main-process build and survive packaging
 * inside the asar. Each one runs exactly once, inside a transaction, and is
 * recorded in `_migrations`. Re-running `migrate()` on an up-to-date database
 * is a no-op.
 *
 * To add a migration: create `002_something.sql` next to this file, import it
 * below, and append it to `MIGRATIONS`. Never edit an already-shipped file.
 */

import init001 from './migrations/001_init.sql?raw';
import type { Db } from './client';

export interface Migration {
  /** Sort key and primary key in `_migrations`. Matches the filename stem. */
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ id: '001_init', sql: init001 }];

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

export interface MigrateResult {
  readonly applied: string[];
  readonly alreadyApplied: string[];
}

/**
 * Bring `db` up to the latest schema. Safe to call on every boot.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  db.exec(CREATE_MIGRATIONS_TABLE);

  const isApplied = db.prepare<[string], { id: string }>(
    'SELECT id FROM _migrations WHERE id = ?',
  );
  const record = db.prepare<[string, string]>(
    'INSERT INTO _migrations (id, applied_at) VALUES (?, ?)',
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));

  for (const migration of ordered) {
    if (isApplied.get(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }

    // One transaction per migration: a failing migration leaves the database on
    // the previous version rather than half-way through this one.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, new Date().toISOString());
    });
    run();
    applied.push(migration.id);
  }

  return { applied, alreadyApplied };
}

/** Migration ids currently recorded in the database, in application order. */
export function appliedMigrations(db: Db): string[] {
  const tableExists = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'",
    )
    .get();
  if (!tableExists) return [];
  return db
    .prepare<[], { id: string }>('SELECT id FROM _migrations ORDER BY id')
    .all()
    .map((row) => row.id);
}
