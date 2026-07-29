/**
 * The app's appearance preference, as a context of its own.
 *
 * This used to live in `AppShell.tsx`, which was fine while the shell was the
 * only thing that read it. It is not fine any more: `ui/beam` needs the current
 * mode to pick a light- or dark-tuned beam, and `AppShell` mounts the assistant
 * dock, which mounts a beam. That closes a cycle —
 * `AppShell -> AssistantDock -> ui/beam -> AppShell` — and a module cycle in a
 * bundler is not a compile error, it is an intermittent `undefined` at runtime
 * depending on which module the graph happens to evaluate first.
 *
 * A leaf module breaks it: this file imports nothing but React and a shared
 * type, so everything can depend on it and it can depend on nothing back.
 * `AppShell.tsx` re-exports all three names so `App.tsx` — which is not ours to
 * edit — keeps importing them from where it always did.
 */

import { createContext, useContext, useEffect, useState } from 'react';

import type { ThemeMode } from '../../shared/types';

/** The two appearances a `ThemeMode` can actually resolve to on screen. */
export type ResolvedAppearance = 'light' | 'dark';

/** Media query the OS answers with the user's appearance preference. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeModeContextValue {
  readonly mode: ThemeMode;
  readonly setMode: (mode: ThemeMode) => void;
}

export const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: 'system',
  setMode: () => undefined,
});

export function useThemeMode(): ThemeModeContextValue {
  return useContext(ThemeModeContext);
}

// ---------------------------------------------------------------------------
// The sidebar's appearance toggle, as pure functions
// ---------------------------------------------------------------------------

/**
 * What the app is actually painted as right now.
 *
 * `system` is not a third appearance; it is a deferral, and what it defers to is
 * the OS preference. Resolving it here is what lets the toggle below be a
 * two-state control without lying about the current state.
 */
export function resolveAppearance(mode: ThemeMode, prefersDark: boolean): ResolvedAppearance {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/**
 * The mode one press of the sidebar toggle moves to.
 *
 * The cycle is light <-> dark, and `system` resolves to whatever it is currently
 * showing before flipping — so the first press always visibly changes the
 * appearance, which is the only thing a user pressing a sun/moon glyph is
 * asking for. It does *not* cycle back into `system`: a three-state cycle on a
 * two-state glyph has a press that appears to do nothing (system already
 * resolving to the mode you just left), and `Auto` is one click away on
 * Settings, which is where a preference that means "follow something else"
 * belongs. Deliberately never returns `system`.
 */
export function nextThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedAppearance {
  return resolveAppearance(mode, prefersDark) === 'dark' ? 'light' : 'dark';
}

/**
 * Accessible name for the toggle. It states the *action*, not the state: a
 * button named "Dark" leaves a screen-reader user guessing whether that is what
 * it is or what it does.
 */
export function themeToggleLabel(next: ResolvedAppearance): string {
  return `Switch to ${next} theme`;
}

/**
 * The OS appearance preference, kept live.
 *
 * `matchMedia` is absent under `environment: 'node'` and in any non-browser
 * host, so its absence resolves to "light" rather than throwing on first render.
 * The listener matters because `system` mode has to follow the OS while the app
 * is open — without it the toggle's glyph would go stale the moment the user
 * changed appearance in System Settings.
 */
export function usePrefersDarkScheme(): boolean {
  const [prefersDark, setPrefersDark] = useState(() => matchPrefersDark()?.matches ?? false);

  useEffect(() => {
    const query = matchPrefersDark();
    if (!query) return undefined;
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersDark(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);

  return prefersDark;
}

function matchPrefersDark(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(PREFERS_DARK_QUERY);
}
