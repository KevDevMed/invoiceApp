import type { BorderBeamColorVariant, BorderBeamSize } from 'border-beam';
import { describe, expect, it } from 'vitest';

import type { ThemeMode } from '../../../../shared/types';
import { BEAM_PRESETS, beamProps, resolveScheme, type BeamPreset } from '../presets';

/**
 * The library's full vocabulary, spelled out once and then checked against the
 * library's own union by `satisfies`. The guard has two halves and they catch
 * opposite failures:
 *
 * - `satisfies Record<BorderBeamSize, true>` catches the library *growing*. A
 *   `border-beam` upgrade that adds a sixth size makes this object miss a key
 *   and `npm run typecheck` fails here, at the upgrade, rather than the new
 *   element going quietly unused. (It equally catches a size being removed:
 *   the leftover key becomes an excess property.)
 * - The runtime union assertions below catch a preset *dropping* one. They
 *   compare the sizes our presets actually emit against these keys, so
 *   retuning `composer-focus` off `sm` fails vitest.
 *
 * The keys are hand-written on purpose — a set derived from `PRESETS` could
 * not detect a preset that stopped covering something. `tsc` is what keeps the
 * hand-written half honest.
 */
const ALL_SIZES = {
  sm: true,
  md: true,
  line: true,
  'pulse-outside': true,
  'pulse-inner': true,
} satisfies Record<BorderBeamSize, true>;

const ALL_COLOR_VARIANTS = {
  colorful: true,
  mono: true,
  ocean: true,
  sunset: true,
} satisfies Record<BorderBeamColorVariant, true>;

/** Runtime views of the two maps, so vitest and `tsc` cannot drift apart. */
const ALL_SIZE_KEYS = Object.keys(ALL_SIZES) as readonly BorderBeamSize[];
const ALL_COLOR_VARIANT_KEYS = Object.keys(ALL_COLOR_VARIANTS) as readonly BorderBeamColorVariant[];

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

  it('resolves every ThemeMode to the right concrete scheme', () => {
    // Spelled out as a full truth table rather than `toContain(['light',
    // 'dark'])`: that shape passes for any implementation that returns a legal
    // scheme, including one that ignores its arguments entirely.
    const cases: readonly (readonly [ThemeMode, boolean, 'light' | 'dark'])[] = [
      ['light', true, 'light'],
      ['light', false, 'light'],
      ['dark', true, 'dark'],
      ['dark', false, 'dark'],
      ['system', true, 'dark'],
      ['system', false, 'light'],
    ];
    expect(cases).toHaveLength(6);
    for (const [mode, prefersDark, expected] of cases) {
      expect(resolveScheme(mode, prefersDark)).toBe(expected);
    }
  });
});

describe('beamProps', () => {
  it('exposes exactly the six presets', () => {
    expect([...BEAM_PRESETS].sort()).toEqual([...EXPECTED_PRESETS].sort());
  });

  /*
   * Was "uses every BorderBeamSize at least once". `pulse-outside` is now
   * deliberately excluded, and the assertion states the exclusion rather than
   * being loosened to tolerate it — both halves still fail loudly.
   *
   * Why it is excluded: it is the only size whose layers carry negative insets
   * (a bloom at `inset: -30px`), so it enlarges its host by 30px on every side.
   * The launcher wore it while it was a bubble floating in the window's corner,
   * which had the room. In the breadcrumb band it did not: 30px of halo around
   * a 28px button, minus the 16px shell gutter, hung 12px past the content box
   * and put a horizontal scrollbar on every route in the app
   * (`.astryx-layout-content` 1196/1184 at a 1440 window, the same 12px at
   * every width). No other surface in this app has 30px of clearance either —
   * see the module header for the walk through all six.
   */
  const UNUSED_SIZE: BorderBeamSize = 'pulse-outside';

  it('uses every BorderBeamSize the library ships except the uncropped halo', () => {
    const used = new Set(BEAM_PRESETS.map((preset) => beamProps(preset, 'dark').size));
    expect([...used].sort()).toEqual([...ALL_SIZE_KEYS].filter((size) => size !== UNUSED_SIZE).sort());
  });

  it('keeps the outward bloom off every surface, because nothing has room for it', () => {
    // Stated separately from the coverage assertion above so the reason has its
    // own failure: this is the regression, not a tuning preference.
    for (const preset of BEAM_PRESETS) {
      expect(beamProps(preset, 'dark').size).not.toBe(UNUSED_SIZE);
    }
  });

  it('uses every BorderBeamColorVariant the library ships at least once', () => {
    const used = new Set(BEAM_PRESETS.map((preset) => beamProps(preset, 'dark').colorVariant));
    expect([...used].sort()).toEqual([...ALL_COLOR_VARIANT_KEYS].sort());
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

  it('freezes the hue shift on exactly the monochrome presets', () => {
    // `staticColors` is not free tuning: on `mono` a drifting hue is either
    // invisible or a grey that faintly tints, and on a coloured variant the
    // shift is the point. Asserting both directions, so setting the flag
    // everywhere — or nowhere — fails.
    for (const preset of BEAM_PRESETS) {
      const props = beamProps(preset, 'dark');
      expect(props.staticColors ?? false).toBe(props.colorVariant === 'mono');
    }
  });

  it('makes panel-streaming the single loudest preset', () => {
    // The one loud beam, by design. If a second preset ties or beats it, the
    // "is it stuck or is it thinking" signal has stopped being distinctive.
    const streaming = beamProps('panel-streaming', 'dark');
    const others = BEAM_PRESETS.filter((preset) => preset !== 'panel-streaming');
    expect(others).toHaveLength(5);
    for (const preset of others) {
      expect(beamProps(preset, 'dark').strength).toBeLessThan(streaming.strength);
    }
  });

  it('does not share mutable state between calls', () => {
    const first = beamProps('panel-streaming', 'dark');
    const second = beamProps('panel-streaming', 'light');
    expect(first).not.toBe(second);
    expect(first.theme).toBe('dark');
  });
});
