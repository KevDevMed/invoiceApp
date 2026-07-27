import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type Db } from '../../../db/client';
import { migrate } from '../../../db/migrate';
import { deriveModelId, UnsafeModelPathError } from '../catalog';
import { ModelDownloader, type DownloadProgress, type FetchLike } from '../downloader';
import { getModel, PART_SUFFIX, upsertModel } from '../store';

/**
 * These tests never touch the network: `fetch` is a stub that hands back a
 * ReadableStream built from in-memory buffers. They do touch a real temp
 * directory, because the resume and rename behaviour is the thing under test.
 */

const REPO = 'test-owner/test-repo';
const FILENAME = 'test-model.gguf';
// Derived, not hand-written: ids now carry a hash of the exact repo/file pair.
const MODEL_ID = deriveModelId(REPO, FILENAME);

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
  /** The digest a non-catalog download resolves to. Null means "none published". */
  let publishedDigest: string | null;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    root = mkdtempSync(path.join(tmpdir(), 'invoiceapp-models-'));
    events = [];
    publishedDigest = null;
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
    resolveDigest?: (repo: string, filename: string) => Promise<string | null>;
    maxConcurrentDownloads?: number;
  }): ModelDownloader {
    return new ModelDownloader({
      db: () => db,
      modelsRoot: () => root,
      fetch: options.fetch,
      emit: (progress) => events.push(progress),
      now: options.now,
      freeDiskBytes: options.freeDiskBytes ?? (async () => 1_000_000_000),
      throttleMs: options.throttleMs ?? 0,
      // Stands in for the Hub blob API. The tests never reach the network.
      resolveDigest: options.resolveDigest ?? (async () => publishedDigest),
      maxConcurrentDownloads: options.maxConcurrentDownloads,
    });
  }

  function finalPath(): string {
    return path.join(root, MODEL_ID, FILENAME);
  }

  it('downloads to a .part file and renames it into place', async () => {
    const payload = Buffer.from('the weights, such as they are');
    publishedDigest = sha256(payload);
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
    // The digest is persisted, so a later boot can tell verified bytes apart.
    expect(record?.verifiedSha256).toBe(publishedDigest);
    expect(events.at(-1)?.status).toBe('ready');
  });

  it('resumes with a Range header and appends rather than truncating', async () => {
    const head = Buffer.from('AAAAAAAAAA');
    const tail = Buffer.from('BBBBBBBBBB');
    publishedDigest = sha256(Buffer.concat([head, tail]));

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
    publishedDigest = sha256(whole);
    const downloader = build({ fetch: async () => stubResponse({ status: 200, chunks: [whole] }) });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.resumed).toBe(false);
    expect(readFileSync(finalPath())).toEqual(whole);
  });

  it('leaves a resumable .part behind when cancelled, and no final file', async () => {
    const chunks = [Buffer.from('0123456789'), Buffer.from('abcdefghij'), Buffer.from('never sent')];
    publishedDigest = sha256(Buffer.concat(chunks));
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
    // Neither name survives: the mismatch is caught while the file is a `.part`,
    // so the final name never exists at any point.
    expect(existsSync(path.join(root, 'qwen3-0-6b-q8-0', catalogFile))).toBe(false);
    expect(existsSync(path.join(root, 'qwen3-0-6b-q8-0', `${catalogFile}${PART_SUFFIX}`))).toBe(false);

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
    publishedDigest = sha256(Buffer.concat(chunks));
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
    publishedDigest = sha256(Buffer.concat(chunks));
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
    publishedDigest = sha256(Buffer.from('bytes'));
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


  // -------------------------------------------------------------------------
  // Integrity: nothing is fetched, and nothing is promoted, without a digest
  // -------------------------------------------------------------------------

  it('refuses a non-catalog download when no digest can be obtained', async () => {
    publishedDigest = null;
    const fetched = vi.fn();
    const downloader = build({
      fetch: async (url) => {
        fetched(url);
        return stubResponse({ chunks: [Buffer.from('unverifiable weights')] });
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('No SHA-256 is published');
    // Refused before a single byte was requested.
    expect(fetched).not.toHaveBeenCalled();
    expect(existsSync(finalPath())).toBe(false);

    const record = getModel(db, MODEL_ID);
    expect(record?.status).toBe('error');
    expect(record?.verifiedSha256).toBeNull();
  });

  it('refuses the download when the digest lookup itself fails', async () => {
    const downloader = build({
      fetch: async () => {
        throw new Error('fetch should never be called');
      },
      resolveDigest: async () => {
        throw new Error('Hugging Face returned HTTP 500');
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Could not obtain a SHA-256');
    expect(getModel(db, MODEL_ID)?.status).toBe('error');
  });

  it('catches a checksum mismatch while the file is still a .part', async () => {
    publishedDigest = sha256(Buffer.from('what we asked for'));
    const downloader = build({
      fetch: async () => stubResponse({ chunks: [Buffer.from('what we actually got')] }),
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Checksum mismatch');
    // The final name never existed, so no crash window can leave one behind.
    expect(existsSync(finalPath())).toBe(false);
    expect(existsSync(`${finalPath()}${PART_SUFFIX}`)).toBe(false);

    const record = getModel(db, MODEL_ID);
    expect(record?.status).toBe('error');
    expect(record?.verifiedSha256).toBeNull();
  });

  it('verifies an existing final file in place rather than downloading it again', async () => {
    const payload = Buffer.from('weights that survived a demotion');
    publishedDigest = sha256(payload);
    mkdirSync(path.join(root, MODEL_ID), { recursive: true });
    writeFileSync(finalPath(), payload);

    const fetched = vi.fn();
    const downloader = build({
      fetch: async (url) => {
        fetched(url);
        return stubResponse({ chunks: [payload] });
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('ready');
    expect(fetched).not.toHaveBeenCalled();
    expect(getModel(db, MODEL_ID)?.verifiedSha256).toBe(publishedDigest);
  });

  // -------------------------------------------------------------------------
  // Transport: https on every hop
  // -------------------------------------------------------------------------

  it('rejects an http hop before issuing a single plaintext request', async () => {
    publishedDigest = sha256(Buffer.from('never delivered'));
    const requested: string[] = [];

    const downloader = build({
      fetch: async (url) => {
        requested.push(url);
        if (url.startsWith('https://huggingface.co/')) {
          return {
            ok: false,
            status: 302,
            statusText: 'Found',
            url,
            headers: new Headers({ location: 'http://cdn.example.test/weights.gguf' }),
            body: null,
          } as unknown as Response;
        }
        return stubResponse({ chunks: [Buffer.from('never delivered')], url });
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('Refusing non-https download URL');
    // The only request that ever went out is the https one we started with.
    expect(requested).toHaveLength(1);
    expect(requested[0]?.startsWith('https://')).toBe(true);
    expect(requested.some((url) => url.startsWith('http://'))).toBe(false);
  });

  it('follows an https redirect chain and refuses to loop forever', async () => {
    const payload = Buffer.from('redirected weights');
    publishedDigest = sha256(payload);
    const requested: string[] = [];

    const downloader = build({
      fetch: async (url) => {
        requested.push(url);
        if (url.startsWith('https://huggingface.co/')) {
          return {
            ok: false,
            status: 302,
            statusText: 'Found',
            url,
            headers: new Headers({ location: 'https://cdn.example.test/weights.gguf' }),
            body: null,
          } as unknown as Response;
        }
        return stubResponse({ chunks: [payload], url });
      },
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;

    expect(outcome.status).toBe('ready');
    expect(requested).toHaveLength(2);
    expect(requested[1]).toBe('https://cdn.example.test/weights.gguf');
  });

  it('gives up on a redirect loop', async () => {
    publishedDigest = sha256(Buffer.from('nothing'));
    const downloader = build({
      fetch: async (url) =>
        ({
          ok: false,
          status: 307,
          statusText: 'Temporary Redirect',
          url,
          headers: new Headers({ location: 'https://cdn.example.test/a.gguf' }),
          body: null,
        }) as unknown as Response,
    });

    const outcome = await downloader.start({ repo: REPO, filename: FILENAME }).completion;
    expect(outcome.status).toBe('error');
    expect(outcome.error).toMatch(/Redirect loop|Gave up after/);
  });

  // -------------------------------------------------------------------------
  // Concurrency and disk space
  // -------------------------------------------------------------------------

  it('runs two downloads at a time and queues the third', async () => {
    const payload = Buffer.from('shared payload');
    publishedDigest = sha256(payload);

    const release: Array<() => void> = [];
    const downloader = build({
      fetch: async () => {
        await new Promise<void>((resolve) => release.push(resolve));
        return stubResponse({ chunks: [payload] });
      },
      maxConcurrentDownloads: 2,
    });

    const started = [
      downloader.start({ repo: 'owner/one', filename: 'one.gguf' }),
      downloader.start({ repo: 'owner/two', filename: 'two.gguf' }),
      downloader.start({ repo: 'owner/three', filename: 'three.gguf' }),
    ];

    // Let the two slots fill.
    await vi.waitFor(() => {
      expect(release).toHaveLength(2);
    });
    expect(downloader.runningCount()).toBe(2);
    expect(downloader.queuedCount()).toBe(1);

    release.forEach((resolve) => resolve());
    await vi.waitFor(() => {
      expect(release).toHaveLength(3);
    });
    release.forEach((resolve) => resolve());

    const outcomes = await Promise.all(started.map((start) => start.completion));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['ready', 'ready', 'ready']);
    expect(downloader.runningCount()).toBe(0);
    expect(downloader.queuedCount()).toBe(0);
  });

  it('counts the bytes other in-flight downloads have committed when checking free space', async () => {
    // Two catalog models: 639 MB and 1.10 GB, against 1.2 GB of free space.
    // Each fits on its own; together they do not.
    const first = { repo: 'Qwen/Qwen3-0.6B-GGUF', filename: 'Qwen3-0.6B-Q8_0.gguf' };
    const second = { repo: 'unsloth/Qwen3-1.7B-GGUF', filename: 'Qwen3-1.7B-Q4_K_M.gguf' };

    const release: Array<() => void> = [];
    const downloader = build({
      fetch: async () => {
        await new Promise<void>((resolve) => release.push(resolve));
        return stubResponse({ chunks: [Buffer.from('x')] });
      },
      freeDiskBytes: async () => 1_200_000_000,
    });

    const firstStart = downloader.start(first);
    await vi.waitFor(() => {
      expect(release).toHaveLength(1);
    });

    const secondOutcome = await downloader.start(second).completion;

    expect(secondOutcome.status).toBe('error');
    expect(secondOutcome.error).toContain('Not enough free disk space');
    expect(secondOutcome.error).toContain('already committed by other downloads');

    release.forEach((resolve) => resolve());
    await firstStart.completion;
  });

  it('surfaces an HTTP error as a failed download', async () => {
    publishedDigest = sha256(Buffer.from('anything'));
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
