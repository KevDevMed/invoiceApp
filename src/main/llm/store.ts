/**
 * Persistence for the `models` table.
 *
 * The table is the single source of truth for "what does this machine have".
 * The filesystem is the second source of truth, and the two disagree whenever
 * the app is killed mid-download — `reconcileOnBoot` is what settles that
 * argument, every boot, before the renderer is allowed to ask.
 *
 * Every function takes an explicit `Db`. Nothing here reaches for the process
 * singleton, so the whole module is testable against `:memory:`.
 */

import { statSync } from 'node:fs';

import { randomUUID } from 'node:crypto';

import type { Db } from '../../db/client';
import type { ChatMessage, ChatRole, ChatThread, ModelRecord, ModelStatus } from '../../shared/types';
import { assertSafeModelFilename, assertSafeModelId, resolveModelPath } from './catalog';

export const PART_SUFFIX = '.part';

interface ModelRow {
  id: string;
  repo: string;
  filename: string;
  quant: string | null;
  size_bytes: number | null;
  sha256: string | null;
  local_path: string | null;
  status: string;
  downloaded_bytes: number;
  error: string | null;
  smoke_test: string | null;
  verified_sha256: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A model row with the two columns migration 002 added.
 *
 * `ModelRecord` lives in the frozen contract and cannot grow fields, so the
 * extra ones ride alongside it. Responses are not re-validated on the way out,
 * so both reach the renderer; anything typed as `ModelRecord` simply ignores
 * them.
 */
export interface StoredModel extends ModelRecord {
  /** JSON-encoded smoke-test record, or null when the model was never tested. */
  readonly smokeTest: string | null;
  /**
   * The digest this machine computed over the bytes on disk, after they matched
   * the expected one. Null means these bytes were never verified.
   */
  readonly verifiedSha256: string | null;
}

function toRecord(row: ModelRow): StoredModel {
  return {
    id: row.id,
    repo: row.repo,
    filename: row.filename,
    quant: row.quant,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    localPath: row.local_path,
    status: row.status as ModelStatus,
    downloadedBytes: row.downloaded_bytes,
    error: row.error,
    smokeTest: row.smoke_test,
    verifiedSha256: row.verified_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface UpsertModelInput {
  readonly id: string;
  readonly repo: string;
  readonly filename: string;
  readonly quant?: string | null;
  readonly sizeBytes?: number | null;
  readonly sha256?: string | null;
  readonly status?: ModelStatus;
}

/**
 * Create the row for a model if it is not there yet, otherwise refresh the
 * metadata we know about it. Never downgrades a `ready` row: a model already on
 * disk stays ready even if the renderer asks for it again.
 */
export function upsertModel(db: Db, input: UpsertModelInput): StoredModel {
  assertSafeModelId(input.id);
  assertSafeModelFilename(input.filename);

  const timestamp = nowIso();
  const existing = getModel(db, input.id);

  if (!existing) {
    db.prepare(
      `INSERT INTO models
         (id, repo, filename, quant, size_bytes, sha256, local_path, status,
          downloaded_bytes, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)`,
    ).run(
      input.id,
      input.repo,
      input.filename,
      input.quant ?? null,
      input.sizeBytes ?? null,
      input.sha256 ?? null,
      input.status ?? 'available',
      timestamp,
      timestamp,
    );
    return requireModel(db, input.id);
  }

  const nextStatus = existing.status === 'ready' ? 'ready' : (input.status ?? existing.status);
  db.prepare(
    `UPDATE models
        SET repo = ?, filename = ?, quant = ?, size_bytes = ?, sha256 = ?, status = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.repo,
    input.filename,
    input.quant ?? existing.quant,
    input.sizeBytes ?? existing.sizeBytes,
    input.sha256 ?? existing.sha256,
    nextStatus,
    timestamp,
    input.id,
  );
  return requireModel(db, input.id);
}

export function getModel(db: Db, id: string): StoredModel | null {
  const row = db.prepare<[string], ModelRow>('SELECT * FROM models WHERE id = ?').get(id);
  return row ? toRecord(row) : null;
}

export function requireModel(db: Db, id: string): StoredModel {
  const record = getModel(db, id);
  if (!record) throw new Error(`No such model: ${id}`);
  return record;
}

export function listModels(db: Db): StoredModel[] {
  return db
    .prepare<[], ModelRow>('SELECT * FROM models ORDER BY created_at ASC, id ASC')
    .all()
    .map(toRecord);
}

export function markDownloading(db: Db, id: string, downloadedBytes: number): StoredModel {
  db.prepare(
    `UPDATE models
        SET status = 'downloading', downloaded_bytes = ?, error = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(downloadedBytes, nowIso(), id);
  return requireModel(db, id);
}

/**
 * Progress writes are frequent, so this is the one statement that skips the
 * read-back. The caller already knows the byte count it just wrote.
 */
export function recordProgress(db: Db, id: string, downloadedBytes: number): void {
  db.prepare('UPDATE models SET downloaded_bytes = ?, updated_at = ? WHERE id = ?').run(
    downloadedBytes,
    nowIso(),
    id,
  );
}

/**
 * Promote a model to `ready`.
 *
 * `verifiedSha256` is the digest computed over the bytes now sitting at
 * `localPath`, and it is not optional: a `ready` row without one is exactly the
 * state that let an unverified GGUF reach the native parser. The only caller
 * allowed to pass a digest is the one that just hashed the file.
 */
export function markReady(
  db: Db,
  id: string,
  localPath: string,
  sizeBytes: number,
  verifiedSha256: string,
): StoredModel {
  db.prepare(
    `UPDATE models
        SET status = 'ready', local_path = ?, size_bytes = ?, downloaded_bytes = ?,
            error = NULL, verified_sha256 = ?, updated_at = ?
      WHERE id = ?`,
  ).run(localPath, sizeBytes, sizeBytes, verifiedSha256, nowIso(), id);
  return requireModel(db, id);
}

/** Drop a stored smoke-test record. The weights it described are gone or replaced. */
export function clearSmokeTestRecord(db: Db, id: string): void {
  db.prepare('UPDATE models SET smoke_test = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Forget that a model's bytes were ever verified — used when they are replaced. */
export function clearVerification(db: Db, id: string): void {
  db.prepare('UPDATE models SET verified_sha256 = NULL, updated_at = ? WHERE id = ?').run(
    nowIso(),
    id,
  );
}

export function markError(db: Db, id: string, message: string): StoredModel {
  db.prepare(
    `UPDATE models SET status = 'error', local_path = NULL, error = ?, updated_at = ? WHERE id = ?`,
  ).run(message.slice(0, 4000), nowIso(), id);
  return requireModel(db, id);
}

/**
 * A cancelled or interrupted download is `available`, not `error`: nothing went
 * wrong, and the retained byte count is what makes the next attempt resumable.
 */
export function markInterrupted(db: Db, id: string, downloadedBytes: number): StoredModel {
  db.prepare(
    `UPDATE models
        SET status = 'available', local_path = NULL, downloaded_bytes = ?, error = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(downloadedBytes, nowIso(), id);
  return requireModel(db, id);
}

export function deleteModelRow(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM models WHERE id = ?').run(id);
  return result.changes > 0;
}

/** Total bytes of weights this machine is currently holding. */
export function totalDiskUsageBytes(db: Db): number {
  const row = db
    .prepare<[], { total: number | null }>(
      `SELECT SUM(CASE WHEN status = 'ready' THEN COALESCE(size_bytes, downloaded_bytes) ELSE downloaded_bytes END) AS total
         FROM models`,
    )
    .get();
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

export interface DiskProbeResult {
  /** Where the completed weight file would be, or null when the path is unusable. */
  readonly finalPath: string | null;
  /** Size of the completed weight file, or null when it is not there. */
  readonly finalBytes: number | null;
  /** Size of the partial download, or null when there is none. */
  readonly partBytes: number | null;
}

export type DiskProbe = (record: ModelRecord) => DiskProbeResult;

/** The real probe: `stat` the two paths a download can leave behind. */
export function createDiskProbe(modelsRoot: string): DiskProbe {
  return (record) => {
    let finalPath: string;
    try {
      finalPath = resolveModelPath(modelsRoot, record.id, record.filename);
    } catch {
      // A row whose id or filename no longer passes the allow-list is treated as
      // having nothing on disk, which downgrades it to `available` below.
      return { finalPath: null, finalBytes: null, partBytes: null };
    }
    return {
      finalPath,
      finalBytes: sizeOrNull(finalPath),
      partBytes: sizeOrNull(`${finalPath}${PART_SUFFIX}`),
    };
  };
}

function sizeOrNull(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

export interface ReconcileResult {
  readonly promotedToReady: string[];
  readonly resetToAvailable: string[];
  /** Rows demoted purely because their bytes were never checksum-verified. */
  readonly unverified: string[];
}

/**
 * Settle every row against what is actually on disk.
 *
 * A row stuck in `downloading` means the app died mid-transfer — no writer
 * exists any more, so the row is a lie until we fix it. A `ready` row whose
 * file has been deleted behind our back is equally a lie.
 *
 * Size is never enough to promote a row. A file this machine has not hashed
 * against a known digest stays out of `ready`, however plausible its size is:
 * `llm:load` hands `ready` files straight to llama.cpp's C++ GGUF parser, so
 * "the byte count looks right" is not a standard that file gets to meet. The
 * downloader re-verifies such a file in place and promotes it without
 * re-downloading when the hash matches.
 */
export function reconcileOnBoot(db: Db, probe: DiskProbe): ReconcileResult {
  const promotedToReady: string[] = [];
  const resetToAvailable: string[] = [];
  const unverified: string[] = [];

  for (const record of listModels(db)) {
    if (record.status !== 'downloading' && record.status !== 'ready') continue;

    const { finalPath, finalBytes, partBytes } = probe(record);
    const sizeMatches =
      finalPath !== null &&
      finalBytes !== null &&
      (record.sizeBytes === null || finalBytes === record.sizeBytes);

    if (sizeMatches && record.verifiedSha256 !== null && finalPath !== null && finalBytes !== null) {
      if (record.status !== 'ready' || record.downloadedBytes !== finalBytes || record.localPath !== finalPath) {
        markReady(db, record.id, finalPath, finalBytes, record.verifiedSha256);
        if (record.status !== 'ready') promotedToReady.push(record.id);
      }
      continue;
    }

    if (sizeMatches) unverified.push(record.id);

    // No final file, wrong size, or never verified — in every case the resumable
    // `.part` (if any) is what we carry forward, and the row is not `ready`.
    markInterrupted(db, record.id, partBytes ?? 0);
    resetToAvailable.push(record.id);
  }

  return { promotedToReady, resetToAvailable, unverified };
}

// ---------------------------------------------------------------------------
// Chat threads and messages
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  title: string | null;
  model_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

function toThread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ChatRole,
    content: row.content,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
  };
}

export function createThread(db: Db, options: { title?: string | null; modelId?: string | null } = {}): ChatThread {
  const timestamp = nowIso();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO chat_threads (id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, options.title ?? null, options.modelId ?? null, timestamp, timestamp);
  return requireThread(db, id);
}

export function getThread(db: Db, id: string): ChatThread | null {
  const row = db.prepare<[string], ThreadRow>('SELECT * FROM chat_threads WHERE id = ?').get(id);
  return row ? toThread(row) : null;
}

export function requireThread(db: Db, id: string): ChatThread {
  const thread = getThread(db, id);
  if (!thread) throw new Error(`No such chat thread: ${id}`);
  return thread;
}

export function listThreads(db: Db, limit = 100): ChatThread[] {
  return db
    .prepare<[number], ThreadRow>('SELECT * FROM chat_threads ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toThread);
}

export function updateThread(
  db: Db,
  id: string,
  patch: { title?: string | null; modelId?: string | null },
): ChatThread {
  const current = requireThread(db, id);
  db.prepare('UPDATE chat_threads SET title = ?, model_id = ?, updated_at = ? WHERE id = ?').run(
    patch.title === undefined ? current.title : patch.title,
    patch.modelId === undefined ? current.modelId : patch.modelId,
    nowIso(),
    id,
  );
  return requireThread(db, id);
}

export function deleteThread(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id).changes > 0;
}

export interface AppendMessageInput {
  readonly threadId: string;
  readonly role: ChatRole;
  readonly content: string;
  /** JSON-encoded tool-call proposals or results. Kept verbatim. */
  readonly toolCalls?: unknown;
}

export function appendMessage(db: Db, input: AppendMessageInput): ChatMessage {
  const timestamp = nowIso();
  const id = randomUUID();
  const encoded =
    input.toolCalls === undefined || input.toolCalls === null ? null : JSON.stringify(input.toolCalls);

  db.prepare(
    `INSERT INTO chat_messages (id, thread_id, role, content, tool_calls, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.threadId, input.role, input.content, encoded, timestamp);

  db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(timestamp, input.threadId);

  const row = db.prepare<[string], MessageRow>('SELECT * FROM chat_messages WHERE id = ?').get(id);
  if (!row) throw new Error('Failed to read back the message that was just inserted.');
  return toMessage(row);
}

export function listMessages(db: Db, threadId: string): ChatMessage[] {
  return db
    .prepare<[string], MessageRow>(
      'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(threadId)
    .map(toMessage);
}
