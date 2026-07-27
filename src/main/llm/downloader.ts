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
 * Two rules hold above that shape:
 *
 *   - Nothing is downloaded without a known SHA-256, and nothing is renamed into
 *     place until the `.part` has been hashed and matched. A file that reaches
 *     the final name has been verified on this machine, and the digest is stored
 *     so a later boot can tell verified bytes from merely well-sized ones.
 *   - Redirects are followed by hand, asserting https on every hop before it is
 *     requested. `redirect: 'follow'` walks an https-to-http redirect silently
 *     and only lets you complain afterwards.
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
import { lookupFileDigest } from './hf';
import {
  clearSmokeTestRecord,
  clearVerification,
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
      | 'DIGEST_UNAVAILABLE'
      | 'HTTP_ERROR'
      | 'TOO_MANY_REDIRECTS'
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
  /**
   * The expected SHA-256 for a repo/file pair that is not in the catalog.
   *
   * Defaults to the Hub's `?blobs=true` blob digest — the same source the
   * catalog's own digests came from. Returning null means "no digest can be
   * obtained", and the download is refused rather than run unverified.
   */
  readonly resolveDigest?: (
    repo: string,
    filename: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  /** Hugging Face token, for digest lookups against gated repos. */
  readonly hfToken?: () => string | null;
  /** How many transfers may run at once. The rest queue. */
  readonly maxConcurrentDownloads?: number;
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

/** Hops a download may follow before we call it a redirect chain gone wrong. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirect(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

async function defaultFreeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(dir);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

/** Transfers allowed to run at once. The rest queue rather than share bandwidth. */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;

export class ModelDownloader {
  private readonly deps: Required<Pick<DownloaderDeps, 'now' | 'freeDiskBytes' | 'throttleMs'>> &
    DownloaderDeps;

  private readonly active = new Map<string, { controller: AbortController; completion: Promise<DownloadOutcome> }>();

  private readonly maxConcurrent: number;

  /** Transfers holding a slot right now. */
  private running = 0;

  /** Transfers parked waiting for a slot, in arrival order. */
  private readonly waiting: Array<{ grant: () => void }> = [];

  /**
   * Bytes each in-flight transfer still intends to write.
   *
   * Without this the free-space check is a race: six downloads each ask "is
   * there room for me?" against the same untouched free space, all six say yes,
   * and the disk fills half-way through.
   */
  private readonly committedBytes = new Map<string, number>();

  constructor(deps: DownloaderDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      freeDiskBytes: deps.freeDiskBytes ?? defaultFreeDiskBytes,
      throttleMs: deps.throttleMs ?? 250,
    };
    this.maxConcurrent = Math.max(1, deps.maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS);
  }

  isDownloading(modelId: string): boolean {
    return this.active.has(modelId);
  }

  activeDownloadIds(): string[] {
    return [...this.active.keys()];
  }

  /** Transfers actually transferring, as opposed to queued. */
  runningCount(): number {
    return this.running;
  }

  /** Transfers accepted but waiting for a slot. */
  queuedCount(): number {
    return this.waiting.length;
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
    const completion = this.run(modelId, request, url, target, entry, controller.signal).finally(() => {
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
    request: StartDownloadRequest,
    url: string,
    target: string,
    entry: CatalogEntry | undefined,
    signal: AbortSignal,
  ): Promise<DownloadOutcome> {
    const db = this.deps.db();
    const partPath = `${target}${PART_SUFFIX}`;
    let received = 0;
    let resumed = false;
    let holdsSlot = false;

    try {
      // Queue behind the concurrency cap before anything is fetched or measured,
      // so the disk-space arithmetic below sees a stable set of transfers.
      holdsSlot = await this.acquireSlot(signal);
      if (!holdsSlot || signal.aborted) {
        return this.cancelled(db, modelId, await sizeOrZero(partPath), entry?.sizeBytes ?? null);
      }

      // Nothing is fetched until we know what the bytes are supposed to hash to.
      const expected = await this.expectedDigest(db, request, entry, signal);
      const expectedTotal = entry?.sizeBytes ?? null;

      await fs.mkdir(path.dirname(target), { recursive: true });

      // A final file may already be sitting there: left by a previous run, or
      // demoted at boot for never having been verified. Hash it rather than
      // spend the bandwidth again.
      const existingFinalBytes = await sizeOrZero(target);
      if (existingFinalBytes > 0) {
        if ((await sha256File(target)) === expected) {
          return this.promote(db, modelId, target, expected, existingFinalBytes, false);
        }
        await fs.rm(target, { force: true });
        clearVerification(db, modelId);
      }

      const already = await sizeOrZero(partPath);

      if (expectedTotal !== null && already >= expectedTotal) {
        // A `.part` that is already the full size means the previous run died
        // between the last write and the verify. Verify and promote it.
        return await this.finish(db, modelId, partPath, target, expected, entry, already, true);
      }

      const remaining = (expectedTotal ?? 0) - already;
      await this.assertEnoughDiskSpace(modelId, target, remaining);
      this.committedBytes.set(modelId, Math.max(0, remaining));

      const headers: Record<string, string> = {};
      if (already > 0) {
        headers.Range = `bytes=${already}-`;
      }

      const response = await this.fetchFollowingRedirects(url, headers, signal);

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

      return await this.finish(db, modelId, partPath, target, expected, entry, received, resumed);
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
    } finally {
      this.committedBytes.delete(modelId);
      if (holdsSlot) this.releaseSlot();
    }
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  /**
   * Take a transfer slot, waiting for one if the cap is reached.
   *
   * Resolves false when the download was cancelled while queued — the caller
   * must not release a slot it never held.
   */
  private async acquireSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        },
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      };
      this.waiting.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Hand the slot to the next queued transfer, or give it back to the pool. */
  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.running -= 1;
  }

  // -------------------------------------------------------------------------
  // Integrity
  // -------------------------------------------------------------------------

  /**
   * The SHA-256 these bytes must hash to, or a refusal.
   *
   * Catalog entries carry their digest. Anything else — and `llm:download` takes
   * a free-form repo and filename from the renderer — is looked up against the
   * Hub blob API, the same source the catalog's digests came from. No digest, no
   * download: an unverified GGUF ends up in llama.cpp's native parser, and that
   * is not a place to send bytes nobody vouched for.
   */
  private async expectedDigest(
    db: Db,
    request: StartDownloadRequest,
    entry: CatalogEntry | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    if (entry?.sha256) return entry.sha256;

    const resolve =
      this.deps.resolveDigest ??
      ((repo, filename, abort) =>
        lookupFileDigest(repo, filename, {
          token: this.deps.hfToken?.() ?? null,
          signal: abort,
        }));

    let digest: string | null;
    try {
      digest = await resolve(request.repo, request.filename, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new DownloadError(
        `Could not obtain a SHA-256 for ${request.repo}/${request.filename}: ${message}. Refusing to download weights that cannot be verified.`,
        'DIGEST_UNAVAILABLE',
      );
    }

    if (digest === null || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new DownloadError(
        `No SHA-256 is published for ${request.repo}/${request.filename}, so the download cannot be verified. Refusing to download it.`,
        'DIGEST_UNAVAILABLE',
      );
    }

    // Store what we will check against, so the UI and a later boot can see it.
    upsertModel(db, {
      id: deriveModelId(request.repo, request.filename),
      repo: request.repo,
      filename: request.filename,
      sha256: digest,
      status: 'downloading',
    });
    return digest;
  }

  /**
   * Follow redirects by hand, asserting https on every hop *before* requesting it.
   *
   * `redirect: 'follow'` would issue the plaintext request first and only then
   * let us look at `response.url`, which is one plaintext request too late.
   */
  private async fetchFollowingRedirects(
    initialUrl: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    let url = assertHttpsUrl(initialUrl);
    const seen = new Set<string>([url]);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.deps.fetch(url, { headers, signal, redirect: 'manual' });

      const location = isRedirect(response.status) ? response.headers.get('location') : null;
      if (location === null) {
        // Not a redirect. `response.url` is checked too, in case the fetch
        // implementation resolved something on our behalf.
        if (response.url) assertHttpsUrl(response.url);
        return response;
      }

      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new DownloadError(`Redirect to an unreadable location: ${location}`, 'HTTP_ERROR');
      }

      // Throws before the next request is made, which is the whole point.
      next = assertHttpsUrl(next);
      if (seen.has(next)) {
        throw new DownloadError(`Redirect loop while downloading: ${next}`, 'TOO_MANY_REDIRECTS');
      }
      seen.add(next);
      url = next;
    }

    throw new DownloadError(
      `Gave up after ${MAX_REDIRECTS} redirects starting at ${initialUrl}.`,
      'TOO_MANY_REDIRECTS',
    );
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

  /**
   * Verify the `.part`, then — and only then — rename it into place.
   *
   * Hashing before the rename closes the crash window the other order left open:
   * a rename that lands and a process that dies before the checksum runs leaves
   * a final-named file of exactly the right size that nothing ever hashed, and
   * boot reconciliation used to call that `ready`.
   */
  private async finish(
    db: Db,
    modelId: string,
    partPath: string,
    target: string,
    expectedSha256: string,
    entry: CatalogEntry | undefined,
    bytes: number,
    resumed: boolean,
  ): Promise<DownloadOutcome> {
    const actual = await sha256File(partPath);
    if (actual !== expectedSha256) {
      // The bad bytes go, and no file ever appears under the final name.
      await fs.rm(partPath, { force: true });
      const message = `Checksum mismatch for ${modelId}: expected ${expectedSha256}, got ${actual}`;
      markError(db, modelId, message);
      this.emitProgress(
        {
          modelId,
          receivedBytes: bytes,
          totalBytes: entry?.sizeBytes ?? null,
          bytesPerSecond: 0,
          etaSeconds: null,
          status: 'error',
          error: message,
        },
        true,
      );
      return { modelId, status: 'error', path: null, bytes, error: message, resumed };
    }

    await fs.rename(partPath, target);
    const finalBytes = await sizeOrZero(target);
    return this.promote(db, modelId, target, expectedSha256, finalBytes, resumed);
  }

  /** Record verified weights and announce them. The only path to `ready`. */
  private promote(
    db: Db,
    modelId: string,
    target: string,
    verifiedSha256: string,
    finalBytes: number,
    resumed: boolean,
  ): DownloadOutcome {
    markReady(db, modelId, target, finalBytes, verifiedSha256);
    // Any earlier smoke test described bytes that are no longer the ones here.
    clearSmokeTestRecord(db, modelId);
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

  /**
   * Refuse a transfer the disk cannot hold — counting what the other in-flight
   * transfers have already promised to write, not just this one's share.
   */
  private async assertEnoughDiskSpace(
    modelId: string,
    target: string,
    remainingBytes: number,
  ): Promise<void> {
    if (remainingBytes <= 0) return;
    const free = await this.deps.freeDiskBytes(path.dirname(target));
    if (free === null) return;

    let committedElsewhere = 0;
    for (const [id, bytes] of this.committedBytes) {
      if (id !== modelId) committedElsewhere += bytes;
    }

    const needed = Math.ceil((remainingBytes + committedElsewhere) * DISK_SPACE_MARGIN);
    if (free < needed) {
      throw new DownloadError(
        `Not enough free disk space: ${formatBytes(needed)} needed${committedElsewhere > 0 ? ` (including ${formatBytes(committedElsewhere)} already committed by other downloads)` : ''}, ${formatBytes(free)} available.`,
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
