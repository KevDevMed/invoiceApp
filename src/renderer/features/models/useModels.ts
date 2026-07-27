/**
 * State for the Models page: the machine, the catalog, what is on disk, the
 * per-variant compatibility verdicts, and live download progress.
 *
 * Two things are re-derived here that main already knows, both because the
 * frozen contract has no field for them:
 *   - transfer rate and ETA, from the deltas between consecutive
 *     `llm:downloadProgress` events (the event carries byte counts only);
 *   - nothing else — verdicts, system info and smoke tests come from main
 *     through the multiplexed `llm:catalog` channel in `./llmExtra`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';


import {
  checkSupport as checkSupportCall,
  fetchCatalog,
  fetchSystemInfo,
  lookupHfRepo,
  runSmokeTest as runSmokeTestCall,
  variantKey,
  type HfRepoView,
  type LocalModel,
  type SmokeTestView,
  type SupportVerdict,
  type SystemInfoView,
  type VariantSupportView,
} from './llmExtra';

export interface CatalogEntryView {
  readonly id: string;
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
}

/** One repo with every quant variant we know about, which is what the list renders. */
export interface CatalogGroup {
  readonly repo: string;
  readonly variants: readonly CatalogEntryView[];
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
  readonly groups: CatalogGroup[];
  readonly local: LocalModel[];
  readonly progress: Record<string, DownloadState>;
  readonly activeModelId: string | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly busyId: string | null;

  /** Detected machine, or null while loading / when detection failed outright. */
  readonly system: SystemInfoView | null;
  readonly systemError: string | null;
  readonly isSystemLoading: boolean;

  /** Verdicts keyed by `repo/filename`. */
  readonly support: Record<string, VariantSupportView>;
  /** Variants with a check in flight, same key. */
  readonly checking: Record<string, boolean>;

  readonly hfRepo: HfRepoView | null;
  readonly hfError: string | null;
  readonly isHfLoading: boolean;

  /** Model id whose smoke test is running right now. */
  readonly testingId: string | null;
  readonly lastSmokeTest: SmokeTestView | null;

  refresh(): Promise<void>;
  refreshSystem(): Promise<void>;
  ensureSupport(entry: { repo: string; filename: string; sizeBytes: number | null }, refresh?: boolean): Promise<void>;
  verdictFor(repo: string, filename: string): SupportVerdict;
  lookupRepo(input: string): Promise<void>;
  clearRepo(): void;
  download(entry: { repo: string; filename: string; quant?: string | null }): Promise<void>;
  /** Stop the transfer, keeping the partial file so it can be resumed. */
  pause(modelId: string): Promise<void>;
  /** Stop the transfer and throw the partial file away. */
  cancel(modelId: string): Promise<void>;
  remove(modelId: string): Promise<void>;
  load(modelId: string): Promise<void>;
  unload(): Promise<void>;
  smokeTest(modelId: string): Promise<void>;
  dismissError(): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useModels(): ModelsState {
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [local, setLocal] = useState<LocalModel[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadState>>({});
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [system, setSystem] = useState<SystemInfoView | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [isSystemLoading, setIsSystemLoading] = useState(true);

  const [support, setSupport] = useState<Record<string, VariantSupportView>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const [hfRepo, setHfRepo] = useState<HfRepoView | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [isHfLoading, setIsHfLoading] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [lastSmokeTest, setLastSmokeTest] = useState<SmokeTestView | null>(null);

  const samples = useRef<Map<string, Sample>>(new Map());
  /** Keys with a check already requested, so a re-render cannot fire a second one. */
  const requested = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [catalogEntries, localResult, active] = await Promise.all([
        fetchCatalog(),
        window.api.invoke('llm:listLocal', undefined),
        window.api.invoke('settings:get', { key: ACTIVE_MODEL_SETTING_KEY }),
      ]);
      setCatalog(catalogEntries);
      setLocal(localResult.models);
      setActiveModelId(active.value && active.value.length > 0 ? active.value : null);
      setError(null);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshSystem = useCallback(async () => {
    setIsSystemLoading(true);
    try {
      setSystem(await fetchSystemInfo());
      setSystemError(null);
    } catch (caught) {
      // Detection failing is not an app error: it means every verdict is grey.
      setSystem(null);
      setSystemError(message(caught));
    } finally {
      setIsSystemLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSystem();
  }, [refresh, refreshSystem]);

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

  /**
   * Check one variant, lazily and at most once.
   *
   * Main caches the answer too; this guard exists so an expanded card that
   * re-renders does not queue a second range request before the first returns.
   */
  const ensureSupport = useCallback(
    async (
      entry: { repo: string; filename: string; sizeBytes: number | null },
      forceRefresh = false,
    ) => {
      const key = variantKey(entry.repo, entry.filename);
      if (!forceRefresh && requested.current.has(key)) return;
      requested.current.add(key);
      setChecking((current) => ({ ...current, [key]: true }));

      try {
        const result = await checkSupportCall({
          repo: entry.repo,
          filename: entry.filename,
          sizeBytes: entry.sizeBytes,
          refresh: forceRefresh,
        });
        setSupport((current) => ({ ...current, [key]: result }));
        // A grey answer is worth retrying later; a real verdict is not.
        if (result.error !== null) requested.current.delete(key);
      } catch (caught) {
        requested.current.delete(key);
        setError(message(caught));
      } finally {
        setChecking((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const verdictFor = useCallback(
    (repo: string, filename: string): SupportVerdict => {
      const key = variantKey(repo, filename);
      if (checking[key]) return 'LOADING';
      return support[key]?.breakdown.verdict ?? 'GREY';
    },
    [checking, support],
  );

  const lookupRepo = useCallback(async (input: string) => {
    setIsHfLoading(true);
    setHfError(null);
    try {
      setHfRepo(await lookupHfRepo(input));
    } catch (caught) {
      setHfRepo(null);
      setHfError(message(caught));
    } finally {
      setIsHfLoading(false);
    }
  }, []);

  const clearRepo = useCallback(() => {
    setHfRepo(null);
    setHfError(null);
  }, []);

  const download = useCallback(
    async (entry: { repo: string; filename: string; quant?: string | null }) => {
      await run(variantKey(entry.repo, entry.filename), () =>
        window.api.invoke('llm:download', {
          repo: entry.repo,
          filename: entry.filename,
          quant: entry.quant ?? undefined,
        }),
      );
    },
    [run],
  );

  const pause = useCallback(
    async (modelId: string) => {
      await run(modelId, () => window.api.invoke('llm:cancelDownload', { modelId }));
    },
    [run],
  );

  const cancel = useCallback(
    async (modelId: string) => {
      await run(modelId, async () => {
        await window.api.invoke('llm:cancelDownload', { modelId });
        // Cancel means "forget it": the partial file goes too.
        await window.api.invoke('llm:removeModel', { modelId });
      });
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

  const smokeTest = useCallback(
    async (modelId: string) => {
      setTestingId(modelId);
      setError(null);
      try {
        setLastSmokeTest(await runSmokeTestCall(modelId));
      } catch (caught) {
        setError(message(caught));
      } finally {
        setTestingId(null);
        await refresh();
      }
    },
    [refresh],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const groups = useMemo(() => groupByRepo(catalog), [catalog]);

  return useMemo(
    () => ({
      catalog,
      groups,
      local,
      progress,
      activeModelId,
      isLoading,
      error,
      busyId,
      system,
      systemError,
      isSystemLoading,
      support,
      checking,
      hfRepo,
      hfError,
      isHfLoading,
      testingId,
      lastSmokeTest,
      refresh,
      refreshSystem,
      ensureSupport,
      verdictFor,
      lookupRepo,
      clearRepo,
      download,
      pause,
      cancel,
      remove,
      load,
      unload,
      smokeTest,
      dismissError,
    }),
    [
      catalog,
      groups,
      local,
      progress,
      activeModelId,
      isLoading,
      error,
      busyId,
      system,
      systemError,
      isSystemLoading,
      support,
      checking,
      hfRepo,
      hfError,
      isHfLoading,
      testingId,
      lastSmokeTest,
      refresh,
      refreshSystem,
      ensureSupport,
      verdictFor,
      lookupRepo,
      clearRepo,
      download,
      pause,
      cancel,
      remove,
      load,
      unload,
      smokeTest,
      dismissError,
    ],
  );
}

function groupByRepo(entries: readonly CatalogEntryView[]): CatalogGroup[] {
  const byRepo = new Map<string, CatalogEntryView[]>();
  for (const entry of entries) {
    const bucket = byRepo.get(entry.repo);
    if (bucket) bucket.push(entry);
    else byRepo.set(entry.repo, [entry]);
  }
  return [...byRepo.entries()].map(([repo, variants]) => ({
    repo,
    variants: [...variants].sort((left, right) => (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)),
  }));
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

/** Binary units, for memory figures — the verdict arithmetic is in GiB. */
export function formatGiB(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
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
