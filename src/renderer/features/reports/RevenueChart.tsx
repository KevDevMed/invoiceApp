/**
 * Revenue-by-period chart: grouped columns, two series (invoiced / paid),
 * dependency-free inline SVG.
 *
 * Restyled to the app's neutral hairline language: all colours come from
 * astryx tokens (which are light-dark aware, so no per-mode overrides), thin
 * marks with 4px rounded data-ends square at the baseline, a 2px surface gap
 * between touching bars, hairline gridlines, text in ink tokens (never series
 * colors), a legend, a hover tooltip listing both series at the hovered
 * bucket, and a table-view twin rendered by the parent page so no value is
 * gated behind hover.
 */

import { useMemo, useState } from 'react';

import { formatMoney } from '../../../shared/money';
import { barPath, niceMax } from './chartScale';

export interface RevenueChartBucket {
  readonly bucket: string;
  readonly totalCents: number;
  readonly paidCents: number;
}

export interface RevenueChartProps {
  readonly buckets: readonly RevenueChartBucket[];
  readonly currency: string;
}

// Everything on semantic tokens; they resolve per theme mode via light-dark().
const CHART_STYLE = `
.revenue-chart {
  --chart-grid: var(--color-border);
  --chart-baseline: var(--color-border-emphasized);
  --chart-series-1: var(--color-accent);
  --chart-series-2: var(--color-icon-orange);
  position: relative;
  background: var(--color-background-surface);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-element);
}
.revenue-chart__tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--color-background-popover);
  border: var(--border-width) solid var(--color-border);
  border-radius: var(--radius-inner);
  padding: var(--spacing-1-5) var(--spacing-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-low);
  white-space: nowrap;
  z-index: 2;
}
.revenue-chart__legend {
  display: flex;
  gap: var(--spacing-4);
  padding: var(--spacing-2) var(--spacing-3) 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  align-items: center;
}
.revenue-chart__swatch {
  display: inline-block;
  width: var(--spacing-2);
  height: var(--spacing-2);
  border-radius: var(--spacing-0-5);
  margin-right: var(--spacing-1-5);
  vertical-align: middle;
}
`;

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
              fill="var(--color-text-secondary)"
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
                fill="var(--color-text-secondary)"
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
            top: 'var(--spacing-6)',
            transform: 'translateX(-50%)',
          }}
        >
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-0-5)' }}>
            {hoveredBucket.bucket}
          </div>
          <div>
            <span
              className="revenue-chart__swatch"
              style={{ background: 'var(--chart-series-1)' }}
            />
            <strong>{formatMoney(hoveredBucket.totalCents, currency)}</strong>
            <span style={{ color: 'var(--color-text-secondary)' }}> invoiced</span>
          </div>
          <div>
            <span
              className="revenue-chart__swatch"
              style={{ background: 'var(--chart-series-2)' }}
            />
            <strong>{formatMoney(hoveredBucket.paidCents, currency)}</strong>
            <span style={{ color: 'var(--color-text-secondary)' }}> paid</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
