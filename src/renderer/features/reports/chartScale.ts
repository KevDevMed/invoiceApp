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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Short axis labels for ISO-date bucket starts (YYYY-MM-DD). When every bucket
 * is a first-of-month (the month grouping) labels read "Jul 2025"; otherwise
 * (week grouping, Mondays) "7 Jul 25". Anything non-ISO passes through as-is.
 */
export function bucketLabels(buckets: readonly string[]): string[] {
  const monthly = buckets.length > 0 && buckets.every((b) => /^\d{4}-\d{2}-01$/.test(b));
  return buckets.map((bucket) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
    if (!match) return bucket;
    const [, year = '', monthDigits = '', dayDigits = ''] = match;
    const month = MONTHS[Number(monthDigits) - 1];
    if (month === undefined) return bucket;
    if (monthly) return `${month} ${year}`;
    return `${Number(dayDigits)} ${month} ${year.slice(2)}`;
  });
}

/**
 * Draw every Nth axis label so labels of roughly labelWidth px never collide;
 * every bar keeps its band, only the text thins out.
 */
export function labelStep(count: number, plotWidth: number, labelWidth: number): number {
  if (count <= 0 || plotWidth <= 0 || labelWidth <= 0) return 1;
  const maxLabels = Math.max(1, Math.floor(plotWidth / labelWidth));
  return Math.ceil(count / maxLabels);
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
