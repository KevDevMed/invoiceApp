import { describe, expect, it } from 'vitest';

import type { SupportVerdict } from '../llmExtra';
import type { CatalogEntryView } from '../useModels';
import { recommendModel } from '../recommendation';

function entry(overrides: Partial<CatalogEntryView> & { id: string }): CatalogEntryView {
  return {
    repo: `acme/${overrides.id}-GGUF`,
    filename: `${overrides.id}.gguf`,
    quant: 'Q4_K_M',
    sizeBytes: 1_000_000_000,
    description: null,
    ...overrides,
  };
}

function verdicts(map: Record<string, SupportVerdict>) {
  return (repo: string, filename: string): SupportVerdict => map[`${repo}/${filename}`] ?? 'GREY';
}

describe('recommendModel', () => {
  it('has no recommendation before any verdict has come back', () => {
    expect(recommendModel([entry({ id: 'a' })], verdicts({}))).toBeNull();
    expect(
      recommendModel([entry({ id: 'a' })], verdicts({ 'acme/a-GGUF/a.gguf': 'LOADING' })),
    ).toBeNull();
  });

  it('has no recommendation for an empty catalog', () => {
    expect(recommendModel([], verdicts({}))).toBeNull();
  });

  it('never recommends a model it expects to fail', () => {
    expect(
      recommendModel([entry({ id: 'a' })], verdicts({ 'acme/a-GGUF/a.gguf': 'RED' })),
    ).toBeNull();
  });

  it('prefers a comfortable fit over a tight one, even a much bigger tight one', () => {
    const result = recommendModel(
      [
        entry({ id: 'tight', sizeBytes: 9_000_000_000 }),
        entry({ id: 'comfy', sizeBytes: 2_000_000_000 }),
      ],
      verdicts({
        'acme/tight-GGUF/tight.gguf': 'YELLOW',
        'acme/comfy-GGUF/comfy.gguf': 'GREEN',
      }),
    );
    expect(result?.entry.id).toBe('comfy');
    expect(result?.verdict).toBe('GREEN');
  });

  it('falls back to a tight fit when nothing fits comfortably', () => {
    const result = recommendModel(
      [entry({ id: 'tight' })],
      verdicts({ 'acme/tight-GGUF/tight.gguf': 'YELLOW' }),
    );
    expect(result?.entry.id).toBe('tight');
    expect(result?.verdict).toBe('YELLOW');
  });

  it('prefers an MLX build over a GGUF one when both fit', () => {
    const result = recommendModel(
      [
        entry({ id: 'gguf', repo: 'acme/Model-GGUF', filename: 'model-q4.gguf', sizeBytes: 5_000 }),
        entry({ id: 'mlx', repo: 'mlx-community/Model-4bit', filename: 'model.safetensors', sizeBytes: 4_000 }),
      ],
      verdicts({
        'acme/Model-GGUF/model-q4.gguf': 'GREEN',
        'mlx-community/Model-4bit/model.safetensors': 'GREEN',
      }),
    );
    expect(result?.entry.id).toBe('mlx');
    expect(result?.format).toBe('MLX');
  });

  it('takes the largest of the builds that fit', () => {
    const result = recommendModel(
      [
        entry({ id: 'small', sizeBytes: 600_000_000 }),
        entry({ id: 'big', sizeBytes: 5_000_000_000 }),
        entry({ id: 'huge', sizeBytes: 40_000_000_000 }),
      ],
      verdicts({
        'acme/small-GGUF/small.gguf': 'GREEN',
        'acme/big-GGUF/big.gguf': 'GREEN',
        'acme/huge-GGUF/huge.gguf': 'RED',
      }),
    );
    expect(result?.entry.id).toBe('big');
  });

  it('breaks a dead heat by id so the hero cannot flicker between refreshes', () => {
    const catalog = [entry({ id: 'zeta' }), entry({ id: 'alpha' })];
    const map = verdicts({
      'acme/zeta-GGUF/zeta.gguf': 'GREEN',
      'acme/alpha-GGUF/alpha.gguf': 'GREEN',
    });
    expect(recommendModel(catalog, map)?.entry.id).toBe('alpha');
    // Same data, opposite arrival order: same answer.
    expect(recommendModel([...catalog].reverse(), map)?.entry.id).toBe('alpha');
  });
});
