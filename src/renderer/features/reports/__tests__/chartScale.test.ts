import { describe, expect, it } from 'vitest';

import { barPath, niceMax } from '../chartScale';

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
