/**
 * Hugging Face repo lookup.
 *
 * This is what makes the catalog open-ended: paste `bartowski/Qwen2.5-7B-Instruct-GGUF`
 * and every `.gguf` in the repo comes back as a selectable quant variant with its
 * size, ready to be checked for compatibility before anything is downloaded.
 *
 * `fetch` is injected so the tests never touch the network.
 */

import { downloadUrl } from './catalog';

const HF_API_ORIGIN = 'https://huggingface.co';

export type HfErrorCode =
  | 'INVALID_REPO'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'BAD_RESPONSE'
  | 'NO_GGUF';

export class HfError extends Error {
  constructor(
    message: string,
    readonly code: HfErrorCode,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'HfError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HfLookupOptions {
  readonly fetch?: FetchLike;
  /** Hugging Face access token, for gated or private repos. */
  readonly token?: string | null;
  readonly signal?: AbortSignal;
}

export interface GgufVariant {
  readonly filename: string;
  /** Quant label parsed out of the filename, e.g. `Q4_K_M`. Null when unrecognisable. */
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  /**
   * The blob digest the Hub reports for this file (`lfs.oid`, a SHA-256).
   *
   * Null for a file the Hub does not report one for. The downloader refuses to
   * fetch a model it has no expected digest for, so this is not decoration.
   */
  readonly sha256: string | null;
  readonly downloadUrl: string;
  /** True for `-00001-of-00003.gguf` style splits, which the downloader cannot handle. */
  readonly isSplit: boolean;
}

export interface HfRepoInfo {
  readonly repo: string;
  readonly gated: boolean;
  readonly isPrivate: boolean;
  readonly license: string | null;
  readonly lastModified: string | null;
  readonly variants: readonly GgufVariant[];
  /** Files skipped because the downloader handles one file per model. */
  readonly skippedSplitFiles: readonly string[];
}

/** `owner/name`, the only shape the Hub API and our download URL builder accept. */
export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function assertRepoId(repo: string): string {
  const trimmed = repo.trim();
  if (!REPO_PATTERN.test(trimmed) || trimmed.includes('..')) {
    throw new HfError(
      `"${repo}" is not a Hugging Face repo id. Expected something like "bartowski/Qwen2.5-7B-Instruct-GGUF".`,
      'INVALID_REPO',
    );
  }
  return trimmed;
}

/**
 * Accepts a bare repo id or a full `huggingface.co/owner/name[/...]` URL, since
 * pasting the browser URL is the obvious thing for a user to do.
 */
export function normaliseRepoInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes('://')) return assertRepoId(trimmed.replace(/^\/+|\/+$/g, ''));

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new HfError(`Could not read "${input}" as a repo id or a URL.`, 'INVALID_REPO');
  }
  if (url.host !== 'huggingface.co' && url.host !== 'www.huggingface.co') {
    throw new HfError(`Only huggingface.co links are supported, got ${url.host}.`, 'INVALID_REPO');
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new HfError(`That link has no owner/name in it: ${input}`, 'INVALID_REPO');
  }
  return assertRepoId(`${segments[0]}/${segments[1]}`);
}

const QUANT_PATTERN = /(?:^|[-_.])((?:IQ|Q)\d+(?:_[A-Za-z0-9]+)*|BF16|F16|F32|MXFP4)(?=[-_.]|$)/i;

/** Pull the quant label out of a GGUF filename. */
export function parseQuant(filename: string): string | null {
  const stem = filename.replace(/\.gguf$/i, '');
  const match = QUANT_PATTERN.exec(stem);
  return match?.[1] ? match[1].toUpperCase() : null;
}

const SPLIT_PATTERN = /-\d{5}-of-\d{5}\.gguf$/i;

export function isSplitFile(filename: string): boolean {
  return SPLIT_PATTERN.test(filename);
}

interface HubSibling {
  rfilename?: unknown;
  size?: unknown;
  lfs?: { size?: unknown; oid?: unknown; sha256?: unknown } | null;
}

interface HubModelResponse {
  siblings?: unknown;
  gated?: unknown;
  private?: unknown;
  lastModified?: unknown;
  cardData?: { license?: unknown } | null;
}

/** A 64-character lowercase hex digest, or null. Nothing else is accepted. */
function digestOf(sibling: HubSibling): string | null {
  for (const raw of [sibling.lfs?.oid, sibling.lfs?.sha256]) {
    if (typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw)) return raw;
  }
  return null;
}

function sizeOf(sibling: HubSibling): number | null {
  const lfsSize = sibling.lfs?.size;
  if (typeof lfsSize === 'number' && Number.isFinite(lfsSize)) return lfsSize;
  if (typeof sibling.size === 'number' && Number.isFinite(sibling.size)) return sibling.size;
  return null;
}

/**
 * List every `.gguf` in a repo, with its size.
 *
 * `?blobs=true` is what makes the Hub return per-file sizes; without it the
 * sizes come back undefined and the compatibility verdict has nothing to work
 * with.
 */
export async function lookupRepo(repoInput: string, options: HfLookupOptions = {}): Promise<HfRepoInfo> {
  const repo = normaliseRepoInput(repoInput);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const encoded = repo.split('/').map(encodeURIComponent).join('/');
  const url = `${HF_API_ORIGIN}/api/models/${encoded}?blobs=true`;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token && options.token.length > 0) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await doFetch(url, { method: 'GET', headers, signal: options.signal });

  if (!response.ok) {
    throw errorForStatus(response.status, repo, Boolean(options.token));
  }

  let payload: HubModelResponse;
  try {
    payload = (await response.json()) as HubModelResponse;
  } catch {
    throw new HfError(`Hugging Face returned something that is not JSON for ${repo}.`, 'BAD_RESPONSE');
  }

  if (!Array.isArray(payload.siblings)) {
    throw new HfError(`Hugging Face returned no file list for ${repo}.`, 'BAD_RESPONSE');
  }

  const variants: GgufVariant[] = [];
  const skippedSplitFiles: string[] = [];

  for (const raw of payload.siblings as HubSibling[]) {
    const filename = raw?.rfilename;
    if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.gguf')) continue;
    // Files in subdirectories would need a different resolve URL and a different
    // on-disk layout; the downloader only knows repo-root files.
    if (filename.includes('/')) {
      skippedSplitFiles.push(filename);
      continue;
    }
    if (isSplitFile(filename)) {
      skippedSplitFiles.push(filename);
      continue;
    }

    let resolved: string;
    try {
      resolved = downloadUrl(repo, filename);
    } catch {
      // A filename our path allow-list refuses is not offered at all.
      skippedSplitFiles.push(filename);
      continue;
    }

    variants.push({
      filename,
      quant: parseQuant(filename),
      sizeBytes: sizeOf(raw),
      sha256: digestOf(raw),
      downloadUrl: resolved,
      isSplit: false,
    });
  }

  if (variants.length === 0) {
    throw new HfError(
      skippedSplitFiles.length > 0
        ? `${repo} only contains multi-part or nested GGUF files, which this app cannot download yet.`
        : `${repo} has no .gguf files. Look for a repo whose name ends in "-GGUF".`,
      'NO_GGUF',
    );
  }

  variants.sort((left, right) => (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0));

  return {
    repo,
    gated: payload.gated === true || typeof payload.gated === 'string',
    isPrivate: payload.private === true,
    license: typeof payload.cardData?.license === 'string' ? payload.cardData.license : null,
    lastModified: typeof payload.lastModified === 'string' ? payload.lastModified : null,
    variants,
    skippedSplitFiles,
  };
}

/** Distinct, actionable messages — 401, 403 and 404 mean three different fixes. */
function errorForStatus(status: number, repo: string, hasToken: boolean): HfError {
  switch (status) {
    case 401:
      return new HfError(
        hasToken
          ? `Hugging Face rejected the access token (401). Check it is still valid and has "read" access to ${repo}.`
          : `${repo} needs authentication (401). Add a Hugging Face access token in Settings and try again.`,
        'UNAUTHORIZED',
        401,
      );
    case 403:
      return new HfError(
        `Access to ${repo} is gated (403). Accept the model's licence on huggingface.co with the same account your token belongs to, then try again.`,
        'FORBIDDEN',
        403,
      );
    case 404:
      return new HfError(
        `No such repo: ${repo} (404). Check the spelling, and note that private repos need a token.`,
        'NOT_FOUND',
        404,
      );
    case 429:
      return new HfError(
        `Hugging Face is rate-limiting this machine (429). Wait a minute and try again.`,
        'RATE_LIMITED',
        429,
      );
    default:
      return new HfError(`Hugging Face returned HTTP ${status} for ${repo}.`, 'HTTP_ERROR', status);
  }
}

/**
 * The Hub's SHA-256 for one file in a repo, or null when it does not report one.
 *
 * This is the same `?blobs=true` call the catalog's digests were taken from, and
 * it is what lets the downloader refuse a model it has no expected digest for
 * without restricting downloads to the curated list.
 */
export async function lookupFileDigest(
  repo: string,
  filename: string,
  options: HfLookupOptions = {},
): Promise<string | null> {
  const info = await lookupRepo(repo, options);
  const variant = info.variants.find((candidate) => candidate.filename === filename);
  return variant?.sha256 ?? null;
}
