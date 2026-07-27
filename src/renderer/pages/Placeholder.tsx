/**
 * Stand-in for a feature that has not been built yet.
 *
 * Downstream builders swap the route element in routes.tsx for their real page;
 * this component and the shell around it stay untouched.
 */

import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/Stack';

export interface PlaceholderProps {
  readonly name: string;
  readonly description?: string;
}

export function Placeholder({ name, description }: PlaceholderProps): React.JSX.Element {
  return (
    <VStack gap={4} padding={4} height="100%">
      <Heading level={1}>{name}</Heading>
      <EmptyState
        title={`${name} is not built yet`}
        description={description ?? 'This screen is a placeholder. The feature lands in a later piece.'}
        headingLevel={2}
      />
    </VStack>
  );
}
