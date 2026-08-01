import { describe, expect, it } from 'vitest';

import type { SupportBreakdownView, SystemInfoView } from '../llmExtra';
import {
  approxDuration,
  approxGigabytes,
  browseSummary,
  catalogGoodFor,
  downloadEtaSentence,
  familyInitial,
  fitFootnote,
  fitSentence,
  fitTooltip,
  formatBadgeLabel,
  heroSentence,
  installedRowSubtitle,
  installedSummary,
  machineChipSummary,
  machineWord,
  modelDisplayName,
  modelFormat,
} from '../modelCopy';

const GIB = 1_073_741_824;

function breakdown(overrides: Partial<SupportBreakdownView> = {}): SupportBreakdownView {
  return {
    verdict: 'GREEN',
    modelSizeBytes: 4 * GIB,
    kvCacheBytes: 2 * GIB,
    totalRequiredBytes: 6 * GIB,
    totalSystemMemoryBytes: 18 * GIB,
    totalVramBytes: 18 * GIB,
    usableVramBytes: 16 * GIB,
    usableTotalMemoryBytes: 18 * GIB,
    reserveBytes: 2 * GIB,
    hasDiscreteGpu: false,
    contextSize: 8192,
    kvCache: null,
    reason: 'main says so',
    ...overrides,
  };
}

function system(overrides: Partial<SystemInfoView> = {}): SystemInfoView {
  return {
    platform: 'darwin',
    arch: 'arm64',
    isAppleSilicon: true,
    hasUnifiedMemory: true,
    cpuModel: 'Apple M3 Pro',
    cpuCores: 12,
    totalRamBytes: 18 * GIB,
    freeRamBytes: 8 * GIB,
    gpus: [],
    totalVramBytes: 18 * GIB,
    vramSource: 'node-llama-cpp',
    gpuBackend: 'metal',
    detectionError: null,
    summary: 'Apple M3 Pro',
    ...overrides,
  };
}

describe('modelFormat', () => {
  it('spots an MLX build from either half of the name', () => {
    expect(modelFormat('mlx-community/Qwen2.5-7B-Instruct-4bit', 'model.safetensors')).toBe('MLX');
    expect(modelFormat('someone/Qwen', 'qwen-mlx.gguf')).toBe('MLX');
  });

  it('does not read MLX out of a longer word', () => {
    expect(modelFormat('acme/mlxtreme-7B-GGUF', 'mlxtreme-7B-Q4_K_M.gguf')).toBe('GGUF');
  });

  it('calls everything else GGUF', () => {
    expect(modelFormat('Qwen/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf')).toBe('GGUF');
  });
});

describe('modelDisplayName', () => {
  it('reads the name off the repo, without the format suffix or the quant', () => {
    expect(modelDisplayName('Qwen/Qwen3-0.6B-GGUF', 'Qwen3-0.6B-Q8_0.gguf')).toBe('Qwen3 0.6B');
    expect(
      modelDisplayName('Qwen/Qwen2.5-1.5B-Instruct-GGUF', 'qwen2.5-1.5b-instruct-q4_k_m.gguf'),
    ).toBe('Qwen2.5 1.5B Instruct');
    expect(
      modelDisplayName(
        'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
        'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
      ),
    ).toBe('Mistral 7B Instruct v0.3');
  });

  it('falls back to the filename when there is no repo name to read', () => {
    expect(modelDisplayName('', 'Some-Model-Q4.gguf')).toBe('Some Model Q4');
  });
});

describe('formatBadgeLabel', () => {
  it('shows the quant for GGUF and nothing extra for a plain MLX build', () => {
    expect(formatBadgeLabel('GGUF', 'Q4_K_M')).toBe('GGUF · Q4_K_M');
    expect(formatBadgeLabel('GGUF', null)).toBe('GGUF');
    expect(formatBadgeLabel('MLX', null)).toBe('MLX');
    expect(formatBadgeLabel('MLX', '4bit')).toBe('MLX · 4bit');
  });
});

describe('familyInitial', () => {
  it('takes the first letter, uppercased', () => {
    expect(familyInitial('qwen3 8B')).toBe('Q');
    expect(familyInitial('  Mistral')).toBe('M');
  });

  it('has something to render for an empty name', () => {
    expect(familyInitial('   ')).toBe('?');
  });
});

describe('catalogGoodFor', () => {
  it('drops the licence, context and size main packed in front of the note', () => {
    expect(
      catalogGoodFor('Apache-2.0 · 32K context · 1.11 GB · The recommended default.'),
    ).toBe('The recommended default.');
  });

  it('passes a bare note through and maps nothing to null', () => {
    expect(catalogGoodFor('Good at drafting notes')).toBe('Good at drafting notes');
    expect(catalogGoodFor(null)).toBeNull();
    expect(catalogGoodFor('')).toBeNull();
  });
});

describe('approxGigabytes', () => {
  it('rounds a memory figure to whole binary gigabytes', () => {
    expect(approxGigabytes(6 * GIB)).toBe('about 6 GB');
    expect(approxGigabytes(6.4 * GIB)).toBe('about 6 GB');
    expect(approxGigabytes(6.6 * GIB)).toBe('about 7 GB');
  });

  it('never says "about 0 GB", and says nothing when nothing was measured', () => {
    expect(approxGigabytes(1000)).toBe('about 1 GB');
    expect(approxGigabytes(null)).toBeNull();
    expect(approxGigabytes(0)).toBeNull();
    expect(approxGigabytes(-1)).toBeNull();
  });
});

describe('machineWord', () => {
  it('says Mac only when it is one', () => {
    expect(machineWord('darwin')).toBe('Mac');
    expect(machineWord('win32')).toBe('machine');
    expect(machineWord(null)).toBe('machine');
  });
});

describe('machineChipSummary', () => {
  it('reads as the design mock does', () => {
    expect(machineChipSummary(system())).toBe('M3 Pro · 18 GB');
  });

  it('degrades to whichever half was detected', () => {
    expect(machineChipSummary(system({ cpuModel: null }))).toBe('18 GB');
    expect(machineChipSummary(system({ totalRamBytes: null }))).toBe('M3 Pro');
    expect(machineChipSummary(system({ cpuModel: null, totalRamBytes: null }))).toBe(
      'Machine not detected',
    );
    expect(machineChipSummary(null)).toBe('Machine not detected');
  });
});

describe('fitSentence', () => {
  it('gives every verdict a sentence with no jargon in it', () => {
    expect(fitSentence('GREEN', 'darwin')).toBe('Runs comfortably');
    expect(fitSentence('YELLOW', 'darwin')).toBe('Tight — other apps may slow down');
    expect(fitSentence('RED', 'darwin')).toBe('Needs more memory than this Mac has');
    expect(fitSentence('RED', 'linux')).toBe('Needs more memory than this machine has');
    expect(fitSentence('LOADING', 'darwin')).toBe('Working out what this needs…');
    expect(fitSentence('GREY', 'darwin')).toBe('Not checked yet');
  });

  it('appends the "good for" note when there is one', () => {
    expect(fitSentence('GREEN', 'darwin', 'good all-round writing')).toBe(
      'Runs comfortably · good all-round writing',
    );
    expect(fitSentence('GREEN', 'darwin', '   ')).toBe('Runs comfortably');
    expect(fitSentence('GREEN', 'darwin', null)).toBe('Runs comfortably');
  });
});

describe('fitTooltip', () => {
  it('explains a green verdict with the numbers it was computed from', () => {
    const tooltip = fitTooltip('GREEN', breakdown(), 'GGUF', 'darwin');
    expect(tooltip.title).toBe('Why this one:');
    expect(tooltip.body).toBe('It needs about 6 GB while running, leaving 12 GB for everything else.');
  });

  it('leads with the GPU advantage for an MLX build', () => {
    const tooltip = fitTooltip('GREEN', breakdown(), 'MLX', 'darwin');
    expect(tooltip.body).toContain("uses this Mac's GPU directly");
    expect(tooltip.body).toContain('It needs about 6 GB while running');
  });

  it('says what is tight about a warning', () => {
    const tooltip = fitTooltip(
      'YELLOW',
      breakdown({ verdict: 'YELLOW', totalRequiredBytes: 9 * GIB }),
      'GGUF',
      'darwin',
    );
    expect(tooltip.title).toBe('Why the warning:');
    expect(tooltip.body).toBe(
      'This build needs about 9 GB of the 18 GB this Mac has usable. It runs, but a big browser session alongside it will start swapping.',
    );
  });

  it('explains a red verdict without softening it', () => {
    const tooltip = fitTooltip(
      'RED',
      breakdown({ verdict: 'RED', totalRequiredBytes: 30 * GIB }),
      'GGUF',
      'darwin',
    );
    expect(tooltip.title).toBe('Why it will not fit:');
    expect(tooltip.body).toContain('about 30 GB, more than the 18 GB');
  });

  it('invents no numbers when nothing has read the header', () => {
    for (const verdict of ['GREEN', 'YELLOW', 'RED', 'GREY', 'LOADING'] as const) {
      const tooltip = fitTooltip(verdict, null, 'GGUF', 'darwin');
      expect(tooltip.body).not.toMatch(/about \d/);
      expect(tooltip.title.length).toBeGreaterThan(0);
    }
  });
});

describe('heroSentence', () => {
  it('says what it is good at, then what it costs', () => {
    expect(
      heroSentence(
        'Good at drafting invoice notes and answering questions about your clients',
        4_372_812_000,
        6 * GIB,
      ),
    ).toBe(
      'Good at drafting invoice notes and answering questions about your clients. 4.37 GB download, uses about 6 GB of memory while running.',
    );
  });

  it('drops the memory clause rather than guessing it', () => {
    expect(heroSentence('Handy.', 4_372_812_000, null)).toBe('Handy. 4.37 GB download.');
    expect(heroSentence(null, null, null)).toBe('');
    expect(heroSentence(null, null, 6 * GIB)).toBe('Uses about 6 GB of memory while running.');
  });
});

describe('approxDuration', () => {
  it('rounds the way somebody waiting would', () => {
    expect(approxDuration(42)).toBe('about 40 sec');
    expect(approxDuration(250)).toBe('about 4 min');
    expect(approxDuration(7200)).toBe('about 2 hr');
  });

  it('has nothing to say about a non-duration', () => {
    expect(approxDuration(0)).toBeNull();
    expect(approxDuration(Number.NaN)).toBeNull();
  });
});

describe('downloadEtaSentence', () => {
  it('quotes a time only when a real rate was measured', () => {
    expect(downloadEtaSentence(4_372_812_000, 18_000_000)).toBe('about 4 min on this connection');
    expect(downloadEtaSentence(4_372_812_000, 0)).toBeNull();
    expect(downloadEtaSentence(4_372_812_000, null)).toBeNull();
    expect(downloadEtaSentence(null, 18_000_000)).toBeNull();
  });
});

describe('installedSummary', () => {
  it('reads as the design mock does, and singularises', () => {
    expect(installedSummary(2, 6_400_000_000)).toBe('2 models · 6.40 GB on disk');
    expect(installedSummary(1, 4_400_000_000)).toBe('1 model · 4.40 GB on disk');
    expect(installedSummary(0, 0)).toBe('Nothing downloaded yet');
  });
});

describe('browseSummary', () => {
  it('counts the curated builds it actually has', () => {
    expect(browseSummary(6)).toBe('6 curated builds, plus search across Hugging Face');
    expect(browseSummary(1)).toBe('1 curated build, plus search across Hugging Face');
  });
});

describe('installedRowSubtitle', () => {
  it('adds the note only when there is one', () => {
    expect(installedRowSubtitle(2_000_000_000, 'faster, less accurate')).toBe(
      '2.00 GB on disk · faster, less accurate',
    );
    expect(installedRowSubtitle(2_000_000_000, null)).toBe('2.00 GB on disk');
  });
});

describe('fitFootnote', () => {
  it('states the two constants every verdict was judged against', () => {
    expect(fitFootnote(8192, 2_288_490_189)).toBe(
      'Fit is judged at a 8k context with 2 GB held back for the system.',
    );
  });

  it('spells out a context that is not a whole number of k', () => {
    expect(fitFootnote(6000, 2 * GIB)).toContain('6,000-token context');
  });
});
