import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertHttpsUrl,
  CATALOG,
  catalogEntryUrl,
  deriveModelId,
  describeEntry,
  downloadUrl,
  findCatalogEntry,
  findCatalogEntryByFile,
  isSafeModelFilename,
  isSafeModelId,
  resolveModelDir,
  resolveModelPath,
  UnsafeModelPathError,
} from '../catalog';

const ROOT = path.resolve('/tmp/invoiceapp-test/models');

describe('catalog contents', () => {
  it('has unique ids and one entry per repo/file pair', () => {
    const ids = CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const pairs = CATALOG.map((entry) => `${entry.repo}/${entry.filename}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('only ships ids and filenames that pass the allow-list', () => {
    for (const entry of CATALOG) {
      expect(isSafeModelId(entry.id), entry.id).toBe(true);
      expect(isSafeModelFilename(entry.filename), entry.filename).toBe(true);
    }
  });

  it('records a full 64-character SHA-256 and a real size for every entry', () => {
    for (const entry of CATALOG) {
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sizeBytes, entry.id).toBeGreaterThan(1_000_000);
    }
  });

  it('covers both ends of the hardware range and only offers tool-callers', () => {
    const smallest = Math.min(...CATALOG.map((entry) => entry.paramsBillions));
    const largest = Math.max(...CATALOG.map((entry) => entry.paramsBillions));
    expect(smallest).toBeLessThanOrEqual(1.7);
    expect(largest).toBeGreaterThanOrEqual(7);
    expect(CATALOG.every((entry) => entry.supportsTools)).toBe(true);
  });

  it('finds entries by id and by repo/file pair', () => {
    const first = CATALOG[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(findCatalogEntry(first.id)).toBe(first);
    expect(findCatalogEntryByFile(first.repo, first.filename)).toBe(first);
    expect(findCatalogEntry('not-a-model')).toBeUndefined();
  });

  it('summarises license, context and size in the one description field it gets', () => {
    const entry = CATALOG[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    const description = describeEntry(entry);
    expect(description).toContain(entry.license);
    expect(description).toContain('context');
    expect(description).toContain('GB');
  });
});

describe('downloadUrl', () => {
  it('builds the Hugging Face resolve/main URL', () => {
    expect(downloadUrl('Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf')).toBe(
      'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    );
  });

  it('builds a URL for every catalog entry', () => {
    for (const entry of CATALOG) {
      expect(catalogEntryUrl(entry)).toBe(
        `https://huggingface.co/${entry.repo}/resolve/main/${entry.filename}`,
      );
    }
  });

  it('rejects a repo that is not exactly owner/name', () => {
    expect(() => downloadUrl('Qwen', 'model.gguf')).toThrow(UnsafeModelPathError);
    expect(() => downloadUrl('a/b/c', 'model.gguf')).toThrow(UnsafeModelPathError);
    expect(() => downloadUrl('/b', 'model.gguf')).toThrow(UnsafeModelPathError);
  });

  it('refuses a filename that could add path segments', () => {
    expect(() => downloadUrl('Qwen/Qwen3-4B-GGUF', '../../etc/passwd.gguf')).toThrow(
      UnsafeModelPathError,
    );
    expect(() => downloadUrl('Qwen/Qwen3-4B-GGUF', 'sub/dir/model.gguf')).toThrow(
      UnsafeModelPathError,
    );
  });
});

describe('assertHttpsUrl', () => {
  it('accepts https', () => {
    expect(assertHttpsUrl('https://huggingface.co/a/b')).toBe('https://huggingface.co/a/b');
  });

  it.each(['http://huggingface.co/a', 'file:///etc/passwd', 'ftp://example.com/x'])(
    'rejects %s',
    (url) => {
      expect(() => assertHttpsUrl(url)).toThrow(UnsafeModelPathError);
    },
  );

  it('rejects a string that is not a URL at all', () => {
    expect(() => assertHttpsUrl('not a url')).toThrow(UnsafeModelPathError);
  });
});

describe('path safety', () => {
  it('resolves a normal id and filename inside the models directory', () => {
    expect(resolveModelPath(ROOT, 'qwen3-4b-q4-k-m', 'Qwen3-4B-Q4_K_M.gguf')).toBe(
      path.join(ROOT, 'qwen3-4b-q4-k-m', 'Qwen3-4B-Q4_K_M.gguf'),
    );
    expect(resolveModelDir(ROOT, 'qwen3-4b-q4-k-m')).toBe(path.join(ROOT, 'qwen3-4b-q4-k-m'));
  });

  it.each([
    ['parent traversal', '../evil'],
    ['nested traversal', 'a/../../evil'],
    ['absolute path', '/etc'],
    ['dot segment', '.'],
    ['double dot', '..'],
    ['null byte', `good${String.fromCharCode(0)}bad`],
    ['newline', 'good\nbad'],
    ['uppercase', 'Qwen3'],
    ['empty', ''],
  ])('refuses a %s model id', (_label, id) => {
    expect(isSafeModelId(id)).toBe(false);
    expect(() => resolveModelPath(ROOT, id, 'model.gguf')).toThrow(UnsafeModelPathError);
    expect(() => resolveModelDir(ROOT, id)).toThrow(UnsafeModelPathError);
  });

  it.each([
    ['parent traversal', '../model.gguf'],
    ['nested traversal', 'a/../../model.gguf'],
    ['absolute path', '/etc/passwd.gguf'],
    ['separator', 'dir/model.gguf'],
    ['null byte', `mod${String.fromCharCode(0)}el.gguf`],
    ['wrong extension', 'model.bin'],
    ['no extension', 'model'],
    ['double dot inside', 'mo..del.gguf'],
    ['empty', ''],
  ])('refuses a %s filename', (_label, filename) => {
    expect(isSafeModelFilename(filename)).toBe(false);
    expect(() => resolveModelPath(ROOT, 'good-id', filename)).toThrow(UnsafeModelPathError);
  });

  it('never resolves outside the models root, even for a root with a trailing separator', () => {
    const resolved = resolveModelPath(`${ROOT}${path.sep}`, 'good-id', 'model.gguf');
    expect(resolved.startsWith(ROOT + path.sep)).toBe(true);
  });
});

describe('deriveModelId', () => {
  it('reuses the catalog id when the repo/file pair is curated', () => {
    const entry = CATALOG[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(deriveModelId(entry.repo, entry.filename)).toBe(entry.id);
  });

  it('slugifies an unknown pair into something the allow-list accepts', () => {
    const id = deriveModelId('SomeOwner/Some.Model-GGUF', 'Some.Model-Q4_K_M.gguf');
    expect(isSafeModelId(id)).toBe(true);
    expect(id).toMatch(/^someowner-some-model-gguf-some-model-q4-k-m-[0-9a-f]{10}$/);
    // Same input, same id: the directory a model lives in has to be stable.
    expect(deriveModelId('SomeOwner/Some.Model-GGUF', 'Some.Model-Q4_K_M.gguf')).toBe(id);
  });

  it('gives colliding slugs distinct ids', () => {
    // Both slugify to `a-b-c-x`: the separator between repo and filename is the
    // same character the slugifier maps `/` and `.` to.
    const first = deriveModelId('a/b-c', 'x.gguf');
    const second = deriveModelId('a/b', 'c-x.gguf');

    expect(first).not.toBe(second);
    expect(isSafeModelId(first)).toBe(true);
    expect(isSafeModelId(second)).toBe(true);
    expect(first.startsWith('a-b-c-x-')).toBe(true);
    expect(second.startsWith('a-b-c-x-')).toBe(true);
  });

  it('keeps a derived id inside the allow-list length even for a long pair', () => {
    const id = deriveModelId(`${'o'.repeat(90)}/${'n'.repeat(90)}`, `${'f'.repeat(200)}.gguf`);
    expect(isSafeModelId(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it('strips traversal out of a hostile repo name rather than passing it through', () => {
    const id = deriveModelId('../../etc', 'passwd.gguf');
    expect(isSafeModelId(id)).toBe(true);
    expect(id).not.toContain('.');
    expect(id).not.toContain('/');
  });
});
