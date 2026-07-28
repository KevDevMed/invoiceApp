/**
 * The preview sheet's scale. There is no DOM here (vitest runs in `node`), which
 * is exactly why the decision lives in a pure module: the component measures,
 * this decides, and the clamping is provable without mounting React.
 */

import { describe, expect, it } from 'vitest';

import {
  MIN_PREVIEW_SCALE,
  PAPER_WIDTH_PX,
  previewScale,
  scaledPreviewHeight,
} from '../previewScale';

describe('previewScale', () => {
  it('never blows the sheet up past 100% when the pane is wider than the paper', () => {
    expect(previewScale(PAPER_WIDTH_PX + 1)).toBe(1);
    expect(previewScale(1200)).toBe(1);
    expect(previewScale(10_000)).toBe(1);
  });

  it('is exactly 1 when the pane is exactly the paper width', () => {
    expect(previewScale(PAPER_WIDTH_PX)).toBe(1);
  });

  it('shrinks proportionally when the pane is narrower', () => {
    expect(previewScale(397, 794)).toBe(0.5);
    expect(previewScale(600, 800)).toBe(0.75);
  });

  it('holds a legibility floor rather than shrinking without limit', () => {
    expect(previewScale(10, PAPER_WIDTH_PX)).toBe(MIN_PREVIEW_SCALE);
    expect(previewScale(1, PAPER_WIDTH_PX)).toBe(MIN_PREVIEW_SCALE);
    // The floor is a floor, not a rounding: a width just above it is honoured.
    expect(previewScale(0.5 * PAPER_WIDTH_PX, PAPER_WIDTH_PX)).toBe(0.5);
  });

  it('reads a not-yet-measured container as the unscaled sheet', () => {
    expect(previewScale(0)).toBe(1);
    expect(previewScale(-320)).toBe(1);
    expect(previewScale(Number.NaN)).toBe(1);
    expect(previewScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(previewScale(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('refuses to divide by a paper width that is not a positive number', () => {
    expect(previewScale(400, 0)).toBe(1);
    expect(previewScale(400, -794)).toBe(1);
    expect(previewScale(400, Number.NaN)).toBe(1);
  });

  it('defaults to the A4 paper width', () => {
    expect(PAPER_WIDTH_PX).toBe(794);
    expect(previewScale(PAPER_WIDTH_PX / 2)).toBe(previewScale(PAPER_WIDTH_PX / 2, PAPER_WIDTH_PX));
  });
});

describe('scaledPreviewHeight', () => {
  it('gives the wrapper the painted height, not the layout height', () => {
    expect(scaledPreviewHeight(1000, 0.5)).toBe(500);
    // Rounded up, so a fractional remainder can never clip the last row.
    expect(scaledPreviewHeight(1001, 0.5)).toBe(501);
  });

  it('is a no-op at scale 1', () => {
    expect(scaledPreviewHeight(1234, 1)).toBe(1234);
  });

  it('returns 0 for anything not yet measured, so the caller sizes itself', () => {
    expect(scaledPreviewHeight(0, 0.5)).toBe(0);
    expect(scaledPreviewHeight(Number.NaN, 0.5)).toBe(0);
    expect(scaledPreviewHeight(-100, 0.5)).toBe(0);
    expect(scaledPreviewHeight(1000, 0)).toBe(0);
    expect(scaledPreviewHeight(1000, Number.NaN)).toBe(0);
  });
});
