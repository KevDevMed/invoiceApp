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
  created_at: string;
  updated_at: string;
}

function toRecord(row: ModelRow): ModelRecord {
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
export function upsertModel(db: Db, input: UpsertModelInput): ModelRecord {
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

export function getModel(db: Db, id: string): ModelRecord | null {
  const row = db.prepare<[string], ModelRow>('SELECT * FROM models WHERE id = ?').get(id);
  return row ? toRecord(row) : null;
}

export function requireModel(db: Db, id: string): ModelRecord {
  const record = getModel(db, id);
  if (!record) throw new Error(`No such model: ${id}`);
  return record;
}

export function listModels(db: Db): ModelRecord[] {
  return db
    .prepare<[], ModelRow>('SELECT * FROM models ORDER BY created_at ASC, id ASC')
    .all()
    .map(toRecord);
}

export function markDownloading(db: Db, id: string, downloadedBytes: number): ModelRecord {
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

export function markReady(db: Db, id: string, localPath: string, sizeBytes: number): ModelRecord {
  db.prepare(
    `UPDATE models
        SET status = 'ready', local_path = ?, size_bytes = ?, downloaded_bytes = ?, error = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(localPath, sizeBytes, sizeBytes, nowIso(), id);
  return requireModel(db, id);
}

export function markError(db: Db, id: string, message: string): ModelRecord {
  db.prepare(
    `UPDATE models SET status = 'error', local_path = NULL, error = ?, updated_at = ? WHERE id = ?`,
  ).run(message.slice(0, 4000), nowIso(), id);
  return requireModel(db, id);
}

/**
 * A cancelled or interrupted download is `available`, not `error`: nothing went
 * wrong, and the retained byte count is what makes the next attempt resumable.
 */
export function markInterrupted(db: Db, id: string, downloadedBytes: number): ModelRecord {
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
}

/**
 * Settle every row against what is actually on disk.
 *
 * A row stuck in `downloading` means the app died mid-transfer — no writer
 * exists any more, so the row is a lie until we fix it. A `ready` row whose
 * file has been deleted behind our back is equally a lie.
 */
export function reconcileOnBoot(db: Db, probe: DiskProbe): ReconcileResult {
  const promotedToReady: string[] = [];
  const resetToAvailable: string[] = [];

  for (const record of listModels(db)) {
    if (record.status !== 'downloading' && record.status !== 'ready') continue;

    const { finalPath, finalBytes, partBytes } = probe(record);

    if (finalPath !== null && finalBytes !== null && (record.sizeBytes === null || finalBytes === record.sizeBytes)) {
      if (record.status !== 'ready' || record.downloadedBytes !== finalBytes || record.localPath !== finalPath) {
        markReady(db, record.id, finalPath, finalBytes);
        if (record.status !== 'ready') promotedToReady.push(record.id);
      }
      continue;
    }

    // Either there is no final file, or it is the wrong size — in both cases the
    // resumable `.part` (if any) is what we carry forward.
    markInterrupted(db, record.id, partBytes ?? 0);
    resetToAvailable.push(record.id);
  }

  return { promotedToReady, resetToAvailable };
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
