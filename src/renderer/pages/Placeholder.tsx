/**
 * Stand-in for a feature that has not been built yet.
 *
 * Downstream builders swap the route element in routes.tsx for their real page;
 * this component and the shell around it stay untouched.
 */

import { EmptyState } from '@astryxdesign/core/EmptyState';

import { Page, PageHeader } from '../ui/Page';

export interface PlaceholderProps {
  readonly name: string;
  readonly description?: string;
}

export function Placeholder({ name, description }: PlaceholderProps): React.JSX.Element {
  return (
    <Page>
      <PageHeader title={name} />
      <EmptyState
        title={`${name} is not built yet`}
        description={description ?? 'This screen is a placeholder. The feature lands in a later piece.'}
        headingLevel={2}
      />
    </Page>
  );
}
