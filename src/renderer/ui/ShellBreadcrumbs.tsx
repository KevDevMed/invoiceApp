/**
 * The breadcrumb bar: a 36px band directly under the tab strip.
 *
 * Trail at the inline start, live status at the inline end, a hairline along
 * the bottom. Everything it *decides* is in `./breadcrumbTrail` and
 * `./shellStatus`; this file is the arrangement and nothing else.
 *
 * Not a drag region. The band immediately above it is (the window has to be
 * grabbable somewhere), but a breadcrumb is a row of links, and a row of links
 * inside `-webkit-app-region: drag` is a row of links that has to opt every one
 * of its own children back out. Keeping the drag surface in the strip above
 * means this band never has to think about it.
 */

import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { HStack, StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import { BREADCRUMB_BAND_HEIGHT } from '../chrome';
import type { BreadcrumbStep } from './breadcrumbTrail';

/** Accessible name of the nav landmark the trail renders as. */
export const BREADCRUMB_LABEL = 'Page location';

export function ShellBreadcrumbs({
  trail,
  status,
}: {
  readonly trail: readonly BreadcrumbStep[];
  /** The `12 open · 3 overdue` line, or null when there is nothing to state. */
  readonly status: string | null;
}): React.JSX.Element {
  return (
    <StackItem size="static">
      <HStack
        className="app-breadcrumb-bar"
        height={BREADCRUMB_BAND_HEIGHT}
        align="center"
        justify="between"
        gap={3}
        paddingInline={4}
      >
        <StackItem size="fill">
          {trail.length === 0 ? null : (
            /*
              `supporting` is the dense variant: smaller type in secondary ink,
              which is what a band this short can carry without competing with
              the page heading a few pixels below it. The current step comes back
              to primary ink and semibold through `isCurrent` — that is the
              component's own contract, not a style set here.
            */
            <Breadcrumbs variant="supporting" label={BREADCRUMB_LABEL}>
              {trail.map((step) => (
                <BreadcrumbItem key={step.label} href={step.href} isCurrent={step.isCurrent}>
                  {step.label}
                </BreadcrumbItem>
              ))}
            </Breadcrumbs>
          )}
        </StackItem>
        {status === null ? null : (
          <Text type="supporting" hasTabularNumbers>
            {status}
          </Text>
        )}
      </HStack>
    </StackItem>
  );
}
