/**
 * Models feature barrel — the `/models` route.
 *
 * The flow this page implements, in order:
 *
 *   browse the catalog or paste a Hugging Face repo
 *     -> a per-quant compatibility verdict, computed before anything downloads
 *     -> download, with progress / pause / resume / cancel
 *     -> the model appears under "My Models"
 *     -> "Test on my machine" really loads it and generates tokens
 *     -> the recorded result travels with the model into the assistant
 *
 * Red is a warning, not a block: the estimate can be wrong and it is the user's
 * machine, so downloading anyway stays possible behind a confirmation that says
 * plainly what is expected to happen.
 */

import { useCallback, useState } from 'react';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import type { ModelRecord } from '../../../shared/types';
import {
  describeSmokeTest,
  downloadErrorOf,
  presentVerdict,
  readSmokeTest,
  variantKey,
  type SupportVerdict,
  type VariantSupportView,
} from './llmExtra';
import {
  formatBytes,
  formatDuration,
  formatGiB,
  formatRate,
  useModels,
  type DownloadState,
  type ModelsState,
} from './useModels';

/** What the list needs to know about one downloadable file. */
interface Variant {
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
}

export function ModelsPage(): React.JSX.Element {
  const models = useModels();
  const [pendingRed, setPendingRed] = useState<Variant | null>(null);

  const localByFile = new Map<string, ModelRecord>(
    models.local.map((record) => [variantKey(record.repo, record.filename), record]),
  );

  const startDownload = useCallback(
    (variant: Variant, verdict: SupportVerdict) => {
      if (verdict === 'RED') {
        setPendingRed(variant);
        return;
      }
      void models.download(variant);
    },
    [models],
  );

  return (
    <VStack gap={4} padding={4} isScrollable height="100%">
      <VStack gap={1}>
        <Heading level={1}>Models</Heading>
        <Text type="supporting">
          Models run entirely on this machine. Nothing you type in the assistant leaves the app.
        </Text>
      </VStack>

      {models.error ? (
        <Banner
          status="error"
          title="Something went wrong"
          description={models.error}
          isDismissable
          onDismiss={models.dismissError}
        />
      ) : null}

      <SystemPanel models={models} />

      <RepoLookup models={models} localByFile={localByFile} onDownload={startDownload} />

      <VStack gap={2}>
        <Heading level={2}>Catalog</Heading>
        {models.isLoading ? (
          <HStack gap={2} padding={6} hAlign="center">
            <Spinner label="Loading the model catalog" />
          </HStack>
        ) : models.groups.length === 0 ? (
          <EmptyState
            title="No models in the catalog"
            description="The curated catalog could not be read. Restart the app and try again."
            headingLevel={3}
          />
        ) : (
          models.groups.map((group) => (
            <Card key={group.repo} padding={3}>
              <Collapsible
                value={group.repo}
                defaultIsOpen={false}
                onOpenChange={(isOpen) => {
                  // Lazy: nothing is checked until the user asks to see it.
                  if (!isOpen) return;
                  for (const variant of group.variants) {
                    void models.ensureSupport(variant);
                  }
                }}
                trigger={
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text weight="semibold">{group.repo}</Text>
                    <Badge
                      variant="neutral"
                      label={`${group.variants.length} ${group.variants.length === 1 ? 'variant' : 'variants'}`}
                    />
                  </HStack>
                }
              >
                <VStack gap={3} padding={2}>
                  {group.variants.map((variant) => (
                    <VariantRow
                      key={variant.filename}
                      models={models}
                      variant={variant}
                      record={localByFile.get(variantKey(variant.repo, variant.filename)) ?? null}
                      onDownload={startDownload}
                    />
                  ))}
                </VStack>
              </Collapsible>
            </Card>
          ))
        )}
      </VStack>

      <MyModels models={models} />

      <AlertDialog
        isOpen={pendingRed !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingRed(null);
        }}
        title="This model looks too big for this machine"
        description={
          pendingRed
            ? `${pendingRed.filename} needs more memory than we measured as usable. Expect it to fail to load, or to run so slowly it is unusable — and the download is ${formatBytes(pendingRed.sizeBytes)}. The estimate can be wrong, and it is your machine, so you can go ahead.`
            : ''
        }
        actionLabel="Download anyway"
        actionVariant="destructive"
        cancelLabel="Not now"
        onAction={() => {
          const variant = pendingRed;
          setPendingRed(null);
          if (variant) void models.download(variant);
        }}
      />
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// System panel
// ---------------------------------------------------------------------------

function SystemPanel({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const system = models.system;

  if (models.isSystemLoading) {
    return (
      <Card padding={3} variant="muted">
        <HStack gap={2} vAlign="center">
          <Spinner label="Detecting this machine" />
          <Text type="supporting">Detecting memory and GPUs…</Text>
        </HStack>
      </Card>
    );
  }

  if (!system) {
    return (
      <Banner
        status="warning"
        title="Hardware detection failed"
        description={`Compatibility verdicts are unavailable on this machine, so every model shows as "Not checked". ${models.systemError ?? ''}`}
      />
    );
  }

  return (
    <Card padding={3} variant="muted">
      <VStack gap={2}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={2}>This machine</Heading>
          <Button
            label="Re-detect"
            size="sm"
            variant="ghost"
            onClick={() => {
              void models.refreshSystem();
            }}
            tooltip="Probe memory and GPUs again, and clear the cached verdicts"
          />
        </HStack>

        <MetadataList columns="multi">
          <MetadataListItem label="System RAM">
            {system.totalRamBytes === null
              ? 'unknown'
              : `${formatGiB(system.totalRamBytes)} total · ${formatGiB(system.freeRamBytes)} free`}
          </MetadataListItem>
          <MetadataListItem label="CPU">
            {system.cpuModel ?? 'unknown'}
            {system.cpuCores ? ` · ${system.cpuCores} cores` : ''}
          </MetadataListItem>
          <MetadataListItem label="GPU">
            {system.gpus.length === 0
              ? 'none detected'
              : system.gpus.map((gpu) => gpu.name).join(', ')}
          </MetadataListItem>
          <MetadataListItem label="VRAM">
            {system.totalVramBytes === null ? 'unknown' : formatGiB(system.totalVramBytes)}
          </MetadataListItem>
          <MetadataListItem label="Unified memory">
            {system.hasUnifiedMemory ? 'yes — RAM is shared with the GPU' : 'no'}
          </MetadataListItem>
          <MetadataListItem label="Platform">
            {system.platform}/{system.arch}
            {system.gpuBackend ? ` · ${system.gpuBackend}` : ' · CPU only'}
          </MetadataListItem>
        </MetadataList>

        <Text type="supporting">
          Verdicts are computed against these numbers, at an 8192-token context, with{' '}
          {formatGiB(2_288_490_189)} held back for the system.
        </Text>

        {system.detectionError ? (
          <Banner
            status="warning"
            title="Some hardware could not be read"
            description={system.detectionError}
          />
        ) : null}
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Hugging Face lookup
// ---------------------------------------------------------------------------

interface RepoLookupProps {
  readonly models: ModelsState;
  readonly localByFile: Map<string, ModelRecord>;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}

function RepoLookup({ models, localByFile, onDownload }: RepoLookupProps): React.JSX.Element {
  const [input, setInput] = useState('');

  const submit = (): void => {
    if (input.trim().length === 0) return;
    void models.lookupRepo(input.trim());
  };

  return (
    <Card padding={3}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Add from Hugging Face</Heading>
          <Text type="supporting">
            Paste a repo id or link — anything ending in <code>-GGUF</code> — and every quant in it
            is checked against this machine before you download.
          </Text>
        </VStack>

        <HStack gap={2} vAlign="end" wrap="wrap">
          <TextInput
            label="Hugging Face repo"
            value={input}
            onChange={setInput}
            placeholder="bartowski/Qwen2.5-7B-Instruct-GGUF"
            hasClear
            isLoading={models.isHfLoading}
          />
          <Button label="Look up" variant="primary" isLoading={models.isHfLoading} onClick={submit} />
          {models.hfRepo ? <Button label="Clear" variant="ghost" onClick={models.clearRepo} /> : null}
        </HStack>

        {models.hfError ? (
          <Banner status="error" title="Could not read that repo" description={models.hfError} />
        ) : null}

        {models.hfRepo ? (
          <VStack gap={3}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text weight="semibold">{models.hfRepo.repo}</Text>
              {models.hfRepo.license ? (
                <Badge variant="neutral" label={models.hfRepo.license} />
              ) : null}
              {models.hfRepo.gated ? <Badge variant="warning" label="Gated" /> : null}
              {models.hfRepo.isPrivate ? <Badge variant="warning" label="Private" /> : null}
            </HStack>

            {models.hfRepo.skippedSplitFiles.length > 0 ? (
              <Text type="supporting">
                {models.hfRepo.skippedSplitFiles.length} file
                {models.hfRepo.skippedSplitFiles.length === 1 ? ' is' : 's are'} multi-part or in a
                subdirectory and cannot be downloaded here.
              </Text>
            ) : null}

            {models.hfRepo.variants.map((variant) => {
              const asVariant: Variant = {
                repo: models.hfRepo?.repo ?? '',
                filename: variant.filename,
                quant: variant.quant,
                sizeBytes: variant.sizeBytes,
                description: null,
              };
              return (
                <VariantRow
                  key={variant.filename}
                  models={models}
                  variant={asVariant}
                  record={localByFile.get(variantKey(asVariant.repo, variant.filename)) ?? null}
                  onDownload={onDownload}
                />
              );
            })}
          </VStack>
        ) : null}
      </VStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One downloadable variant
// ---------------------------------------------------------------------------

interface VariantRowProps {
  readonly models: ModelsState;
  readonly variant: Variant;
  readonly record: ModelRecord | null;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}

function VariantRow({ models, variant, record, onDownload }: VariantRowProps): React.JSX.Element {
  const key = variantKey(variant.repo, variant.filename);
  const verdict = models.verdictFor(variant.repo, variant.filename);
  const support = models.support[key] ?? null;
  const progress: DownloadState | null = record ? (models.progress[record.id] ?? null) : null;

  // The event stream is ahead of the table between two refreshes, so it wins.
  const isDownloading = progress?.status === 'downloading' || record?.status === 'downloading';
  const isReady = progress?.status === 'ready' || (record?.status === 'ready' && !isDownloading);
  const failure = progress?.status === 'error' ? progress.error : downloadErrorOf(record?.error ?? null);

  const received = progress?.receivedBytes ?? record?.downloadedBytes ?? 0;
  const total = progress?.totalBytes ?? record?.sizeBytes ?? variant.sizeBytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  const isPaused = !isReady && !isDownloading && received > 0;
  const isBusy = models.busyId === key || (record !== null && models.busyId === record.id);

  return (
    <VStack gap={2}>
      <Divider />
      <HStack gap={3} hAlign="between" vAlign="start" wrap="wrap">
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="semibold">{variant.quant ?? variant.filename}</Text>
            <VerdictChip verdict={verdict} platform={models.system?.platform ?? null} />
            {isReady ? <Badge variant="success" label="Downloaded" /> : null}
          </HStack>
          <Text type="supporting">
            {variant.filename} · {formatBytes(variant.sizeBytes)}
          </Text>
        </VStack>

        <HStack gap={2} wrap="wrap">
          {isDownloading ? (
            <>
              <Button
                label="Pause"
                variant="secondary"
                isLoading={isBusy}
                onClick={() => {
                  if (record) void models.pause(record.id);
                }}
                tooltip="Stops the transfer and keeps what has been downloaded so far"
              />
              <Button
                label="Cancel"
                variant="destructive"
                isLoading={isBusy}
                onClick={() => {
                  if (record) void models.cancel(record.id);
                }}
                tooltip="Stops the transfer and deletes the partial file"
              />
            </>
          ) : (
            <Button
              label={isReady ? 'Re-download' : isPaused ? 'Resume' : 'Download'}
              variant={isReady ? 'ghost' : 'primary'}
              isLoading={isBusy}
              onClick={() => {
                onDownload(variant, verdict);
              }}
            />
          )}
          {verdict === 'GREY' || support?.error ? (
            <Button
              label="Check"
              variant="ghost"
              isLoading={models.checking[key] === true}
              onClick={() => {
                void models.ensureSupport(variant, true);
              }}
              tooltip="Read the model header and compute whether it fits on this machine"
            />
          ) : null}
        </HStack>
      </HStack>

      {variant.description ? <Text type="supporting">{variant.description}</Text> : null}

      {failure ? <Banner status="error" title="Download failed" description={failure} /> : null}

      {isDownloading ? (
        <VStack gap={1}>
          <ProgressBar
            label={`Downloading ${variant.filename}`}
            value={percent}
            max={100}
            hasValueLabel
            variant="accent"
          />
          <HStack gap={3} wrap="wrap">
            <Text type="supporting">
              {formatBytes(received)} of {formatBytes(total)}
            </Text>
            <Text type="supporting">{formatRate(progress?.bytesPerSecond ?? 0)}</Text>
            <Text type="supporting">ETA {formatDuration(progress?.etaSeconds ?? null)}</Text>
          </HStack>
        </VStack>
      ) : null}

      {isPaused ? (
        <Text type="supporting">
          Paused at {formatBytes(received)} — Resume continues from there.
        </Text>
      ) : null}

      <SupportDetails
        verdict={verdict}
        support={support}
        isChecking={models.checking[key] === true}
      />
    </VStack>
  );
}

function VerdictChip({
  verdict,
  platform,
}: {
  readonly verdict: SupportVerdict;
  readonly platform: string | null;
}): React.JSX.Element {
  const presentation = presentVerdict(verdict, platform);
  return <Badge variant={presentation.badge} label={presentation.label} />;
}

/** The numbers behind the chip. They are what make the verdict trustworthy. */
function SupportDetails({
  verdict,
  support,
  isChecking,
}: {
  readonly verdict: SupportVerdict;
  readonly support: VariantSupportView | null;
  readonly isChecking: boolean;
}): React.JSX.Element | null {
  if (isChecking) {
    return (
      <HStack gap={2} vAlign="center">
        <Spinner label="Checking compatibility" size="sm" />
        <Text type="supporting">Reading the model header…</Text>
      </HStack>
    );
  }

  if (!support) {
    return verdict === 'GREY' ? (
      <Text type="supporting">Not checked yet. Press Check to read the header.</Text>
    ) : null;
  }

  if (support.error) {
    return <Text type="supporting">Could not check: {support.error}</Text>;
  }

  const breakdown = support.breakdown;

  return (
    <Collapsible
      value={`${support.repo}/${support.filename}`}
      defaultIsOpen={false}
      trigger={<Text type="supporting">Why?</Text>}
    >
      <VStack gap={2} padding={2}>
        <Text type="supporting">{breakdown.reason}</Text>
        <MetadataList columns="multi">
          <MetadataListItem label="Weights">{formatGiB(breakdown.modelSizeBytes)}</MetadataListItem>
          <MetadataListItem label={`KV cache at ${breakdown.contextSize} tokens`}>
            {formatGiB(breakdown.kvCacheBytes)}
          </MetadataListItem>
          <MetadataListItem label="Total required">
            {formatGiB(breakdown.totalRequiredBytes)}
          </MetadataListItem>
          <MetadataListItem label="Usable VRAM">
            {formatGiB(breakdown.usableVramBytes)}
          </MetadataListItem>
          <MetadataListItem label="Usable total memory">
            {formatGiB(breakdown.usableTotalMemoryBytes)}
          </MetadataListItem>
          <MetadataListItem label="Architecture">
            {support.architecture ?? 'unknown'}
            {support.maxContextLength ? ` · ${support.maxContextLength} max context` : ''}
          </MetadataListItem>
        </MetadataList>
      </VStack>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// My Models
// ---------------------------------------------------------------------------

function MyModels({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const ready = models.local.filter((record) => record.status === 'ready');
  const diskUsage = models.local.reduce(
    (total, record) =>
      total +
      (record.status === 'ready' ? (record.sizeBytes ?? record.downloadedBytes) : record.downloadedBytes),
    0,
  );

  return (
    <VStack gap={2}>
      <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
        <Heading level={2}>My models</Heading>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Text type="supporting">{formatBytes(diskUsage)} on disk</Text>
          <Divider orientation="vertical" />
          {models.activeModelId ? (
            <HStack gap={2} vAlign="center">
              <Badge variant="info" label={`Loaded: ${models.activeModelId}`} />
              <Button
                label="Unload"
                size="sm"
                variant="ghost"
                isLoading={models.busyId === '__unload__'}
                onClick={() => {
                  void models.unload();
                }}
              />
            </HStack>
          ) : (
            <Text type="supporting">No model loaded</Text>
          )}
        </HStack>
      </HStack>

      {ready.length === 0 ? (
        <EmptyState
          title="Nothing downloaded yet"
          description="Pick a model above. The compatibility chip tells you whether it will run here before you spend the bandwidth."
          headingLevel={3}
        />
      ) : (
        ready.map((record) => (
          <LocalModelCard key={record.id} models={models} record={record} />
        ))
      )}
    </VStack>
  );
}

function LocalModelCard({
  models,
  record,
}: {
  readonly models: ModelsState;
  readonly record: ModelRecord;
}): React.JSX.Element {
  const smokeTest = readSmokeTest(record.error);
  const isActive = models.activeModelId === record.id;
  const isTesting = models.testingId === record.id;
  const isBusy = models.busyId === record.id;

  const badge =
    smokeTest === null
      ? { variant: 'neutral' as const, label: 'Untested' }
      : smokeTest.verdict === 'pass'
        ? { variant: 'success' as const, label: describeSmokeTest(smokeTest) }
        : smokeTest.verdict === 'slow'
          ? { variant: 'warning' as const, label: describeSmokeTest(smokeTest) }
          : { variant: 'error' as const, label: describeSmokeTest(smokeTest) };

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="start" wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={3}>{record.id}</Heading>
              {record.quant ? <Badge variant="neutral" label={record.quant} /> : null}
              <Badge variant={badge.variant} label={badge.label} />
              {isActive ? <Badge variant="info" label="Loaded" /> : null}
            </HStack>
            <Text type="supporting">
              {record.repo} · {formatBytes(record.sizeBytes ?? record.downloadedBytes)}
            </Text>
          </VStack>
        </HStack>

        {isTesting ? (
          <HStack gap={2} vAlign="center">
            <Spinner label="Running the smoke test" size="sm" />
            <Text type="supporting">
              Loading the model and generating a short reply. This evicts whatever model was loaded.
            </Text>
          </HStack>
        ) : null}

        {smokeTest ? <SmokeTestSummary record={smokeTest} /> : null}

        <HStack gap={2} wrap="wrap">
          <Button
            label={smokeTest === null ? 'Test on my machine' : 'Test again'}
            variant={smokeTest === null ? 'primary' : 'secondary'}
            isLoading={isTesting}
            isDisabled={models.testingId !== null && !isTesting}
            onClick={() => {
              void models.smokeTest(record.id);
            }}
            tooltip="Loads the model and generates a few tokens, right now, on this machine"
          />
          <Button
            label={isActive ? 'Loaded' : 'Load'}
            variant="secondary"
            isDisabled={isActive || isTesting}
            isLoading={isBusy && !isActive}
            onClick={() => {
              void models.load(record.id);
            }}
            tooltip="Make this the model the assistant uses"
          />
          <Button
            label="Delete"
            variant="destructive"
            isLoading={isBusy}
            isDisabled={isTesting}
            onClick={() => {
              void models.remove(record.id);
            }}
            tooltip="Removes the weights from this machine"
          />
        </HStack>
      </VStack>
    </Card>
  );
}

function SmokeTestSummary({ record }: { readonly record: NonNullable<ReturnType<typeof readSmokeTest>> }): React.JSX.Element {
  return (
    <VStack gap={2}>
      {record.verdict === 'fail' ? (
        <Banner
          status="error"
          title={
            record.failureKind === 'timeout'
              ? 'The test timed out'
              : record.failureKind === 'out_of_memory'
                ? 'The machine ran out of memory'
                : 'The test failed'
          }
          description={record.error ?? 'No further detail was reported.'}
        />
      ) : null}

      <MetadataList columns="multi">
        <MetadataListItem label="Load time">{`${record.loadMs} ms`}</MetadataListItem>
        <MetadataListItem label="First token">
          {record.timeToFirstTokenMs === null ? '—' : `${record.timeToFirstTokenMs} ms`}
        </MetadataListItem>
        <MetadataListItem label="Speed">
          {record.tokensPerSecond === null ? '—' : `${record.tokensPerSecond} tok/s`}
        </MetadataListItem>
        <MetadataListItem label="Tokens">{record.tokensGenerated}</MetadataListItem>
        <MetadataListItem label="Peak memory">
          {record.peakRssBytes === null ? 'unknown' : formatBytes(record.peakRssBytes)}
        </MetadataListItem>
        <MetadataListItem label="Context tested">{record.contextSize}</MetadataListItem>
      </MetadataList>

      {record.text.trim().length > 0 ? (
        <Card padding={2} variant="muted">
          <Text type="supporting">It said: “{record.text.trim()}”</Text>
        </Card>
      ) : null}
    </VStack>
  );
}
