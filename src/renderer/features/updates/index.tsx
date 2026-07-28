/**
 * The Updates section of the Settings page.
 *
 * Layout is the page's language, not a new one: a muted section heading, a
 * hairline `Divider`, then rows of `label + right-aligned control`. No card per
 * setting. The section is self-contained so `Settings.tsx` adds one element and
 * nothing else — in particular, none of this touches the "Save settings" flow.
 * Update controls act the moment they are pressed; there is nothing to save.
 *
 * Every decision about copy, colour and which button exists lives in
 * `./updateRows`, where it is tested. This file is layout only.
 */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

import {
  actionView,
  bannerView,
  formatCurrentVersion,
  progressView,
  statusView,
} from './updateRows';
import { useUpdates } from './useUpdates';

/** Matches `CONTROL_WIDTH` in `Settings.tsx`, so every row lines up down the page. */
const CONTROL_WIDTH = 340;

export function UpdatesSection(): React.JSX.Element {
  const updates = useUpdates();
  const state = updates.state;

  return (
    <VStack gap={2}>
      <Heading level={3} accessibilityLevel={2}>
        Updates
      </Heading>
      <Divider />

      {state === null ? (
        <UpdatesRow label="Update status">
          <Spinner label="Reading the update status" size="sm" />
        </UpdatesRow>
      ) : (
        <>
          <UpdatesRow label="Installed version">
            <Text>{formatCurrentVersion(state)}</Text>
          </UpdatesRow>

          <UpdatesRow label="Update status">
            <UpdatesStatus updates={updates} />
          </UpdatesRow>
        </>
      )}
    </VStack>
  );
}

// ---------------------------------------------------------------------------

function UpdatesStatus({
  updates,
}: {
  readonly updates: ReturnType<typeof useUpdates>;
}): React.JSX.Element | null {
  const state = updates.state;
  if (state === null) return null;

  const status = statusView(state);
  const banner = bannerView(state);
  const action = actionView(state, updates.isBusy);
  const progress = progressView(state);

  const press = (): void => {
    if (action.kind === 'check') void updates.check();
    else if (action.kind === 'download') void updates.download();
    else if (action.kind === 'install') void updates.install();
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap="wrap">
        <StatusDot variant={status.dot} label={status.headline} />
        <Text weight="medium">{status.headline}</Text>
      </HStack>

      {/* The error message comes from main, which is the only side that knows it. */}
      {banner ? (
        <Banner status={banner.status} title={banner.title} description={banner.description} />
      ) : null}

      {status.detail ? (
        <Text type="supporting" display="block">
          {status.detail}
        </Text>
      ) : null}

      {progress ? (
        <VStack gap={1}>
          <ProgressBar
            label="Downloading the update"
            value={progress.percent ?? 0}
            max={100}
            hasValueLabel={progress.percent !== null}
            isIndeterminate={progress.percent === null}
            variant="accent"
          />
          <Text type="supporting" display="block">
            {progress.transferred}
          </Text>
        </VStack>
      ) : null}

      {action.kind === 'none' ? null : (
        <HStack gap={2} wrap="wrap">
          <Button
            label={action.label}
            size="sm"
            variant={action.variant}
            isDisabled={action.isDisabled}
            isLoading={action.isLoading}
            tooltip={action.tooltip ?? undefined}
            onClick={press}
          />
        </HStack>
      )}
    </VStack>
  );
}

/**
 * One row: label left, control right — the same shape `SettingsRow` gives the
 * business settings, kept here so this section can be dropped into the page
 * without exporting the page's private helpers.
 */
function UpdatesRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <VStack gap={0}>
      <HStack gap={4} justify="between" align="start" paddingBlock={3} wrap="wrap">
        <StackItem size="fill">
          <Text weight="medium">{label}</Text>
        </StackItem>
        <VStack width={CONTROL_WIDTH} maxWidth="100%">
          {children}
        </VStack>
      </HStack>
      <Divider />
    </VStack>
  );
}
