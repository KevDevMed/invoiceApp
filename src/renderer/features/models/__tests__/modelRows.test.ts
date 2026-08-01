import { describe, expect, it } from 'vitest';

import type { DiscoveredVariantView, LocalModel, SmokeTestView } from '../llmExtra';
import {
  countByFit,
  countChecks,
  diskUsageBytes,
  fitsMachine,
  groupDiscovered,
  smokeTestStatus,
  transferState,
  verdictStatus,
  type TransferRecord,
} from '../modelRows';
import type { DownloadState } from '../useModels';

function progress(overrides: Partial<DownloadState> = {}): DownloadState {
  return {
    receivedBytes: 0,
    totalBytes: null,
    status: 'downloading',
    error: null,
    bytesPerSecond: 0,
    etaSeconds: null,
    ...overrides,
  };
}

function record(overrides: Partial<TransferRecord> = {}): TransferRecord {
  return {
    status: 'ready',
    downloadedBytes: 0,
    sizeBytes: null,
    error: null,
    ...overrides,
  };
}

function smokeTest(overrides: Partial<SmokeTestView> = {}): SmokeTestView {
  return {
    kind: 'smokeTest',
    modelId: 'model-1',
    verdict: 'pass',
    loadMs: 900,
    timeToFirstTokenMs: 120,
    generationMs: 800,
    tokensGenerated: 32,
    tokensPerSecond: 41,
    peakRssBytes: null,
    contextSize: 8192,
    maxTokens: 64,
    text: 'hello',
    error: null,
    failureKind: null,
    ranAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('transferState', () => {
  it('reports nothing in flight when there is no record and no event', () => {
    expect(transferState(null, null, null)).toEqual({
      isDownloading: false,
      isReady: false,
      isPaused: false,
      failure: null,
      receivedBytes: 0,
      totalBytes: null,
      percent: 0,
    });
  });

  it('lets the live event win over a stale record', () => {
    const state = transferState(
      progress({ status: 'downloading', receivedBytes: 50, totalBytes: 200 }),
      record({ status: 'ready', downloadedBytes: 200, sizeBytes: 200 }),
      null,
    );
    expect(state.isDownloading).toBe(true);
    expect(state.isReady).toBe(false);
    expect(state.receivedBytes).toBe(50);
    expect(state.percent).toBe(25);
  });

  it('marks a ready record as ready when nothing is streaming', () => {
    const state = transferState(null, record({ status: 'ready', sizeBytes: 100 }), null);
    expect(state.isReady).toBe(true);
    expect(state.isPaused).toBe(false);
  });

  it('treats a stopped partial download as paused', () => {
    const state = transferState(
      null,
      record({ status: 'available', downloadedBytes: 30, sizeBytes: 120 }),
      null,
    );
    expect(state.isPaused).toBe(true);
    expect(state.percent).toBe(25);
  });

  it('surfaces the event error only for a failed event, else the record error', () => {
    expect(transferState(progress({ status: 'error', error: 'reset' }), null, null).failure).toBe(
      'reset',
    );
    expect(
      transferState(progress({ status: 'downloading' }), record({ error: 'disk full' }), null)
        .failure,
    ).toBe('disk full');
  });

  it('falls back to the catalog size when neither event nor record knows the total', () => {
    const state = transferState(null, record({ status: 'available', downloadedBytes: 10 }), 40);
    expect(state.totalBytes).toBe(40);
    expect(state.percent).toBe(25);
  });

  it('clamps the percentage at 100 and stays at 0 for an unknown total', () => {
    expect(
      transferState(progress({ receivedBytes: 300, totalBytes: 100 }), null, null).percent,
    ).toBe(100);
    expect(transferState(progress({ receivedBytes: 300 }), null, null).percent).toBe(0);
  });
});

describe('verdictStatus', () => {
  it('maps every verdict to a status colour', () => {
    expect(verdictStatus('GREEN')).toBe('success');
    expect(verdictStatus('YELLOW')).toBe('warning');
    expect(verdictStatus('RED')).toBe('error');
    expect(verdictStatus('LOADING')).toBe('accent');
    expect(verdictStatus('GREY')).toBe('neutral');
  });
});

describe('smokeTestStatus', () => {
  it('calls a missing test untested', () => {
    expect(smokeTestStatus(null)).toEqual({ status: 'neutral', label: 'untested' });
  });

  it('keeps the sentence describeSmokeTest already prints', () => {
    expect(smokeTestStatus(smokeTest({ verdict: 'pass', tokensPerSecond: 41 }))).toEqual({
      status: 'success',
      label: 'tested · 41 tok/s',
    });
    expect(smokeTestStatus(smokeTest({ verdict: 'slow', tokensPerSecond: 3 }))).toEqual({
      status: 'warning',
      label: 'slow · 3 tok/s',
    });
    expect(smokeTestStatus(smokeTest({ verdict: 'fail' }))).toEqual({
      status: 'error',
      label: 'failed on this machine',
    });
  });
});

describe('diskUsageBytes', () => {
  it('is zero for no models', () => {
    expect(diskUsageBytes([])).toBe(0);
  });

  it('counts the full size once ready and the partial bytes otherwise', () => {
    const local = [
      { status: 'ready', sizeBytes: 100, downloadedBytes: 100 },
      { status: 'downloading', sizeBytes: 400, downloadedBytes: 25 },
      // Ready but with no recorded size: the downloaded byte count is all we have.
      { status: 'ready', sizeBytes: null, downloadedBytes: 7 },
    ] satisfies Pick<LocalModel, 'status' | 'sizeBytes' | 'downloadedBytes'>[];
    expect(diskUsageBytes(local)).toBe(132);
  });
});

describe('fitsMachine', () => {
  it('counts yellow as runnable and grey as not', () => {
    expect(fitsMachine('GREEN')).toBe(true);
    // Split across CPU and GPU is still "it runs", and it is the common case
    // on a machine with no discrete GPU.
    expect(fitsMachine('YELLOW')).toBe(true);
    expect(fitsMachine('RED')).toBe(false);
    expect(fitsMachine('GREY')).toBe(false);
    expect(fitsMachine('LOADING')).toBe(false);
  });
});

describe('countByFit', () => {
  it('splits verdicts into runs / too big / unknown', () => {
    expect(countByFit(['GREEN', 'YELLOW', 'RED', 'GREY', 'LOADING'])).toEqual({
      fits: 2,
      tooBig: 1,
      unknown: 2,
    });
  });
});

describe('countChecks', () => {
  it('keeps too-big, failed and never-checked apart', () => {
    expect(
      countChecks([
        { verdict: 'RED', error: null },
        { verdict: 'GREY', error: 'range request refused' },
        { verdict: 'GREY', error: null },
        { verdict: 'LOADING', error: null },
        { verdict: 'GREEN', error: null },
        { verdict: 'YELLOW', error: null },
      ]),
    ).toEqual({ tooBig: 1, checkFailed: 1, unchecked: 2 });
  });

  it('counts a failed check as failed even when it reports a verdict', () => {
    expect(countChecks([{ verdict: 'RED', error: 'header read timed out' }])).toEqual({
      tooBig: 0,
      checkFailed: 1,
      unchecked: 0,
    });
  });

  it('counts nothing for an empty catalog', () => {
    expect(countChecks([])).toEqual({ tooBig: 0, checkFailed: 0, unchecked: 0 });
  });
});

describe('groupDiscovered', () => {
  const model = (repo: string, filename: string): DiscoveredVariantView => ({
    repo,
    filename,
    quant: 'Q4_K_M',
    sizeBytes: 1000,
    sha256: null,
    license: 'apache-2.0',
    gated: false,
    isPrivate: false,
    downloads: 42,
    likes: null,
    verdict: 'GREEN',
    support: null,
    reason: '',
  });

  it('keeps repos in the order main ranked them and collects their files', () => {
    const groups = groupDiscovered([
      model('acme/b', 'b1.gguf'),
      model('acme/a', 'a1.gguf'),
      model('acme/b', 'b2.gguf'),
    ]);

    expect(groups.map((group) => group.repo)).toEqual(['acme/b', 'acme/a']);
    expect(groups[0]!.models.map((entry) => entry.filename)).toEqual(['b1.gguf', 'b2.gguf']);
    expect(groups[0]!.license).toBe('apache-2.0');
    expect(groups[0]!.downloads).toBe(42);
  });

  it('returns nothing for nothing', () => {
    expect(groupDiscovered([])).toEqual([]);
  });
});
