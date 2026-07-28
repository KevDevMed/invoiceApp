/**
 * Renderer state for in-app updates.
 *
 * Main owns the state machine; this hook owns nothing but the latest snapshot of
 * it. Two sources feed that snapshot and both are needed:
 *   - `updates:getState` on mount, because the background check runs ten seconds
 *     after boot and may well have found an update before this component
 *     existed;
 *   - the `updates:state` event, for everything after that.
 *
 * Every action swallows an IPC rejection into the `error` phase. A rejected
 * `invoke` here means the channel itself failed — nothing a React error boundary
 * can do anything useful with, and nothing worth taking the Settings page down
 * for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { UpdateState } from '../../../shared/ipc-contract';

export interface UpdatesController {
  /** null until `updates:getState` answers — the section renders a spinner. */
  readonly state: UpdateState | null;
  /** An action's IPC call is in flight, before main has broadcast its phase. */
  readonly isBusy: boolean;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
}

function message(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  return raw.length > 0 ? raw : 'The update could not be completed. Please try again later.';
}

export function useUpdates(): UpdatesController {
  const [state, setState] = useState<UpdateState | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  /**
   * Mount flag shared by the actions.
   *
   * The effects use their own `cancelled` locals, but an action can outlive the
   * component entirely — `install()` in particular is answered by a process that
   * is on its way out — so a ref is what those read.
   */
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const initial = await window.api.invoke('updates:getState', undefined);
        if (!cancelled) setState(initial);
      } catch (error) {
        if (cancelled) return;
        // No snapshot at all, so there is no version to report either. Say what
        // is known rather than rendering an empty section forever.
        setState({
          phase: 'error',
          currentVersion: '',
          availableVersion: null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          message: message(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // `on()` hands back its own unsubscribe; returning it directly is the
    // cleanup, and skipping that leaks a listener per mount.
    const unsubscribe = window.api.on('updates:state', (next) => {
      setState(next);
    });
    return unsubscribe;
  }, []);

  /**
   * Run one action and fold any rejection into the state's error copy.
   *
   * The response is applied as well as the event, so a channel that answers
   * without a transition (a re-entrant check, a download in a phase that has no
   * file behind it) still leaves the UI holding main's truth.
   */
  const run = useCallback(
    async (channel: 'updates:check' | 'updates:download' | 'updates:install') => {
      setIsBusy(true);
      try {
        const next = await window.api.invoke(channel, undefined);
        if (isMounted.current) setState(next);
      } catch (error) {
        if (isMounted.current) {
          setState((current) =>
            current === null
              ? current
              : { ...current, phase: 'error', progressPercent: null, message: message(error) },
          );
        }
      } finally {
        if (isMounted.current) setIsBusy(false);
      }
    },
    [],
  );

  const check = useCallback(async () => {
    await run('updates:check');
  }, [run]);

  const download = useCallback(async () => {
    await run('updates:download');
  }, [run]);

  const install = useCallback(async () => {
    await run('updates:install');
  }, [run]);

  return { state, isBusy, check, download, install };
}
