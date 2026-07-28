/**
 * Pure presentation for the Updates section.
 *
 * Everything that can be *wrong* about the update UI is a decision about copy,
 * colour, or which button exists — none of which needs React. It all lives here
 * so the tests can drive one `UpdateState` through it and read the answer, the
 * same way `../models/modelRows.ts` works. The component is then only layout.
 *
 * Two rules the copy follows, because both cost the user something real:
 *   - the download is hundreds of MB (this app ships llama.cpp backends), so the
 *     size is said before the button is pressed, not after;
 *   - installing quits the app immediately, so that is stated on the control
 *     that does it rather than discovered afterwards.
 */

import type { UpdateState } from '../../../shared/ipc-contract';

/** StatusDot variants — mirrors `StatusDotVariant` without importing the component. */
export type UpdateDotStatus = 'success' | 'warning' | 'error' | 'accent' | 'neutral';

/** Banner statuses — mirrors `BannerStatus`. */
export type UpdateBannerStatus = 'info' | 'warning' | 'error' | 'success';

/** Which IPC call the one visible button makes. `none` means: render no button. */
export type UpdateActionKind = 'none' | 'check' | 'download' | 'install';

export interface UpdateStatusView {
  /** One line, plain language, naming the offered version when there is one. */
  readonly headline: string;
  /** Supporting copy under the headline, or null when the headline says it all. */
  readonly detail: string | null;
  readonly dot: UpdateDotStatus;
}

export interface UpdateBannerView {
  readonly status: UpdateBannerStatus;
  readonly title: string;
  readonly description: string;
}

export interface UpdateActionView {
  readonly kind: UpdateActionKind;
  readonly label: string;
  readonly variant: 'primary' | 'secondary';
  readonly isLoading: boolean;
  readonly isDisabled: boolean;
  readonly tooltip: string | null;
}

export interface UpdateProgressView {
  /** null when the transfer has reported no total yet — render indeterminate. */
  readonly percent: number | null;
  /** "142 MB of 517 MB", or "142 MB downloaded" when the total is unknown. */
  readonly transferred: string;
}

/** What the user is offered, or a placeholder when main has not named it yet. */
function offered(state: UpdateState): string {
  return state.availableVersion ?? 'A new version';
}

/**
 * The status line for a phase.
 *
 * `unsupported` and `error` deliberately surface `message` from main rather than
 * inventing copy: main is the only side that knows *which* unsupported (a
 * development run or a non-macOS build) and *which* failure.
 */
export function statusView(state: UpdateState): UpdateStatusView {
  switch (state.phase) {
    case 'unsupported':
      return {
        headline: 'This build cannot update itself.',
        detail: state.message ?? 'Updates are only available in the installed macOS app.',
        dot: 'neutral',
      };

    case 'idle':
      return {
        headline: 'Up to date.',
        detail: 'No newer version was found. This app checks on its own a few times a day.',
        dot: 'success',
      };

    case 'checking':
      return {
        headline: 'Checking for updates…',
        detail: null,
        dot: 'accent',
      };

    case 'available':
      return {
        headline: `${offered(state)} is available.`,
        detail:
          'The download is large — several hundred megabytes, because the update ships the local AI backends with it. Avoid it on a metered or hotspot connection.',
        dot: 'warning',
      };

    case 'downloading':
      return {
        headline: `Downloading ${offered(state)}…`,
        detail: 'You can keep working. The app will not restart on its own.',
        dot: 'accent',
      };

    case 'downloaded':
      return {
        headline: `${offered(state)} is downloaded and ready to install.`,
        detail:
          'Installing quits this app immediately and reopens it on the new version. Save anything you are working on first.',
        dot: 'success',
      };

    case 'error':
      return {
        headline: 'The update failed.',
        detail: state.message ?? 'The update could not be completed. Please try again later.',
        dot: 'error',
      };
  }
}

/**
 * The banner, or null when the status line is enough.
 *
 * Only `error` earns one: everything else is a normal state, and a page that
 * banners its normal states teaches people to ignore banners.
 */
export function bannerView(state: UpdateState): UpdateBannerView | null {
  if (state.phase !== 'error') return null;
  return {
    status: 'error',
    title: 'The update failed',
    description: state.message ?? 'The update could not be completed. Please try again later.',
  };
}

/**
 * The single action control.
 *
 * `isBusy` is the renderer's own in-flight flag: an IPC call can be outstanding
 * before main has broadcast the phase it moves to, and a button that ignores
 * that gap can be pressed twice.
 */
export function actionView(state: UpdateState, isBusy = false): UpdateActionView {
  switch (state.phase) {
    // No dead control on a build that can never update.
    case 'unsupported':
      return {
        kind: 'none',
        label: '',
        variant: 'secondary',
        isLoading: false,
        isDisabled: true,
        tooltip: null,
      };

    case 'idle':
      return {
        kind: 'check',
        label: 'Check for updates',
        variant: 'secondary',
        isLoading: isBusy,
        isDisabled: false,
        tooltip: 'Ask the release feed whether a newer version exists',
      };

    case 'checking':
      return {
        kind: 'check',
        label: 'Check for updates',
        variant: 'secondary',
        isLoading: true,
        isDisabled: false,
        tooltip: 'Ask the release feed whether a newer version exists',
      };

    case 'available':
      return {
        kind: 'download',
        label: 'Download update',
        variant: 'primary',
        isLoading: isBusy,
        isDisabled: false,
        tooltip: 'Downloads several hundred megabytes. Nothing installs until you ask.',
      };

    // The progress bar is the whole story while bytes are moving.
    case 'downloading':
      return {
        kind: 'none',
        label: '',
        variant: 'primary',
        isLoading: false,
        isDisabled: true,
        tooltip: null,
      };

    case 'downloaded':
      return {
        kind: 'install',
        label: 'Restart and install',
        variant: 'primary',
        isLoading: isBusy,
        isDisabled: false,
        tooltip: 'Quits this app now and reopens it on the new version',
      };

    case 'error':
      return {
        kind: 'check',
        label: 'Try again',
        variant: 'secondary',
        isLoading: isBusy,
        isDisabled: false,
        tooltip: 'Check the release feed again',
      };
  }
}

/** The progress readout, or null in every phase where nothing is transferring. */
export function progressView(state: UpdateState): UpdateProgressView | null {
  if (state.phase !== 'downloading') return null;

  const transferred = state.transferredBytes;
  const total = state.totalBytes;

  // Main sends `progressPercent` directly; the byte counts are the fallback for
  // the first event of a transfer, which can carry bytes before a percent.
  let percent = state.progressPercent;
  if (percent === null && transferred !== null && total !== null && total > 0) {
    percent = (transferred / total) * 100;
  }

  return {
    percent: percent === null ? null : clampPercent(percent),
    transferred:
      total !== null && total > 0
        ? `${formatBytes(transferred)} of ${formatBytes(total)}`
        : `${formatBytes(transferred)} downloaded`,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Decimal units, matching the Models page — a release asset is quoted in MB by
 * GitHub, and matching that is worth more here than binary correctness.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'an unknown amount';
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;

  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The always-visible line: what is running right now. */
export function formatCurrentVersion(state: UpdateState): string {
  return state.currentVersion.length > 0 ? `Version ${state.currentVersion}` : 'Unknown version';
}
