/**
 * Revenue-by-period chart: grouped columns, two series (invoiced / paid),
 * dependency-free inline SVG.
 *
 * Built to the dataviz method: categorical slots 1 (blue) and 2 (orange) from
 * the validated reference palette (validated for both modes with
 * validate_palette.js), thin marks with 4px rounded data-ends square at the
 * baseline, a 2px surface gap between touching bars, solid hairline gridlines,
 * text in ink tokens (never series colors), a legend (two series), a hover
 * tooltip listing both series at the hovered bucket, and a table-view twin
 * rendered by the parent page so no value is gated behind hover.
 */

import { useMemo, useState } from 'react';

import { formatMoney } from '../../../shared/money';

export interface RevenueChartBucket {
  readonly bucket: string;
  readonly totalCents: number;
  readonly paidCents: number;
}

export interface RevenueChartProps {
  readonly buckets: readonly RevenueChartBucket[];
  readonly currency: string;
}

// Reference dataviz palette, categorical slots 1-2, light + dark steps.
const CHART_STYLE = `
.revenue-chart {
  color-scheme: light;
  --chart-surface: #fcfcfb;
  --chart-ink: #0b0b0b;
  --chart-ink-secondary: #52514e;
  --chart-muted: #898781;
  --chart-grid: #e1e0d9;
  --chart-baseline: #c3c2b7;
  --chart-series-1: #2a78d6;
  --chart-series-2: #eb6834;
  position: relative;
  background: var(--chart-surface);
  border-radius: 8px;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme='light'])) .revenue-chart {
    color-scheme: dark;
    --chart-surface: #1a1a19;
    --chart-ink: #ffffff;
    --chart-ink-secondary: #c3c2b7;
    --chart-muted: #898781;
    --chart-grid: #2c2c2a;
    --chart-baseline: #383835;
    --chart-series-1: #3987e5;
    --chart-series-2: #d95926;
  }
}
:root[data-theme='dark'] .revenue-chart {
  color-scheme: dark;
  --chart-surface: #1a1a19;
  --chart-ink: #ffffff;
  --chart-ink-secondary: #c3c2b7;
  --chart-muted: #898781;
  --chart-grid: #2c2c2a;
  --chart-baseline: #383835;
  --chart-series-1: #3987e5;
  --chart-series-2: #d95926;
}
.revenue-chart__tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--chart-surface);
  border: 1px solid var(--chart-grid);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--chart-ink);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  white-space: nowrap;
  z-index: 2;
}
.revenue-chart__legend {
  display: flex;
  gap: 16px;
  padding: 8px 12px 0;
  font-size: 12px;
  color: var(--chart-ink-secondary);
  align-items: center;
}
.revenue-chart__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: -1px;
}
`;

/** Round up to a clean 1/2/5 x 10^n axis maximum. */
function niceMax(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Column with a 4px rounded data-end, square at the baseline. */
function barPath(x: number, y: number, width: number, baseline: number): string {
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

const WIDTH = 720;
const HEIGHT = 260;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 64 };

export function RevenueChart({ buckets, currency }: RevenueChartProps): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null);

  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const baseline = MARGIN.top + plotHeight;

  const maxCents = niceMax(Math.max(...buckets.map((b) => Math.max(b.totalCents, b.paidCents)), 1));
  const ticks = useMemo(() => [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxCents * f)), [maxCents]);

  const bandWidth = plotWidth / buckets.length;
  // Two bars per band, 2px surface gap between them, capped at 24px each.
  const barWidth = Math.max(2, Math.min(24, (bandWidth - 2) * 0.35));
  const yFor = (cents: number): number => baseline - (cents / maxCents) * plotHeight;

  const hoveredBucket = hovered !== null ? buckets[hovered] : undefined;
  const hoveredCenter = hovered !== null ? MARGIN.left + bandWidth * (hovered + 0.5) : 0;

  return (
    <div className="revenue-chart">
      <style>{CHART_STYLE}</style>
      <div className="revenue-chart__legend">
        <span>
          <span className="revenue-chart__swatch" style={{ background: 'var(--chart-series-1)' }} />
          Invoiced
        </span>
        <span>
          <span className="revenue-chart__swatch" style={{ background: 'var(--chart-series-2)' }} />
          Paid
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`Revenue by period, ${buckets.length} buckets. Values are also in the table below.`}
        onMouseLeave={() => setHovered(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke={tick === 0 ? 'var(--chart-baseline)' : 'var(--chart-grid)'}
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={yFor(tick) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--chart-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatMoney(tick, currency)}
            </text>
          </g>
        ))}

        {buckets.map((bucket, index) => {
          const center = MARGIN.left + bandWidth * (index + 0.5);
          const x1 = center - barWidth - 1; // 2px surface gap between the pair
          const x2 = center + 1;
          return (
            <g key={bucket.bucket}>
              {bucket.totalCents > 0 ? (
                <path d={barPath(x1, yFor(bucket.totalCents), barWidth, baseline)} fill="var(--chart-series-1)" />
              ) : null}
              {bucket.paidCents > 0 ? (
                <path d={barPath(x2, yFor(bucket.paidCents), barWidth, baseline)} fill="var(--chart-series-2)" />
              ) : null}
              <text
                x={center}
                y={HEIGHT - 8}
                textAnchor="middle"
                fontSize={11}
                fill="var(--chart-muted)"
              >
                {bucket.bucket}
              </text>
              {/* full-band hit target: bigger than the marks, per interaction spec */}
              <rect
                x={MARGIN.left + bandWidth * index}
                y={MARGIN.top}
                width={bandWidth}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHovered(index)}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(null)}
                tabIndex={0}
                aria-label={`${bucket.bucket}: invoiced ${formatMoney(bucket.totalCents, currency)}, paid ${formatMoney(bucket.paidCents, currency)}`}
              />
            </g>
          );
        })}
      </svg>

      {hoveredBucket ? (
        <div
          className="revenue-chart__tooltip"
          style={{
            left: `${(hoveredCenter / WIDTH) * 100}%`,
            top: 24,
            transform: 'translateX(-50%)',
          }}
        >
          <div style={{ color: 'var(--chart-ink-secondary)', marginBottom: 2 }}>
            {hoveredBucket.bucket}
          </div>
          <div>
            <span
              className="revenue-chart__swatch"
              style={{ background: 'var(--chart-series-1)' }}
            />
            <strong>{formatMoney(hoveredBucket.totalCents, currency)}</strong>
            <span style={{ color: 'var(--chart-ink-secondary)' }}> invoiced</span>
          </div>
          <div>
            <span
              className="revenue-chart__swatch"
              style={{ background: 'var(--chart-series-2)' }}
            />
            <strong>{formatMoney(hoveredBucket.paidCents, currency)}</strong>
            <span style={{ color: 'var(--chart-ink-secondary)' }}> paid</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
