import type { HTMLAttributes, ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '../lib/cn';
import { Overline, Panel, type Tone } from './primitives';

/* ------------------------------------------------------------------ *
 * StatTile
 * ------------------------------------------------------------------ */

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Rendered small and grey immediately after the value, e.g. "kWh". */
  unit?: string;
  /** Small print under the value. */
  caption?: ReactNode;
  icon?: ReactNode;
  /** Percentage change vs the previous equal-length period. */
  changePercent?: number | null;
  /** For metrics where down is good (faults, latency). */
  invertChange?: boolean;
  sparkline?: ReactNode;
  className?: string;
}

/**
 * A hero number.
 *
 * Deliberately NOT a chart: when the job is "what is this number right now",
 * a chart is a worse answer than the number itself. The sparkline is optional
 * context, not the point — it carries no axis and no labels on purpose.
 */
export function StatTile({
  label,
  value,
  unit,
  caption,
  icon,
  changePercent,
  invertChange,
  sparkline,
  className,
}: StatTileProps) {
  const hasChange = typeof changePercent === 'number' && Number.isFinite(changePercent);
  const up = hasChange && changePercent > 0;
  const flat = hasChange && Math.abs(changePercent) < 0.05;
  const good = invertChange ? !up : up;

  return (
    <Panel className={cn('px-[18px] py-4', className)} padded={false}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <Overline>{label}</Overline>
        {icon && <span className="text-ink-3 [&>svg]:size-3.5">{icon}</span>}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="font-display tabular text-[30px] font-semibold leading-none tracking-[-0.03em]">
            {value}
            {unit && <span className="ml-1 text-[15px] font-medium text-ink-3">{unit}</span>}
          </div>
          {hasChange ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[11.5px] font-medium',
                flat ? 'text-ink-3' : good ? 'text-accent' : 'text-danger',
              )}
            >
              {flat ? (
                <Minus className="size-3" aria-hidden />
              ) : up ? (
                <ArrowUp className="size-3" aria-hidden />
              ) : (
                <ArrowDown className="size-3" aria-hidden />
              )}
              {Math.abs(changePercent).toFixed(1)}% vs previous
            </span>
          ) : (
            caption && <span className="text-[11.5px] text-ink-2">{caption}</span>
          )}
        </div>
        {sparkline && <div className="shrink-0">{sparkline}</div>}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Sparkline
 * ------------------------------------------------------------------ */

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** CSS colour. Defaults to chart series 1. */
  stroke?: string;
  filled?: boolean;
  className?: string;
}

export function Sparkline({
  values,
  width = 84,
  height = 26,
  stroke = 'var(--color-c1)',
  filled,
  className,
}: SparklineProps) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / span) * (height - 3) - 1.5;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      // Decorative: the number beside it carries the meaning.
      aria-hidden
      className={className}
    >
      {filled && <path d={`${d} L${width} ${height} L0 ${height} Z`} fill="var(--c1-fill)" />}
      <path d={d} stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * ProgressBar / Meter
 * ------------------------------------------------------------------ */

export interface MeterProps {
  value: number;
  max?: number;
  tone?: Tone;
  label: string;
  showValue?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

const meterFill: Record<Tone, string> = {
  neutral: 'bg-ink-3',
  accent: 'bg-accent',
  info: 'bg-info',
  warn: 'bg-warn',
  danger: 'bg-danger',
  violet: 'bg-violet',
};

export function Meter({
  value,
  max = 100,
  tone = 'accent',
  label,
  showValue,
  size = 'md',
  className,
}: MeterProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {showValue && (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] text-ink-2">{label}</span>
          <span className="tabular text-xs text-ink-1">{pct.toFixed(0)}%</span>
        </div>
      )}
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={max}
        className={cn(
          'overflow-hidden rounded-full border border-line-soft bg-surface-2',
          size === 'sm' ? 'h-[5px]' : 'h-[7px]',
        )}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', meterFill[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Multi-segment bar — the connector-state breakdown on the overview.
 *
 * The 2px gaps are not decoration: adjacent fills of similar lightness merge
 * visually without them, which is the most common way a stacked bar becomes
 * unreadable.
 */
export interface StackedBarProps {
  segments: Array<{ key: string; value: number; color: string; label: string }>;
  height?: number;
  className?: string;
}

export function StackedBar({ segments, height = 10, className }: StackedBarProps) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className={cn('flex gap-[2px]', className)} style={{ height }} role="img"
      aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}>
      {segments.map((s, i) => (
        <div
          key={s.key}
          title={`${s.label}: ${s.value}`}
          style={{
            flexGrow: s.value,
            background: s.color,
            borderRadius:
              i === 0 ? '4px 0 0 4px' : i === segments.length - 1 ? '0 4px 4px 0' : undefined,
          }}
        />
      ))}
      {total === 0 && <div className="flex-grow rounded-[4px] bg-surface-2" />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * RingGauge
 * ------------------------------------------------------------------ */

export interface RingGaugeProps {
  /** 0–100. */
  percent: number;
  size?: number;
  thickness?: number;
  tone?: 'accent' | 'warn' | 'danger' | 'info';
  label: string;
  children?: ReactNode;
  className?: string;
}

/** The driver app's budget ring. */
export function RingGauge({
  percent,
  size = 252,
  thickness = 14,
  tone = 'accent',
  label,
  children,
  className,
}: RingGaugeProps) {
  const r = (size - thickness) / 2 - 4;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, percent));
  const stroke =
    tone === 'warn'
      ? 'var(--color-warn)'
      : tone === 'danger'
        ? 'var(--color-danger)'
        : tone === 'info'
          ? 'var(--color-info)'
          : 'var(--color-accent)';

  return (
    <div className={cn('relative grid place-items-center', className)} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        fill="none"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-surface-2)" strokeWidth={thickness} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={stroke}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-700"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r - thickness}
          stroke="var(--color-line-soft)"
          strokeWidth={1}
          strokeDasharray="2 6"
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex flex-col items-center gap-1">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Table
 * ------------------------------------------------------------------ */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** CSS grid track for this column, e.g. "120px" or "minmax(0,1fr)". */
  width: string;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Rendered instead of rows when the list is empty. */
  empty?: ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  dense?: boolean;
  className?: string;
}

/**
 * A CSS-grid table.
 *
 * Grid rather than `<table>` because every column width here is fixed by
 * design and grid gives identical alignment across a virtualised list without
 * `table-layout` gymnastics. Row semantics are supplied explicitly so screen
 * readers still see a table.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  loading,
  skeletonRows = 8,
  dense,
  className,
}: DataTableProps<T>) {
  const template = columns.map((c) => c.width).join(' ');

  return (
    <div role="table" className={cn('flex min-h-0 flex-col', className)}>
      <div
        role="row"
        className="grid shrink-0 gap-3 border-b border-line-soft bg-surface-1 px-5 py-2.5
                   text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-3"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((c) => (
          <span key={c.key} role="columnheader" className={c.align === 'right' ? 'text-right' : undefined}>
            {c.header}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-grow overflow-auto">
        {loading
          ? Array.from({ length: skeletonRows }, (_, i) => (
              <div
                key={i}
                className="grid gap-3 border-b border-line-soft px-5 py-2.5"
                style={{ gridTemplateColumns: template }}
              >
                {columns.map((c) => (
                  <div key={c.key} className="h-4 rounded-xs shimmer" />
                ))}
              </div>
            ))
          : rows.length === 0
            ? (empty ?? null)
            : rows.map((row) => {
                const key = rowKey(row);
                const selected = key === selectedKey;
                const interactive = Boolean(onRowClick);
                return (
                  <div
                    key={key}
                    role="row"
                    tabIndex={interactive ? 0 : undefined}
                    aria-selected={interactive ? selected : undefined}
                    onClick={() => onRowClick?.(row)}
                    onKeyDown={(e) => {
                      if (!interactive) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick?.(row);
                      }
                    }}
                    className={cn(
                      'grid items-center gap-3 border-b border-line-soft px-5 transition-colors',
                      dense ? 'py-1.5' : 'py-2',
                      interactive && 'cursor-pointer hover:bg-surface-2',
                      selected && 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]',
                    )}
                    style={{ gridTemplateColumns: template }}
                  >
                    {columns.map((c) => (
                      <div
                        key={c.key}
                        role="cell"
                        className={cn('min-w-0', c.align === 'right' && 'text-right')}
                      >
                        {c.render(row)}
                      </div>
                    ))}
                  </div>
                );
              })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EmptyState / Skeleton
 * ------------------------------------------------------------------ */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('grid place-items-center px-6 py-14 text-center', className)}>
      <div className="flex max-w-sm flex-col items-center gap-3">
        {icon && (
          <span className="grid size-11 place-items-center rounded-md border border-line-soft bg-surface-2 text-ink-3 [&>svg]:size-5">
            {icon}
          </span>
        )}
        <h3 className="font-display text-[15px] font-semibold">{title}</h3>
        {description && <p className="text-[13px] leading-relaxed text-ink-3">{description}</p>}
        {action && <div className="mt-1">{action}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('rounded-sm shimmer', className)} {...rest} />;
}

/* ------------------------------------------------------------------ *
 * KeyValue
 * ------------------------------------------------------------------ */

export interface KeyValueProps {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
  className?: string;
  columns?: number;
}

export function KeyValue({ items, className, columns }: KeyValueProps) {
  return (
    <dl
      className={cn(columns ? 'grid gap-x-6 gap-y-3' : 'flex flex-wrap gap-x-7 gap-y-3', className)}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))` } : undefined}
    >
      {items.map((it) => (
        <div key={it.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">{it.label}</dt>
          <dd className={cn('truncate text-[13.5px] text-ink-1', it.mono && 'font-mono tabular')}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
