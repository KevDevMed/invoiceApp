/**
 * Models feature barrel — the `/models` route.
 *
 * The flow this page implements, in order:
 *
 *   browse the catalog or paste a Hugging Face repo
 *     -> a per-quant compatibility verdict, computed before anything downloads
 *     -> download, with progress / pause / resume / cancel
 *     -> the model appears under "Installed models"
 *     -> "Test on my machine" really loads it and generates tokens
 *     -> the recorded result travels with the model into the assistant
 *
 * Red is a warning, not a block: the estimate can be wrong and it is the user's
 * machine, so downloading anyway stays possible behind a confirmation that says
 * plainly what is expected to happen.
 *
 * Layout is the shared page language: `Page` + `PageHeader`, then titled
 * sections separated by hairlines, and models as dense rows rather than cards.
 */

import { useCallback, useState } from 'react';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';

import { Page, PageHeader } from '../../ui/Page';

import {
  describeSmokeTest,
  presentVerdict,
  readSmokeTest,
  variantKey,
  type LocalModel,
  type SupportVerdict,
  type VariantSupportView,
} from './llmExtra';
import { diskUsageBytes, smokeTestStatus, transferState, verdictStatus } from './modelRows';
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

  const localByFile = new Map<string, LocalModel>(
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
    <Page>
      <PageHeader
        title="Models"
        description="Models run entirely on this machine. Nothing you type in the assistant leaves the app."
        actions={
          <Button
            label="Re-detect hardware"
            variant="secondary"
            isLoading={models.isSystemLoading}
            onClick={() => {
              void models.refreshSystem();
            }}
            tooltip="Probe memory and GPUs again, and clear the cached verdicts"
          />
        }
      />

      {models.error ? (
        <Banner
          status="error"
          title="Something went wrong"
          description={models.error}
          isDismissable
          onDismiss={models.dismissError}
        />
      ) : null}

      <SystemSection models={models} />

      <InstalledSection models={models} />

      <CatalogSection models={models} localByFile={localByFile} onDownload={startDownload} />

      <RepoLookupSection models={models} localByFile={localByFile} onDownload={startDownload} />

      <DiagnosticsSection models={models} />

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
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Section chrome
// ---------------------------------------------------------------------------

/**
 * A titled page region: heading, optional muted description, optional trailing
 * controls, then a hairline and the rows. Deliberately not astryx `Section` —
 * that paints a surface behind the region, and the page language here is
 * hairlines and whitespace rather than boxes.
 */
function PageSection({
  title,
  description,
  end,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly end?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={3}>
      <HStack justify="between" align="end" gap={3} wrap="wrap">
        <VStack gap={0.5}>
          {/* Visually a level-3 heading, semantically the page's h2: the
              reference keeps section labels quiet under a big page title. */}
          <Heading level={3} accessibilityLevel={2}>
            {title}
          </Heading>
          {description === undefined ? null : (
            <Text type="supporting" display="block">
              {description}
            </Text>
          )}
        </VStack>
        {end === undefined ? null : (
          <HStack gap={2} align="center" wrap="wrap">
            {end}
          </HStack>
        )}
      </HStack>
      <Divider />
      {children}
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// This machine
// ---------------------------------------------------------------------------

function SystemSection({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const system = models.system;

  return (
    <PageSection
      title="This machine"
      description="What the compatibility verdicts are measured against."
    >
      {models.isSystemLoading ? (
        <HStack gap={2} align="center">
          <Spinner label="Detecting this machine" size="sm" />
          <Text type="supporting">Detecting memory and GPUs…</Text>
        </HStack>
      ) : !system ? (
        <Banner
          status="warning"
          title="Hardware detection failed"
          description={`Compatibility verdicts are unavailable on this machine, so every model shows as "Not checked". ${models.systemError ?? ''}`}
        />
      ) : (
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
      )}
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// Installed models
// ---------------------------------------------------------------------------

function InstalledSection({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const ready = models.local.filter((record) => record.status === 'ready');
  const diskUsage = diskUsageBytes(models.local);

  return (
    <PageSection
      title="Installed models"
      description={`${formatBytes(diskUsage)} on disk.`}
      end={
        models.activeModelId ? (
          <>
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
          </>
        ) : (
          <Text type="supporting">No model loaded</Text>
        )
      }
    >
      {ready.length === 0 ? (
        <EmptyState
          title="Nothing downloaded yet"
          description="Pick a model from the catalog below. The compatibility dot tells you whether it will run here before you spend the bandwidth."
          headingLevel={3}
          isCompact
        />
      ) : (
        <List hasDividers density="balanced">
          {ready.map((record) => (
            <InstalledRow key={record.id} models={models} record={record} />
          ))}
        </List>
      )}
    </PageSection>
  );
}

function InstalledRow({
  models,
  record,
}: {
  readonly models: ModelsState;
  readonly record: LocalModel;
}): React.JSX.Element {
  const smokeTest = readSmokeTest(record);
  const status = smokeTestStatus(smokeTest);
  const isActive = models.activeModelId === record.id;
  const isTesting = models.testingId === record.id;
  const isBusy = models.busyId === record.id;

  return (
    <ListItem
      label={record.id}
      startContent={<StatusDot variant={status.status} label={`Smoke test: ${status.label}`} />}
      description={
        <VStack gap={2}>
          <Text type="supporting" display="block">
            {record.repo}
            {record.quant ? ` · ${record.quant}` : ''} ·{' '}
            {formatBytes(record.sizeBytes ?? record.downloadedBytes)} · {status.label}
            {isActive ? ' · loaded' : ''}
          </Text>

          {isTesting ? (
            <HStack gap={2} align="center">
              <Spinner label="Running the smoke test" size="sm" />
              <Text type="supporting">
                Loading the model and generating a short reply. This evicts whatever model was
                loaded.
              </Text>
            </HStack>
          ) : null}

          {smokeTest ? <SmokeTestSummary record={smokeTest} /> : null}
        </VStack>
      }
      endContent={
        <HStack gap={2} wrap="wrap">
          <Button
            label={smokeTest === null ? 'Test on my machine' : 'Test again'}
            size="sm"
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
            size="sm"
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
            size="sm"
            variant="destructive"
            isLoading={isBusy}
            isDisabled={isTesting}
            onClick={() => {
              void models.remove(record.id);
            }}
            tooltip="Removes the weights from this machine"
          />
        </HStack>
      }
    />
  );
}

function SmokeTestSummary({
  record,
}: {
  readonly record: NonNullable<ReturnType<typeof readSmokeTest>>;
}): React.JSX.Element {
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

      <Collapsible
        value={`smoke-${record.modelId}`}
        defaultIsOpen={false}
        trigger={<Text type="supporting">Test detail</Text>}
      >
        <VStack gap={2} padding={2}>
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
            <Section variant="muted" padding={2}>
              <Text type="supporting">It said: “{record.text.trim()}”</Text>
            </Section>
          ) : null}
        </VStack>
      </Collapsible>
    </VStack>
  );
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface DownloadableProps {
  readonly models: ModelsState;
  readonly localByFile: Map<string, LocalModel>;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}

function CatalogSection({ models, localByFile, onDownload }: DownloadableProps): React.JSX.Element {
  return (
    <PageSection
      title="Catalog"
      description="Curated GGUF builds. Opening a repo checks every quant against this machine."
    >
      {models.isLoading ? (
        <HStack gap={2} align="center">
          <Spinner label="Loading the model catalog" size="sm" />
          <Text type="supporting">Reading the catalog…</Text>
        </HStack>
      ) : models.groups.length === 0 ? (
        <EmptyState
          title="No models in the catalog"
          description="The curated catalog could not be read. Restart the app and try again."
          headingLevel={3}
          isCompact
        />
      ) : (
        <VStack gap={0}>
          {models.groups.map((group) => (
            <VStack key={group.repo} gap={2} paddingBlock={2}>
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
                  <HStack gap={2} align="center" wrap="wrap">
                    <Text weight="semibold">{group.repo}</Text>
                    <Badge
                      variant="neutral"
                      label={`${group.variants.length} ${group.variants.length === 1 ? 'variant' : 'variants'}`}
                    />
                  </HStack>
                }
              >
                <List hasDividers density="compact">
                  {group.variants.map((variant) => (
                    <VariantRow
                      key={variant.filename}
                      models={models}
                      variant={variant}
                      record={localByFile.get(variantKey(variant.repo, variant.filename)) ?? null}
                      onDownload={onDownload}
                    />
                  ))}
                </List>
              </Collapsible>
              <Divider />
            </VStack>
          ))}
        </VStack>
      )}
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// Hugging Face lookup
// ---------------------------------------------------------------------------

function RepoLookupSection({
  models,
  localByFile,
  onDownload,
}: DownloadableProps): React.JSX.Element {
  const [input, setInput] = useState('');

  const submit = (): void => {
    if (input.trim().length === 0) return;
    void models.lookupRepo(input.trim());
  };

  return (
    <PageSection
      title="Add from Hugging Face"
      description="Paste a repo id or link ending in -GGUF. Every quant in it is checked against this machine before you download."
    >
      <VStack gap={3}>
        <HStack gap={2} align="end" wrap="wrap">
          <TextInput
            label="Hugging Face repo"
            value={input}
            onChange={setInput}
            placeholder="bartowski/Qwen2.5-7B-Instruct-GGUF"
            hasClear
            isLoading={models.isHfLoading}
          />
          <Button
            label="Look up"
            variant="primary"
            isLoading={models.isHfLoading}
            onClick={submit}
          />
          {models.hfRepo ? (
            <Button label="Clear" variant="ghost" onClick={models.clearRepo} />
          ) : null}
        </HStack>

        {models.hfError ? (
          <Banner status="error" title="Could not read that repo" description={models.hfError} />
        ) : null}

        {models.hfRepo ? (
          <VStack gap={2}>
            <HStack gap={2} align="center" wrap="wrap">
              <Text weight="semibold">{models.hfRepo.repo}</Text>
              {models.hfRepo.license ? (
                <Badge variant="neutral" label={models.hfRepo.license} />
              ) : null}
              {models.hfRepo.gated ? <Badge variant="warning" label="Gated" /> : null}
              {models.hfRepo.isPrivate ? <Badge variant="warning" label="Private" /> : null}
            </HStack>

            {models.hfRepo.skippedSplitFiles.length > 0 ? (
              <Text type="supporting" display="block">
                {models.hfRepo.skippedSplitFiles.length} file
                {models.hfRepo.skippedSplitFiles.length === 1 ? ' is' : 's are'} multi-part or in a
                subdirectory and cannot be downloaded here.
              </Text>
            ) : null}

            <List hasDividers density="compact">
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
            </List>
          </VStack>
        ) : null}
      </VStack>
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// One downloadable variant
// ---------------------------------------------------------------------------

interface VariantRowProps {
  readonly models: ModelsState;
  readonly variant: Variant;
  readonly record: LocalModel | null;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}

function VariantRow({ models, variant, record, onDownload }: VariantRowProps): React.JSX.Element {
  const key = variantKey(variant.repo, variant.filename);
  const verdict = models.verdictFor(variant.repo, variant.filename);
  const support = models.support[key] ?? null;
  const progress: DownloadState | null = record ? (models.progress[record.id] ?? null) : null;
  const presentation = presentVerdict(verdict, models.system?.platform ?? null);

  const transfer = transferState(progress, record, variant.sizeBytes);
  const isBusy = models.busyId === key || (record !== null && models.busyId === record.id);

  return (
    <ListItem
      label={variant.quant ?? variant.filename}
      startContent={<StatusDot variant={verdictStatus(verdict)} label={presentation.label} />}
      description={
        <VStack gap={2}>
          <Text type="supporting" display="block">
            {variant.filename} · {formatBytes(variant.sizeBytes)} · {presentation.label}
            {transfer.isReady ? ' · downloaded' : ''}
          </Text>

          {variant.description ? (
            <Text type="supporting" display="block">
              {variant.description}
            </Text>
          ) : null}

          {transfer.failure ? (
            <Banner status="error" title="Download failed" description={transfer.failure} />
          ) : null}

          {transfer.isDownloading ? (
            <VStack gap={1}>
              <ProgressBar
                label={`Downloading ${variant.filename}`}
                value={transfer.percent}
                max={100}
                hasValueLabel
                variant="accent"
              />
              <HStack gap={3} wrap="wrap">
                <Text type="supporting">
                  {formatBytes(transfer.receivedBytes)} of {formatBytes(transfer.totalBytes)}
                </Text>
                <Text type="supporting">{formatRate(progress?.bytesPerSecond ?? 0)}</Text>
                <Text type="supporting">ETA {formatDuration(progress?.etaSeconds ?? null)}</Text>
              </HStack>
            </VStack>
          ) : null}

          {transfer.isPaused ? (
            <Text type="supporting" display="block">
              Paused at {formatBytes(transfer.receivedBytes)} — Resume continues from there.
            </Text>
          ) : null}

          <SupportDetails
            verdict={verdict}
            support={support}
            isChecking={models.checking[key] === true}
          />
        </VStack>
      }
      endContent={
        <HStack gap={2} wrap="wrap">
          {transfer.isDownloading ? (
            <>
              <Button
                label="Pause"
                size="sm"
                variant="secondary"
                isLoading={isBusy}
                onClick={() => {
                  if (record) void models.pause(record.id);
                }}
                tooltip="Stops the transfer and keeps what has been downloaded so far"
              />
              <Button
                label="Cancel"
                size="sm"
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
              label={transfer.isReady ? 'Re-download' : transfer.isPaused ? 'Resume' : 'Download'}
              size="sm"
              variant={transfer.isReady ? 'ghost' : 'primary'}
              isLoading={isBusy}
              onClick={() => {
                onDownload(variant, verdict);
              }}
            />
          )}
          {verdict === 'GREY' || support?.error ? (
            <Button
              label="Check"
              size="sm"
              variant="ghost"
              isLoading={models.checking[key] === true}
              onClick={() => {
                void models.ensureSupport(variant, true);
              }}
              tooltip="Read the model header and compute whether it fits on this machine"
            />
          ) : null}
        </HStack>
      }
    />
  );
}

/** The numbers behind the dot. They are what make the verdict trustworthy. */
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
      <HStack gap={2} align="center">
        <Spinner label="Checking compatibility" size="sm" />
        <Text type="supporting">Reading the model header…</Text>
      </HStack>
    );
  }

  if (!support) {
    return verdict === 'GREY' ? (
      <Text type="supporting" display="block">
        Not checked yet. Press Check to read the header.
      </Text>
    ) : null;
  }

  if (support.error) {
    return (
      <Text type="supporting" display="block">
        Could not check: {support.error}
      </Text>
    );
  }

  const breakdown = support.breakdown;

  return (
    <Collapsible
      value={`${support.repo}/${support.filename}`}
      defaultIsOpen={false}
      trigger={<Text type="supporting">Why?</Text>}
    >
      <VStack gap={2} padding={2}>
        <Text type="supporting" display="block">
          {breakdown.reason}
        </Text>
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
// Diagnostics
// ---------------------------------------------------------------------------

function DiagnosticsSection({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const lastSmokeTest = models.lastSmokeTest;

  return (
    <PageSection
      title="Diagnostics"
      description="How the verdicts are computed, and anything this machine refused to report."
    >
      <VStack gap={3}>
        <Text type="supporting" display="block">
          Verdicts are computed against the numbers above, at an 8192-token context, with{' '}
          {formatGiB(2_288_490_189)} held back for the system.
        </Text>

        {models.systemError ? (
          <Banner
            status="warning"
            title="Hardware detection reported a problem"
            description={models.systemError}
          />
        ) : null}

        {models.system?.detectionError ? (
          <Banner
            status="warning"
            title="Some hardware could not be read"
            description={models.system.detectionError}
          />
        ) : null}

        {lastSmokeTest ? (
          <Text type="supporting" display="block">
            Last smoke test: {lastSmokeTest.modelId} — {describeSmokeTest(lastSmokeTest)}.
          </Text>
        ) : null}
      </VStack>
    </PageSection>
  );
}
