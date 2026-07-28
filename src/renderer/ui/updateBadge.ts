/**
 * Whether the sidebar shows an "update waiting" indicator, and what it says.
 *
 * The decision is pure and lives here for the same reason `../chrome.ts` does:
 * the root vitest project is `environment: 'node'` with no DOM harness, so the
 * shell's React file stays a thin renderer of decisions taken in modules that
 * can be unit-tested directly.
 *
 * The bar is deliberately quiet. It appears only for the three phases that mean
 * a user action is actually pending, and in particular *never* for `error`: the
 * web preview answers every `updates:*` channel with 501, so `error` is the
 * normal state of a browser session and an indicator there would be permanent
 * noise that resolves to nothing. `unsupported` (a dev run, any non-macOS
 * build) and `checking` are silent for the same reason — nothing is waiting.
 */

import type { UpdateState } from '../../shared/ipc-contract';

export interface UpdateBadgeDecision {
  /** False means render nothing at all — not an empty or disabled element. */
  readonly isVisible: boolean;
  /**
   * Accessible, human label. Also the collapsed rail's tooltip, which is why it
   * is a full sentence fragment rather than a bare percentage.
   */
  readonly label: string;
}

const HIDDEN: UpdateBadgeDecision = { isVisible: false, label: '' };

/** Percent is only shown when main has actually reported one. */
function downloadingLabel(progressPercent: number | null): string {
  if (progressPercent === null) return 'Downloading update';
  return `Downloading update ${Math.round(progressPercent)}%`;
}

/**
 * `null` is the pre-answer state of `useUpdates()` — the snapshot has not
 * arrived yet, so there is nothing to announce.
 */
export function updateBadge(state: UpdateState | null): UpdateBadgeDecision {
  if (state === null) return HIDDEN;

  switch (state.phase) {
    case 'available':
      return { isVisible: true, label: 'Update available' };
    case 'downloading':
      return { isVisible: true, label: downloadingLabel(state.progressPercent) };
    case 'downloaded':
      return { isVisible: true, label: 'Update ready to install' };
    case 'unsupported':
    case 'idle':
    case 'checking':
    case 'error':
      return HIDDEN;
  }
}
