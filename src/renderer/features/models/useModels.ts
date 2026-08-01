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


import type { SupportTarget } from './browseRows';
import {
  armUse,
  attachModelId,
  cancelArm,
  disarmKey,
  emptyArmState,
  noteTerminal,
  type ArmState,
} from './downloadArm';
import {
  applyDiscoveryFold,
  foldDiscoveryVerdicts,
  foldIsEmpty,
} from './supportCache';
import {
  checkSupport as checkSupportCall,
  discoverModels as discoverModelsCall,
  fetchCatalog,
  fetchSystemInfo,
  lookupHfRepo,
  runSmokeTest as runSmokeTestCall,
  variantKey,
  type DiscoveryView,
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
  /**
   * A `Re-check` is running right now.
   *
   * Deliberately narrower than "something is loading". The chip's button is
   * disabled while this is true, and folding a Hub sweep into it made `Re-check`
   * unpressable during the one activity most likely to make someone want it.
   */
  readonly isRechecking: boolean;

  /** Verdicts keyed by `repo/filename`. */
  readonly support: Record<string, VariantSupportView>;
  /** Variants with a check in flight, same key. */
  readonly checking: Record<string, boolean>;

  readonly hfRepo: HfRepoView | null;
  readonly hfError: string | null;
  readonly isHfLoading: boolean;

  /** Last "what runs here" sweep, or null before one has been asked for. */
  readonly discovery: DiscoveryView | null;
  readonly discoveryError: string | null;
  readonly isDiscovering: boolean;

  /** Model id whose smoke test is running right now. */
  readonly testingId: string | null;
  readonly lastSmokeTest: SmokeTestView | null;

  refresh(): Promise<void>;
  /** `refresh` re-probes the hardware instead of reading main's cached profile. */
  refreshSystem(refresh?: boolean): Promise<void>;
  /**
   * Throw every cached verdict away, measure the machine again, and re-check the
   * variants passed in. What `Re-check` does, and what its tooltip promises.
   */
  recheck(targets: readonly SupportTarget[]): Promise<void>;
  ensureSupport(entry: { repo: string; filename: string; sizeBytes: number | null }, refresh?: boolean): Promise<void>;
  verdictFor(repo: string, filename: string): SupportVerdict;
  lookupRepo(input: string): Promise<void>;
  clearRepo(): void;
  /** Search the Hub and rank the results against this machine. */
  discover(query: string): Promise<void>;
  clearDiscovery(): void;
  download(entry: { repo: string; filename: string; quant?: string | null }): Promise<void>;
  /**
   * Download, then load the model the moment the transfer reports `ready`.
   *
   * A failed, cancelled or paused transfer loads nothing. `llm:download` returns
   * as soon as the transfer *starts*, so the second half is armed here and fired
   * from the progress stream.
   */
  downloadAndUse(entry: { repo: string; filename: string; quant?: string | null }): Promise<void>;
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
  const [isRechecking, setIsRechecking] = useState(false);

  const [support, setSupport] = useState<Record<string, VariantSupportView>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});

  const [hfRepo, setHfRepo] = useState<HfRepoView | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [isHfLoading, setIsHfLoading] = useState(false);

  const [discovery, setDiscovery] = useState<DiscoveryView | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [lastSmokeTest, setLastSmokeTest] = useState<SmokeTestView | null>(null);

  const samples = useRef<Map<string, Sample>>(new Map());
  /**
   * Which machine reading every cached verdict belongs to.
   *
   * `recheck` bumps it. Every async producer of `support` captures it on entry
   * and discards its whole result if it moved while the call was in flight —
   * see `./supportCache`. This is the one thing standing between an obsolete
   * verdict and a RED model downloading with no confirmation.
   */
  const generation = useRef(0);
  /**
   * Key → the generation whose check has been requested or answered for it, so
   * a re-render cannot fire a second check and a bumped generation
   * automatically invalidates every entry without clearing anything.
   */
  const requested = useRef<Map<string, number>>(new Map());
  /**
   * Write ordering *within* one generation.
   *
   * The generation settles who wins across a `Re-check`; this settles it between
   * two producers that both belong to the current reading. Every producer takes
   * a sequence number before it goes out and may only write a key no later
   * producer has already written or cleared — otherwise a slow sweep's perfectly
   * valid verdict lands on top of the fresher one that overtook it.
   */
  const nextWrite = useRef(1);
  const writtenAt = useRef<Map<string, number>>(new Map());
  /** Latest Hub lookup / sweep, so a late response cannot replace a newer one. */
  const hfToken = useRef(0);
  const discoveryToken = useRef(0);
  /** Latest hardware probe, same reason. */
  const systemToken = useRef(0);
  /**
   * Still on screen. The Models page starts a check per curated build on mount,
   * so navigating away mid-sweep otherwise lands setters on an unmounted tree.
   */
  const mounted = useRef(true);
  /** `Download & use` arms, keyed to the request that made them. */
  const useArm = useRef<ArmState>(emptyArmState());
  /** Latest `load`, so the progress subscription can call it without depending on it. */
  const loadRef = useRef<((modelId: string) => Promise<void>) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const refreshSystem = useCallback(async (refresh = false) => {
    const token = (systemToken.current += 1);
    const isCurrent = (): boolean => systemToken.current === token && mounted.current;
    setIsSystemLoading(true);
    try {
      const info = await fetchSystemInfo(refresh);
      if (!isCurrent()) return;
      setSystem(info);
      setSystemError(null);
    } catch (caught) {
      // Detection failing is not an app error: it means every verdict is grey.
      if (!isCurrent()) return;
      setSystem(null);
      setSystemError(message(caught));
    } finally {
      if (isCurrent()) setIsSystemLoading(false);
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
        // `Download & use` promised two things. Only a transfer that actually
        // finished earns the second one — error, cancelled and paused disarm it.
        const outcome = noteTerminal(useArm.current, event.modelId, event.status, at);
        useArm.current = outcome.state;
        if (outcome.shouldLoad && loadRef.current) {
          void loadRef.current(event.modelId); // refreshes on its way out
        } else {
          void refresh();
        }
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
   * Check one variant, lazily and at most once per machine reading.
   *
   * Main caches the answer too; the `requested` guard exists so an expanded card
   * that re-renders does not queue a second range request before the first
   * returns. It is keyed by generation, so a `Re-check` invalidates it without
   * having to clear it — and clearing it was itself a race, since a check still
   * in flight would then be re-requested by the next render.
   *
   * The result is dropped outright if the generation moved while the call was
   * out: it is a statement about a machine reading nobody believes any more.
   */
  const ensureSupport = useCallback(
    async (
      entry: { repo: string; filename: string; sizeBytes: number | null },
      forceRefresh = false,
    ) => {
      const gen = generation.current;
      const seq = (nextWrite.current += 1);
      const key = variantKey(entry.repo, entry.filename);
      if (!forceRefresh && requested.current.get(key) === gen) return;
      requested.current.set(key, gen);
      setChecking((current) => ({ ...current, [key]: true }));

      try {
        const result = await checkSupportCall({
          repo: entry.repo,
          filename: entry.filename,
          sizeBytes: entry.sizeBytes,
          refresh: forceRefresh,
        });
        if (generation.current !== gen || !mounted.current) return;
        // Someone newer already spoke about this key; this answer is merely late.
        if ((writtenAt.current.get(key) ?? 0) > seq) return;
        writtenAt.current.set(key, seq);
        setSupport((current) => ({ ...current, [key]: result }));
        // A grey answer is worth retrying later; a real verdict is not.
        if (result.error !== null) requested.current.delete(key);
      } catch (caught) {
        if (generation.current !== gen || !mounted.current) return;
        requested.current.delete(key);
        setError(message(caught));
      } finally {
        // A stale producer must not clear a flag the current one set; `recheck`
        // replaces the whole map at the bump, so nothing is stranded LOADING.
        if (generation.current === gen && mounted.current) {
          setChecking((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        }
      }
    },
    [],
  );

  /**
   * `Re-check`: invalidate, re-measure, re-check.
   *
   * The verdict cache has to be emptied *before* the probe, not after. A verdict
   * is a statement about a machine reading, so the moment that reading is thrown
   * away the verdicts computed from it are unfounded — and one of them is the
   * only thing standing between a RED model and a download with no confirmation.
   *
   * Emptying it is not enough on its own, which is what round one got wrong: a
   * check or a sweep that was already in flight would resolve afterwards and
   * write the old verdicts straight back. Bumping the generation is what makes
   * those results unwelcome rather than merely late.
   *
   * Two clicks are one race the generation did not settle on its own. The second
   * `Re-check` bumps past the first, but the first was parked on `refreshSystem`
   * and would wake up *after* the bump — so its targets, captured before the
   * click, would be checked under the new generation as though they were the
   * current screen, and its `finally` would clear flags the second one set. The
   * generation is captured here and re-read after every await instead.
   *
   * `refreshSystem(true)` is the other half of the promise the tooltip makes.
   * Without it the machine reading is main's cached one and this whole dance
   * recomputes the same verdicts from the same numbers.
   */
  const recheck = useCallback(
    async (targets: readonly SupportTarget[]) => {
      generation.current += 1;
      const gen = generation.current;
      writtenAt.current.clear();
      setIsRechecking(true);
      setSupport({});
      // Marked as in flight before the machine is even probed, so the rows read
      // LOADING for the whole invalidation rather than flashing through GREY —
      // which would claim, for a second, that nobody had ever looked.
      setChecking(
        Object.fromEntries(
          targets.map((target) => [variantKey(target.repo, target.filename), true] as const),
        ),
      );
      try {
        await refreshSystem(true);
        if (generation.current !== gen) return;
        await Promise.all(targets.map((target) => ensureSupport(target, true)));
      } finally {
        // A superseded re-check leaves the flag alone: the one that overtook it
        // owns it now and is still running.
        if (generation.current === gen && mounted.current) setIsRechecking(false);
      }
    },
    [refreshSystem, ensureSupport],
  );

  const verdictFor = useCallback(
    (repo: string, filename: string): SupportVerdict => {
      const key = variantKey(repo, filename);
      if (checking[key]) return 'LOADING';
      return support[key]?.breakdown.verdict ?? 'GREY';
    },
    [checking, support],
  );

  /**
   * Look one repo up by name.
   *
   * Tokenised because a search box produces overlapping requests as a matter of
   * course: without it the *slowest* lookup wins rather than the latest, and a
   * `Clear results` pressed while one is out is silently undone when it lands.
   * `clearRepo` bumps the token for exactly that reason.
   */
  const lookupRepo = useCallback(async (input: string) => {
    const token = (hfToken.current += 1);
    const isCurrent = (): boolean => hfToken.current === token && mounted.current;
    setIsHfLoading(true);
    setHfError(null);
    try {
      const found = await lookupHfRepo(input);
      if (!isCurrent()) return;
      setHfRepo(found);
    } catch (caught) {
      if (!isCurrent()) return;
      setHfRepo(null);
      setHfError(message(caught));
    } finally {
      // One finished lookup must not report "done" while another is still out.
      if (isCurrent()) setIsHfLoading(false);
    }
  }, []);

  const clearRepo = useCallback(() => {
    hfToken.current += 1;
    setHfRepo(null);
    setHfError(null);
    setIsHfLoading(false);
  }, []);

  /**
   * Sweep the Hub for models this machine can run.
   *
   * The verdicts that come back are folded into the same `support` map the
   * catalog rows read, and their keys are marked as answered, so a discovered
   * row that is also in the catalog renders its verdict immediately and does not
   * spend a second range request on a header main has already read.
   *
   * Two things the fold is careful about, both of them the round-one blocker in
   * different clothes:
   *
   *   - a result with no usable verdict **clears** that key and does not mark it
   *     answered — unconditionally. Round two spared a key the current reading
   *     had already answered, on the reasoning that both were founded on the
   *     same machine reading. That reasoning does not survive the sweep saying
   *     it could not verify the key: the row kept a stale colour *and* lost its
   *     `Check` affordance, with no way back;
   *   - if `Re-check` ran while the sweep was out, none of these verdicts are
   *     about the machine reading now on screen. The rows are still the right
   *     rows — the search happened, and dropping them would lose work the user
   *     asked for — but every verdict in them is discarded and the ones main did
   *     check are re-asked against the current reading.
   */
  const discover = useCallback(
    async (query: string) => {
      const gen = generation.current;
      const seq = (nextWrite.current += 1);
      const token = (discoveryToken.current += 1);
      const isCurrent = (): boolean => discoveryToken.current === token && mounted.current;
      setIsDiscovering(true);
      setDiscoveryError(null);
      try {
        // INV-4: `refresh` because main's per-variant verdict cache carries no
        // reference to the hardware profile its entries were computed against.
        // A check that was in flight across a `Re-check` still writes its stale
        // answer into that cache, and a sweep asking politely is served it —
        // whereupon a model that does not fit folds in as non-RED and downloads
        // without the confirmation. The renderer cannot fence another process's
        // cache, so it declines to accept anything that cache might have served.
        // The durable fix is versioning main's cache against the profile, filed
        // as INV-4; when that lands, drop this flag and the header reads it costs.
        const result = await discoverModelsCall({ query, refresh: true });
        // A newer search, or a `Clear results`, has spoken since. Its rows are
        // what the user is looking at; these are a stale answer to a stale query.
        if (!isCurrent()) return;

        if (generation.current !== gen) {
          setDiscovery(result);
          for (const model of result.models) {
            if (model.support === null) continue;
            // `forceRefresh`, because main caches per variant too: asking
            // politely hands back the very verdict the generation bump
            // discarded, computed against the reading nobody believes.
            void ensureSupport(
              {
                repo: model.repo,
                filename: model.filename,
                sizeBytes: model.sizeBytes,
              },
              true,
            );
          }
          return;
        }

        setDiscovery(result);
        const fold = foldDiscoveryVerdicts(
          result.models,
          (key) => (writtenAt.current.get(key) ?? 0) > seq,
        );
        for (const key of fold.answered) {
          requested.current.set(key, gen);
          writtenAt.current.set(key, seq);
        }
        for (const key of fold.clear) {
          requested.current.delete(key);
          writtenAt.current.set(key, seq);
        }
        if (!foldIsEmpty(fold)) {
          setSupport((current) => applyDiscoveryFold(current, fold));
        }
      } catch (caught) {
        if (generation.current !== gen || !isCurrent()) return;
        setDiscovery(null);
        setDiscoveryError(message(caught));
      } finally {
        // One finished sweep must not say "done" while another is still running.
        if (isCurrent()) setIsDiscovering(false);
      }
    },
    [ensureSupport],
  );

  const clearDiscovery = useCallback(() => {
    discoveryToken.current += 1;
    setDiscovery(null);
    setDiscoveryError(null);
    setIsDiscovering(false);
  }, []);

  const download = useCallback(
    async (entry: { repo: string; filename: string; quant?: string | null }) => {
      const key = variantKey(entry.repo, entry.filename);
      // A plain `Download` never loads anything, so it also revokes whatever an
      // earlier `Download & use` on the same file left armed.
      useArm.current = disarmKey(useArm.current, key);
      await run(key, () =>
        window.api.invoke('llm:download', {
          repo: entry.repo,
          filename: entry.filename,
          quant: entry.quant ?? undefined,
        }),
      );
    },
    [run],
  );

  const downloadAndUse = useCallback(
    async (entry: { repo: string; filename: string; quant?: string | null }) => {
      const key = variantKey(entry.repo, entry.filename);
      setBusyId(key);
      setError(null);
      // Armed *before* the invoke: a cached or tiny file can report `ready`
      // before `llm:download` resolves, and an arm that lands afterwards both
      // misses its own event and is left behind for the next download to trip
      // over. `attachModelId` picks up an event that arrived in the gap.
      const armed = armUse(useArm.current, key, Date.now());
      useArm.current = armed.state;
      try {
        const { modelId } = await window.api.invoke('llm:download', {
          repo: entry.repo,
          filename: entry.filename,
          quant: entry.quant ?? undefined,
        });
        const attached = attachModelId(useArm.current, armed.token, modelId, Date.now());
        useArm.current = attached.state;
        if (attached.shouldLoad && loadRef.current) {
          await loadRef.current(modelId); // refreshes on its way out
          return;
        }
        await refresh();
      } catch (caught) {
        useArm.current = cancelArm(useArm.current, armed.token);
        setError(message(caught));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
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

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

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
      isRechecking,
      support,
      checking,
      hfRepo,
      hfError,
      isHfLoading,
      discovery,
      discoveryError,
      isDiscovering,
      testingId,
      lastSmokeTest,
      refresh,
      refreshSystem,
      recheck,
      ensureSupport,
      verdictFor,
      lookupRepo,
      clearRepo,
      discover,
      clearDiscovery,
      download,
      downloadAndUse,
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
      isRechecking,
      support,
      checking,
      hfRepo,
      hfError,
      isHfLoading,
      discovery,
      discoveryError,
      isDiscovering,
      testingId,
      lastSmokeTest,
      refresh,
      refreshSystem,
      recheck,
      ensureSupport,
      verdictFor,
      lookupRepo,
      clearRepo,
      discover,
      clearDiscovery,
      download,
      downloadAndUse,
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
