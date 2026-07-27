import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { UnsafeModelPathError } from '../catalog';
import { ModelDownloader, type DownloadProgress, type FetchLike } from '../downloader';
import { getModel, PART_SUFFIX, upsertModel } from '../store';

/**
 * These tests never touch the network: `fetch` is a stub that hands back a
 * ReadableStream built from in-memory buffers. They do touch a real temp
 * directory, because the resume and rename behaviour is the thing under test.
 */

const REPO = 'test-owner/test-repo';
const FILENAME = 'test-model.gguf';
const MODEL_ID = 'test-owner-test-repo-test-model';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function streamOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(new Uint8Array(chunk));
    },
  });
}

interface StubResponseInit {
  readonly status?: number;
  readonly chunks: Buffer[];
  readonly headers?: Record<string, string>;
  readonly url?: string;
}

function stubResponse(init: StubResponseInit): Response {
  const status = init.status ?? 200;
  const total = init.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const headers = new Headers({ 'content-length': String(total), ...init.headers });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    url: init.url ?? 'https://huggingface.co/test-owner/test-repo/resolve/main/test-model.gguf',
    headers,
    body: streamOf(init.chunks),
  } as unknown as Response;
}

describe('ModelDownloader', () => {
  let db: Db;
  let root: string;
  let events: DownloadProgress[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    root = mkdtempSync(path.join(tmpdir(), 'invoiceapp-models-'));
    events = [];
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function build(options: {
    fetch: FetchLike;
    now?: () => number;
    freeDiskBytes?: (dir: string) => Promise<number | null>;
    throttleMs?: number;
  }): ModelDownloader {
    return new ModelDownloader({
      db: () => db,
      modelsRoot: () => root,
      fetch: options.fetch,
      emit: (progress) => events.push(progress),
      now: options.now,
      freeDiskBytes: options.freeDiskBytes ?? (async () => 1_000_000_000),
      throttleMs: options.throttleMs ?? 0,
    });
  }

  function finalPath(): string {
    return path.join(root, MODEL_ID, FILENAME);
  }

  it('downloads to a .part file and renames it into place', async () => {
    const payload = Buffer.from('the weights, such as they are');
    const downloader = build({ fetch: async () => stubResponse({ chunks: [payload] }) });

    const { modelId, completion } = downloader.start({ repo: REPO, filename: FILENAME });
    const outcome = await completion;

    expect(modelId).toBe(MODEL_ID);
    expect(outcome.status).toBe('ready');
    expect(readFileSync(finalPath())).toEqual(payload);
    expect(existsSync(`${finalPath()}${PART_SUFFIX}`)).toBe(false);

    const record = getModel(db, MODEL_ID);
    expect(record?.status).toBe('ready');
    expect(record?.downloadedBytes).toBe(payload.byteLength);
    expect(record?.localPath).toBe(finalPath());
    expect(events.at(-1)?.status).toBe('ready');
  });

  it('resumes with a Range header and appends rather than truncating', async () => {
    const head = Buffer.from('AAAAAAAAAA');
    const tail = Buffer.from('BBBBBBBBBB');

    mkdirSync(path.join(root, MODEL_ID), { recursive: true });
    writeFileSync(`${finalPath()}${PART_SUFFIX}`, head);

    const seen: Record<string, string>[] = [];
    const downloader = build({
      fetch: async (_url, init) => {
        seen.push({ ...(init.headers as Record<string, string>) });
        return stubResponse({
          status: 206,
          chunks: [tail],
          headers: { 'content-range': `bytes 10-19/20` },
        });
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(seen[0]?.Range).toBe('bytes=10-');
    expect(outcome.status).toBe('ready');
    expect(outcome.resumed).toBe(true);
    // Appended, not truncated: both halves survive in order.
    expect(readFileSync(finalPath()).toString()).toBe('AAAAAAAAAABBBBBBBBBB');
  });

  it('starts over when the server ignores Range and replies 200', async () => {
    mkdirSync(path.join(root, MODEL_ID), { recursive: true });
    writeFileSync(`${finalPath()}${PART_SUFFIX}`, Buffer.from('STALEBYTES'));

    const whole = Buffer.from('the whole file');
    const downloader = build({ fetch: async () => stubResponse({ status: 200, chunks: [whole] }) });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.resumed).toBe(false);
    expect(readFileSync(finalPath())).toEqual(whole);
  });

  it('leaves a resumable .part behind when cancelled, and no final file', async () => {
    const chunks = [Buffer.from('0123456789'), Buffer.from('abcdefghij'), Buffer.from('never sent')];
    let cancelNow: (() => void) | null = null;

    const downloader = build({
      fetch: async (_url, init) => {
        const signal = init.signal;
        let index = 0;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (signal?.aborted || index >= 2) {
              controller.close();
              return;
            }
            const chunk = chunks[index];
            index += 1;
            if (chunk) controller.enqueue(new Uint8Array(chunk));
            // Cancel once the first chunk has been handed over.
            if (index === 1) cancelNow?.();
          },
        });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://huggingface.co/x/y/resolve/main/test-model.gguf',
          headers: new Headers({ 'content-length': '30' }),
          body: stream,
        } as unknown as Response;
      },
    });

    const started = downloader.start({ repo: REPO, filename: FILENAME });
    cancelNow = () => downloader.cancel(started.modelId);
    const outcome = await started.completion;

    expect(outcome.status).toBe('cancelled');
    expect(existsSync(finalPath())).toBe(false);

    const partPath = `${finalPath()}${PART_SUFFIX}`;
    expect(existsSync(partPath)).toBe(true);
    const partBytes = readFileSync(partPath).byteLength;
    expect(partBytes).toBeGreaterThan(0);

    const record = getModel(db, MODEL_ID);
    // `available` with the byte count retained is what makes the retry resumable.
    expect(record?.status).toBe('available');
    expect(record?.downloadedBytes).toBe(partBytes);
    expect(events.at(-1)?.status).toBe('cancelled');
  });

  it('deletes the file and errors when the SHA-256 does not match', async () => {
    const payload = Buffer.from('corrupted content');
    upsertModel(db, {
      id: MODEL_ID,
      repo: REPO,
      filename: FILENAME,
      sha256: sha256(Buffer.from('the content we expected')),
    });

    // Point the downloader at a catalog-like entry by seeding the row's sha and
    // using a catalog entry: the real check reads the catalog, so use one.
    const downloader = build({ fetch: async () => stubResponse({ chunks: [payload] }) });
    const catalogRepo = 'Qwen/Qwen3-0.6B-GGUF';
    const catalogFile = 'Qwen3-0.6B-Q8_0.gguf';

    const outcome = await downloader.start({ repo: catalogRepo, filename: catalogFile }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Checksum mismatch');
    expect(existsSync(path.join(root, 'qwen3-0-6b-q8-0', catalogFile))).toBe(false);

    const record = getModel(db, 'qwen3-0-6b-q8-0');
    expect(record?.status).toBe('error');
    expect(record?.error).toContain('Checksum mismatch');
    expect(events.at(-1)?.status).toBe('error');
  });

  it('refuses to start when there is not enough free disk space', async () => {
    const downloader = build({
      fetch: async () => {
        throw new Error('fetch should never be called');
      },
      freeDiskBytes: async () => 1024,
    });

    const outcome = await downloader.start({
      repo: 'Qwen/Qwen3-0.6B-GGUF',
      filename: 'Qwen3-0.6B-Q8_0.gguf',
    }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Not enough free disk space');
    expect(getModel(db, 'qwen3-0-6b-q8-0')?.status).toBe('error');
  });

  it('throttles progress events instead of emitting one per chunk', async () => {
    const chunks = Array.from({ length: 40 }, (_, index) => Buffer.from(`chunk-${index}-`));
    let clock = 0;
    // 10ms of simulated time per chunk against a 250ms throttle: 40 chunks span
    // 400ms, so at most a couple of interim events may escape.
    const now = (): number => {
      clock += 10;
      return clock;
    };

    const downloader = build({
      fetch: async () => stubResponse({ chunks }),
      now,
      throttleMs: 250,
    });

    await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    const interim = events.filter((event) => event.status === 'downloading');
    expect(interim.length).toBeLessThanOrEqual(4);
    expect(events.at(-1)?.status).toBe('ready');
  });

  it('reports a transfer rate and an ETA while downloading', async () => {
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(1000, 1));
    let clock = 0;
    const downloader = build({
      fetch: async () => stubResponse({ chunks }),
      now: () => {
        clock += 100;
        return clock;
      },
      throttleMs: 100,
    });

    await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    const withRate = events.find((event) => event.status === 'downloading' && event.bytesPerSecond > 0);
    expect(withRate).toBeDefined();
    expect(withRate?.etaSeconds).not.toBeNull();
  });

  it('refuses a path-traversal filename before touching the filesystem', () => {
    const downloader = build({
      fetch: async () => {
        throw new Error('fetch should never be called');
      },
    });

    expect(() => downloader.start({ repo: REPO, filename: '../../evil.gguf' })).toThrow(
      UnsafeModelPathError,
    );
    expect(() => downloader.start({ repo: REPO, filename: '/etc/passwd.gguf' })).toThrow(
      UnsafeModelPathError,
    );
    expect(existsSync(path.join(root, MODEL_ID))).toBe(false);
  });

  it('refuses a second concurrent download of the same model', async () => {
    const gate = vi.fn();
    const downloader = build({
      fetch: async () => {
        gate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        return stubResponse({ chunks: [Buffer.from('bytes')] });
      },
    });

    const first = downloader.start({ repo: REPO, filename: FILENAME });
    expect(() => downloader.start({ repo: REPO, filename: FILENAME })).toThrow(
      /Download already running/,
    );
    await first.completion;
    expect(downloader.isDownloading(MODEL_ID)).toBe(false);
  });

  it('surfaces an HTTP error as a failed download', async () => {
    const downloader = build({
      fetch: async () =>
        ({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          url: 'https://huggingface.co/x/y',
          headers: new Headers(),
          body: null,
        }) as unknown as Response,
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('HTTP 404');
  });
});
