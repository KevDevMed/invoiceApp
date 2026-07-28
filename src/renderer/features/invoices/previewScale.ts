/**
 * How big the previewed "sheet of paper" is drawn.
 *
 * The editor's preview renders `InvoiceDocument` at one fixed paper width and
 * then scales the whole sheet with a CSS transform, so narrowing the pane makes
 * the page smaller instead of re-wrapping its columns. A reflowing preview is
 * not a preview: the line table would break differently on screen than it does
 * in the exported PDF.
 *
 * Pure module by design — the vitest project is `environment: 'node'`, so the
 * arithmetic lives here where it can be tested and the component only measures.
 */

/**
 * Paper width, in CSS px: A4 (210mm) at 96dpi = 793.7, rounded to 794.
 *
 * A4 rather than US Letter (816) because the PDF exporter sizes its content
 * column to the narrower of the two — "fits the narrower A4 width and centers
 * on Letter" (src/main/pdf/invoice-template.ts) — so A4 is the width that
 * actually decides where the exported document wraps.
 */
export const PAPER_WIDTH_PX = 794;

/**
 * Smallest scale the sheet is allowed to shrink to. Below roughly a third the
 * document's body type stops being legible, and a preview nobody can read is
 * worse than one that clips: at the floor the pane keeps its own scrollbar.
 */
export const MIN_PREVIEW_SCALE = 0.35;

/**
 * The uniform scale for a sheet of `paperWidth` shown in `availableWidth`.
 *
 * Clamped at both ends:
 * - never above 1 — a preview blown up past 100% is not what prints;
 * - never below `MIN_PREVIEW_SCALE`.
 *
 * A width that is not a usable positive finite number (0 before the first
 * `ResizeObserver` callback, NaN from an unmounted node, a negative from a
 * collapsed container) means "not measured yet", and the honest answer there is
 * the unscaled sheet — the first real measurement corrects it a frame later.
 */
export function previewScale(availableWidth: number, paperWidth: number = PAPER_WIDTH_PX): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  if (!Number.isFinite(paperWidth) || paperWidth <= 0) return 1;
  const ratio = availableWidth / paperWidth;
  if (ratio >= 1) return 1;
  return Math.max(MIN_PREVIEW_SCALE, ratio);
}

/**
 * The height a scaled sheet actually needs from the layout.
 *
 * `transform: scale()` is paint-only: the element keeps its unscaled box, so a
 * sheet drawn at 0.6 would still reserve its full height and leave a gap under
 * itself. The wrapper is given this number instead. Returns 0 for a height that
 * has not been measured yet, which the caller reads as "let it size itself".
 */
export function scaledPreviewHeight(naturalHeight: number, scale: number): number {
  if (!Number.isFinite(naturalHeight) || naturalHeight <= 0) return 0;
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return Math.ceil(naturalHeight * scale);
}
