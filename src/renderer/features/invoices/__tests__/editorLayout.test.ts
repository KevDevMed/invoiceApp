/**
 * The preview rail's page arithmetic. The pane is a fixed-size window onto a
 * sheet of A4, so "how many pages is this" and "how far up is page 2" are the
 * two numbers the whole rail is built from.
 */

import { describe, expect, it } from 'vitest';

import {
  PAPER_HEIGHT_PX,
  clampPageIndex,
  documentPageCount,
  pageLabel,
  pageOffsetPx,
} from '../editorLayout';
import { PAPER_WIDTH_PX } from '../previewScale';

describe('PAPER_HEIGHT_PX', () => {
  it('is the paper width in A4 proportions', () => {
    expect(PAPER_HEIGHT_PX).toBe(Math.round((PAPER_WIDTH_PX * 297) / 210));
    expect(PAPER_HEIGHT_PX).toBe(1123);
  });
});

describe('documentPageCount', () => {
  it('is one page for a document that fits', () => {
    expect(documentPageCount(400)).toBe(1);
    expect(documentPageCount(PAPER_HEIGHT_PX)).toBe(1);
  });

  it('is one page before the sheet has been measured', () => {
    expect(documentPageCount(0)).toBe(1);
    expect(documentPageCount(Number.NaN)).toBe(1);
    expect(documentPageCount(-40)).toBe(1);
  });

  it('does not turn a rounding artefact into a second page', () => {
    expect(documentPageCount(PAPER_HEIGHT_PX + 4)).toBe(1);
  });

  it('counts a page for content that is genuinely below the fold', () => {
    expect(documentPageCount(PAPER_HEIGHT_PX + 200)).toBe(2);
    expect(documentPageCount(PAPER_HEIGHT_PX * 2 + 200)).toBe(3);
  });

  it('takes the page height as a parameter, so the test is not the constant', () => {
    expect(documentPageCount(250, 100)).toBe(3);
    expect(documentPageCount(250, 0)).toBe(1);
  });
});

describe('clampPageIndex', () => {
  it('holds an index inside the document', () => {
    expect(clampPageIndex(0, 1)).toBe(0);
    expect(clampPageIndex(4, 2)).toBe(1);
    expect(clampPageIndex(-2, 3)).toBe(0);
  });

  it('survives a document that claims no pages', () => {
    expect(clampPageIndex(3, 0)).toBe(0);
    expect(clampPageIndex(Number.NaN, 3)).toBe(0);
  });
});

describe('pageOffsetPx', () => {
  it('lifts the sheet by one page height per page', () => {
    expect(pageOffsetPx(0)).toBe(0);
    expect(pageOffsetPx(1)).toBe(-PAPER_HEIGHT_PX);
    expect(pageOffsetPx(2, 100)).toBe(-200);
  });

  it('never lifts the sheet the wrong way', () => {
    expect(pageOffsetPx(-3)).toBe(0);
    expect(pageOffsetPx(Number.NaN)).toBe(0);
  });
});

describe('pageLabel', () => {
  it('reads 1-based, like the page it names', () => {
    expect(pageLabel(0, 2)).toBe('1 / 2');
    expect(pageLabel(1, 2)).toBe('2 / 2');
  });

  it('never reads past the end', () => {
    expect(pageLabel(7, 2)).toBe('2 / 2');
    expect(pageLabel(0, 0)).toBe('1 / 1');
  });
});
