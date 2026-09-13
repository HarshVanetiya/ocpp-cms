import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn';

/**
 * Charts.
 *
 * Hand-rolled SVG rather than a charting library, for three reasons that are
 * worth knowing rather than just accepting:
 *
 *  1. Every charting library ships its own colour and typography opinions, and
 *     overriding them costs more code than drawing the marks.
 *  2. These charts are simple — a stacked area and a bar row. The library
 *     earns its weight at the complicated end, not here.
 *  3. Bundle size. Recharts and friends are 90–150 KB; this file is 6.
 *
 * The rules the marks follow (the same ones any good chart follows):
 *   - 2px lines, recessive grid, no chart junk.
 *   - One y-axis. Never two — a dual-axis chart lets you imply any correlation
 *     you like by choosing scales, which is why it is the classic bad chart.
 *   - A legend whenever there is more than one series; identity is never
 *     carried by colour alone.
 *   - Series colours come from the validated chart palette (`--color-c1…c5`),
 *     which lives in its own lightness band separate from the UI ink.
 *   - A crosshair and tooltip, because an interactive chart that cannot be
 *     interrogated is a picture.
 */

export interface SeriesPoint {
  /** ISO timestamp. */
  t: string;
  value: number;
}

export interface Series {
  key: string;
  label: string;
  /** CSS colour, normally `var(--color-c1)`. */
  color: string;
  points: SeriesPoint[];
}

export interface TimeSeriesChartProps {
  series: Series[];
  /** Stack the series. Only correct when they sum to a meaningful total. */
  stacked?: boolean;
  height?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  formatTime?: (iso: string) => string;
  /** Number of horizontal grid lines, including the top. */
  yTicks?: number;
  className?: string;
  emptyLabel?: string;
}

const PAD_LEFT = 40;
const PAD_BOTTOM = 24;
const PAD_TOP = 6;

function niceMax(value: number) {
  if (value <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(value));
  const n = value / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

export function TimeSeriesChart({
  series,
  stacked = false,
  height = 220,
  unit,
  formatValue = (v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }),
  formatTime = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  yTicks = 5,
  className,
  emptyLabel = 'No data for this period',
}: TimeSeriesChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  // Measure instead of guessing: the chart must fit whatever panel holds it.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const len = series[0]?.points.length ?? 0;

  const model = useMemo(() => {
    if (len === 0) return null;
    const plotW = Math.max(40, width - PAD_LEFT - 8);
    const plotH = height - PAD_BOTTOM - PAD_TOP;

    // Cumulative tops per point, so a stacked chart and a layered one share code.
    const tops: number[][] = [];
    for (let s = 0; s < series.length; s += 1) {
      tops.push(
        series[s].points.map((p, i) =>
          stacked && s > 0 ? tops[s - 1][i] + p.value : p.value,
        ),
      );
    }
    const peak = Math.max(...tops.flat(), 0);
    const max = niceMax(peak);

    const x = (i: number) => PAD_LEFT + (len === 1 ? plotW / 2 : (i / (len - 1)) * plotW);
    const y = (v: number) => PAD_TOP + plotH - (v / max) * plotH;

    const paths = series.map((s, si) => {
      const upper = tops[si];
      const lower = stacked && si > 0 ? tops[si - 1] : new Array(len).fill(0);
      const line = upper.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      const back = lower
        .map((_, i) => {
          const j = len - 1 - i;
          return `L${x(j).toFixed(1)} ${y(lower[j]).toFixed(1)}`;
        })
        .join(' ');
      return { key: s.key, line, area: `${line} ${back} Z` };
    });

    return { plotW, plotH, max, x, y, tops, paths };
  }, [series, stacked, width, height, len]);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!model || len === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ratio = (px - PAD_LEFT) / model.plotW;
      const idx = Math.round(ratio * (len - 1));
      setHover(Math.max(0, Math.min(len - 1, idx)));
    },
    [model, len],
  );

  if (len === 0 || !model) {
    return (
      <div
        ref={wrapRef}
        className={cn('grid place-items-center text-[13px] text-ink-3', className)}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    );
  }

  const { max, x, y, tops, paths, plotH } = model;
  const ticks = Array.from({ length: yTicks }, (_, i) => (max / (yTicks - 1)) * i);
  const xLabelIdx = [0, Math.floor((len - 1) / 4), Math.floor((len - 1) / 2), Math.floor(((len - 1) * 3) / 4), len - 1];

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        fill="none"
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} over time${unit ? `, in ${unit}` : ''}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none"
      >
        {/* grid — recessive on purpose; it orients, it does not compete */}
        {ticks.slice(1).map((t) => (
          <line
            key={t}
            x1={PAD_LEFT}
            x2={width - 8}
            y1={y(t) + 0.5}
            y2={y(t) + 0.5}
            stroke="var(--grid-line)"
            strokeWidth={1}
          />
        ))}
        <line
          x1={PAD_LEFT}
          x2={width - 8}
          y1={PAD_TOP + plotH + 0.5}
          y2={PAD_TOP + plotH + 0.5}
          stroke="var(--color-line)"
          strokeWidth={1}
        />

        {/* y labels wear ink tokens, never the series colour */}
        {ticks.map((t) => (
          <text
            key={t}
            x={PAD_LEFT - 8}
            y={y(t) + 3.5}
            textAnchor="end"
            className="fill-ink-3 font-mono text-[10px]"
          >
            {formatValue(t)}
          </text>
        ))}

        {/* fills first, then strokes, so lines sit above every area */}
        {paths.map((p, i) => (
          <path
            key={`a-${p.key}`}
            d={p.area}
            fill={i === 0 ? 'var(--c1-fill)' : i === 1 ? 'var(--c2-fill)' : 'var(--grid-line)'}
          />
        ))}
        {paths.map((p, i) => (
          <path
            key={`l-${p.key}`}
            d={p.line}
            stroke={series[i].color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              stroke="var(--color-ink-3)"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
            />
            {series.map((s, si) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(tops[si][hover])}
                r={4}
                fill={s.color}
                // A 2px ring in the surface colour keeps overlapping dots separable.
                stroke="var(--color-surface-1)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}

        {xLabelIdx.map((i, n) => (
          <text
            key={i}
            x={x(i)}
            y={height - 6}
            textAnchor={n === 0 ? 'start' : n === xLabelIdx.length - 1 ? 'end' : 'middle'}
            className="fill-ink-3 font-mono text-[10px]"
          >
            {formatTime(series[0].points[i].t)}
          </text>
        ))}
      </svg>

      {hover !== null && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 min-w-[150px] rounded-sm border border-line bg-surface-3 p-2.5 elev-3"
          style={{
            left: Math.min(Math.max(x(hover) + 12, 8), Math.max(8, width - 168)),
            top: 8,
          }}
        >
          <div className="mb-1.5 font-mono text-[10.5px] text-ink-3">
            {new Date(series[0].points[hover].t).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
          {[...series].reverse().map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
                <span
                  aria-hidden
                  className="size-2 rounded-[2px]"
                  style={{ background: s.color }}
                />
                {s.label}
              </span>
              <span className="tabular font-mono text-[11.5px] font-medium text-ink-1">
                {formatValue(s.points[hover].value)}
                {unit && <span className="ml-1 text-ink-3">{unit}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The legend. Always present for two or more series — identity must never rest
 * on colour alone, because roughly 1 in 12 men cannot rely on it.
 */
export function ChartLegend({
  series,
  className,
}: {
  series: Array<Pick<Series, 'key' | 'label' | 'color'>>;
  className?: string;
}) {
  if (series.length < 2) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-4', className)}>
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-2 text-xs text-ink-2">
          <span aria-hidden className="size-[9px] rounded-[2px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The accessible fallback: the same numbers as a real table.
 *
 * Charts are not readable by everyone. Shipping the table alongside costs
 * almost nothing and is the difference between "mostly accessible" and
 * "accessible".
 */
export function ChartDataTable({
  series,
  unit,
  formatTime = (iso) => new Date(iso).toLocaleString(),
  className,
}: {
  series: Series[];
  unit?: string;
  formatTime?: (iso: string) => string;
  className?: string;
}) {
  const rows = series[0]?.points ?? [];
  return (
    <div className={cn('max-h-64 overflow-auto rounded-sm border border-line-soft', className)}>
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface-2">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold text-ink-3">
              Time
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-3 py-2 text-right font-semibold text-ink-3">
                {s.label}
                {unit && ` (${unit})`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.t} className="border-t border-line-soft">
              <td className="px-3 py-1.5 font-mono text-ink-2">{formatTime(p.t)}</td>
              {series.map((s) => (
                <td key={s.key} className="tabular px-3 py-1.5 text-right font-mono text-ink-1">
                  {s.points[i]?.value.toFixed(1) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
