/**
 * Models feature barrel — the `/models` route.
 *
 * Everything on this page is driven by `useModels`: the curated catalog, what
 * this machine has on disk, and the live download events. `ModelsPage` is the
 * name `routes.tsx` imports; the file layout under this directory is ours.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { ModelRecord } from '../../../shared/types';
import {
  formatBytes,
  formatDuration,
  formatRate,
  useModels,
  type CatalogEntryView,
  type DownloadState,
} from './useModels';

export function ModelsPage(): React.JSX.Element {
  const models = useModels();

  const localById = new Map<string, ModelRecord>(models.local.map((record) => [record.id, record]));
  const diskUsage = models.local.reduce(
    (total, record) =>
      total + (record.status === 'ready' ? (record.sizeBytes ?? record.downloadedBytes) : record.downloadedBytes),
    0,
  );
  const readyCount = models.local.filter((record) => record.status === 'ready').length;

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

      <Card padding={3} variant="muted">
        <HStack gap={4} wrap="wrap" vAlign="center">
          <VStack gap={0.5}>
            <Text type="supporting">Disk used by weights</Text>
            <Text weight="semibold">{formatBytes(diskUsage)}</Text>
          </VStack>
          <Divider orientation="vertical" />
          <VStack gap={0.5}>
            <Text type="supporting">Downloaded models</Text>
            <Text weight="semibold">{readyCount}</Text>
          </VStack>
          <Divider orientation="vertical" />
          <VStack gap={0.5}>
            <Text type="supporting">Active model</Text>
            {models.activeModelId ? (
              <HStack gap={2} vAlign="center">
                <Badge variant="success" label={models.activeModelId} />
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
              <Text type="supporting">None loaded</Text>
            )}
          </VStack>
        </HStack>
      </Card>

      {models.isLoading ? (
        <HStack gap={2} padding={6} hAlign="center">
          <Spinner label="Loading the model catalog" />
        </HStack>
      ) : models.catalog.length === 0 ? (
        <EmptyState
          title="No models in the catalog"
          description="The curated catalog could not be read. Restart the app and try again."
          headingLevel={2}
        />
      ) : (
        <VStack gap={3}>
          {models.catalog.map((entry) => (
            <ModelCard
              key={entry.id}
              entry={entry}
              record={localById.get(entry.id) ?? null}
              progress={models.progress[entry.id] ?? null}
              isActive={models.activeModelId === entry.id}
              isBusy={models.busyId === entry.id}
              onDownload={() => {
                void models.download(entry);
              }}
              onCancel={() => {
                void models.cancel(entry.id);
              }}
              onRemove={() => {
                void models.remove(entry.id);
              }}
              onLoad={() => {
                void models.load(entry.id);
              }}
            />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

interface ModelCardProps {
  readonly entry: CatalogEntryView;
  readonly record: ModelRecord | null;
  readonly progress: DownloadState | null;
  readonly isActive: boolean;
  readonly isBusy: boolean;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
  readonly onLoad: () => void;
}

function ModelCard({
  entry,
  record,
  progress,
  isActive,
  isBusy,
  onDownload,
  onCancel,
  onRemove,
  onLoad,
}: ModelCardProps): React.JSX.Element {
  // The event stream is ahead of the table between two refreshes, so it wins.
  const isDownloading = progress?.status === 'downloading' || record?.status === 'downloading';
  const isReady = progress?.status === 'ready' || (record?.status === 'ready' && !isDownloading);
  const failure = progress?.status === 'error' ? progress.error : (record?.error ?? null);

  const received = progress?.receivedBytes ?? record?.downloadedBytes ?? 0;
  const total = progress?.totalBytes ?? record?.sizeBytes ?? entry.sizeBytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  const hasResumablePart = !isReady && !isDownloading && received > 0;

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="start" hAlign="between" wrap="wrap">
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={2}>{entry.id}</Heading>
              {entry.quant ? <Badge variant="neutral" label={entry.quant} /> : null}
              {isReady ? <Badge variant="success" label="Downloaded" /> : null}
              {isActive ? <Badge variant="info" label="Active" /> : null}
            </HStack>
            <Text type="supporting">{entry.repo}</Text>
          </VStack>
          <Text weight="semibold">{formatBytes(entry.sizeBytes)}</Text>
        </HStack>

        {entry.description ? <Text>{entry.description}</Text> : null}

        {failure ? <Banner status="error" title="Download failed" description={failure} /> : null}

        {isDownloading ? (
          <VStack gap={1}>
            <ProgressBar
              label={`Downloading ${entry.id}`}
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

        {hasResumablePart ? (
          <Text type="supporting">
            {formatBytes(received)} already downloaded — starting again resumes from there.
          </Text>
        ) : null}

        <HStack gap={2} wrap="wrap">
          {isDownloading ? (
            <Button
              label="Cancel"
              variant="secondary"
              isLoading={isBusy}
              onClick={onCancel}
              tooltip="Stops the transfer and keeps what has been downloaded so far"
            />
          ) : (
            <Button
              label={isReady ? 'Re-download' : hasResumablePart ? 'Resume download' : 'Download'}
              variant={isReady ? 'ghost' : 'primary'}
              isLoading={isBusy}
              onClick={onDownload}
            />
          )}

          <Button
            label={isActive ? 'Loaded' : 'Load'}
            variant="secondary"
            isDisabled={!isReady || isActive}
            isLoading={isBusy && !isActive}
            onClick={onLoad}
            tooltip={isReady ? 'Make this the model the assistant uses' : 'Download it first'}
          />

          <Button
            label="Delete"
            variant="destructive"
            isDisabled={!isReady && received === 0}
            isLoading={isBusy}
            onClick={onRemove}
            tooltip="Removes the weights from this machine"
          />
        </HStack>
      </VStack>
    </Card>
  );
}
