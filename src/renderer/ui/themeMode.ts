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

import { createContext, useContext } from 'react';

import type { ThemeMode } from '../../shared/types';

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
