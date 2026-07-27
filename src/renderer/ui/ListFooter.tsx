/**
 * The row under a table: `"1-10 of 240 · Results per page [10 ▾]"` on the left,
 * page controls on the right, hairline rule above.
 *
 *   <ListFooter
 *     total={rows.length}
 *     page={page}
 *     pageSize={pageSize}
 *     onPageChange={setPage}
 *     onPageSizeChange={setPageSize}
 *   />
 *
 * The component is stateless: it clamps the page it is given for display, but
 * the owner keeps the state. Slice rows with `pageSlice` from ./pagination so
 * the table and the footer agree.
 */

import { Divider } from '@astryxdesign/core/Divider';
import { Pagination } from '@astryxdesign/core/Pagination';
import { Selector } from '@astryxdesign/core/Selector';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import { clampPage, rangeLabel } from './pagination';

const DEFAULT_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];

export interface ListFooterProps {
  /** Total number of rows across all pages. */
  total: number;
  /** Current 1-based page. */
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Defaults to [10, 25, 50, 100]. */
  pageSizeOptions?: readonly number[];
}

export function ListFooter({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
}: ListFooterProps): React.JSX.Element {
  const current = clampPage(page, total, pageSize);

  return (
    <VStack gap={3}>
      <Divider />
      <HStack justify="between" align="center" gap={3} wrap="wrap">
        <HStack gap={2} align="center">
          <Text type="supporting">{rangeLabel(total, page, pageSize)}</Text>
          <Text type="supporting">·</Text>
          <Text type="supporting">Results per page</Text>
          <Selector
            label="Results per page"
            isLabelHidden
            size="sm"
            value={String(pageSize)}
            options={pageSizeOptions.map((option) => ({
              value: String(option),
              label: String(option),
            }))}
            onChange={(value) => {
              const next = Number(value);
              if (Number.isFinite(next) && next > 0) onPageSizeChange(next);
            }}
          />
        </HStack>
        <Pagination
          page={current}
          onChange={onPageChange}
          totalItems={total}
          pageSize={pageSize}
          variant="compact"
          size="sm"
        />
      </HStack>
    </VStack>
  );
}
