/**
 * Pure row derivations for the Models page.
 *
 * The page renders installed models and catalog variants as rows, and every row
 * needs the same three answers: what is the transfer doing, what colour is the
 * status dot, and how much disk is this costing. None of that needs React, so it
 * lives here where it can be tested.
 *
 * These functions moved out of `index.tsx` unchanged — the download state
 * machine is exactly the one the page has always used.
 */

import { describeSmokeTest, type LocalModel, type SmokeTestView, type SupportVerdict } from './llmExtra';
import type { DownloadState } from './useModels';

/** The StatusDot variants a row can take. */
export type RowStatus = 'success' | 'warning' | 'error' | 'accent' | 'neutral';

export interface TransferState {
  readonly isDownloading: boolean;
  readonly isReady: boolean;
  /** Partially downloaded, but nothing is moving right now. */
  readonly isPaused: boolean;
  /** Download failure only — the smoke test reports its own outcome. */
  readonly failure: string | null;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly percent: number;
}

/** What the record on disk needs to expose for a transfer verdict. */
export type TransferRecord = Pick<LocalModel, 'status' | 'downloadedBytes' | 'sizeBytes' | 'error'>;

/**
 * Fold the live progress event and the stored record into one row state.
 *
 * The event stream is ahead of the table between two refreshes, so it wins
 * wherever the two disagree.
 */
export function transferState(
  progress: DownloadState | null,
  record: TransferRecord | null,
  fallbackSizeBytes: number | null,
): TransferState {
  const isDownloading = progress?.status === 'downloading' || record?.status === 'downloading';
  const isReady = progress?.status === 'ready' || (record?.status === 'ready' && !isDownloading);
  const failure = progress?.status === 'error' ? progress.error : (record?.error ?? null);

  const receivedBytes = progress?.receivedBytes ?? record?.downloadedBytes ?? 0;
  const totalBytes = progress?.totalBytes ?? record?.sizeBytes ?? fallbackSizeBytes ?? null;
  const percent =
    totalBytes !== null && totalBytes > 0
      ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100))
      : 0;

  return {
    isDownloading,
    isReady,
    isPaused: !isReady && !isDownloading && receivedBytes > 0,
    failure,
    receivedBytes,
    totalBytes,
    percent,
  };
}

/** Compatibility verdict as a status colour. */
export function verdictStatus(verdict: SupportVerdict): RowStatus {
  switch (verdict) {
    case 'GREEN':
      return 'success';
    case 'YELLOW':
      return 'warning';
    case 'RED':
      return 'error';
    case 'LOADING':
      return 'accent';
    case 'GREY':
      return 'neutral';
  }
}

export interface SmokeTestStatus {
  readonly status: RowStatus;
  readonly label: string;
}

/** The recorded smoke test as a status colour plus the sentence it already prints. */
export function smokeTestStatus(smokeTest: SmokeTestView | null): SmokeTestStatus {
  if (smokeTest === null) return { status: 'neutral', label: 'untested' };
  switch (smokeTest.verdict) {
    case 'pass':
      return { status: 'success', label: describeSmokeTest(smokeTest) };
    case 'slow':
      return { status: 'warning', label: describeSmokeTest(smokeTest) };
    case 'fail':
      return { status: 'error', label: describeSmokeTest(smokeTest) };
  }
}

/**
 * Bytes on disk across every record: the full size once a model is ready, and
 * whatever has landed so far while it is not.
 */
export function diskUsageBytes(
  local: readonly Pick<LocalModel, 'status' | 'sizeBytes' | 'downloadedBytes'>[],
): number {
  return local.reduce(
    (total, record) =>
      total +
      (record.status === 'ready'
        ? (record.sizeBytes ?? record.downloadedBytes)
        : record.downloadedBytes),
    0,
  );
}
