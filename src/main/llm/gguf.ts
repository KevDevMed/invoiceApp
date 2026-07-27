/**
 * Read a GGUF header over the network without downloading the model.
 *
 * The verdict-before-download flow needs `block_count`, the head counts, the
 * key/value lengths and the context length — all of which live in the first few
 * megabytes of the file. HTTP `Range` requests fetch exactly that much.
 *
 * Why a hand-written parser rather than `readGgufFileInfo` from node-llama-cpp
 * (which does exist in 3.19.1 and does accept a URL — see
 * `node_modules/node-llama-cpp/dist/gguf/readGgufFileInfo.d.ts`): that function
 * owns its own fetch stack, so a unit test either hits the real Hugging Face or
 * tests nothing. The reader below takes an injected `fetch`, which is what makes
 * the truncated-header and bad-magic cases testable. `readGgufFileInfo` is still
 * used for *local* files in `readLocalGgufMetadata`, where there is no network
 * to mock and no reason to re-implement file reading.
 *
 * Format (GGUF v2/v3, little-endian):
 *   magic "GGUF" | version u32 | tensor_count u64 | kv_count u64 | kv pairs
 * Each KV: key (u64 length + UTF-8 bytes), value type u32, value.
 */

import type { GgufMetadataMap } from './compatibility';

export type GgufErrorCode =
  | 'HTTP_ERROR'
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_VALUE_TYPE'
  | 'TRUNCATED'
  | 'TOO_LARGE';

export class GgufError extends Error {
  constructor(
    message: string,
    readonly code: GgufErrorCode,
  ) {
    super(message);
    this.name = 'GgufError';
  }
}

/** GGUF value type tags. */
export const GGUF_TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

/** First slice requested. Big enough that most headers arrive in one round trip. */
export const INITIAL_CHUNK_BYTES = 4 * 1024 * 1024;
/** Hard stop. A header larger than this is not a header we are willing to read. */
export const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/**
 * Metadata keys the compatibility verdict needs, as suffixes appended to the
 * architecture name. Once all of these (plus `general.architecture`) have been
 * seen, parsing stops early rather than walking the tokenizer vocabulary.
 */
const REQUIRED_ARCH_SUFFIXES = [
  'block_count',
  'attention.head_count',
  'attention.head_count_kv',
  'attention.key_length',
  'attention.value_length',
  'embedding_length',
  'context_length',
  'attention.sliding_window',
] as const;

export interface GgufHeader {
  readonly version: number;
  readonly tensorCount: number;
  readonly metadataKvCount: number;
  readonly architecture: string | null;
  readonly metadata: GgufMetadataMap;
  /** True when parsing stopped early because every needed key had been seen. */
  readonly stoppedEarly: boolean;
}

// ---------------------------------------------------------------------------
// Byte-level cursor
// ---------------------------------------------------------------------------

/** Thrown internally when the cursor runs off the end of what has been fetched. */
class NeedMoreBytes extends Error {
  constructor(readonly upTo: number) {
    super(`Need bytes up to ${upTo}`);
    this.name = 'NeedMoreBytes';
  }
}

class Cursor {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private view(length: number): DataView {
    if (this.offset + length > this.bytes.length) {
      throw new NeedMoreBytes(this.offset + length);
    }
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
  }

  u8(): number {
    const value = this.view(1).getUint8(0);
    this.offset += 1;
    return value;
  }

  i8(): number {
    const value = this.view(1).getInt8(0);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view(2).getUint16(0, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    const value = this.view(2).getInt16(0, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view(4).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    const value = this.view(4).getInt32(0, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    const value = this.view(4).getFloat32(0, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    const value = this.view(8).getFloat64(0, true);
    this.offset += 8;
    return value;
  }

  /**
   * 64-bit values are returned as JS numbers. Counts and lengths in a real GGUF
   * are far below 2^53; anything above that is rejected rather than silently
   * losing precision.
   */
  u64(): number {
    const value = this.view(8).getBigUint64(0, true);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GgufError(`GGUF unsigned 64-bit value out of range: ${value}`, 'TRUNCATED');
    }
    return Number(value);
  }

  i64(): number {
    const value = this.view(8).getBigInt64(0, true);
    this.offset += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new GgufError(`GGUF signed 64-bit value out of range: ${value}`, 'TRUNCATED');
    }
    return Number(value);
  }

  string(): string {
    const length = this.u64();
    if (this.offset + length > this.bytes.length) {
      throw new NeedMoreBytes(this.offset + length);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(slice);
  }

  magic(): string {
    const view = this.view(4);
    const value = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    this.offset += 4;
    return value;
  }
}

type ScalarValue = string | number | boolean;

function readScalar(cursor: Cursor, type: number): ScalarValue {
  switch (type) {
    case GGUF_TYPE.UINT8:
      return cursor.u8();
    case GGUF_TYPE.INT8:
      return cursor.i8();
    case GGUF_TYPE.UINT16:
      return cursor.u16();
    case GGUF_TYPE.INT16:
      return cursor.i16();
    case GGUF_TYPE.UINT32:
      return cursor.u32();
    case GGUF_TYPE.INT32:
      return cursor.i32();
    case GGUF_TYPE.FLOAT32:
      return cursor.f32();
    case GGUF_TYPE.BOOL:
      return cursor.u8() !== 0;
    case GGUF_TYPE.STRING:
      return cursor.string();
    case GGUF_TYPE.UINT64:
      return cursor.u64();
    case GGUF_TYPE.INT64:
      return cursor.i64();
    case GGUF_TYPE.FLOAT64:
      return cursor.f64();
    default:
      throw new GgufError(`Unsupported GGUF value type: ${type}`, 'UNSUPPORTED_VALUE_TYPE');
  }
}

/**
 * Parse the header out of whatever bytes are available.
 *
 * Throws `NeedMoreBytes` (internal) when the buffer ends mid-structure, which is
 * the signal to fetch another range. Arrays are walked but not retained: the
 * tokenizer vocabulary is megabytes of strings nobody here needs.
 */
function parseHeader(bytes: Uint8Array): GgufHeader {
  const cursor = new Cursor(bytes);

  const magic = cursor.magic();
  if (magic !== 'GGUF') {
    throw new GgufError(
      `Not a GGUF file: expected magic "GGUF", got ${JSON.stringify(magic)}.`,
      'BAD_MAGIC',
    );
  }

  const version = cursor.u32();
  if (version < 2 || version > 3) {
    throw new GgufError(
      `Unsupported GGUF version ${version}. This app reads v2 and v3.`,
      'UNSUPPORTED_VERSION',
    );
  }

  const tensorCount = cursor.u64();
  const metadataKvCount = cursor.u64();

  const metadata: Record<string, ScalarValue> = {};
  let architecture: string | null = null;
  let stoppedEarly = false;

  for (let index = 0; index < metadataKvCount; index += 1) {
    const key = cursor.string();
    const type = cursor.u32();

    if (type === GGUF_TYPE.ARRAY) {
      const elementType = cursor.u32();
      const count = cursor.u64();
      for (let element = 0; element < count; element += 1) {
        readScalar(cursor, elementType);
      }
      continue;
    }

    const value = readScalar(cursor, type);
    metadata[key] = value;
    if (key === 'general.architecture' && typeof value === 'string') {
      architecture = value;
    }

    if (architecture !== null && hasEverythingNeeded(metadata, architecture)) {
      stoppedEarly = true;
      break;
    }
  }

  return { version, tensorCount, metadataKvCount, architecture, metadata, stoppedEarly };
}

function hasEverythingNeeded(metadata: Record<string, ScalarValue>, architecture: string): boolean {
  return REQUIRED_ARCH_SUFFIXES.every((suffix) =>
    Object.prototype.hasOwnProperty.call(metadata, `${architecture}.${suffix}`),
  );
}

/** Parse a complete in-memory GGUF header. Exposed for tests and local files. */
export function parseGgufHeader(bytes: Uint8Array): GgufHeader {
  try {
    return parseHeader(bytes);
  } catch (error) {
    if (error instanceof NeedMoreBytes) {
      throw new GgufError(
        `GGUF header is truncated: needed ${error.upTo} bytes but only ${bytes.length} are available.`,
        'TRUNCATED',
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RemoteGgufOptions {
  readonly fetch?: FetchLike;
  /** Extra request headers, e.g. an `Authorization` bearer for a gated repo. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly initialChunkBytes?: number;
  readonly maxHeaderBytes?: number;
}

function withHeaders(options: RemoteGgufOptions, extra: Record<string, string>): Record<string, string> {
  return { ...(options.headers ?? {}), ...extra };
}

/** `content-length` of the whole file, from a `HEAD`. Null when the server will not say. */
export async function headFileSize(url: string, options: RemoteGgufOptions = {}): Promise<number | null> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await doFetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: withHeaders(options, {}),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new GgufError(
      `HEAD ${url} failed with HTTP ${response.status}.`,
      'HTTP_ERROR',
    );
  }

  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchRange(
  url: string,
  start: number,
  endInclusive: number,
  options: RemoteGgufOptions,
): Promise<Uint8Array> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const response = await doFetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: withHeaders(options, { range: `bytes=${start}-${endInclusive}` }),
    signal: options.signal,
  });

  // 206 is the expected answer; a 200 means the server ignored the range and is
  // sending the whole file, which is still usable — we just stop reading it.
  if (response.status !== 206 && response.status !== 200) {
    throw new GgufError(
      `Range request for ${url} failed with HTTP ${response.status}.`,
      'HTTP_ERROR',
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Read the GGUF header of a remote file with as few bytes as possible.
 *
 * Fetches an initial slice, tries to parse, and only asks for more when the
 * parser runs off the end. A server that stops returning new bytes means the
 * file really is shorter than the header claims — that is a `TRUNCATED` error,
 * never a partially-filled metadata map.
 */
export async function readRemoteGgufHeader(
  url: string,
  options: RemoteGgufOptions = {},
): Promise<GgufHeader> {
  const initial = options.initialChunkBytes ?? INITIAL_CHUNK_BYTES;
  const limit = options.maxHeaderBytes ?? MAX_HEADER_BYTES;

  let buffer = await fetchRange(url, 0, initial - 1, options);
  if (buffer.length === 0) {
    throw new GgufError(`Range request for ${url} returned no bytes.`, 'TRUNCATED');
  }

  for (;;) {
    try {
      return parseHeader(buffer);
    } catch (error) {
      if (!(error instanceof NeedMoreBytes)) throw error;

      if (error.upTo > limit) {
        throw new GgufError(
          `GGUF header of ${url} wants ${error.upTo} bytes, over the ${limit}-byte ceiling.`,
          'TOO_LARGE',
        );
      }

      const want = Math.min(limit, Math.max(error.upTo, buffer.length * 2));
      const next = await fetchRange(url, buffer.length, want - 1, options);
      if (next.length === 0) {
        throw new GgufError(
          `GGUF header of ${url} is truncated: the file ends at ${buffer.length} bytes but the header needs ${error.upTo}.`,
          'TRUNCATED',
        );
      }

      const grown = new Uint8Array(buffer.length + next.length);
      grown.set(buffer, 0);
      grown.set(next, buffer.length);
      buffer = grown;
    }
  }
}

/**
 * Read a GGUF header from a file already on disk.
 *
 * Delegates to node-llama-cpp's `readGgufFileInfo`, which reads only the parts
 * of the file it needs. Imported dynamically so this module stays importable on
 * a machine where the native addon will not load.
 */
export async function readLocalGgufMetadata(filePath: string): Promise<GgufMetadataMap> {
  const module = (await import('node-llama-cpp')) as unknown as {
    readGgufFileInfo?: (
      path: string,
      options?: { readTensorInfo?: boolean; sourceType?: 'filesystem' | 'network'; logWarnings?: boolean },
    ) => Promise<{ metadata?: unknown }>;
  };

  if (typeof module.readGgufFileInfo !== 'function') {
    throw new GgufError('node-llama-cpp does not expose readGgufFileInfo.', 'HTTP_ERROR');
  }

  const info = await module.readGgufFileInfo(filePath, {
    readTensorInfo: false,
    sourceType: 'filesystem',
    logWarnings: false,
  });

  return flattenMetadata(info.metadata);
}

/**
 * node-llama-cpp returns metadata as a nested object (`{llama: {block_count}}`);
 * everything here is keyed by the flat dotted names the GGUF file uses.
 */
export function flattenMetadata(value: unknown, prefix = ''): GgufMetadataMap {
  const flat: Record<string, string | number | boolean> = {};
  if (value === null || typeof value !== 'object') return flat;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (child === null || child === undefined) continue;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
      flat[path] = child;
      continue;
    }
    if (typeof child === 'bigint') {
      flat[path] = Number(child);
      continue;
    }
    if (Array.isArray(child)) continue;
    Object.assign(flat, flattenMetadata(child, path));
  }

  return flat;
}
