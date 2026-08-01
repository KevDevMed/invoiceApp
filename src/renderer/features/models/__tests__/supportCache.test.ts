import { describe, expect, it } from 'vitest';

import type { DiscoveredVariantView, VariantSupportView } from '../llmExtra';
import { applyDiscoveryFold, foldDiscoveryVerdicts, foldIsEmpty } from '../supportCache';

function support(overrides: Partial<VariantSupportView> = {}): VariantSupportView {
  return {
    repo: 'a/Foo-GGUF',
    filename: 'foo.gguf',
    sizeBytes: 1_000,
    contextSize: 8192,
    breakdown: {
      verdict: 'GREEN',
      modelSizeBytes: 1,
      kvCacheBytes: 1,
      totalRequiredBytes: 2,
      totalSystemMemoryBytes: 10,
      totalVramBytes: 0,
      usableVramBytes: 0,
      usableTotalMemoryBytes: 8,
      reserveBytes: 2,
      hasDiscreteGpu: false,
      contextSize: 8192,
      kvCache: null,
      reason: 'fits',
    },
    architecture: 'qwen3',
    maxContextLength: 32_768,
    checkedAt: '2026-01-01T00:00:00.000Z',
    error: null,
    ...overrides,
  };
}

function discovered(overrides: Partial<DiscoveredVariantView> = {}): DiscoveredVariantView {
  return {
    repo: 'a/Foo-GGUF',
    filename: 'foo.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 1_000,
    sha256: null,
    license: null,
    gated: false,
    isPrivate: false,
    downloads: null,
    likes: null,
    verdict: 'GREEN',
    support: support(),
    reason: 'fits',
    ...overrides,
  };
}

const nothingFresh = (): boolean => false;

describe('foldDiscoveryVerdicts', () => {
  it('caches a real verdict and marks the key answered', () => {
    const fold = foldDiscoveryVerdicts([discovered()], nothingFresh);

    expect(Object.keys(fold.apply)).toEqual(['a/Foo-GGUF/foo.gguf']);
    expect(fold.answered).toEqual(['a/Foo-GGUF/foo.gguf']);
    expect(fold.clear).toEqual([]);
  });

  it('clears a key the sweep had no verdict for, and does not mark it answered', () => {
    const fold = foldDiscoveryVerdicts([discovered({ support: null })], nothingFresh);

    expect(fold.apply).toEqual({});
    expect(fold.answered).toEqual([]);
    expect(fold.clear).toEqual(['a/Foo-GGUF/foo.gguf']);
  });

  it('treats a failed check the same as no check at all', () => {
    const fold = foldDiscoveryVerdicts(
      [discovered({ support: support({ error: 'range request refused' }) })],
      nothingFresh,
    );

    expect(fold.apply).toEqual({});
    expect(fold.answered).toEqual([]);
    expect(fold.clear).toEqual(['a/Foo-GGUF/foo.gguf']);
  });

  it('leaves a verdict the current machine reading already produced', () => {
    const fold = foldDiscoveryVerdicts(
      [discovered({ support: null })],
      (key) => key === 'a/Foo-GGUF/foo.gguf',
    );

    expect(fold.clear).toEqual([]);
    expect(fold.answered).toEqual([]);
  });

  it('has nothing to do with an empty sweep', () => {
    expect(foldIsEmpty(foldDiscoveryVerdicts([], nothingFresh))).toBe(true);
  });
});

describe('applyDiscoveryFold', () => {
  it('drops a stale verdict rather than leaving it in place', () => {
    const before = { 'a/Foo-GGUF/foo.gguf': support({ breakdown: support().breakdown }) };
    const fold = foldDiscoveryVerdicts([discovered({ support: null })], nothingFresh);

    expect(applyDiscoveryFold(before, fold)).toEqual({});
  });

  it('writes the verdicts the sweep did produce', () => {
    const fold = foldDiscoveryVerdicts([discovered()], nothingFresh);
    const after = applyDiscoveryFold({}, fold);

    expect(after['a/Foo-GGUF/foo.gguf']?.breakdown.verdict).toBe('GREEN');
  });

  it('never clears a key the same fold wrote', () => {
    const fold = foldDiscoveryVerdicts(
      [discovered(), discovered({ support: null })],
      nothingFresh,
    );
    const after = applyDiscoveryFold({}, fold);

    expect(Object.keys(after)).toEqual(['a/Foo-GGUF/foo.gguf']);
  });

  it('leaves other keys alone', () => {
    const other = support({ repo: 'b/Bar-GGUF', filename: 'bar.gguf' });
    const fold = foldDiscoveryVerdicts([discovered({ support: null })], nothingFresh);

    expect(Object.keys(applyDiscoveryFold({ 'b/Bar-GGUF/bar.gguf': other }, fold))).toEqual([
      'b/Bar-GGUF/bar.gguf',
    ]);
  });
});
