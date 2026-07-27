import { describe, expect, it } from 'vitest';

import { barPath, bucketLabels, labelStep, niceMax } from '../chartScale';

describe('niceMax', () => {
  it('returns 100 for zero and negative input', () => {
    expect(niceMax(0)).toBe(100);
    expect(niceMax(-5)).toBe(100);
  });

  it('rounds up to 1/2/5 steps within a magnitude', () => {
    expect(niceMax(1)).toBe(1);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(20)).toBe(20);
    expect(niceMax(21)).toBe(50);
    expect(niceMax(75)).toBe(100);
    expect(niceMax(100)).toBe(100);
    expect(niceMax(101)).toBe(200);
  });

  it('scales with magnitude', () => {
    expect(niceMax(123_456)).toBe(200_000);
    expect(niceMax(999_999)).toBe(1_000_000);
  });

  it('never returns less than the input', () => {
    for (const value of [1, 3, 7, 42, 99, 550, 1234, 987654]) {
      expect(niceMax(value)).toBeGreaterThanOrEqual(value);
    }
  });
});

describe('bucketLabels', () => {
  it('renders month buckets as "Mon YYYY" when every bucket is a first-of-month', () => {
    expect(bucketLabels(['2025-07-01', '2025-08-01', '2026-01-01'])).toEqual([
      'Jul 2025',
      'Aug 2025',
      'Jan 2026',
    ]);
  });

  it('renders week buckets as "D Mon YY" when any bucket is mid-month', () => {
    expect(bucketLabels(['2025-06-30', '2025-07-07'])).toEqual(['30 Jun 25', '7 Jul 25']);
  });

  it('treats a Monday-the-1st week among other weeks as a week, not a month', () => {
    expect(bucketLabels(['2025-09-01', '2025-09-08'])).toEqual(['1 Sep 25', '8 Sep 25']);
  });

  it('passes non-ISO strings through unchanged', () => {
    expect(bucketLabels(['total', '2025-13-01'])).toEqual(['total', '2025-13-01']);
  });

  it('returns an empty list for no buckets', () => {
    expect(bucketLabels([])).toEqual([]);
  });
});

describe('labelStep', () => {
  it('keeps every label while they all fit', () => {
    expect(labelStep(8, 640, 64)).toBe(1);
    expect(labelStep(10, 640, 64)).toBe(1);
  });

  it('thins labels once they would collide', () => {
    expect(labelStep(13, 640, 64)).toBe(2);
    expect(labelStep(60, 640, 64)).toBe(6);
  });

  it('never draws more labels than fit, at any count', () => {
    for (const count of [1, 13, 26, 52, 120, 500]) {
      const step = labelStep(count, 640, 64);
      expect(Math.ceil(count / step)).toBeLessThanOrEqual(10);
    }
  });

  it('falls back to every label on degenerate input', () => {
    expect(labelStep(0, 640, 64)).toBe(1);
    expect(labelStep(5, 0, 64)).toBe(1);
    expect(labelStep(5, 640, 0)).toBe(1);
  });
});

describe('barPath', () => {
  it('starts and ends at the baseline and closes the path', () => {
    const d = barPath(10, 50, 20, 200);
    expect(d.startsWith('M 10 200')).toBe(true);
    expect(d.endsWith('L 30 200 Z')).toBe(true);
  });

  it('caps the corner radius at 4', () => {
    const d = barPath(0, 100, 20, 200);
    expect(d).toContain('L 0 104'); // y + r with r = 4
  });

  it('limits the radius to half the bar width', () => {
    const d = barPath(0, 100, 4, 200);
    expect(d).toContain('L 0 102'); // r = width / 2 = 2
  });

  it('limits the radius to the bar height', () => {
    const d = barPath(0, 199, 20, 200);
    expect(d).toContain('L 0 200'); // r = baseline - y = 1
  });
});
