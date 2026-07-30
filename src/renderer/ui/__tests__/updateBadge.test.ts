import { describe, expect, it } from 'vitest';

import type { UpdateState } from '../../../shared/ipc-contract';
import { updateBadge } from '../updateBadge';

function state(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '0.1.6',
    availableVersion: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    message: null,
    ...patch,
  };
}

// Every phase in the contract, written out. A phase added to
// `UpdateState.phase` without a decision here fails the exhaustiveness test
// below rather than silently defaulting to highlighted.
const ALL_PHASES: readonly UpdateState['phase'][] = [
  'unsupported',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'error',
];

/** The only three phases where something is genuinely waiting on the user. */
const HIGHLIGHTED_PHASES: readonly UpdateState['phase'][] = [
  'available',
  'downloading',
  'downloaded',
];

// The approved resting label, written out rather than imported: comparing
// against the module's own constant would pass for '' too, and an unlabelled
// permanent control is exactly the regression a resting label exists to avoid.
const RESTING_LABEL = 'Check for updates';

describe('updateBadge', () => {
  it('rests, rather than vanishing, before the first snapshot arrives', () => {
    expect(updateBadge(null)).toEqual({ label: RESTING_LABEL, isHighlighted: false });
  });

  it('announces an available update, highlighted', () => {
    expect(updateBadge(state({ phase: 'available', availableVersion: '0.1.7' }))).toEqual({
      label: 'Update available',
      isHighlighted: true,
    });
  });

  it('announces a download with its progress', () => {
    expect(updateBadge(state({ phase: 'downloading', progressPercent: 42 }))).toEqual({
      label: 'Downloading update 42%',
      isHighlighted: true,
    });
  });

  it('rounds a fractional percent', () => {
    expect(updateBadge(state({ phase: 'downloading', progressPercent: 41.6 })).label).toBe(
      'Downloading update 42%',
    );
    expect(updateBadge(state({ phase: 'downloading', progressPercent: 0 })).label).toBe(
      'Downloading update 0%',
    );
  });

  it('drops the percent when main has not reported one', () => {
    expect(updateBadge(state({ phase: 'downloading' }))).toEqual({
      label: 'Downloading update',
      isHighlighted: true,
    });
  });

  it('announces a downloaded update as ready to install', () => {
    expect(updateBadge(state({ phase: 'downloaded' }))).toEqual({
      label: 'Update ready to install',
      isHighlighted: true,
    });
  });

  // Each label is pinned literally: the screenshot harness asserts these
  // strings, and they are what a screen reader and a tooltip say.
  it('labels every resting phase without highlighting it', () => {
    expect(updateBadge(state({ phase: 'idle' }))).toEqual({
      label: RESTING_LABEL,
      isHighlighted: false,
    });
    expect(updateBadge(state({ phase: 'checking' }))).toEqual({
      label: 'Checking for updates',
      isHighlighted: false,
    });
    expect(updateBadge(state({ phase: 'unsupported' }))).toEqual({
      label: 'Updates are not available in this build',
      isHighlighted: false,
    });
  });

  // The web preview 501s every `updates:*` channel, so `error` is the normal
  // state of a browser session. The control is still named there — it is on
  // screen either way now — but a blue glyph would be permanent noise that
  // resolves to nothing, so the highlight is what stays silent.
  it('never highlights error, including with a message', () => {
    expect(updateBadge(state({ phase: 'error', message: 'Not implemented' }))).toEqual({
      label: 'Update status unavailable',
      isHighlighted: false,
    });
  });

  it('decides every phase in the contract', () => {
    for (const phase of ALL_PHASES) {
      const decision = updateBadge(state({ phase }));
      expect(typeof decision.isHighlighted).toBe('boolean');
      expect(decision.isHighlighted).toBe(HIGHLIGHTED_PHASES.includes(phase));
      // A permanent control with an empty label is an unlabelled control.
      expect(decision.label.length).toBeGreaterThan(0);
    }
  });

  it('never hides the control — the decision has no visibility left to take', () => {
    // The regression this pins: reintroducing `isVisible` (or any falsey
    // "render nothing" flag) is what put the button back to appearing and
    // disappearing under the user.
    for (const phase of ALL_PHASES) {
      expect(Object.keys(updateBadge(state({ phase }))).sort()).toEqual([
        'isHighlighted',
        'label',
      ]);
    }
  });
});
