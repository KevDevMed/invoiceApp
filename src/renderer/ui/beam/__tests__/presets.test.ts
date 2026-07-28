import { describe, expect, it } from 'vitest';

import type { ThemeMode } from '../../../../shared/types';
import { BEAM_PRESETS, beamProps, resolveScheme, type BeamPreset } from '../presets';

/**
 * The library's full vocabulary, spelled out rather than imported: the point of
 * the exhaustiveness test below is to fail when *our* presets stop covering it,
 * and a set derived from the same source as the thing under test could not.
 * A library upgrade that adds a sixth size should fail here too — that is a
 * decision someone has to make, not a silent gap in coverage.
 */
const ALL_SIZES = ['sm', 'md', 'line', 'pulse-outside', 'pulse-inner'] as const;
const ALL_COLOR_VARIANTS = ['colorful', 'mono', 'ocean', 'sunset'] as const;

const EXPECTED_PRESETS: readonly BeamPreset[] = [
  'launcher-idle',
  'launcher-attention',
  'panel-streaming',
  'panel-idle',
  'composer-focus',
  'approval-pending',
];

describe('resolveScheme', () => {
  it('honours an explicit choice over the OS preference', () => {
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('dark', true)).toBe('dark');
    expect(resolveScheme('dark', false)).toBe('dark');
  });

  it('follows the OS preference only under `system`', () => {
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme('system', false)).toBe('light');
  });

  it('resolves every ThemeMode to a concrete scheme', () => {
    const modes: readonly ThemeMode[] = ['light', 'dark', 'system'];
    for (const mode of modes) {
      for (const prefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveScheme(mode, prefersDark));
      }
    }
  });
});

describe('beamProps', () => {
  it('exposes exactly the six presets', () => {
    expect([...BEAM_PRESETS].sort()).toEqual([...EXPECTED_PRESETS].sort());
  });

  it('uses every BorderBeamSize the library ships at least once', () => {
    const used = new Set(BEAM_PRESETS.map((preset) => beamProps(preset, 'dark').size));
    expect([...used].sort()).toEqual([...ALL_SIZES].sort());
  });

  it('uses every BorderBeamColorVariant the library ships at least once', () => {
    const used = new Set(BEAM_PRESETS.map((preset) => beamProps(preset, 'dark').colorVariant));
    expect([...used].sort()).toEqual([...ALL_COLOR_VARIANTS].sort());
  });

  it('returns the scheme it was given as `theme`, and never `auto`', () => {
    for (const preset of BEAM_PRESETS) {
      expect(beamProps(preset, 'light').theme).toBe('light');
      expect(beamProps(preset, 'dark').theme).toBe('dark');
      expect(beamProps(preset, 'dark').theme).not.toBe('auto');
    }
  });

  it('keeps strength within 0-1 and duration positive', () => {
    for (const preset of BEAM_PRESETS) {
      const props = beamProps(preset, 'dark');
      expect(props.strength).toBeGreaterThan(0);
      expect(props.strength).toBeLessThanOrEqual(1);
      expect(props.duration).toBeGreaterThan(0);
    }
  });

  it('keeps ambient presets slower and quieter than the streaming signal', () => {
    // The rule the tuning comments state: motion tracks how much the user is
    // meant to care. Ambient beams are on screen permanently, so they must stay
    // below the library's 2.3s default breath in speed and well below the
    // streaming beam in strength.
    const streaming = beamProps('panel-streaming', 'dark');
    for (const preset of ['launcher-idle', 'panel-idle'] as const) {
      const ambient = beamProps(preset, 'dark');
      expect(ambient.duration).toBeGreaterThan(2.3);
      expect(ambient.strength).toBeLessThan(streaming.strength);
    }
  });

  it('does not share mutable state between calls', () => {
    const first = beamProps('panel-streaming', 'dark');
    const second = beamProps('panel-streaming', 'light');
    expect(first).not.toBe(second);
    expect(first.theme).toBe('dark');
  });
});
