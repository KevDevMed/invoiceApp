/**
 * What the sidebar's update control says, and whether it is highlighted.
 *
 * The decision is pure and lives here for the same reason `../chrome.ts` does:
 * the root vitest project is `environment: 'node'` with no DOM harness, so the
 * shell's React file stays a thin renderer of decisions taken in modules that
 * can be unit-tested directly.
 *
 * The control itself is now permanent — one glyph that always sits in the
 * sidebar's title band and always leads to Settings, where the real update UI
 * lives. What used to be `isVisible` is therefore gone, and the quiet the old
 * decision bought by *hiding* is now bought by `isHighlighted`:
 *
 * The highlight is deliberately silent. It fires only for the three phases that
 * mean a user action is actually pending, and in particular *never* for `error`:
 * the web preview answers every `updates:*` channel with 501, so `error` is the
 * normal state of a browser session and a blue glyph there would be permanent
 * noise that resolves to nothing. `unsupported` (a dev run, any non-macOS
 * build) and `checking` stay unhighlighted for the same reason — nothing is
 * waiting. Every one of those phases still gets a *label*, because a permanent
 * control with no accessible name is worse than a noisy one.
 */

import type { UpdateState } from '../../shared/ipc-contract';

export interface UpdateBadgeDecision {
  /**
   * Accessible, human label. Also the button's tooltip, which is why it is a
   * full sentence fragment rather than a bare percentage.
   */
  readonly label: string;
  /**
   * True when something is genuinely waiting on the user, and the only thing
   * that turns the glyph blue.
   */
  readonly isHighlighted: boolean;
}

/**
 * The label when nothing is waiting. Also what `null` (no snapshot yet) gets:
 * the control is already on screen and has to be named before the first answer
 * from main arrives. Says what pressing it does — it opens Settings, where the
 * check lives — rather than describing a state.
 */
const RESTING: UpdateBadgeDecision = { label: 'Check for updates', isHighlighted: false };

/** Percent is only shown when main has actually reported one. */
function downloadingLabel(progressPercent: number | null): string {
  if (progressPercent === null) return 'Downloading update';
  return `Downloading update ${Math.round(progressPercent)}%`;
}

/**
 * `null` is the pre-answer state of `useUpdates()` — the snapshot has not
 * arrived yet, so the control rests.
 */
export function updateBadge(state: UpdateState | null): UpdateBadgeDecision {
  if (state === null) return RESTING;

  switch (state.phase) {
    case 'available':
      return { label: 'Update available', isHighlighted: true };
    case 'downloading':
      return { label: downloadingLabel(state.progressPercent), isHighlighted: true };
    case 'downloaded':
      return { label: 'Update ready to install', isHighlighted: true };
    case 'checking':
      return { label: 'Checking for updates', isHighlighted: false };
    /*
      Both of these are resting states dressed as problems, and neither is worth
      a highlight. `error` is what the whole web preview reports; `unsupported`
      is every non-macOS build and every unpackaged dev run. The label states
      the fact without claiming anything is pending.
    */
    case 'error':
      return { label: 'Update status unavailable', isHighlighted: false };
    case 'unsupported':
      return { label: 'Updates are not available in this build', isHighlighted: false };
    case 'idle':
      return RESTING;
  }
}
