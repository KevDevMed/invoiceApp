/**
 * Discovery: the size prefilter, the per-repo cap, the header-check ceiling and
 * the fit ordering. Search, lookup and the support service are all fakes — the
 * point of this module is the arithmetic between them, not the network.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SupportVerdict } from '../compatibility';
import {
  compareByFit,
  discoverModels,
  isProjectorFile,
  type DiscoveredVariant,
} from '../discovery';
import type { HfRepoInfo, HfSearchHit } from '../hf';
import type { CheckRequest, VariantSupport } from '../support-service';

const GIB = 1_073_741_824;

function hit(repo: string, downloads = 1000): HfSearchHit {
  return {
    repo,
    downloads,
    likes: 10,
    gated: false,
    isPrivate: false,
    lastModified: '2025-01-01T00:00:00.000Z',
    tags: ['gguf'],
  };
}

function repoInfo(repo: string, files: Array<[string, number]>): HfRepoInfo {
  return {
    repo,
    gated: false,
    isPrivate: false,
    license: 'apache-2.0',
    lastModified: '2025-01-01T00:00:00.000Z',
    variants: files.map(([filename, sizeBytes]) => ({
      filename,
      quant: filename.includes('Q4') ? 'Q4_K_M' : 'Q8_0',
      sizeBytes,
      sha256: 'a'.repeat(64),
      downloadUrl: `https://huggingface.co/${repo}/resolve/main/${filename}`,
      isSplit: false,
    })),
    skippedSplitFiles: [],
  };
}

function supportFor(request: CheckRequest, verdict: SupportVerdict): VariantSupport {
  return {
    repo: request.repo,
    filename: request.filename,
    sizeBytes: request.sizeBytes ?? null,
    contextSize: 8192,
    breakdown: {
      verdict,
      modelSizeBytes: request.sizeBytes ?? 0,
      kvCacheBytes: 0,
      totalRequiredBytes: request.sizeBytes ?? 0,
      totalSystemMemoryBytes: 0,
      totalVramBytes: 8 * GIB,
      usableVramBytes: 6 * GIB,
      usableTotalMemoryBytes: 6 * GIB,
      reserveBytes: 0,
      hasDiscreteGpu: false,
      contextSize: 8192,
      kvCache: null,
      reason: `${verdict} for ${request.filename}`,
    },
    architecture: 'llama',
    maxContextLength: 32_768,
    checkedAt: '2025-01-01T00:00:00.000Z',
    error: null,
  };
}

/** Usable budget of 6 GiB, and whatever verdict the caller dictates per file. */
function deps(
  options: {
    hits?: HfSearchHit[];
    repos?: Record<string, HfRepoInfo>;
    usable?: number;
    verdict?: (request: CheckRequest) => SupportVerdict;
    lookupFails?: Set<string>;
  } = {},
) {
  const usable = options.usable ?? 6 * GIB;
  const checkMany = vi.fn(async (requests: readonly CheckRequest[]) =>
    requests.map((request) => supportFor(request, options.verdict?.(request) ?? 'GREEN')),
  );
  const search = vi.fn(async () => options.hits ?? []);
  const lookup = vi.fn(async (repo: string) => {
    if (options.lookupFails?.has(repo)) throw new Error(`${repo} is gated`);
    const info = options.repos?.[repo];
    if (!info) throw new Error(`no fixture for ${repo}`);
    return info;
  });

  return {
    deps: {
      support: {
        budget: async () => ({
          hasDiscreteGpu: false,
          totalSystemMemoryBytes: 0,
          totalVramBytes: usable,
          usableVramBytes: usable,
          usableTotalMemoryBytes: usable,
        }),
        checkMany,
      },
      search,
      lookup,
    },
    checkMany,
    search,
    lookup,
  };
}

describe('discoverModels', () => {
  it('never checks a file whose weights alone exceed usable memory', async () => {
    const fixture = deps({
      hits: [hit('acme/big-GGUF')],
      repos: {
        'acme/big-GGUF': repoInfo('acme/big-GGUF', [
          ['big-Q8_0.gguf', 20 * GIB],
          ['big-Q4_K_M.gguf', 4 * GIB],
        ]),
      },
    });

    const result = await discoverModels(fixture.deps);

    expect(fixture.checkMany).toHaveBeenCalledTimes(1);
    const requested = fixture.checkMany.mock.calls[0]![0].map((request) => request.filename);
    expect(requested).toEqual(['big-Q4_K_M.gguf']);
    expect(result.variantsTooBig).toBe(1);
    expect(result.variantsChecked).toBe(1);
  });

  it('never offers a multimodal projector as if it were a model', async () => {
    const fixture = deps({
      hits: [hit('unsloth/vision-GGUF')],
      repos: {
        'unsloth/vision-GGUF': repoInfo('unsloth/vision-GGUF', [
          // Small enough to pass the size filter, and useless on its own.
          ['mmproj-F16.gguf', 1 * GIB],
          ['mmproj-BF16.gguf', 1 * GIB],
          ['vision-Q4_K_M.gguf', 3 * GIB],
        ]),
      },
    });

    const result = await discoverModels(fixture.deps);

    const requested = fixture.checkMany.mock.calls[0]![0].map((request) => request.filename);
    expect(requested).toEqual(['vision-Q4_K_M.gguf']);
    expect(result.variantsProjectors).toBe(2);
    expect(result.variantsFound).toBe(1);
    expect(result.models.map((model) => model.filename)).toEqual(['vision-Q4_K_M.gguf']);
  });

  it('keeps only the largest quants per repo and counts the rest', async () => {
    const fixture = deps({
      hits: [hit('acme/many-GGUF')],
      repos: {
        'acme/many-GGUF': repoInfo('acme/many-GGUF', [
          ['many-Q2_K.gguf', 1 * GIB],
          ['many-Q4_K_M.gguf', 2 * GIB],
          ['many-Q5_K_M.gguf', 3 * GIB],
          ['many-Q8_0.gguf', 4 * GIB],
        ]),
      },
    });

    const result = await discoverModels(fixture.deps, { maxVariantsPerRepo: 2 });

    const requested = fixture.checkMany.mock.calls[0]![0].map((request) => request.filename);
    expect(requested).toEqual(['many-Q8_0.gguf', 'many-Q5_K_M.gguf']);
    expect(result.variantsDeduplicated).toBe(2);
    expect(result.variantsFound).toBe(4);
  });

  it('skips the prefilter entirely when memory could not be measured', async () => {
    const fixture = deps({
      usable: 0,
      hits: [hit('acme/big-GGUF')],
      repos: {
        'acme/big-GGUF': repoInfo('acme/big-GGUF', [['big-Q8_0.gguf', 200 * GIB]]),
      },
      verdict: () => 'GREY',
    });

    const result = await discoverModels(fixture.deps);

    expect(result.usableMemoryBytes).toBeNull();
    expect(result.variantsTooBig).toBe(0);
    expect(result.variantsChecked).toBe(1);
  });

  it('caps header reads and reports every file it did not verify', async () => {
    const repos: Record<string, HfRepoInfo> = {};
    const hits: HfSearchHit[] = [];
    for (let index = 0; index < 5; index += 1) {
      const repo = `acme/model-${index}-GGUF`;
      hits.push(hit(repo));
      repos[repo] = repoInfo(repo, [[`model-${index}-Q4_K_M.gguf`, (index + 1) * GIB]]);
    }
    const fixture = deps({ hits, repos });

    const result = await discoverModels(fixture.deps, { maxChecks: 2 });

    expect(result.variantsChecked).toBe(2);
    expect(result.variantsUnchecked).toBe(3);
    expect(result.warnings.some((warning) => warning.includes('3 more files'))).toBe(true);
    // The biggest that fit are the ones worth the range read.
    const requested = fixture.checkMany.mock.calls[0]![0].map((request) => request.filename);
    expect(requested).toEqual(['model-4-Q4_K_M.gguf', 'model-3-Q4_K_M.gguf']);
    // The rest still appear, as unverified rows rather than as nothing.
    expect(result.models).toHaveLength(5);
    const unverified = result.models.filter((model) => model.support === null);
    expect(unverified).toHaveLength(3);
    expect(unverified.every((model) => model.verdict === 'GREY')).toBe(true);
  });

  it('keeps going when one repo listing fails, and says which', async () => {
    const fixture = deps({
      hits: [hit('acme/ok-GGUF'), hit('acme/gated-GGUF')],
      repos: { 'acme/ok-GGUF': repoInfo('acme/ok-GGUF', [['ok-Q4_K_M.gguf', 2 * GIB]]) },
      lookupFails: new Set(['acme/gated-GGUF']),
    });

    const result = await discoverModels(fixture.deps);

    expect(result.reposFound).toBe(2);
    expect(result.reposInspected).toBe(1);
    expect(result.models).toHaveLength(1);
    expect(result.warnings).toContain('acme/gated-GGUF: acme/gated-GGUF is gated');
  });

  it('orders what runs before what might before what will not', async () => {
    const verdicts: Record<string, SupportVerdict> = {
      'a-Q4_K_M.gguf': 'RED',
      'b-Q4_K_M.gguf': 'GREEN',
      'c-Q4_K_M.gguf': 'YELLOW',
    };
    const fixture = deps({
      hits: [hit('acme/a-GGUF'), hit('acme/b-GGUF'), hit('acme/c-GGUF')],
      repos: {
        'acme/a-GGUF': repoInfo('acme/a-GGUF', [['a-Q4_K_M.gguf', 3 * GIB]]),
        'acme/b-GGUF': repoInfo('acme/b-GGUF', [['b-Q4_K_M.gguf', 2 * GIB]]),
        'acme/c-GGUF': repoInfo('acme/c-GGUF', [['c-Q4_K_M.gguf', 1 * GIB]]),
      },
      verdict: (request) => verdicts[request.filename] ?? 'GREY',
    });

    const result = await discoverModels(fixture.deps);

    expect(result.models.map((model) => model.filename)).toEqual([
      'b-Q4_K_M.gguf',
      'c-Q4_K_M.gguf',
      'a-Q4_K_M.gguf',
    ]);
  });

  it('passes the requested context size through to every check', async () => {
    const fixture = deps({
      hits: [hit('acme/ok-GGUF')],
      repos: { 'acme/ok-GGUF': repoInfo('acme/ok-GGUF', [['ok-Q4_K_M.gguf', 2 * GIB]]) },
    });

    await discoverModels(fixture.deps, { ctxSize: 32_768 });

    expect(fixture.checkMany.mock.calls[0]![0][0]!.ctxSize).toBe(32_768);
  });
});

describe('compareByFit', () => {
  const row = (verdict: SupportVerdict, sizeBytes: number): DiscoveredVariant => ({
    repo: 'acme/x-GGUF',
    filename: `x-${sizeBytes}.gguf`,
    quant: 'Q4_K_M',
    sizeBytes,
    sha256: null,
    license: null,
    gated: false,
    isPrivate: false,
    downloads: null,
    likes: null,
    verdict,
    support: null,
    reason: '',
  });

  it('prefers the biggest model within one verdict', () => {
    const sorted = [row('GREEN', 1 * GIB), row('GREEN', 4 * GIB)].sort(compareByFit);
    expect(sorted[0]!.sizeBytes).toBe(4 * GIB);
  });

  it('puts unknown ahead of known-impossible', () => {
    const sorted = [row('RED', 4 * GIB), row('GREY', 1 * GIB)].sort(compareByFit);
    expect(sorted[0]!.verdict).toBe('GREY');
  });
});

describe('isProjectorFile', () => {
  it('recognises the projector names that ship next to weights', () => {
    expect(isProjectorFile('mmproj-F16.gguf')).toBe(true);
    expect(isProjectorFile('Qwen3-VL-mmproj-BF16.gguf')).toBe(true);
    expect(isProjectorFile('mmproj.gguf')).toBe(true);
  });

  it('does not swallow a real model whose name merely contains the letters', () => {
    expect(isProjectorFile('Qwen3-4B-Q4_K_M.gguf')).toBe(false);
    expect(isProjectorFile('mmprojectorish-8B-Q4_K_M.gguf')).toBe(false);
  });
});
