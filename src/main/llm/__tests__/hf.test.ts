/**
 * Hugging Face lookup. `fetch` is a stub; nothing here touches the network.
 */

import { describe, expect, it, vi } from 'vitest';

import { HfError, isSplitFile, lookupRepo, normaliseRepoInput, parseQuant } from '../hf';

function jsonServer(payload: unknown, status = 200) {
  const doFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  return { fetch: doFetch as unknown as typeof fetch, calls: doFetch };
}

const REPO_PAYLOAD = {
  id: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
  private: false,
  gated: false,
  lastModified: '2025-01-02T03:04:05.000Z',
  cardData: { license: 'apache-2.0' },
  siblings: [
    { rfilename: 'README.md', size: 1200 },
    { rfilename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', lfs: { size: 4_683_073_344 } },
    { rfilename: 'Qwen2.5-7B-Instruct-Q8_0.gguf', lfs: { size: 8_098_525_888 } },
    { rfilename: 'Qwen2.5-7B-Instruct-IQ3_XS.gguf', size: 3_346_000_000 },
    { rfilename: 'Qwen2.5-7B-Instruct-f16-00001-of-00002.gguf', lfs: { size: 8_000_000_000 } },
    { rfilename: 'nested/dir/Qwen2.5-7B-Instruct-Q2_K.gguf', lfs: { size: 3_000_000_000 } },
  ],
};

describe('normaliseRepoInput', () => {
  it('accepts a bare owner/name', () => {
    expect(normaliseRepoInput('  bartowski/Qwen2.5-7B-Instruct-GGUF  ')).toBe(
      'bartowski/Qwen2.5-7B-Instruct-GGUF',
    );
  });

  it('accepts a pasted browser URL', () => {
    expect(normaliseRepoInput('https://huggingface.co/Qwen/Qwen3-8B-GGUF/tree/main')).toBe(
      'Qwen/Qwen3-8B-GGUF',
    );
  });

  it.each([
    'not-a-repo',
    'too/many/segments/here'.replace('/here', ''),
    '../evil/path',
    'https://example.com/Qwen/Qwen3-8B-GGUF',
    'https://huggingface.co/onlyowner',
  ])('rejects %s', (input) => {
    expect(() => normaliseRepoInput(input)).toThrowError(HfError);
  });

  it('reports INVALID_REPO as the code', () => {
    try {
      normaliseRepoInput('nope');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HfError).code).toBe('INVALID_REPO');
    }
  });
});

describe('parseQuant', () => {
  it.each([
    ['Qwen2.5-7B-Instruct-Q4_K_M.gguf', 'Q4_K_M'],
    ['Qwen3-0.6B-Q8_0.gguf', 'Q8_0'],
    ['model-IQ3_XS.gguf', 'IQ3_XS'],
    ['model-f16.gguf', 'F16'],
    ['model-BF16.gguf', 'BF16'],
    ['model.gguf', null],
  ])('reads %s as %s', (filename, expected) => {
    expect(parseQuant(filename)).toBe(expected);
  });
});

describe('isSplitFile', () => {
  it('spots multi-part names', () => {
    expect(isSplitFile('m-00001-of-00002.gguf')).toBe(true);
    expect(isSplitFile('m-Q4_K_M.gguf')).toBe(false);
  });
});

describe('lookupRepo', () => {
  it('lists every downloadable gguf with its size', async () => {
    const server = jsonServer(REPO_PAYLOAD);
    const info = await lookupRepo('bartowski/Qwen2.5-7B-Instruct-GGUF', { fetch: server.fetch });

    expect(info.repo).toBe('bartowski/Qwen2.5-7B-Instruct-GGUF');
    expect(info.license).toBe('apache-2.0');
    expect(info.gated).toBe(false);
    expect(info.variants.map((variant) => variant.filename)).toEqual([
      'Qwen2.5-7B-Instruct-IQ3_XS.gguf',
      'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
      'Qwen2.5-7B-Instruct-Q8_0.gguf',
    ]);
    expect(info.variants[1]).toMatchObject({
      quant: 'Q4_K_M',
      sizeBytes: 4_683_073_344,
      downloadUrl:
        'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    });
    // Split and nested files are reported as skipped, not silently dropped.
    expect(info.skippedSplitFiles).toEqual([
      'Qwen2.5-7B-Instruct-f16-00001-of-00002.gguf',
      'nested/dir/Qwen2.5-7B-Instruct-Q2_K.gguf',
    ]);
  });

  it('asks for blob sizes', async () => {
    const server = jsonServer(REPO_PAYLOAD);
    await lookupRepo('bartowski/Qwen2.5-7B-Instruct-GGUF', { fetch: server.fetch });
    expect(server.calls.mock.calls[0]?.[0]).toBe(
      'https://huggingface.co/api/models/bartowski/Qwen2.5-7B-Instruct-GGUF?blobs=true',
    );
  });

  it('sends the token when one is configured, and nothing when it is not', async () => {
    const withToken = jsonServer(REPO_PAYLOAD);
    await lookupRepo('a/b', { fetch: withToken.fetch, token: 'hf_secret' });
    const headers = withToken.calls.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer hf_secret');

    const withoutToken = jsonServer(REPO_PAYLOAD);
    await lookupRepo('a/b', { fetch: withoutToken.fetch });
    const plain = withoutToken.calls.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(plain.authorization).toBeUndefined();
  });

  it.each([
    [401, 'UNAUTHORIZED', /access token/i],
    [403, 'FORBIDDEN', /gated/i],
    [404, 'NOT_FOUND', /No such repo/i],
    [429, 'RATE_LIMITED', /rate-limit/i],
    [500, 'HTTP_ERROR', /HTTP 500/],
  ])('turns %s into a distinct typed error', async (status, code, pattern) => {
    const server = jsonServer({}, status as number);
    let thrown: unknown;
    try {
      await lookupRepo('a/b', { fetch: server.fetch });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HfError);
    expect((thrown as HfError).code).toBe(code);
    expect((thrown as HfError).status).toBe(status);
    expect((thrown as HfError).message).toMatch(pattern as RegExp);
  });

  it('tells a 401 with a token apart from a 401 without one', async () => {
    const anonymous = jsonServer({}, 401);
    const authenticated = jsonServer({}, 401);

    await expect(lookupRepo('a/b', { fetch: anonymous.fetch })).rejects.toThrowError(
      /Add a Hugging Face access token/,
    );
    await expect(
      lookupRepo('a/b', { fetch: authenticated.fetch, token: 'hf_bad' }),
    ).rejects.toThrowError(/rejected the access token/);
  });

  it('errors when the repo has no gguf at all', async () => {
    const server = jsonServer({ siblings: [{ rfilename: 'config.json' }] });
    await expect(lookupRepo('a/b', { fetch: server.fetch })).rejects.toMatchObject({
      code: 'NO_GGUF',
    });
  });

  it('says so when every gguf is multi-part', async () => {
    const server = jsonServer({
      siblings: [{ rfilename: 'm-00001-of-00003.gguf', lfs: { size: 1 } }],
    });
    await expect(lookupRepo('a/b', { fetch: server.fetch })).rejects.toThrowError(/multi-part/);
  });

  it('rejects a response that is not JSON', async () => {
    const doFetch = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }));
    await expect(
      lookupRepo('a/b', { fetch: doFetch as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects a response with no file list', async () => {
    const server = jsonServer({ id: 'a/b' });
    await expect(lookupRepo('a/b', { fetch: server.fetch })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });

  it('reports a gated repo as gated', async () => {
    const server = jsonServer({ ...REPO_PAYLOAD, gated: 'auto', private: true });
    const info = await lookupRepo('a/b', { fetch: server.fetch });
    expect(info.gated).toBe(true);
    expect(info.isPrivate).toBe(true);
  });

  it('never asks the network for an invalid repo id', async () => {
    const server = jsonServer(REPO_PAYLOAD);
    await expect(lookupRepo('nope', { fetch: server.fetch })).rejects.toMatchObject({
      code: 'INVALID_REPO',
    });
    expect(server.calls).not.toHaveBeenCalled();
  });
});
