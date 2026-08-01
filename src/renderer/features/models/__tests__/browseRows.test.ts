import { describe, expect, it } from 'vitest';

import {
  browseFooterSentence,
  buildBrowseRows,
  parseModelQuery,
  visibleBrowseRows,
  type BrowseRow,
} from '../browseRows';
import type {
  DiscoveredVariantView,
  DiscoveryView,
  HfRepoView,
  SupportVerdict,
} from '../llmExtra';
import type { CatalogEntryView } from '../useModels';

function entry(overrides: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    id: 'qwen3-8b',
    repo: 'Qwen/Qwen3-8B-GGUF',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 5_027_783_488,
    description: 'Apache-2.0 · 32K context · 5.03 GB · The most capable option here.',
    ...overrides,
  };
}

function discovered(overrides: Partial<DiscoveredVariantView> = {}): DiscoveredVariantView {
  return {
    repo: 'bartowski/Foo-GGUF',
    filename: 'Foo-Q4_K_M.gguf',
    quant: 'Q4_K_M',
    sizeBytes: 1_000,
    sha256: null,
    license: null,
    gated: false,
    isPrivate: false,
    downloads: null,
    likes: null,
    verdict: 'GREEN',
    support: null,
    reason: 'fits',
    ...overrides,
  };
}

function discovery(models: DiscoveredVariantView[]): DiscoveryView {
  return {
    query: '',
    contextSize: 8192,
    usableMemoryBytes: null,
    models,
    reposFound: 1,
    reposInspected: 1,
    variantsFound: models.length,
    variantsTooBig: 0,
    variantsDeduplicated: 0,
    variantsProjectors: 0,
    variantsChecked: models.length,
    variantsUnchecked: 0,
    warnings: [],
    checkedAt: '2026-01-01T00:00:00.000Z',
  };
}

function hfRepo(overrides: Partial<HfRepoView> = {}): HfRepoView {
  return {
    repo: 'someone/Pasted-GGUF',
    gated: false,
    isPrivate: false,
    license: null,
    lastModified: null,
    variants: [
      {
        filename: 'Pasted-Q4_K_M.gguf',
        quant: 'Q4_K_M',
        sizeBytes: 2_000,
        downloadUrl: 'https://huggingface.co/x',
        isSplit: false,
      },
    ],
    skippedSplitFiles: [],
    ...overrides,
  };
}

/** Verdicts by `repo/filename`; anything unlisted is unchecked. */
function verdicts(map: Record<string, SupportVerdict>) {
  return (repo: string, filename: string): SupportVerdict => map[`${repo}/${filename}`] ?? 'GREY';
}

describe('buildBrowseRows', () => {
  it('merges the three sources into one list and flags where each came from', () => {
    const rows = buildBrowseRows({
      catalog: [entry()],
      hfRepo: hfRepo(),
      discovery: discovery([discovered()]),
      verdictOf: verdicts({
        'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf': 'GREEN',
        'someone/Pasted-GGUF/Pasted-Q4_K_M.gguf': 'GREEN',
        'bartowski/Foo-GGUF/Foo-Q4_K_M.gguf': 'GREEN',
      }),
    });

    expect(rows.map((row) => row.source)).toEqual(['lookup', 'catalog', 'search']);
    expect(rows.map((row) => row.key)).toEqual([
      'someone/Pasted-GGUF/Pasted-Q4_K_M.gguf',
      'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf',
      'bartowski/Foo-GGUF/Foo-Q4_K_M.gguf',
    ]);
  });

  it('deduplicates by id and keeps the catalog flag when a search returns a curated build', () => {
    const rows = buildBrowseRows({
      catalog: [entry()],
      hfRepo: null,
      discovery: discovery([
        discovered({ repo: 'Qwen/Qwen3-8B-GGUF', filename: 'Qwen3-8B-Q4_K_M.gguf' }),
      ]),
      verdictOf: verdicts({ 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf': 'GREEN' }),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('catalog');
  });

  it('orders best fit first, keeping unchecked rows above a known bad one', () => {
    const rows = buildBrowseRows({
      catalog: [
        entry({ id: 'red', repo: 'a/red-GGUF', filename: 'red.gguf' }),
        entry({ id: 'grey', repo: 'a/grey-GGUF', filename: 'grey.gguf' }),
        entry({ id: 'yellow', repo: 'a/yellow-GGUF', filename: 'yellow.gguf' }),
        entry({ id: 'green', repo: 'a/green-GGUF', filename: 'green.gguf' }),
      ],
      hfRepo: null,
      discovery: null,
      verdictOf: verdicts({
        'a/red-GGUF/red.gguf': 'RED',
        'a/yellow-GGUF/yellow.gguf': 'YELLOW',
        'a/green-GGUF/green.gguf': 'GREEN',
      }),
    });

    expect(rows.map((row) => row.verdict)).toEqual(['GREEN', 'YELLOW', 'GREY', 'RED']);
  });

  it('keeps the order main ranked equal-verdict rows in', () => {
    const rows = buildBrowseRows({
      catalog: [],
      hfRepo: null,
      discovery: discovery([
        discovered({ repo: 'a/first-GGUF', filename: 'first.gguf' }),
        discovered({ repo: 'a/second-GGUF', filename: 'second.gguf' }),
      ]),
      verdictOf: verdicts({
        'a/first-GGUF/first.gguf': 'GREEN',
        'a/second-GGUF/second.gguf': 'GREEN',
      }),
    });

    expect(rows.map((row) => row.repo)).toEqual(['a/first-GGUF', 'a/second-GGUF']);
  });

  it('carries the badge fields each row renders', () => {
    const rows = buildBrowseRows({
      catalog: [entry()],
      hfRepo: null,
      discovery: null,
      verdictOf: verdicts({}),
    });

    expect(rows[0]!.displayName).toBe('Qwen3 8B');
    expect(rows[0]!.format).toBe('GGUF');
    expect(rows[0]!.quant).toBe('Q4_K_M');
  });

  it('is empty when there is nothing anywhere', () => {
    expect(
      buildBrowseRows({ catalog: [], hfRepo: null, discovery: null, verdictOf: verdicts({}) }),
    ).toEqual([]);
  });
});

describe('visibleBrowseRows', () => {
  const rows = [
    { verdict: 'GREEN' },
    { verdict: 'YELLOW' },
    { verdict: 'GREY' },
    { verdict: 'RED' },
    { verdict: 'RED' },
  ] as BrowseRow[];

  it('shows everything when the filter is off', () => {
    const visibility = visibleBrowseRows(rows, false);
    expect(visibility.showing).toBe(5);
    expect(visibility.hiddenTooBig).toBe(0);
    expect(visibility.hiddenUnchecked).toBe(0);
  });

  it('keeps what runs and splits the rest by why it went', () => {
    const visibility = visibleBrowseRows(rows, true);
    expect(visibility.rows.map((row) => row.verdict)).toEqual(['GREEN', 'YELLOW']);
    expect(visibility.showing).toBe(2);
    expect(visibility.hiddenTooBig).toBe(2);
    expect(visibility.hiddenUnchecked).toBe(1);
  });
});

describe('browseFooterSentence', () => {
  it('reads as the design mock does when memory is the only reason', () => {
    expect(
      browseFooterSentence(
        { rows: [], showing: 14, hiddenTooBig: 8, hiddenUnchecked: 0 },
        'darwin',
      ),
    ).toBe('Showing 14 — 8 hidden because they need more memory than this Mac has.');
  });

  it('never blames memory for a row that was simply not checked', () => {
    expect(
      browseFooterSentence({ rows: [], showing: 3, hiddenTooBig: 0, hiddenUnchecked: 2 }, 'linux'),
    ).toBe('Showing 3 — 2 not checked yet.');
    expect(
      browseFooterSentence({ rows: [], showing: 3, hiddenTooBig: 1, hiddenUnchecked: 2 }, 'linux'),
    ).toBe(
      'Showing 3 — 1 hidden because they need more memory than this machine has, and 2 not checked yet.',
    );
  });

  it('says nothing about hiding when nothing is hidden', () => {
    expect(
      browseFooterSentence({ rows: [], showing: 6, hiddenTooBig: 0, hiddenUnchecked: 0 }, 'darwin'),
    ).toBe('Showing 6.');
  });
});

describe('parseModelQuery', () => {
  it('treats a bare owner/name as a repo lookup', () => {
    expect(parseModelQuery('bartowski/Qwen2.5-7B-Instruct-GGUF')).toEqual({
      kind: 'repo',
      repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    });
    expect(parseModelQuery('  Qwen/Qwen3-8B-GGUF  ')).toEqual({
      kind: 'repo',
      repo: 'Qwen/Qwen3-8B-GGUF',
    });
  });

  it('pulls the repo out of every shape of Hub URL', () => {
    for (const url of [
      'https://huggingface.co/bartowski/Foo-GGUF',
      'http://www.huggingface.co/bartowski/Foo-GGUF/tree/main',
      'huggingface.co/models/bartowski/Foo-GGUF',
      'https://huggingface.co/bartowski/Foo-GGUF?library=true',
    ]) {
      expect(parseModelQuery(url)).toEqual({ kind: 'repo', repo: 'bartowski/Foo-GGUF' });
    }
  });

  it('treats a phrase as a search, including one with a slash in it', () => {
    expect(parseModelQuery('qwen3 instruct')).toEqual({ kind: 'search', term: 'qwen3 instruct' });
    expect(parseModelQuery('small model / fast')).toEqual({
      kind: 'search',
      term: 'small model / fast',
    });
    expect(parseModelQuery('qwen')).toEqual({ kind: 'search', term: 'qwen' });
  });

  it('reports an empty field as empty', () => {
    expect(parseModelQuery('')).toEqual({ kind: 'empty' });
    expect(parseModelQuery('   ')).toEqual({ kind: 'empty' });
  });
});
