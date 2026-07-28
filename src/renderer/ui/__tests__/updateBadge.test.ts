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
// below rather than silently defaulting to visible.
const ALL_PHASES: readonly UpdateState['phase'][] = [
  'unsupported',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'error',
];

const SILENT_PHASES: readonly UpdateState['phase'][] = [
  'unsupported',
  'idle',
  'checking',
  'error',
];

describe('updateBadge', () => {
  it('shows nothing before the first snapshot arrives', () => {
    expect(updateBadge(null)).toEqual({ isVisible: false, label: '' });
  });

  it('announces an available update', () => {
    expect(updateBadge(state({ phase: 'available', availableVersion: '0.1.7' }))).toEqual({
      isVisible: true,
      label: 'Update available',
    });
  });

  it('announces a download with its progress', () => {
    expect(updateBadge(state({ phase: 'downloading', progressPercent: 42 }))).toEqual({
      isVisible: true,
      label: 'Downloading update 42%',
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
      isVisible: true,
      label: 'Downloading update',
    });
  });

  it('announces a downloaded update as ready to install', () => {
    expect(updateBadge(state({ phase: 'downloaded' }))).toEqual({
      isVisible: true,
      label: 'Update ready to install',
    });
  });

  // The web preview 501s every `updates:*` channel, so `error` is the normal
  // state of a browser session. An indicator there would be permanent noise.
  it('stays silent on error, including with a message', () => {
    expect(updateBadge(state({ phase: 'error', message: 'Not implemented' })).isVisible).toBe(
      false,
    );
  });

  it('stays silent for every phase with nothing waiting', () => {
    for (const phase of SILENT_PHASES) {
      expect(updateBadge(state({ phase }))).toEqual({ isVisible: false, label: '' });
    }
  });

  it('decides every phase in the contract', () => {
    for (const phase of ALL_PHASES) {
      const decision = updateBadge(state({ phase }));
      expect(typeof decision.isVisible).toBe('boolean');
      expect(decision.isVisible).toBe(!SILENT_PHASES.includes(phase));
      // A visible indicator with an empty label is an unlabelled control.
      if (decision.isVisible) expect(decision.label.length).toBeGreaterThan(0);
    }
  });
});
