/**
 * Models feature barrel — the `/models` route, built to design option 1a.
 *
 * The page opens with a single answer: the best model for this machine, what it
 * costs, one button. Everything else is folded away behind it —
 *
 *   header + machine chip      what we measured, and a way to measure again
 *   recommendation hero        the one model to download, or why there isn't one
 *   Browse all models          the curated catalog, a Hub search and a pasted
 *                              repo, merged into one list behind one field
 *   Installed on this Mac      Use / Unload / Delete / Test, closed by default
 *   footnote                   the fit rule, and diagnostics behind a link
 *
 * — so a user who just wants the assistant to work never scrolls. That is the
 * whole point of 1a: the old page was seven stacked sections with three ways to
 * acquire a model, and no obvious place to start.
 *
 * Nothing was dropped in the move. Every capability the old page had is still
 * here; see the report in the commit for the old → new mapping.
 *
 * Red is still a warning, not a block: the estimate can be wrong and it is the
 * user's machine, so downloading anyway stays possible behind a confirmation
 * that says plainly what is expected to happen.
 *
 * The decisions — what to recommend, what the list contains, what the sentences
 * say — live in `recommendation.ts`, `browseRows.ts` and `modelCopy.ts`, which
 * are plain modules with tests. There is no DOM harness in this repo, so
 * anything worth testing has to be outside the component.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Tooltip } from '@astryxdesign/core/Tooltip';

import { Page, PageHeader } from '../../ui/Page';

import {
  browseFooterSentence,
  buildBrowseRows,
  parseModelQuery,
  visibleBrowseRows,
  type BrowseRow,
} from './browseRows';
import {
  describeSmokeTest,
  readSmokeTest,
  variantKey,
  type LocalModel,
  type SupportVerdict,
} from './llmExtra';
import {
  browseSummary,
  catalogGoodFor,
  downloadEtaSentence,
  familyInitial,
  fitFootnote,
  fitSentence,
  fitTooltip,
  formatBadgeLabel,
  heroSentence,
  installedRowSubtitle,
  installedSummary,
  machineChipSummary,
  machineWord,
  modelDisplayName,
} from './modelCopy';
import { diskUsageBytes, smokeTestStatus, transferState, verdictStatus } from './modelRows';
import { recommendModel, type Recommendation } from './recommendation';
import {
  formatBytes,
  formatDuration,
  formatGiB,
  formatRate,
  useModels,
  type DownloadState,
  type ModelsState,
} from './useModels';

/** What every downloadable surface on this page needs to know about one file. */
interface Variant {
  readonly repo: string;
  readonly filename: string;
  readonly quant: string | null;
  readonly sizeBytes: number | null;
  readonly description: string | null;
}

/** The context every verdict on this page was computed against — see the footnote. */
const FIT_CONTEXT_TOKENS = 8192;
const FIT_RESERVE_BYTES = 2_288_490_189;

export function ModelsPage(): React.JSX.Element {
  const models = useModels();
  const [pendingRed, setPendingRed] = useState<Variant | null>(null);

  const platform = models.system?.platform ?? null;
  const machine = machineWord(platform);

  const localByFile = useMemo(
    () =>
      new Map<string, LocalModel>(
        models.local.map((record) => [variantKey(record.repo, record.filename), record]),
      ),
    [models.local],
  );

  /**
   * The hero's pick, computed once and shared.
   *
   * The `Best fit` pill in the list has to be the *same* model the hero offers.
   * Deriving it from list position instead would put the pill on whichever row
   * happened to sort first, and the page would recommend two different things.
   */
  const recommendation = useMemo(
    () => recommendModel(models.catalog, models.verdictFor),
    [models.catalog, models.verdictFor],
  );
  const recommendedKey =
    recommendation === null
      ? null
      : variantKey(recommendation.entry.repo, recommendation.entry.filename);

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

  /**
   * Check the curated catalog as soon as it lands.
   *
   * The old page checked a repo lazily when its card was expanded. 1a has no
   * cards to expand and a hero that cannot say anything until verdicts exist, so
   * the check moves to mount. `ensureSupport` is idempotent per key and main
   * caches the answer, so this costs one 4 MB header read per curated build,
   * once.
   */
  const { catalog, ensureSupport } = models;
  useEffect(() => {
    for (const entry of catalog) {
      void ensureSupport(entry);
    }
  }, [catalog, ensureSupport]);

  return (
    <Page>
      <PageHeader
        title="Models"
        description={`Runs on this ${machine}. Nothing you type leaves the app.`}
        actions={<MachineChip models={models} />}
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

      <RecommendationHero
        models={models}
        recommendation={recommendation}
        localByFile={localByFile}
        onDownload={startDownload}
      />

      <VStack
        gap={0}
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-container)',
          overflow: 'hidden',
        }}
      >
        <BrowseDisclosure
          models={models}
          recommendedKey={recommendedKey}
          localByFile={localByFile}
          onDownload={startDownload}
        />
        <Divider />
        <InstalledDisclosure models={models} />
      </VStack>

      <FitFootnote models={models} />

      <AlertDialog
        isOpen={pendingRed !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setPendingRed(null);
        }}
        title={`This model looks too big for this ${machine}`}
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
// The machine chip — everything the old "This machine" section headlined
// ---------------------------------------------------------------------------

/**
 * A bordered pill carrying the machine summary and a way to measure again.
 *
 * The detailed readout — CPU, GPU, VRAM, unified memory, platform — is not lost:
 * it moved into the diagnostics disclosure in the footnote, which is where a
 * reader goes when the summary is not enough.
 */
function MachineChip({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const detected = models.system !== null;

  return (
    <HStack
      gap={2}
      align="center"
      paddingInline={2}
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-full)',
      }}
    >
      <StatusDot
        variant={models.isSystemLoading ? 'accent' : detected ? 'success' : 'warning'}
        label={
          models.isSystemLoading
            ? 'Detecting this machine'
            : detected
              ? 'Hardware detected'
              : 'Hardware detection failed'
        }
      />
      <Text type="supporting" hasTabularNumbers>
        {models.isSystemLoading ? 'Detecting…' : machineChipSummary(models.system)}
      </Text>
      <Button
        label="Re-check"
        size="sm"
        variant="ghost"
        isLoading={models.isSystemLoading}
        onClick={() => {
          void models.refreshSystem();
        }}
        tooltip="Probe memory and GPUs again, and clear the cached verdicts"
      />
    </HStack>
  );
}

// ---------------------------------------------------------------------------
// The recommendation hero
// ---------------------------------------------------------------------------

interface DownloadableProps {
  readonly models: ModelsState;
  readonly localByFile: Map<string, LocalModel>;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}

/**
 * One model, one sentence, one button.
 *
 * When there is no answer the hero says which kind of "no" it is, because the
 * remedies differ: wait, re-check the hardware, or search for something smaller.
 */
function RecommendationHero({
  models,
  recommendation,
  localByFile,
  onDownload,
}: DownloadableProps & {
  readonly recommendation: Recommendation | null;
}): React.JSX.Element {
  const platform = models.system?.platform ?? null;
  const machine = machineWord(platform);

  /** A rate only exists while bytes are actually moving. See `downloadEtaSentence`. */
  const observedRate = useMemo(() => {
    let best = 0;
    for (const state of Object.values(models.progress)) {
      if (state.status === 'downloading' && state.bytesPerSecond > best) {
        best = state.bytesPerSecond;
      }
    }
    return best > 0 ? best : null;
  }, [models.progress]);

  const isChecking = models.isLoading || Object.keys(models.checking).length > 0;

  if (recommendation === null) {
    return (
      <Card padding={4}>
        {isChecking ? (
          <HStack gap={2} align="center">
            <Spinner label="Working out the best model" size="sm" />
            <Text type="supporting">Working out which model suits this {machine}…</Text>
          </HStack>
        ) : (
          <EmptyState
            title={
              models.catalog.length === 0
                ? 'The curated list could not be read'
                : models.system === null
                  ? `We could not measure this ${machine}`
                  : `Nothing in the curated list fits this ${machine}`
            }
            description={
              models.catalog.length === 0
                ? 'Restart the app and try again. You can still search below and download by name.'
                : models.system === null
                  ? `Press Re-check above. Until memory can be measured, nothing can be recommended — but you can still browse and download below.`
                  : 'Search below for something smaller — "1.5b" or "3b" is a good place to start.'
            }
            headingLevel={2}
            isCompact
          />
        )}
      </Card>
    );
  }

  const { entry, verdict, format } = recommendation;
  const key = variantKey(entry.repo, entry.filename);
  const support = models.support[key] ?? null;
  const record = localByFile.get(key) ?? null;
  const transfer = transferState(models.progress[record?.id ?? ''] ?? null, record, entry.sizeBytes);
  const isActive = record !== null && models.activeModelId === record.id;
  const isBusy = models.busyId === key || (record !== null && models.busyId === record.id);

  const displayName = modelDisplayName(entry.repo, entry.filename);
  const eta = downloadEtaSentence(entry.sizeBytes, observedRate);
  const tooltip = fitTooltip(verdict, support?.breakdown ?? null, format, platform);

  const variant: Variant = {
    repo: entry.repo,
    filename: entry.filename,
    quant: entry.quant,
    sizeBytes: entry.sizeBytes,
    description: entry.description,
  };

  return (
    <Card padding={4}>
      <HStack gap={4} align="start" wrap="wrap">
        <FamilyTile name={displayName} size={52} />

        <StackItem size="fill">
          <VStack gap={2}>
            <HStack gap={2} align="center" wrap="wrap">
              <Heading level={3} accessibilityLevel={2}>
                {displayName}
              </Heading>
              <Badge
                variant={verdict === 'GREEN' ? 'success' : 'warning'}
                label={
                  verdict === 'GREEN'
                    ? `Best fit for this ${machine}`
                    : `The best this ${machine} can hold`
                }
              />
              <Badge variant="neutral" label={formatBadgeLabel(format, entry.quant)} />
              <FitHelp label={displayName} title={tooltip.title} body={tooltip.body} />
            </HStack>

            {/* A measure cap, not a layout width: one sentence is easier to read
                short. The design calls it 560px and astryx takes it as a prop. */}
            <VStack maxWidth={560}>
              <Text display="block">
                {heroSentence(
                  catalogGoodFor(entry.description),
                  entry.sizeBytes,
                  support?.breakdown.totalRequiredBytes ?? null,
                )}
              </Text>
            </VStack>

            {transfer.isDownloading ? (
              <TransferProgress
                label={displayName}
                transfer={transfer}
                progress={models.progress[record?.id ?? ''] ?? null}
              />
            ) : null}

            {transfer.failure ? (
              <Banner status="error" title="Download failed" description={transfer.failure} />
            ) : null}
          </VStack>
        </StackItem>

        <VStack gap={1} align="end">
          {transfer.isDownloading ? (
            <HStack gap={2} wrap="wrap">
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
            </HStack>
          ) : transfer.isReady ? (
            <Button
              label={isActive ? 'In use' : 'Use'}
              variant="primary"
              isDisabled={isActive}
              isLoading={isBusy}
              onClick={() => {
                if (record) void models.load(record.id);
              }}
              tooltip="Make this the model the assistant uses"
            />
          ) : (
            <Button
              label={transfer.isPaused ? 'Resume download' : 'Download & use'}
              variant="primary"
              icon={<Icon icon="arrowDown" size="sm" />}
              isLoading={isBusy}
              onClick={() => {
                onDownload(variant, verdict);
              }}
            />
          )}
          {eta !== null && !transfer.isReady ? <Text type="supporting">{eta}</Text> : null}
        </VStack>
      </HStack>
    </Card>
  );
}

/** The rounded initial tile that stands in for a model family. */
function FamilyTile({ name, size }: { readonly name: string; readonly size: number }): React.JSX.Element {
  return (
    <Center
      width={size}
      height={size}
      style={{
        background: 'var(--color-background-blue)',
        borderRadius: 'var(--radius-container)',
        flexShrink: 0,
      }}
    >
      <Text weight="semibold" color="accent">
        {familyInitial(name)}
      </Text>
    </Center>
  );
}

/**
 * The `help` glyph and the tooltip it reveals.
 *
 * Built on astryx `Tooltip`, which is a `useLayer` surface in `context` mode and
 * therefore does **not** trap focus. `usePopover` would: it calls `useFocusTrap`
 * unconditionally and `isModal: false` only changes the ARIA, so Tab would be
 * unable to leave a transient hint. The trigger is a real button, so the tooltip
 * opens on keyboard focus as well as hover, and its accessible name says what it
 * is about.
 */
function FitHelp({
  label,
  title,
  body,
}: {
  readonly label: string;
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <Tooltip
      placement="above"
      content={
        <VStack gap={1} maxWidth={270}>
          <Text weight="semibold" size="sm" display="block">
            {title}
          </Text>
          <Text size="sm" display="block">
            {body}
          </Text>
        </VStack>
      }
    >
      <IconButton
        label={`Why: ${label}`}
        icon={<Icon icon="info" size="sm" />}
        variant="ghost"
        size="sm"
      />
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Browse all models — catalog + Hub search + pasted repo, in one list
// ---------------------------------------------------------------------------

/**
 * The single acquisition surface.
 *
 * One field replaces the old "Find models for this machine" search *and* the
 * "Add from Hugging Face" paste box: `parseModelQuery` decides which of the two
 * a given string means, so `bartowski/Foo-GGUF` looks the repo up and
 * `qwen3 instruct` searches.
 *
 * `Only what runs here` starts **off**. The catalog checks itself on mount, so
 * for the first second every verdict is `GREY`, and `fitsMachine` — correctly —
 * does not count unknown as yes. An on-by-default filter would therefore open
 * the page on an empty list. The footer says how many are hidden the moment it
 * is switched on.
 */
function BrowseDisclosure({
  models,
  recommendedKey,
  localByFile,
  onDownload,
}: DownloadableProps & {
  readonly recommendedKey: string | null;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [onlyFits, setOnlyFits] = useState(false);

  const platform = models.system?.platform ?? null;
  const parsed = parseModelQuery(query);

  const rows = useMemo(
    () =>
      buildBrowseRows({
        catalog: models.catalog,
        hfRepo: models.hfRepo,
        discovery: models.discovery,
        verdictOf: models.verdictFor,
      }),
    [models.catalog, models.hfRepo, models.discovery, models.verdictFor],
  );
  const visibility = visibleBrowseRows(rows, onlyFits);

  const isSearching = models.isDiscovering || models.isHfLoading;

  const submit = (): void => {
    if (parsed.kind === 'repo') {
      void models.lookupRepo(parsed.repo);
      return;
    }
    void models.discover(parsed.kind === 'search' ? parsed.term : '');
  };

  const clear = (): void => {
    setQuery('');
    models.clearDiscovery();
    models.clearRepo();
  };

  return (
    <Collapsible
      value="browse"
      defaultIsOpen
      trigger={
        <DisclosureHeader
          icon="viewColumns"
          title="Browse all models"
          summary={browseSummary(models.catalog.length)}
        />
      }
    >
      <Section variant="muted" padding={3}>
        <VStack gap={3}>
          <HStack gap={2} align="end" wrap="wrap">
            <StackItem size="fill">
              <TextInput
                label="Search models"
                isLabelHidden
                value={query}
                onChange={setQuery}
                onEnter={submit}
                placeholder="Search names, or paste a Hugging Face link"
                startIcon={<Icon icon="search" size="sm" />}
                hasClear
                isLoading={isSearching}
                width="100%"
              />
            </StackItem>
            <Button
              label={parsed.kind === 'repo' ? 'Look up' : 'Search'}
              variant="secondary"
              isLoading={isSearching}
              onClick={submit}
              tooltip={
                parsed.kind === 'repo'
                  ? 'Read every quant in that repo and check each against this machine'
                  : 'One Hugging Face search, then a header read per candidate. Leave the box empty for the most downloaded ones.'
              }
            />
            <ToggleButton
              label="Only what runs here"
              icon={<Icon icon="check" size="sm" />}
              isPressed={onlyFits}
              onPressedChange={setOnlyFits}
            />
            {models.discovery || models.hfRepo ? (
              <Button label="Clear results" variant="ghost" onClick={clear} />
            ) : null}
          </HStack>

          <HStack gap={3} align="center" wrap="wrap">
            <HStack gap={1} align="center">
              <Badge variant="blue" label="MLX" />
              <Text type="supporting">Uses your {machineWord(platform)}&apos;s GPU — faster</Text>
            </HStack>
            <HStack gap={1} align="center">
              <Badge variant="neutral" label="GGUF" />
              <Text type="supporting">Runs anywhere — slower here</Text>
            </HStack>
          </HStack>

          {models.system && models.system.totalRamBytes === null ? (
            <Banner
              status="warning"
              title="Memory could not be measured"
              description="Nothing can be ranked against this machine, so every row reads “not checked yet”."
            />
          ) : null}

          {models.discoveryError ? (
            <Banner
              status="error"
              title="Could not search Hugging Face"
              description={models.discoveryError}
            />
          ) : null}

          {models.hfError ? (
            <Banner status="error" title="Could not read that repo" description={models.hfError} />
          ) : null}

          {models.hfRepo && (models.hfRepo.gated || models.hfRepo.isPrivate) ? (
            <Banner
              status="warning"
              title={`${models.hfRepo.repo} is ${models.hfRepo.gated ? 'gated' : 'private'}`}
              description="Downloading it needs an access token this app does not hold."
            />
          ) : null}

          {models.hfRepo && models.hfRepo.skippedSplitFiles.length > 0 ? (
            <Text type="supporting" display="block">
              {models.hfRepo.skippedSplitFiles.length} file
              {models.hfRepo.skippedSplitFiles.length === 1 ? ' is' : 's are'} multi-part or in a
              subdirectory and cannot be downloaded here.
            </Text>
          ) : null}

          {models.isLoading ? (
            <HStack gap={2} align="center">
              <Spinner label="Loading the model list" size="sm" />
              <Text type="supporting">Reading the curated list…</Text>
            </HStack>
          ) : null}

          {visibility.rows.length === 0 && !models.isLoading ? (
            <EmptyState
              title={onlyFits && rows.length > 0 ? 'Nothing here runs on this machine' : 'No models to show'}
              description={
                onlyFits && rows.length > 0
                  ? 'Turn the filter off to see everything, or search for something smaller.'
                  : 'Search by name, or paste a Hugging Face link.'
              }
              headingLevel={3}
              isCompact
            />
          ) : (
            <VStack gap={0}>
              {visibility.rows.map((row) => (
                <BrowseRowView
                  key={row.key}
                  models={models}
                  row={row}
                  record={localByFile.get(row.key) ?? null}
                  isBest={row.key === recommendedKey}
                  onDownload={onDownload}
                />
              ))}
            </VStack>
          )}

          <HStack justify="between" align="center" gap={2} wrap="wrap">
            <Text type="supporting">{browseFooterSentence(visibility, platform)}</Text>
            {visibility.hiddenTooBig + visibility.hiddenUnchecked > 0 ? (
              <Link
                as="button"
                onClick={() => {
                  setOnlyFits(false);
                }}
              >
                Show them anyway
              </Link>
            ) : null}
          </HStack>

          <DiscoverySweepDetail models={models} />
        </VStack>
      </Section>
    </Collapsible>
  );
}

/** One row in `Browse all models`. */
function BrowseRowView({
  models,
  row,
  record,
  isBest,
  onDownload,
}: {
  readonly models: ModelsState;
  readonly row: BrowseRow;
  readonly record: LocalModel | null;
  readonly isBest: boolean;
  readonly onDownload: (variant: Variant, verdict: SupportVerdict) => void;
}): React.JSX.Element {
  const platform = models.system?.platform ?? null;
  const support = models.support[row.key] ?? null;
  const progress: DownloadState | null = record ? (models.progress[record.id] ?? null) : null;
  const transfer = transferState(progress, record, row.sizeBytes);
  const isBusy = models.busyId === row.key || (record !== null && models.busyId === record.id);
  const tooltip = fitTooltip(row.verdict, support?.breakdown ?? null, row.format, platform);

  const variant: Variant = {
    repo: row.repo,
    filename: row.filename,
    quant: row.quant,
    sizeBytes: row.sizeBytes,
    description: row.description,
  };

  return (
    <VStack
      gap={2}
      paddingBlock={2}
      style={{ borderBlockStart: '1px solid var(--color-border)' }}
    >
      <HStack gap={3} align="start" wrap="wrap">
        <FamilyTile name={row.displayName} size={26} />

        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} align="center" wrap="wrap">
              <Text weight="semibold">{row.displayName}</Text>
              <Badge
                variant={row.format === 'MLX' ? 'blue' : 'neutral'}
                label={formatBadgeLabel(row.format, row.quant)}
              />
              {isBest ? <Badge variant="success" label="Best fit" /> : null}
              {row.source === 'search' ? <Badge variant="neutral" label="Hugging Face" /> : null}
              {row.source === 'lookup' ? <Badge variant="neutral" label="Pasted link" /> : null}
              {transfer.isReady ? <Badge variant="info" label="Downloaded" /> : null}
            </HStack>

            <HStack gap={2} align="center" wrap="wrap">
              <StatusDot
                variant={verdictStatus(row.verdict)}
                label={fitSentence(row.verdict, platform)}
              />
              <Text type="supporting">
                {fitSentence(
                  row.verdict,
                  platform,
                  row.source === 'catalog' ? catalogGoodFor(row.description) : null,
                )}
              </Text>
              <FitHelp label={row.displayName} title={tooltip.title} body={tooltip.body} />
            </HStack>

            {transfer.isDownloading ? (
              <TransferProgress label={row.displayName} transfer={transfer} progress={progress} />
            ) : null}

            {transfer.isPaused && !transfer.isDownloading ? (
              <Text type="supporting" display="block">
                Paused at {formatBytes(transfer.receivedBytes)} — Resume continues from there.
              </Text>
            ) : null}

            {transfer.failure ? (
              <Banner status="error" title="Download failed" description={transfer.failure} />
            ) : null}

            {support?.error ? (
              <Text type="supporting" display="block">
                Could not check: {support.error}
              </Text>
            ) : null}
          </VStack>
        </StackItem>

        {/* Fixed column so the sizes line up down the list, not under the names. */}
        <VStack width={64} align="end">
          <Text type="supporting" hasTabularNumbers>
            {formatBytes(row.sizeBytes)}
          </Text>
        </VStack>

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
              variant={isBest ? 'primary' : 'secondary'}
              isLoading={isBusy}
              onClick={() => {
                onDownload(variant, row.verdict);
              }}
            />
          )}
          {row.verdict === 'GREY' || support?.error ? (
            <Button
              label="Check"
              size="sm"
              variant="ghost"
              isLoading={models.checking[row.key] === true}
              onClick={() => {
                void models.ensureSupport(variant, true);
              }}
              tooltip="Read the model header and compute whether it fits on this machine"
            />
          ) : null}
        </HStack>
      </HStack>
    </VStack>
  );
}

function TransferProgress({
  label,
  transfer,
  progress,
}: {
  readonly label: string;
  readonly transfer: ReturnType<typeof transferState>;
  readonly progress: DownloadState | null;
}): React.JSX.Element {
  return (
    <VStack gap={1}>
      <ProgressBar
        label={`Downloading ${label}`}
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
  );
}

/**
 * What the last Hub sweep actually did.
 *
 * The old page printed this under the search box. It is still printed, because
 * every count the sweep dropped — too big, extra quants of the same repo,
 * unverified past the header-read ceiling — matters: a list that silently
 * truncated would read as the complete answer. 1a just puts it behind a
 * disclosure so it is not the first thing anyone reads.
 */
function DiscoverySweepDetail({ models }: { readonly models: ModelsState }): React.JSX.Element | null {
  const discovery = models.discovery;
  if (!discovery) return null;

  return (
    <Collapsible
      value="sweep"
      defaultIsOpen={false}
      trigger={<Text type="supporting">What this search looked at</Text>}
    >
      <VStack gap={2} padding={2}>
        <Text type="supporting" display="block">
          Searched {discovery.reposFound} repo{discovery.reposFound === 1 ? '' : 's'}, listed{' '}
          {discovery.reposInspected}, found {discovery.variantsFound} file
          {discovery.variantsFound === 1 ? '' : 's'}, verified {discovery.variantsChecked}
          {discovery.usableMemoryBytes === null
            ? '. Usable memory is unknown, so nothing was filtered by size.'
            : ` against ${formatGiB(discovery.usableMemoryBytes)} of usable memory.`}
          {discovery.variantsTooBig > 0
            ? ` ${discovery.variantsTooBig} file${discovery.variantsTooBig === 1 ? ' was' : 's were'} bigger than that before any KV cache and never checked.`
            : ''}
          {discovery.variantsDeduplicated > 0
            ? ` ${discovery.variantsDeduplicated} extra quant${discovery.variantsDeduplicated === 1 ? '' : 's'} of the same models were skipped — paste the repo into the field above to see them all.`
            : ''}
          {discovery.variantsProjectors > 0
            ? ` ${discovery.variantsProjectors} mmproj file${discovery.variantsProjectors === 1 ? ' is a' : 's are'} multimodal projector${discovery.variantsProjectors === 1 ? '' : 's'}, not model${discovery.variantsProjectors === 1 ? '' : 's'}, and were left out.`
            : ''}
        </Text>
        {discovery.warnings.map((warning) => (
          <Text key={warning} type="supporting" display="block">
            {warning}
          </Text>
        ))}
      </VStack>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Installed on this Mac
// ---------------------------------------------------------------------------

function InstalledDisclosure({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const ready = models.local.filter((record) => record.status === 'ready');
  const machine = machineWord(models.system?.platform ?? null);

  return (
    <Collapsible
      value="installed"
      defaultIsOpen={false}
      trigger={
        <DisclosureHeader
          icon="copy"
          title={`Installed on this ${machine}`}
          summary={installedSummary(ready.length, diskUsageBytes(models.local))}
        />
      }
    >
      <Section variant="muted" padding={3}>
        {ready.length === 0 ? (
          <EmptyState
            title="Nothing downloaded yet"
            description="Take the recommendation above, or browse the full list."
            headingLevel={3}
            isCompact
          />
        ) : (
          <VStack gap={0}>
            {ready.map((record) => (
              <InstalledRow key={record.id} models={models} record={record} />
            ))}
          </VStack>
        )}
      </Section>
    </Collapsible>
  );
}

/**
 * One installed model.
 *
 * The design gives the in-use model an overflow control and everything else a
 * `Use` button. Every row gets the overflow too: Delete and Test have to stay
 * reachable for a model that merely happens not to be loaded, and 1a
 * reorganises the page rather than removing what it could do.
 */
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
  const displayName = modelDisplayName(record.repo, record.filename);

  const menuItems = [
    {
      label: smokeTest === null ? 'Test on my machine' : 'Test again',
      isDisabled: isTesting || (models.testingId !== null && !isTesting),
      onClick: () => {
        void models.smokeTest(record.id);
      },
    },
    ...(isActive
      ? [
          {
            label: 'Unload',
            isDisabled: models.busyId === '__unload__',
            onClick: () => {
              void models.unload();
            },
          },
        ]
      : []),
    { type: 'divider' as const },
    {
      label: 'Delete',
      isDisabled: isTesting || isBusy,
      onClick: () => {
        void models.remove(record.id);
      },
    },
  ];

  return (
    <VStack gap={2} paddingBlock={2} style={{ borderBlockStart: '1px solid var(--color-border)' }}>
      <HStack gap={3} align="start" wrap="wrap">
        <FamilyTile name={displayName} size={26} />

        <StackItem size="fill">
          <VStack gap={1}>
            <HStack gap={2} align="center" wrap="wrap">
              <Text weight="semibold">{displayName}</Text>
              {isActive ? <Badge variant="success" label="In use" /> : null}
              <StatusDot variant={status.status} label={`Smoke test: ${status.label}`} />
            </HStack>

            <Text type="supporting" display="block">
              {installedRowSubtitle(
                record.sizeBytes ?? record.downloadedBytes,
                record.quant ? `${record.quant} · ${status.label}` : status.label,
              )}
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
        </StackItem>

        <HStack gap={2} align="center" wrap="wrap">
          {isActive ? null : (
            <Button
              label="Use"
              size="sm"
              variant="secondary"
              isDisabled={isTesting}
              isLoading={isBusy}
              onClick={() => {
                void models.load(record.id);
              }}
              tooltip="Make this the model the assistant uses"
            />
          )}
          <MoreMenu label={`More actions for ${displayName}`} size="sm" items={menuItems} />
        </HStack>
      </HStack>
    </VStack>
  );
}

/** The numbers a real load-and-generate produced on this machine. */
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
// Shared disclosure chrome
// ---------------------------------------------------------------------------

/** Leading icon, title line, muted summary. The caret is astryx `Collapsible`'s. */
function DisclosureHeader({
  icon,
  title,
  summary,
}: {
  readonly icon: 'viewColumns' | 'copy';
  readonly title: string;
  readonly summary: string;
}): React.JSX.Element {
  return (
    <HStack gap={3} align="center">
      <Icon icon={icon} size="sm" />
      <VStack gap={0.5}>
        <Text weight="semibold" display="block">
          {title}
        </Text>
        <Text type="supporting" display="block">
          {summary}
        </Text>
      </VStack>
    </HStack>
  );
}

// ---------------------------------------------------------------------------
// The footnote, and the diagnostics behind it
// ---------------------------------------------------------------------------

/**
 * One muted line, and the whole of the old `Diagnostics` and `This machine`
 * sections behind `How this is calculated`.
 */
function FitFootnote({ models }: { readonly models: ModelsState }): React.JSX.Element {
  const system = models.system;
  const lastSmokeTest = models.lastSmokeTest;

  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap">
        <Icon icon="info" size="sm" color="secondary" />
        <Text type="supporting">{fitFootnote(FIT_CONTEXT_TOKENS, FIT_RESERVE_BYTES)}</Text>
      </HStack>

      <Collapsible
        value="diagnostics"
        defaultIsOpen={false}
        trigger={<Text type="supporting">How this is calculated</Text>}
      >
        <VStack gap={3} padding={2}>
          <Text type="supporting" display="block">
            Every verdict is the model&apos;s weights plus a KV cache sized for a{' '}
            {FIT_CONTEXT_TOKENS}-token context, compared against the memory below with{' '}
            {formatGiB(FIT_RESERVE_BYTES)} held back for the system. Green means it fits in
            fast memory, yellow means it fits but partly on the CPU, red means it does not fit.
          </Text>

          {models.isSystemLoading ? (
            <HStack gap={2} align="center">
              <Spinner label="Detecting this machine" size="sm" />
              <Text type="supporting">Detecting memory and GPUs…</Text>
            </HStack>
          ) : !system ? (
            <Banner
              status="warning"
              title="Hardware detection failed"
              description={`Compatibility verdicts are unavailable on this machine, so every model shows as “not checked yet”. ${models.systemError ?? ''}`}
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

          {models.systemError ? (
            <Banner
              status="warning"
              title="Hardware detection reported a problem"
              description={models.systemError}
            />
          ) : null}

          {system?.detectionError ? (
            <Banner
              status="warning"
              title="Some hardware could not be read"
              description={system.detectionError}
            />
          ) : null}

          {lastSmokeTest ? (
            <Text type="supporting" display="block">
              Last smoke test: {lastSmokeTest.modelId} — {describeSmokeTest(lastSmokeTest)}.
            </Text>
          ) : null}
        </VStack>
      </Collapsible>
    </VStack>
  );
}
