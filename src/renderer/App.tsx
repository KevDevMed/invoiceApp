/**
 * Renderer root: theme provider + hash router.
 *
 * Hash history is not a preference — a packaged Electron app loads the renderer
 * over `file://`, where browser history routes 404 on reload.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { HashRouter } from 'react-router';

import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';

import { SETTINGS_KEYS, THEME_MODES, type ThemeMode } from '../shared/types';
import { ThemeModeContext, type ThemeModeContextValue } from './AppShell';
import { AppRoutes } from './routes';

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (THEME_MODES as readonly string[]).includes(value);
}

export function App(): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>('system');

  // Restore the persisted preference. Until it arrives we render 'system',
  // which already follows the OS, so there is no visible flash either way.
  useEffect(() => {
    let cancelled = false;
    void window.api
      .invoke('settings:get', { key: SETTINGS_KEYS.themeMode })
      .then((result) => {
        if (!cancelled && isThemeMode(result.value)) setModeState(result.value);
      })
      .catch((error: unknown) => {
        console.warn('[theme] could not read the persisted theme mode:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void window.api
      .invoke('settings:set', { key: SETTINGS_KEYS.themeMode, value: next })
      .catch((error: unknown) => {
        console.warn('[theme] could not persist the theme mode:', error);
      });
  }, []);

  const themeContext = useMemo<ThemeModeContextValue>(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <Theme theme={neutralTheme} mode={mode}>
      <ThemeModeContext value={themeContext}>
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </ThemeModeContext>
    </Theme>
  );
}
