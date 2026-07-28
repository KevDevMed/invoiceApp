/**
 * Shared page primitives. Every route renders into these so padding, max
 * content width and vertical rhythm are identical on every screen.
 *
 * Typical page:
 *
 *   <Page>
 *     <PageHeader title="Invoices" description="…" actions={<Button … />} />
 *     <PageToolbar end={<Button label="Sort order" />}>
 *       <PowerSearch … />
 *     </PageToolbar>
 *     <Table … />
 *     <ListFooter … />
 *   </Page>
 *
 * No feature logic lives here.
 */

import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';

export interface PageProps {
  children: React.ReactNode;
  /**
   * Escape hatch for the content column cap. Numbers are pixels, strings pass
   * through (e.g. '100%' for full-bleed pages such as the assistant chat).
   * Defaults to 1120.
   */
  maxWidth?: number | string;
}

/**
 * The scrolling content container. Render it as the root of a route element;
 * it owns the page padding, the max content width and the gap between blocks.
 * The column is centred in the content area (`align="center"`), so a viewport
 * wider than `maxWidth` splits the leftover space into two equal gutters
 * instead of one on the right; narrower viewports still fill the width.
 * Do not nest one Page inside another.
 */
export function Page({ children, maxWidth = 1120 }: PageProps): React.JSX.Element {
  return (
    <VStack height="100%" isScrollable paddingInline={6} paddingBlock={5} align="center">
      <VStack gap={5} width="100%" maxWidth={maxWidth}>
        {children}
      </VStack>
    </VStack>
  );
}

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned controls on the title row: secondary button then primary. */
  actions?: React.ReactNode;
}

/**
 * Page title block: `Heading level={1}` with a muted one-line description under
 * it, and optional actions right-aligned on the title's row. Exactly one per
 * page — it carries the page's only h1.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps): React.JSX.Element {
  return (
    <HStack justify="between" align="start" gap={4} wrap="wrap">
      <VStack gap={1}>
        <Heading level={1}>{title}</Heading>
        {description === undefined ? null : (
          <Text type="supporting" display="block">
            {description}
          </Text>
        )}
      </VStack>
      {actions === undefined ? null : (
        <HStack gap={2} align="center" wrap="wrap">
          {actions}
        </HStack>
      )}
    </HStack>
  );
}

export interface PageToolbarProps {
  /** Leading controls — typically the inline filter bar (PowerSearch). */
  children: React.ReactNode;
  /** Trailing controls pinned to the right of the same row (search, sort). */
  end?: React.ReactNode;
}

/**
 * The row above a table: filters on the left, trailing controls on the right.
 * Both halves wrap onto extra lines when filter tokens overflow, so pass the
 * tokens directly as children rather than pre-wrapping them.
 */
export function PageToolbar({ children, end }: PageToolbarProps): React.JSX.Element {
  return (
    <HStack justify="between" align="start" gap={3} wrap="wrap">
      <StackItem size="fill">
        <HStack gap={2} align="center" wrap="wrap">
          {children}
        </HStack>
      </StackItem>
      {end === undefined ? null : (
        <HStack gap={2} align="center" wrap="wrap">
          {end}
        </HStack>
      )}
    </HStack>
  );
}
