/**
 * Resumable, cancellable, verified GGUF downloads.
 *
 * The shape of a download on disk is always one of three things:
 *   `<models>/<id>/<file>.part`  — an interrupted transfer, safe to resume
 *   `<models>/<id>/<file>`       — a complete, SHA-verified file
 *   nothing                      — never started, or deleted
 *
 * There is deliberately no fourth state. The final filename only ever appears
 * via `rename()` of a fully verified `.part`, so a torn write can leave a
 * partial file but never a partial *model*.
 *
 * Every filesystem effect is injectable so the tests can drive the whole thing
 * with a fake `fetch` and a temp directory, and never touch the network.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { Db } from '../../db/client';
import {
  assertHttpsUrl,
  catalogEntryUrl,
  deriveModelId,
  downloadUrl,
  findCatalogEntry,
  findCatalogEntryByFile,
  resolveModelDir,
  resolveModelPath,
  type CatalogEntry,
} from './catalog';
import {
  markDownloading,
  markError,
  markInterrupted,
  markReady,
  PART_SUFFIX,
  recordProgress,
  upsertModel,
} from './store';

export type DownloadStatus = 'downloading' | 'ready' | 'error' | 'cancelled';

export interface DownloadProgress {
  readonly modelId: string;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  /** Smoothed transfer rate. Zero until there are two samples to compare. */
  readonly bytesPerSecond: number;
  /** Null when the total size is unknown or the rate is not yet meaningful. */
  readonly etaSeconds: number | null;
  readonly status: DownloadStatus;
  readonly error: string | null;
}

export interface DownloadOutcome {
  readonly modelId: string;
  readonly status: 'ready' | 'cancelled' | 'error';
  readonly path: string | null;
  readonly bytes: number;
  readonly error: string | null;
  /** True when the transfer picked up from an existing `.part`. */
  readonly resumed: boolean;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INSUFFICIENT_DISK_SPACE'
      | 'CHECKSUM_MISMATCH'
      | 'HTTP_ERROR'
      | 'UNSAFE_PATH'
      | 'ALREADY_RUNNING',
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DownloaderDeps {
  readonly db: () => Db;
  readonly modelsRoot: () => string;
  readonly fetch: FetchLike;
  readonly emit: (progress: DownloadProgress) => void;
  readonly now?: () => number;
  /** Free bytes on the volume holding `dir`. Null means "could not tell". */
  readonly freeDiskBytes?: (dir: string) => Promise<number | null>;
  /** Minimum gap between progress emissions. ~4 per second by default. */
  readonly throttleMs?: number;
}

export interface StartDownloadRequest {
  readonly repo: string;
  readonly filename: string;
  readonly quant?: string;
}

export interface StartedDownload {
  readonly modelId: string;
  /** Resolves when the transfer finishes, is cancelled, or fails. Never rejects. */
  readonly completion: Promise<DownloadOutcome>;
}

/** Headroom on top of the remaining bytes, so we do not fill the disk exactly. */
const DISK_SPACE_MARGIN = 1.05;

async function defaultFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

export class ModelDownloader {
  private readonly deps: Required<Pick<DownloaderDeps, 'now' | 'freeDiskBytes' | 'throttleMs'>> &
    DownloaderDeps;

  private readonly active = new Map<string, { controller: AbortController; completion: Promise<DownloadOutcome> }>();

  constructor(deps: DownloaderDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      freeDiskBytes: deps.freeDiskBytes ?? defaultFreeDiskBytes,
      throttleMs: deps.throttleMs ?? 250,
    };
  }

  isDownloading(modelId: string): boolean {
    return this.active.has(modelId);
  }

  activeDownloadIds(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Begin (or resume) a download. Returns as soon as the row is claimed, so the
   * IPC call does not block for the length of a multi-gigabyte transfer.
   */
  start(request: StartDownloadRequest): StartedDownload {
    const modelId = deriveModelId(request.repo, request.filename);
    const existing = this.active.get(modelId);
    if (existing) {
      throw new DownloadError(`Download already running for ${modelId}`, 'ALREADY_RUNNING');
    }

    const entry = findCatalogEntryByFile(request.repo, request.filename);
    const url = entry ? catalogEntryUrl(entry) : downloadUrl(request.repo, request.filename);
    assertHttpsUrl(url);

    // Throws before anything is registered if the id or filename is hostile.
    const target = resolveModelPath(this.deps.modelsRoot(), modelId, request.filename);

    upsertModel(this.deps.db(), {
      id: modelId,
      repo: request.repo,
      filename: request.filename,
      quant: request.quant ?? entry?.quant ?? null,
      sizeBytes: entry?.sizeBytes ?? null,
      sha256: entry?.sha256 ?? null,
      status: 'downloading',
    });

    const controller = new AbortController();
    const completion = this.run(modelId, url, target, entry, controller.signal).finally(() => {
      this.active.delete(modelId);
    });

    this.active.set(modelId, { controller, completion });
    return { modelId, completion };
  }

  /** Abort an in-flight download. The `.part` file is left in place. */
  cancel(modelId: string): boolean {
    const running = this.active.get(modelId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  /** Await an in-flight download without starting one. */
  async wait(modelId: string): Promise<DownloadOutcome | null> {
    const running = this.active.get(modelId);
    return running ? running.completion : null;
  }

  private async run(
    modelId: string,
    url: string,
    target: string,
    entry: CatalogEntry | undefined,
    signal: AbortSignal,
  ): Promise<DownloadOutcome> {
    const db = this.deps.db();
    const partPath = `${target}${PART_SUFFIX}`;
    let received = 0;
    let resumed = false;

    try {
      await fs.mkdir(path.dirname(target), { recursive: true });

      const already = await sizeOrZero(partPath);
      const expectedTotal = entry?.sizeBytes ?? null;

      if (expectedTotal !== null && already >= expectedTotal) {
        // A `.part` that is already the full size means the previous run died
        // between the last write and the rename. Verify and promote it.
        await fs.rename(partPath, target);
        return await this.finish(db, modelId, target, entry, expectedTotal, true);
      }

      await this.assertEnoughDiskSpace(target, (expectedTotal ?? 0) - already);

      const headers: Record<string, string> = {};
      if (already > 0) {
        headers.Range = `bytes=${already}-`;
      }

      const response = await this.deps.fetch(url, { headers, signal, redirect: 'follow' });
      if (response.url) assertHttpsUrl(response.url);

      if (!response.ok) {
        throw new DownloadError(
          `Download failed: HTTP ${response.status} ${response.statusText}`,
          'HTTP_ERROR',
        );
      }

      // 206 means the server honoured Range. Anything else (a 200 in particular)
      // means it is sending the whole file, so the existing bytes are worthless.
      const serverHonouredRange = already > 0 && response.status === 206;
      resumed = serverHonouredRange;
      received = serverHonouredRange ? already : 0;

      const declared = numberOrNull(response.headers.get('content-length'));
      const total = expectedTotal ?? (declared === null ? null : received + declared);

      markDownloading(db, modelId, received);
      this.emitProgress({
        modelId,
        receivedBytes: received,
        totalBytes: total,
        bytesPerSecond: 0,
        etaSeconds: null,
        status: 'downloading',
        error: null,
      }, true);

      const handle = await fs.open(partPath, serverHonouredRange ? 'a' : 'w');
      try {
        received = await this.pump(response, handle, modelId, received, total, signal);
      } finally {
        await handle.close();
      }

      if (signal.aborted) {
        return this.cancelled(db, modelId, received, total);
      }

      await fs.rename(partPath, target);
      return await this.finish(db, modelId, target, entry, received, resumed);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        const bytes = await sizeOrZero(partPath);
        return this.cancelled(db, modelId, bytes, entry?.sizeBytes ?? null);
      }

      const message = error instanceof Error ? error.message : String(error);
      markError(db, modelId, message);
      this.emitProgress(
        {
          modelId,
          receivedBytes: received,
          totalBytes: entry?.sizeBytes ?? null,
          bytesPerSecond: 0,
          etaSeconds: null,
          status: 'error',
          error: message,
        },
        true,
      );
      return { modelId, status: 'error', path: null, bytes: received, error: message, resumed };
    }
  }

  private async pump(
    response: Response,
    handle: FileHandle,
    modelId: string,
    startBytes: number,
    total: number | null,
    signal: AbortSignal,
  ): Promise<number> {
    const body = response.body;
    if (!body) return startBytes;

    const reader = body.getReader();
    let received = startBytes;
    let lastEmitAt = this.deps.now();
    let lastEmitBytes = received;
    let bytesPerSecond = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          // Bytes already in hand are written even when a cancel has landed:
          // throwing them away would make the next resume redo that work.
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          await handle.write(chunk);
          received += chunk.byteLength;
        }

        if (signal.aborted) break;

        const at = this.deps.now();
        const elapsed = at - lastEmitAt;
        if (elapsed >= this.deps.throttleMs) {
          const instant = ((received - lastEmitBytes) * 1000) / elapsed;
          // Exponential smoothing: a single slow chunk should not make the ETA
          // jump around, but a real slowdown should still show up quickly.
          bytesPerSecond = bytesPerSecond === 0 ? instant : bytesPerSecond * 0.6 + instant * 0.4;
          lastEmitAt = at;
          lastEmitBytes = received;

          recordProgress(this.deps.db(), modelId, received);
          this.emitProgress({
            modelId,
            receivedBytes: received,
            totalBytes: total,
            bytesPerSecond: Math.round(bytesPerSecond),
            etaSeconds: etaFrom(received, total, bytesPerSecond),
            status: 'downloading',
            error: null,
          });
        }
      }
    } finally {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }

    return received;
  }

  private async finish(
    db: Db,
    modelId: string,
    target: string,
    entry: CatalogEntry | undefined,
    bytes: number,
    resumed: boolean,
  ): Promise<DownloadOutcome> {
    if (entry?.sha256) {
      const actual = await sha256File(target);
      if (actual !== entry.sha256) {
        await fs.rm(target, { force: true });
        const message = `Checksum mismatch for ${modelId}: expected ${entry.sha256}, got ${actual}`;
        markError(db, modelId, message);
        this.emitProgress(
          {
            modelId,
            receivedBytes: bytes,
            totalBytes: entry.sizeBytes,
            bytesPerSecond: 0,
            etaSeconds: null,
            status: 'error',
            error: message,
          },
          true,
        );
        return { modelId, status: 'error', path: null, bytes, error: message, resumed };
      }
    }

    const finalBytes = await sizeOrZero(target);
    markReady(db, modelId, target, finalBytes);
    this.emitProgress(
      {
        modelId,
        receivedBytes: finalBytes,
        totalBytes: finalBytes,
        bytesPerSecond: 0,
        etaSeconds: 0,
        status: 'ready',
        error: null,
      },
      true,
    );
    return { modelId, status: 'ready', path: target, bytes: finalBytes, error: null, resumed };
  }

  private cancelled(db: Db, modelId: string, bytes: number, total: number | null): DownloadOutcome {
    markInterrupted(db, modelId, bytes);
    this.emitProgress(
      {
        modelId,
        receivedBytes: bytes,
        totalBytes: total,
        bytesPerSecond: 0,
        etaSeconds: null,
        status: 'cancelled',
        error: null,
      },
      true,
    );
    return { modelId, status: 'cancelled', path: null, bytes, error: null, resumed: false };
  }

  private async assertEnoughDiskSpace(target: string, remainingBytes: number): Promise<void> {
    if (remainingBytes <= 0) return;
    const free = await this.deps.freeDiskBytes(path.dirname(target));
    if (free === null) return;

    const needed = Math.ceil(remainingBytes * DISK_SPACE_MARGIN);
    if (free < needed) {
      throw new DownloadError(
        `Not enough free disk space: ${formatBytes(needed)} needed, ${formatBytes(free)} available.`,
        'INSUFFICIENT_DISK_SPACE',
      );
    }
  }

  private readonly lastEmitAt = new Map<string, number>();

  /** Terminal events always go out; interim ones are rate-limited, per model. */
  private emitProgress(progress: DownloadProgress, force = false): void {
    const at = this.deps.now();
    const previous = this.lastEmitAt.get(progress.modelId) ?? Number.NEGATIVE_INFINITY;
    if (!force && at - previous < this.deps.throttleMs) return;
    this.lastEmitAt.set(progress.modelId, at);
    this.deps.emit(progress);
  }
}

// ---------------------------------------------------------------------------
// Deleting local weights
// ---------------------------------------------------------------------------

/** Remove a model's directory, both the final file and any `.part`. */
export async function removeLocalModel(modelsRoot: string, modelId: string): Promise<boolean> {
  const dir = resolveModelDir(modelsRoot, modelId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The catalog entry backing a stored id, when there is one. */
export function catalogEntryForModel(modelId: string): CatalogEntry | undefined {
  return findCatalogEntry(modelId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sizeOrZero(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function etaFrom(received: number, total: number | null, bytesPerSecond: number): number | null {
  if (total === null || bytesPerSecond <= 0) return null;
  const remaining = total - received;
  if (remaining <= 0) return 0;
  return Math.round(remaining / bytesPerSecond);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
