/**
 * GGUF header parsing, against bytes this file builds itself.
 *
 * No network: `fetch` is a stub that serves slices of the synthetic buffer, so
 * the range-request loop, the "server ran out of bytes" case and the bad-magic
 * case are all exercised deterministically.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GGUF_TYPE,
  GgufError,
  flattenMetadata,
  headFileSize,
  parseGgufHeader,
  readRemoteGgufHeader,
} from '../gguf';

// ---------------------------------------------------------------------------
// A tiny GGUF writer
// ---------------------------------------------------------------------------

class Writer {
  private chunks: Uint8Array[] = [];

  raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  ascii(value: string): this {
    return this.raw(new TextEncoder().encode(value));
  }

  u32(value: number): this {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint32(0, value, true);
    return this.raw(buffer);
  }

  u64(value: number): this {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setBigUint64(0, BigInt(value), true);
    return this.raw(buffer);
  }

  f32(value: number): this {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setFloat32(0, value, true);
    return this.raw(buffer);
  }

  str(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u64(encoded.length).raw(encoded);
  }

  bytes(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

type KvValue =
  | { type: 'u32'; value: number }
  | { type: 'u64'; value: number }
  | { type: 'f32'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'stringArray'; value: string[] }
  | { type: 'u32Array'; value: number[] };

function writeKv(writer: Writer, key: string, entry: KvValue): void {
  writer.str(key);
  switch (entry.type) {
    case 'u32':
      writer.u32(GGUF_TYPE.UINT32).u32(entry.value);
      return;
    case 'u64':
      writer.u32(GGUF_TYPE.UINT64).u64(entry.value);
      return;
    case 'f32':
      writer.u32(GGUF_TYPE.FLOAT32).f32(entry.value);
      return;
    case 'bool':
      writer.u32(GGUF_TYPE.BOOL).raw(new Uint8Array([entry.value ? 1 : 0]));
      return;
    case 'string':
      writer.u32(GGUF_TYPE.STRING).str(entry.value);
      return;
    case 'stringArray':
      writer.u32(GGUF_TYPE.ARRAY).u32(GGUF_TYPE.STRING).u64(entry.value.length);
      for (const item of entry.value) writer.str(item);
      return;
    case 'u32Array':
      writer.u32(GGUF_TYPE.ARRAY).u32(GGUF_TYPE.UINT32).u64(entry.value.length);
      for (const item of entry.value) writer.u32(item);
      return;
  }
}

interface BuildOptions {
  readonly magic?: string;
  readonly version?: number;
  readonly tensorCount?: number;
  readonly kvCountOverride?: number;
  readonly trailingBytes?: number;
}

function buildGguf(pairs: Array<[string, KvValue]>, options: BuildOptions = {}): Uint8Array {
  const writer = new Writer();
  writer.ascii(options.magic ?? 'GGUF');
  writer.u32(options.version ?? 3);
  writer.u64(options.tensorCount ?? 0);
  writer.u64(options.kvCountOverride ?? pairs.length);
  for (const [key, value] of pairs) writeKv(writer, key, value);
  if (options.trailingBytes) writer.raw(new Uint8Array(options.trailingBytes));
  return writer.bytes();
}

const QWEN_PAIRS: Array<[string, KvValue]> = [
  ['general.architecture', { type: 'string', value: 'qwen3' }],
  ['general.name', { type: 'string', value: 'Qwen3 1.7B' }],
  ['qwen3.block_count', { type: 'u32', value: 28 }],
  ['qwen3.context_length', { type: 'u32', value: 32_768 }],
  ['qwen3.embedding_length', { type: 'u32', value: 2048 }],
  ['qwen3.attention.head_count', { type: 'u32', value: 16 }],
  ['qwen3.attention.head_count_kv', { type: 'u32', value: 8 }],
  ['qwen3.attention.key_length', { type: 'u32', value: 128 }],
  ['qwen3.attention.value_length', { type: 'u32', value: 128 }],
  ['qwen3.attention.layer_norm_rms_epsilon', { type: 'f32', value: 0.000001 }],
  ['general.file_type', { type: 'u32', value: 15 }],
  ['tokenizer.ggml.tokens', { type: 'stringArray', value: ['<pad>', 'hello', 'world'] }],
  ['tokenizer.ggml.token_type', { type: 'u32Array', value: [1, 1, 1] }],
  ['general.quantized_by', { type: 'string', value: 'nobody' }],
  ['general.some_flag', { type: 'bool', value: true }],
  ['general.big_number', { type: 'u64', value: 4_294_967_296 }],
];

// ---------------------------------------------------------------------------
// A fetch double that serves ranges out of a buffer
// ---------------------------------------------------------------------------

function rangeServer(body: Uint8Array, options: { contentLength?: number | null } = {}) {
  const calls: string[] = [];

  const doFetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.range;

    if (init?.method === 'HEAD') {
      calls.push('HEAD');
      const length = options.contentLength === undefined ? body.length : options.contentLength;
      return new Response(null, {
        status: 200,
        headers: length === null ? {} : { 'content-length': String(length) },
      });
    }

    calls.push(range ?? 'no-range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!match) return new Response(body, { status: 200 });

    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = body.subarray(Math.min(start, body.length), Math.min(end + 1, body.length));
    return new Response(slice, { status: 206 });
  });

  return { fetch: doFetch as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------------------

describe('parseGgufHeader', () => {
  it('reads every scalar type and skips arrays', () => {
    const header = parseGgufHeader(buildGguf(QWEN_PAIRS, { tensorCount: 311 }));

    expect(header.version).toBe(3);
    expect(header.tensorCount).toBe(311);
    expect(header.metadataKvCount).toBe(QWEN_PAIRS.length);
    expect(header.architecture).toBe('qwen3');
    expect(header.metadata['qwen3.block_count']).toBe(28);
    expect(header.metadata['qwen3.attention.head_count_kv']).toBe(8);
    expect(header.metadata['general.name']).toBe('Qwen3 1.7B');
    expect(header.metadata['general.some_flag']).toBe(true);
    expect(header.metadata['general.big_number']).toBe(4_294_967_296);
    expect(header.metadata['qwen3.attention.layer_norm_rms_epsilon']).toBeCloseTo(0.000001, 12);
    // Arrays are walked for their bytes but never retained.
    expect(header.metadata['tokenizer.ggml.tokens']).toBeUndefined();
  });

  it('produces metadata the compatibility check can consume directly', () => {
    const header = parseGgufHeader(buildGguf(QWEN_PAIRS));
    expect(header.metadata[`${header.architecture ?? ''}.context_length`]).toBe(32_768);
  });

  it('rejects a file that is not GGUF', () => {
    const bytes = buildGguf(QWEN_PAIRS, { magic: 'GGUX' });
    expect(() => parseGgufHeader(bytes)).toThrowError(GgufError);
    try {
      parseGgufHeader(bytes);
    } catch (error) {
      expect((error as GgufError).code).toBe('BAD_MAGIC');
    }
  });

  it('rejects an unsupported version', () => {
    try {
      parseGgufHeader(buildGguf(QWEN_PAIRS, { version: 1 }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GgufError).code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('errors rather than returning garbage when the header is cut short', () => {
    const full = buildGguf(QWEN_PAIRS);
    for (const cut of [4, 12, 20, 40, 100, full.length - 1]) {
      const truncated = full.subarray(0, cut);
      let thrown: unknown;
      try {
        parseGgufHeader(truncated);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `cut at ${cut}`).toBeInstanceOf(GgufError);
      expect((thrown as GgufError).code).toBe('TRUNCATED');
    }
  });

  it('errors when the declared KV count exceeds what is present', () => {
    try {
      parseGgufHeader(buildGguf(QWEN_PAIRS, { kvCountOverride: QWEN_PAIRS.length + 5 }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GgufError).code).toBe('TRUNCATED');
    }
  });

  it('rejects an unknown value type instead of guessing its width', () => {
    const writer = new Writer();
    writer.ascii('GGUF').u32(3).u64(0).u64(1);
    writer.str('weird.key').u32(99);
    try {
      parseGgufHeader(writer.bytes());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GgufError).code).toBe('UNSUPPORTED_VALUE_TYPE');
    }
  });
});

describe('readRemoteGgufHeader', () => {
  it('reads the header from the first range when it fits', async () => {
    const body = buildGguf(QWEN_PAIRS, { trailingBytes: 100_000 });
    const server = rangeServer(body);

    const header = await readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
      fetch: server.fetch,
      initialChunkBytes: 4096,
    });

    expect(header.architecture).toBe('qwen3');
    expect(server.calls).toEqual(['bytes=0-4095']);
  });

  it('asks for more bytes when the first range is not enough', async () => {
    const body = buildGguf(QWEN_PAIRS, { trailingBytes: 100_000 });
    const server = rangeServer(body);

    const header = await readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
      fetch: server.fetch,
      initialChunkBytes: 64,
    });

    expect(header.metadata['qwen3.block_count']).toBe(28);
    expect(server.calls.length).toBeGreaterThan(1);
    expect(server.calls[0]).toBe('bytes=0-63');
    // Each retry doubles rather than crawling forward a field at a time.
    expect(server.calls[1]).toBe('bytes=64-127');
  });

  it('sends the authorization header through to the range request', async () => {
    const body = buildGguf(QWEN_PAIRS);
    const server = rangeServer(body);

    await readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
      fetch: server.fetch,
      headers: { authorization: 'Bearer hf_test' },
      initialChunkBytes: 4096,
    });

    const init = (server.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer hf_test');
  });

  it('reports TRUNCATED when the file ends before the header does', async () => {
    const full = buildGguf(QWEN_PAIRS);
    const server = rangeServer(full.subarray(0, 60));

    await expect(
      readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
        fetch: server.fetch,
        initialChunkBytes: 32,
      }),
    ).rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it('refuses to keep fetching past the ceiling', async () => {
    // A header that claims far more KV pairs than the file could hold.
    const body = buildGguf(QWEN_PAIRS, { kvCountOverride: 1_000_000, trailingBytes: 200_000 });
    const server = rangeServer(body);

    await expect(
      readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
        fetch: server.fetch,
        initialChunkBytes: 1024,
        maxHeaderBytes: 8192,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/TOO_LARGE|TRUNCATED/) as unknown as string });
  });

  it('surfaces an HTTP failure as HTTP_ERROR', async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(
      readRemoteGgufHeader('https://huggingface.co/x/y/resolve/main/m.gguf', {
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });
});

describe('headFileSize', () => {
  it('returns the content-length', async () => {
    const server = rangeServer(new Uint8Array(1234));
    await expect(
      headFileSize('https://huggingface.co/x/y/resolve/main/m.gguf', { fetch: server.fetch }),
    ).resolves.toBe(1234);
    expect(server.calls).toEqual(['HEAD']);
  });

  it('returns null when the server will not say', async () => {
    const server = rangeServer(new Uint8Array(10), { contentLength: null });
    await expect(
      headFileSize('https://huggingface.co/x/y/resolve/main/m.gguf', { fetch: server.fetch }),
    ).resolves.toBeNull();
  });

  it('throws on a non-2xx response', async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      headFileSize('https://huggingface.co/x/y/resolve/main/m.gguf', {
        fetch: doFetch as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });
});

describe('flattenMetadata', () => {
  it('turns node-llama-cpp nested metadata into flat dotted keys', () => {
    const flat = flattenMetadata({
      general: { architecture: 'llama', name: 'x' },
      llama: { block_count: 32, attention: { head_count_kv: 8 } },
      tokenizer: { ggml: { tokens: ['a', 'b'] } },
    });

    expect(flat['general.architecture']).toBe('llama');
    expect(flat['llama.block_count']).toBe(32);
    expect(flat['llama.attention.head_count_kv']).toBe(8);
    // Arrays are dropped, exactly as the streaming parser drops them.
    expect(flat['tokenizer.ggml.tokens']).toBeUndefined();
  });

  it('is empty for a non-object', () => {
    expect(flattenMetadata(null)).toEqual({});
    expect(flattenMetadata(42)).toEqual({});
  });
});
