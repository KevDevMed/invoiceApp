/**
 * The sidebar's appearance toggle, tested where its logic actually lives.
 *
 * The button in `AppShell.tsx` is a glyph and an `onClick`; every decision it
 * makes — what "current appearance" means when the mode is `system`, what the
 * next mode is, what the button is called — is a pure function in
 * `ui/themeMode`, which is a leaf module with no DOM and no design-system
 * imports. That is what makes it testable under `environment: 'node'`.
 *
 * `usePrefersDarkScheme` is still not mounted here — there is no DOM in this
 * project to render a hook into. What it delegates to, `watchPrefersDark`, is
 * plain and takes a callback, so the part with a race in it *is* tested below
 * against a hand-built `MediaQueryList`.
 */

import { describe, expect, it } from 'vitest';

import type { ThemeMode } from '../../../shared/types';
import {
  PREFERS_DARK_QUERY,
  nextThemeMode,
  resolveAppearance,
  themeToggleLabel,
  watchPrefersDark,
} from '../themeMode';

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

/**
 * A `MediaQueryList` with two things the real one does not have: it records the
 * order of every interaction, and reading `.matches` is observable. That is
 * what lets the ordering itself be asserted rather than inferred.
 */
function fakeMediaQueryList(initial: boolean) {
  const calls: string[] = [];
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  let matches = initial;
  return {
    calls,
    /** Simulate the OS flipping appearance, as the browser would report it. */
    emit(next: boolean): void {
      matches = next;
      listener?.({ matches: next } as MediaQueryListEvent);
    },
    /** Flip without notifying — an OS change that lands with no listener yet. */
    flipSilently(next: boolean): void {
      matches = next;
    },
    query: {
      media: PREFERS_DARK_QUERY,
      get matches(): boolean {
        calls.push('matches');
        return matches;
      },
      addEventListener(_type: string, fn: (event: MediaQueryListEvent) => void): void {
        calls.push('addEventListener');
        listener = fn;
      },
      removeEventListener(): void {
        calls.push('removeEventListener');
        listener = null;
      },
    },
  };
}

/** Installs a `window.matchMedia` for the duration of `body`. */
function withMatchMedia<T>(query: unknown, body: () => T): T {
  const had = 'window' in globalThis;
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    matchMedia: () => query,
  };
  try {
    return body();
  } finally {
    if (had) (globalThis as { window?: unknown }).window = previous;
    else delete (globalThis as { window?: unknown }).window;
  }
}

describe('watchPrefersDark', () => {
  it('subscribes before it reads, so a change during render is not lost', () => {
    // The regression this pins: the hook's useState initialiser reads `matches`
    // during render and the effect subscribes later. Read-then-subscribe drops
    // anything landing in between *permanently* — no listener fired, and the
    // value is never looked at again.
    const fake = fakeMediaQueryList(false);
    const seen: boolean[] = [];
    withMatchMedia(fake.query, () => {
      fake.flipSilently(true); // the OS change that lands in the gap
      return watchPrefersDark((value) => seen.push(value));
    });
    expect(fake.calls.indexOf('addEventListener')).toBeLessThan(fake.calls.indexOf('matches'));
    expect(seen).toEqual([true]);
  });

  it('reports later changes through the listener', () => {
    const fake = fakeMediaQueryList(false);
    const seen: boolean[] = [];
    withMatchMedia(fake.query, () => watchPrefersDark((value) => seen.push(value)));
    fake.emit(true);
    fake.emit(false);
    expect(seen).toEqual([false, true, false]);
  });

  it('unsubscribes, so a change after cleanup reports nothing', () => {
    const fake = fakeMediaQueryList(false);
    const seen: boolean[] = [];
    const stop = withMatchMedia(fake.query, () => watchPrefersDark((value) => seen.push(value)));
    stop?.();
    fake.emit(true);
    expect(seen).toEqual([false]);
    expect(fake.calls).toContain('removeEventListener');
  });

  it('is a no-op without matchMedia — vitest runs environment: node', () => {
    const seen: boolean[] = [];
    expect(watchPrefersDark((value) => seen.push(value))).toBeUndefined();
    expect(seen).toEqual([]);
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
