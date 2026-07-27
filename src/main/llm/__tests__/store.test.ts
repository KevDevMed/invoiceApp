import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { UnsafeModelPathError } from '../catalog';
import {
  appendMessage,
  createThread,
  deleteModelRow,
  deleteThread,
  getModel,
  listMessages,
  listModels,
  listThreads,
  markDownloading,
  markError,
  markInterrupted,
  markReady,
  recordProgress,
  reconcileOnBoot,
  totalDiskUsageBytes,
  updateThread,
  upsertModel,
  type DiskProbe,
} from '../store';

const MODEL = {
  id: 'qwen3-1-7b-q4-k-m',
  repo: 'unsloth/Qwen3-1.7B-GGUF',
  filename: 'Qwen3-1.7B-Q4_K_M.gguf',
  sizeBytes: 1_107_409_472,
  sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
};

describe('models table', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a row on first upsert and updates metadata afterwards', () => {
    const created = upsertModel(db, MODEL);
    expect(created.status).toBe('available');
    expect(created.downloadedBytes).toBe(0);
    expect(created.localPath).toBeNull();

    const updated = upsertModel(db, { ...MODEL, quant: 'Q4_K_M', status: 'downloading' });
    expect(updated.quant).toBe('Q4_K_M');
    expect(updated.status).toBe('downloading');
    expect(listModels(db)).toHaveLength(1);
  });

  it('never downgrades a ready row back to downloading', () => {
    upsertModel(db, MODEL);
    markReady(db, MODEL.id, '/models/x.gguf', MODEL.sizeBytes);

    const again = upsertModel(db, { ...MODEL, status: 'downloading' });
    expect(again.status).toBe('ready');
  });

  it('walks the full download state machine', () => {
    upsertModel(db, MODEL);

    expect(markDownloading(db, MODEL.id, 0).status).toBe('downloading');

    recordProgress(db, MODEL.id, 4096);
    expect(getModel(db, MODEL.id)?.downloadedBytes).toBe(4096);

    const ready = markReady(db, MODEL.id, '/models/qwen/model.gguf', MODEL.sizeBytes);
    expect(ready.status).toBe('ready');
    expect(ready.localPath).toBe('/models/qwen/model.gguf');
    expect(ready.downloadedBytes).toBe(MODEL.sizeBytes);
    expect(ready.error).toBeNull();

    const failed = markError(db, MODEL.id, 'Checksum mismatch');
    expect(failed.status).toBe('error');
    expect(failed.localPath).toBeNull();
    expect(failed.error).toBe('Checksum mismatch');

    const interrupted = markInterrupted(db, MODEL.id, 512);
    expect(interrupted.status).toBe('available');
    expect(interrupted.downloadedBytes).toBe(512);
    expect(interrupted.error).toBeNull();
  });

  it('truncates an oversized error message to the column contract', () => {
    upsertModel(db, MODEL);
    const failed = markError(db, MODEL.id, 'x'.repeat(9000));
    expect(failed.error).toHaveLength(4000);
  });

  it('refuses to store a row whose id or filename fails the allow-list', () => {
    expect(() => upsertModel(db, { ...MODEL, id: '../escape' })).toThrow(UnsafeModelPathError);
    expect(() => upsertModel(db, { ...MODEL, filename: '../escape.gguf' })).toThrow(
      UnsafeModelPathError,
    );
    expect(listModels(db)).toHaveLength(0);
  });

  it('sums disk usage across ready and partial models', () => {
    upsertModel(db, MODEL);
    markReady(db, MODEL.id, '/models/a.gguf', 1000);

    upsertModel(db, { ...MODEL, id: 'qwen3-0-6b-q8-0', filename: 'Qwen3-0.6B-Q8_0.gguf' });
    markInterrupted(db, 'qwen3-0-6b-q8-0', 250);

    expect(totalDiskUsageBytes(db)).toBe(1250);
  });

  it('deletes a row', () => {
    upsertModel(db, MODEL);
    expect(deleteModelRow(db, MODEL.id)).toBe(true);
    expect(deleteModelRow(db, MODEL.id)).toBe(false);
    expect(getModel(db, MODEL.id)).toBeNull();
  });
});

describe('reconcileOnBoot', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  const probeWith =
    (result: { finalPath?: string | null; finalBytes?: number | null; partBytes?: number | null }): DiskProbe =>
    () => ({
      finalPath: result.finalPath ?? '/models/model.gguf',
      finalBytes: result.finalBytes ?? null,
      partBytes: result.partBytes ?? null,
    });

  it('demotes a stale downloading row to available, keeping the .part byte count', () => {
    upsertModel(db, MODEL);
    markDownloading(db, MODEL.id, 900_000);

    const result = reconcileOnBoot(db, probeWith({ partBytes: 812_345 }));

    expect(result.resetToAvailable).toEqual([MODEL.id]);
    const record = getModel(db, MODEL.id);
    expect(record?.status).toBe('available');
    expect(record?.downloadedBytes).toBe(812_345);
  });

  it('zeroes a stale downloading row when nothing at all is on disk', () => {
    upsertModel(db, MODEL);
    markDownloading(db, MODEL.id, 900_000);

    reconcileOnBoot(db, probeWith({}));

    const record = getModel(db, MODEL.id);
    expect(record?.status).toBe('available');
    expect(record?.downloadedBytes).toBe(0);
  });

  it('promotes a downloading row whose file actually finished before the crash', () => {
    upsertModel(db, MODEL);
    markDownloading(db, MODEL.id, MODEL.sizeBytes - 1);

    const result = reconcileOnBoot(
      db,
      probeWith({ finalPath: '/models/qwen/model.gguf', finalBytes: MODEL.sizeBytes }),
    );

    expect(result.promotedToReady).toEqual([MODEL.id]);
    const record = getModel(db, MODEL.id);
    expect(record?.status).toBe('ready');
    expect(record?.localPath).toBe('/models/qwen/model.gguf');
    expect(record?.downloadedBytes).toBe(MODEL.sizeBytes);
  });

  it('demotes a ready row whose weights were deleted behind our back', () => {
    upsertModel(db, MODEL);
    markReady(db, MODEL.id, '/models/qwen/model.gguf', MODEL.sizeBytes);

    reconcileOnBoot(db, probeWith({}));

    const record = getModel(db, MODEL.id);
    expect(record?.status).toBe('available');
    expect(record?.localPath).toBeNull();
  });

  it('demotes a ready row whose file is the wrong size', () => {
    upsertModel(db, MODEL);
    markReady(db, MODEL.id, '/models/qwen/model.gguf', MODEL.sizeBytes);

    reconcileOnBoot(db, probeWith({ finalBytes: 12 }));

    expect(getModel(db, MODEL.id)?.status).toBe('available');
  });

  it('leaves error and available rows alone', () => {
    upsertModel(db, MODEL);
    markError(db, MODEL.id, 'boom');

    const result = reconcileOnBoot(db, probeWith({ finalBytes: MODEL.sizeBytes }));

    expect(result).toEqual({ promotedToReady: [], resetToAvailable: [] });
    expect(getModel(db, MODEL.id)?.status).toBe('error');
  });
});

describe('chat persistence', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores threads and messages, including the tool-call history', () => {
    const thread = createThread(db, { title: 'Overdue invoices', modelId: MODEL.id });
    expect(listThreads(db)).toHaveLength(1);

    appendMessage(db, { threadId: thread.id, role: 'user', content: 'What is overdue?' });
    appendMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      content: 'Checking.',
      toolCalls: [{ id: 'call-1', name: 'list_invoices', status: 'executed' }],
    });

    const messages = listMessages(db, thread.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.toolCalls).toBeNull();
    expect(JSON.parse(messages[1]?.toolCalls ?? '[]')).toEqual([
      { id: 'call-1', name: 'list_invoices', status: 'executed' },
    ]);
  });

  it('updates a thread and cascades the delete to its messages', () => {
    const thread = createThread(db);
    appendMessage(db, { threadId: thread.id, role: 'user', content: 'hello' });

    const renamed = updateThread(db, thread.id, { title: 'Renamed' });
    expect(renamed.title).toBe('Renamed');

    expect(deleteThread(db, thread.id)).toBe(true);
    expect(listMessages(db, thread.id)).toHaveLength(0);
  });
});
