/**
 * 002 gives the models table its own columns for the smoke-test record and for
 * the verified digest. The interesting part is the upgrade path: a database
 * written by the previous build has smoke-test payloads sitting in `models.error`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../client';
import { appliedMigrations, migrate, MIGRATIONS } from '../migrate';

const NOW = '2026-07-27T10:00:00.000Z';

const SMOKE_PAYLOAD = JSON.stringify({
  kind: 'smokeTest',
  modelId: 'qwen3-1-7b-q4-k-m',
  verdict: 'pass',
  tokensPerSecond: 12.4,
});

function only001(): typeof MIGRATIONS {
  return MIGRATIONS.filter((migration) => migration.id === '001_init');
}

function insertModel(db: Db, id: string, status: string, error: string | null): void {
  db.prepare(
    `INSERT INTO models (id, repo, filename, status, downloaded_bytes, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, 'owner/repo', 'model.gguf', status, error, NOW, NOW);
}

describe('002_model_diagnostics', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds both columns without dropping anything', () => {
    migrate(db);

    const columns = db
      .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
      .all('models')
      .map((row) => row.name);

    expect(columns).toContain('smoke_test');
    expect(columns).toContain('verified_sha256');
    // Nothing 001 created went away.
    expect(columns).toContain('error');
    expect(columns).toContain('sha256');
  });

  it('moves an overloaded smoke-test payload out of models.error', () => {
    migrate(db, only001());
    insertModel(db, 'tested', 'ready', SMOKE_PAYLOAD);
    insertModel(db, 'failed', 'error', 'Checksum mismatch, the file was deleted.');
    insertModel(db, 'clean', 'available', null);

    migrate(db);

    const rows = db
      .prepare<[], { id: string; error: string | null; smoke_test: string | null }>(
        'SELECT id, error, smoke_test FROM models ORDER BY id',
      )
      .all();
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('tested')?.smoke_test).toBe(SMOKE_PAYLOAD);
    expect(byId.get('tested')?.error).toBeNull();

    // A real download error is not a smoke test and stays exactly where it is.
    expect(byId.get('failed')?.error).toBe('Checksum mismatch, the file was deleted.');
    expect(byId.get('failed')?.smoke_test).toBeNull();

    expect(byId.get('clean')?.error).toBeNull();
    expect(byId.get('clean')?.smoke_test).toBeNull();
  });

  it('leaves every pre-existing row unverified, including ready ones', () => {
    migrate(db, only001());
    insertModel(db, 'ready-row', 'ready', null);
    db.prepare('UPDATE models SET sha256 = ? WHERE id = ?').run('a'.repeat(64), 'ready-row');

    migrate(db);

    // A stored `sha256` is what the file *should* hash to, not proof that it
    // ever did — the old code could promote on size alone.
    expect(
      db
        .prepare<[string], { verified_sha256: string | null }>(
          'SELECT verified_sha256 FROM models WHERE id = ?',
        )
        .get('ready-row')?.verified_sha256,
    ).toBeNull();
  });

  it('runs exactly once, however often migrate is called', () => {
    migrate(db);
    insertModel(db, 'kept', 'ready', null);
    db.prepare('UPDATE models SET smoke_test = ? WHERE id = ?').run(SMOKE_PAYLOAD, 'kept');

    const second = migrate(db);
    const third = migrate(db);

    expect(second.applied).toEqual([]);
    expect(third.applied).toEqual([]);
    expect(appliedMigrations(db)).toEqual(['001_init', '002_model_diagnostics']);
    // Data written after the migration survives re-running it.
    expect(
      db
        .prepare<[string], { smoke_test: string | null }>('SELECT smoke_test FROM models WHERE id = ?')
        .get('kept')?.smoke_test,
    ).toBe(SMOKE_PAYLOAD);
  });
});
