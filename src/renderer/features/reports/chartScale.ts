/**
 * Pure scale maths for the revenue chart, kept out of the component so it can
 * be unit-tested in the node vitest project. Values and formulas are exactly
 * the ones the chart has always used.
 */

/** Round up to a clean 1/2/5 x 10^n axis maximum. */
export function niceMax(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Column with a 4px rounded data-end, square at the baseline. */
export function barPath(x: number, y: number, width: number, baseline: number): string {
  const r = Math.min(4, width / 2, Math.max(0, baseline - y));
  return [
    `M ${x} ${baseline}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${baseline}`,
    'Z',
  ].join(' ');
}
