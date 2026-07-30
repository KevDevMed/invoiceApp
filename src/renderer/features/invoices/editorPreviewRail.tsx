/**
 * The editor's preview rail — the fixed-width column on the right that holds
 * the document the client will receive.
 *
 * Three rules shape it, and they are the reason this is its own module:
 *
 * 1. **The pane never grows.** It is `PREVIEW_RAIL_WIDTH` wide and the sheet
 *    inside it is a fixed A4 box (`aspect-ratio: 210/297`, `overflow: hidden`).
 *    A document that does not fit does not stretch the pane and does not put a
 *    horizontal scrollbar under it — it continues onto another page.
 * 2. **The paging is measured, not guessed.** The sheet is drawn at exactly one
 *    A4 width (`PAPER_WIDTH_PX`), so one A4 page is exactly `PAPER_HEIGHT_PX` of
 *    its own layout height. Counting pages is dividing the height the browser
 *    actually laid out by that number, and turning to page 2 is lifting the same
 *    sheet by one page. There is no second, estimated copy of the document's
 *    layout to disagree with the first.
 * 3. **What the pager offers is what exists.** With one page there is no pager
 *    and no thumbnail strip: controls that cannot do anything are worse than no
 *    controls, and a strip of one thumbnail is a picture of the thing it sits
 *    under.
 *
 * Honest limits of (2), stated because the rail looks like more than it is: the
 * fold falls where the browser's layout falls, so a row can be cut across it,
 * and the page breaks are the *preview's*, not the PDF exporter's — that
 * template (src/main/pdf/invoice-template.ts) paginates on its own. Nothing here
 * inserts "carried forward" lines or re-flows rows to avoid a split.
 */

import { useEffect, useRef, useState } from 'react';

import { Badge } from '@astryxdesign/core/Badge';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { InvoiceDocumentModel } from './document';
import {
  PAGE_THUMBNAIL_WIDTH,
  PAPER_ASPECT_RATIO,
  clampPageIndex,
  documentPageCount,
  pageLabel,
  pageOffsetPx,
} from './editorLayout';
import { InvoiceDocument } from './InvoiceDocument';
import { PAPER_WIDTH_PX, previewScale } from './previewScale';

/** The rail's monospace captions — the one place type is deliberately not body. */
const CAPTION_STYLE = {
  fontFamily: 'var(--font-family-code)',
  letterSpacing: '0.08em',
} as const;

/**
 * One page of the document, drawn on a sheet of A4.
 *
 * Two boxes, because `transform: scale()` is paint-only and the scaled sheet
 * still occupies its full unscaled box in layout: the frame is the A4 window and
 * clips, the sheet inside it is the fixed-width, transformed one. `flexShrink`
 * is pinned off — the frame is a flex column with a fixed height, and a sheet
 * that was allowed to shrink into it would report the frame's height back as its
 * own and there would be no page 2 to find.
 *
 * `ResizeObserver` is present in Electron and in the browser preview harness;
 * where it is not, both measurements stay at 0, which `previewScale` reads as
 * "not measured" and answers with scale 1, and `documentPageCount` reads as one
 * page. A missing observer degrades to an unscaled single page, not a crash.
 */
function PaperSheet({
  model,
  activeLineKey,
  pageIndex,
  onMeasure,
}: {
  readonly model: InvoiceDocumentModel;
  readonly activeLineKey: string | null;
  readonly pageIndex: number;
  readonly onMeasure: (naturalHeight: number) => void;
}): React.JSX.Element {
  const frameRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);

  useEffect(() => {
    const frame = frameRef.current;
    const sheet = sheetRef.current;
    if (!frame || !sheet) return;
    if (typeof ResizeObserver === 'undefined') return;

    // `clientWidth`/`offsetHeight` rather than the entry's rects: both are
    // untransformed layout numbers, which is what the scale and the page count
    // are computed from. A `getBoundingClientRect` height here would already
    // carry the scale and feed itself.
    const measure = (): void => {
      setPaneWidth(frame.clientWidth);
      onMeasure(sheet.offsetHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(sheet);
    measure();
    return () => {
      observer.disconnect();
    };
    // `onMeasure` is the rail's own `useState` setter, which React keeps stable,
    // so this observer is attached once per mount and not on every keystroke.
  }, [onMeasure]);

  const scale = previewScale(paneWidth);

  return (
    <VStack
      ref={frameRef}
      width="100%"
      style={{
        aspectRatio: PAPER_ASPECT_RATIO,
        overflow: 'hidden',
        borderRadius: 'var(--radius-element)',
        boxShadow: 'var(--shadow-high)',
      }}
    >
      <VStack
        ref={sheetRef}
        width={PAPER_WIDTH_PX}
        style={{
          flexShrink: 0,
          // Top-inline-start origin: the sheet shrinks towards the corner it is
          // aligned to, so it never drifts away from the pane's edge. The
          // translate is written in unscaled px on purpose — it runs before the
          // scale, so one page is one page height whatever the pane is doing.
          transform: `scale(${String(scale)}) translateY(${String(pageOffsetPx(pageIndex))}px)`,
          transformOrigin: 'top left',
        }}
      >
        <InvoiceDocument model={model} activeLineKey={activeLineKey} />
      </VStack>
    </VStack>
  );
}

/**
 * One page, small. The same document at the same fold — a real picture of the
 * page rather than a drawing of one, so a thumbnail can never show a layout the
 * sheet above it does not have.
 */
function PageThumbnail({
  model,
  pageIndex,
  isCurrent,
  onSelect,
}: {
  readonly model: InvoiceDocumentModel;
  readonly pageIndex: number;
  readonly isCurrent: boolean;
  readonly onSelect: () => void;
}): React.JSX.Element {
  const scale = PAGE_THUMBNAIL_WIDTH / PAPER_WIDTH_PX;
  return (
    <VStack gap={1} hAlign="center">
      <ClickableCard
        label={`Show page ${String(pageIndex + 1)}`}
        padding={0}
        variant="transparent"
        onClick={onSelect}
      >
        <VStack
          width={PAGE_THUMBNAIL_WIDTH}
          style={{
            aspectRatio: PAPER_ASPECT_RATIO,
            overflow: 'hidden',
            borderRadius: 'var(--radius-inner)',
            boxShadow: isCurrent
              ? '0 0 0 calc(var(--border-width) * 2) var(--color-accent)'
              : '0 0 0 var(--border-width) var(--color-border-emphasized)',
            opacity: isCurrent ? 1 : 0.75,
          }}
        >
          <VStack
            width={PAPER_WIDTH_PX}
            aria-hidden
            style={{
              flexShrink: 0,
              transform: `scale(${String(scale)}) translateY(${String(pageOffsetPx(pageIndex))}px)`,
              transformOrigin: 'top left',
            }}
          >
            <InvoiceDocument model={model} />
          </VStack>
        </VStack>
      </ClickableCard>
      <Text type="supporting" color={isCurrent ? undefined : 'secondary'} hasTabularNumbers>
        {String(pageIndex + 1)}
      </Text>
    </VStack>
  );
}

export interface PreviewRailProps {
  readonly model: InvoiceDocumentModel;
  /** The document line being edited, so the paper can light it up. */
  readonly activeLineKey: string | null;
  /** The Save / Create pair, pinned to the foot of the rail. */
  readonly actions: React.ReactNode;
}

export function PreviewRail({
  model,
  activeLineKey,
  actions,
}: PreviewRailProps): React.JSX.Element {
  const [naturalHeight, setNaturalHeight] = useState(0);
  const [requestedPage, setRequestedPage] = useState(0);

  const pageCount = documentPageCount(naturalHeight);
  // Derived, not stored: a document that shrinks back to one page while page 3
  // is showing must not leave the rail pointing at a page that no longer exists.
  const pageIndex = clampPageIndex(requestedPage, pageCount);
  const hasPages = pageCount > 1;

  return (
    <VStack gap={3} height="100%">
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting" color="secondary" style={CAPTION_STYLE}>
            PREVIEW · WHAT THEY RECEIVE
          </Text>
        </StackItem>
        {hasPages ? (
          <HStack gap={1} vAlign="center">
            <IconButton
              label="Previous page"
              icon={<Icon icon="chevronLeft" size="sm" />}
              size="sm"
              variant="ghost"
              isDisabled={pageIndex === 0}
              onClick={() => setRequestedPage(pageIndex - 1)}
            />
            <Text type="supporting" hasTabularNumbers>
              {pageLabel(pageIndex, pageCount)}
            </Text>
            <IconButton
              label="Next page"
              icon={<Icon icon="chevronRight" size="sm" />}
              size="sm"
              variant="ghost"
              isDisabled={pageIndex >= pageCount - 1}
              onClick={() => setRequestedPage(pageIndex + 1)}
            />
          </HStack>
        ) : null}
        <Badge variant="neutral" label="A4" />
      </HStack>

      <PaperSheet
        model={model}
        activeLineKey={activeLineKey}
        pageIndex={pageIndex}
        onMeasure={setNaturalHeight}
      />

      {hasPages ? (
        <VStack gap={1}>
          <Text type="label" color="secondary" style={CAPTION_STYLE}>
            {`PAGES · ${String(pageCount)}`}
          </Text>
          <HStack gap={2} vAlign="center">
            {Array.from({ length: pageCount }, (_, index) => (
              <PageThumbnail
                key={index}
                model={model}
                pageIndex={index}
                isCurrent={index === pageIndex}
                onSelect={() => setRequestedPage(index)}
              />
            ))}
            <StackItem size="fill">
              <Text type="supporting" color="secondary">
                Rows overflow onto new pages — the preview pane never grows.
              </Text>
            </StackItem>
          </HStack>
        </VStack>
      ) : null}

      {/* Takes whatever height the rail has spare, so the actions settle at its
          foot however tall the document above them turns out to be. */}
      <StackItem size="fill" />
      <HStack gap={2}>{actions}</HStack>
    </VStack>
  );
}
