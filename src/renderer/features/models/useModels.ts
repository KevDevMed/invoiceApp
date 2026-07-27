/**
 * State for the Models page: the catalog, what is on disk, and live progress.
 *
 * The `llm:downloadProgress` event carries byte counts but no transfer rate —
 * the frozen contract has no field for one — so the rate and ETA are derived
 * here from the deltas between consecutive events. That is also why the
 * throttling in main matters: these samples are the only clock we have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ModelRecord } from '../../../shared/types';

export interface CatalogEntryView {
  readonly id: string;
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
}

export interface DownloadState {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
  readonly status: 'downloading' | 'ready' | 'error' | 'cancelled';
  readonly error: string | null;
  readonly bytesPerSecond: number;
  readonly etaSeconds: number | null;
}

interface Sample {
  readonly at: number;
  readonly bytes: number;
  readonly bytesPerSecond: number;
}

export const ACTIVE_MODEL_SETTING_KEY = 'llm.activeModelId';

export interface ModelsState {
  readonly catalog: CatalogEntryView[];
  readonly local: ModelRecord[];
  readonly progress: Record<string, DownloadState>;
  readonly activeModelId: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly busyId: string | null;
  refresh(): Promise<void>;
  download(entry: CatalogEntryView): Promise<void>;
  cancel(modelId: string): Promise<void>;
  remove(modelId: string): Promise<void>;
  load(modelId: string): Promise<void>;
  unload(): Promise<void>;
  dismissError(): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useModels(): ModelsState {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [local, setLocal] = useState<ModelRecord[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadState>>({});
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const samples = useRef<Map<string, Sample>>(new Map());

  const refresh = useCallback(async () => {
    try {
      const [catalogResult, localResult, active] = await Promise.all([
        window.api.invoke('llm:catalog', {}),
        window.api.invoke('llm:listLocal', undefined),
        window.api.invoke('settings:get', { key: ACTIVE_MODEL_SETTING_KEY }),
      ]);
      setCatalog(catalogResult.entries);
      setLocal(localResult.models);
      setActiveModelId(active.value && active.value.length > 0 ? active.value : null);
      setError(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.api.on('llm:downloadProgress', (event) => {
      const at = Date.now();
      const previous = samples.current.get(event.modelId);

      let bytesPerSecond = 0;
      if (previous && at > previous.at && event.receivedBytes >= previous.bytes) {
        const instant = ((event.receivedBytes - previous.bytes) * 1000) / (at - previous.at);
        bytesPerSecond =
          previous.bytesPerSecond === 0 ? instant : previous.bytesPerSecond * 0.6 + instant * 0.4;
      }
      samples.current.set(event.modelId, { at, bytes: event.receivedBytes, bytesPerSecond });

      const remaining =
        event.totalBytes === null ? null : Math.max(0, event.totalBytes - event.receivedBytes);
      const etaSeconds =
        remaining === null || bytesPerSecond <= 0 ? null : Math.round(remaining / bytesPerSecond);

      setProgress((current) => ({
        ...current,
        [event.modelId]: {
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          status: event.status,
          error: event.error,
          bytesPerSecond: Math.round(bytesPerSecond),
          etaSeconds,
        },
      }));

      if (event.status !== 'downloading') {
        samples.current.delete(event.modelId);
        void refresh();
      }
    });

    return unsubscribe;
  }, [refresh]);

  const run = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusyId(id);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (caught) {
        setError(message(caught));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const download = useCallback(
    async (entry: CatalogEntryView) => {
      await run(entry.id, () =>
        window.api.invoke('llm:download', {
          repo: entry.repo,
          filename: entry.filename,
          quant: entry.quant ?? undefined,
        }),
      );
    },
    [run],
  );

  const cancel = useCallback(
    async (modelId: string) => {
      await run(modelId, () => window.api.invoke('llm:cancelDownload', { modelId }));
    },
    [run],
  );

  const remove = useCallback(
    async (modelId: string) => {
      await run(modelId, () => window.api.invoke('llm:removeModel', { modelId }));
    },
    [run],
  );

  const load = useCallback(
    async (modelId: string) => {
      await run(modelId, () => window.api.invoke('llm:load', { modelId }));
    },
    [run],
  );

  const unload = useCallback(async () => {
    await run('__unload__', () => window.api.invoke('llm:unload', undefined));
  }, [run]);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return useMemo(
    () => ({
      catalog,
      local,
      progress,
      activeModelId,
      isLoading,
      error,
      busyId,
      refresh,
      download,
      cancel,
      remove,
      load,
      unload,
      dismissError,
    }),
    [
      catalog,
      local,
      progress,
      activeModelId,
      isLoading,
      error,
      busyId,
      refresh,
      download,
      cancel,
      remove,
      load,
      unload,
      dismissError,
    ],
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown size';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
