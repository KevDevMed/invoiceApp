/**
 * The sidebar's appearance toggle, tested where its logic actually lives.
 *
 * The button in `AppShell.tsx` is a glyph and an `onClick`; every decision it
 * makes — what "current appearance" means when the mode is `system`, what the
 * next mode is, what the button is called — is a pure function in
 * `ui/themeMode`, which is a leaf module with no DOM and no design-system
 * imports. That is what makes it testable under `environment: 'node'`.
 *
 * `usePrefersDarkScheme` is deliberately not tested here: it is a hook over
 * `matchMedia`, and there is no DOM in this project to mount it in. Its one
 * non-React decision — absent `matchMedia` means "not dark" — is asserted
 * through the pure functions below, which take `prefersDark` as an argument
 * precisely so the hook has nothing left to get wrong.
 */

import { describe, expect, it } from 'vitest';

import type { ThemeMode } from '../../../shared/types';
import { nextThemeMode, resolveAppearance, themeToggleLabel } from '../themeMode';

const MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

describe('resolveAppearance', () => {
  it('passes explicit modes straight through, whatever the OS says', () => {
    for (const prefersDark of [true, false]) {
      expect(resolveAppearance('light', prefersDark)).toBe('light');
      expect(resolveAppearance('dark', prefersDark)).toBe('dark');
    }
  });

  it('resolves system to the OS preference', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
  });
});

describe('nextThemeMode', () => {
  it('flips an explicit mode', () => {
    for (const prefersDark of [true, false]) {
      expect(nextThemeMode('light', prefersDark)).toBe('dark');
      expect(nextThemeMode('dark', prefersDark)).toBe('light');
    }
  });

  it('flips away from what system is currently showing', () => {
    // The whole reason `system` is resolved first: pressing the toggle while
    // the OS is dark must go light, not "dark again".
    expect(nextThemeMode('system', true)).toBe('light');
    expect(nextThemeMode('system', false)).toBe('dark');
  });

  it('never returns system, from any starting mode', () => {
    // A three-state cycle behind a two-state glyph has a press that appears to
    // do nothing. `Auto` lives on the Settings page instead.
    for (const mode of MODES) {
      for (const prefersDark of [true, false]) {
        expect(nextThemeMode(mode, prefersDark)).not.toBe('system');
      }
    }
  });

  it('always changes the appearance on screen', () => {
    // The property that matters more than the cycle itself: one press is one
    // visible change, from every (mode, OS preference) pair there is.
    for (const mode of MODES) {
      for (const prefersDark of [true, false]) {
        const before = resolveAppearance(mode, prefersDark);
        const after = nextThemeMode(mode, prefersDark);
        expect(after).not.toBe(before);
      }
    }
  });

  it('is an involution — two presses return to where it started', () => {
    for (const mode of MODES) {
      for (const prefersDark of [true, false]) {
        const once = nextThemeMode(mode, prefersDark);
        expect(nextThemeMode(once, prefersDark)).toBe(resolveAppearance(mode, prefersDark));
      }
    }
  });
});

describe('themeToggleLabel', () => {
  it('names the action rather than the state', () => {
    expect(themeToggleLabel('dark')).toBe('Switch to dark theme');
    expect(themeToggleLabel('light')).toBe('Switch to light theme');
  });

  it('describes where the press goes, for every starting point', () => {
    for (const mode of MODES) {
      for (const prefersDark of [true, false]) {
        const label = themeToggleLabel(nextThemeMode(mode, prefersDark));
        expect(label).toContain(nextThemeMode(mode, prefersDark));
        expect(label).not.toContain(resolveAppearance(mode, prefersDark));
      }
    }
  });
});
