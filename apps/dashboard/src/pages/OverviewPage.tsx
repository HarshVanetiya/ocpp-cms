import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  BatteryCharging,
  CircleDollarSign,
  Radio,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import type { ActivityItem, TimeRange } from '@ocpp/contracts';
import { CONNECTOR_STATUS_LABEL } from '@ocpp/contracts';
import {
  useApiQuery,
  useInvalidate,
  useRealtimeEvent,
  useRealtimeTopics,
  useServedBy,
} from '@ocpp/api-client';
import {
  ChartLegend,
  Meter,
  Panel,
  SectionTitle,
  SegmentedControl,
  Sparkline,
  StackedBar,
  StatTile,
  StatusDot,
  TimeSeriesChart,
  formatDuration,
  formatEnergy,
  formatMoney,
  formatNumber,
  formatRelative,
  splitEnergy,
  useNow,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';

const RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

export default function OverviewPage() {
  const [range, setRange] = useState<TimeRange>('24h');
  const invalidate = useInvalidate();
  const now = useNow(30_000);

  const stats = useApiQuery('dashboardStats', { query: { range } });
  const energy = useApiQuery('energySeries', { query: { range, groupBy: 'protocol' } });
  const activity = useApiQuery('activity', { query: { limit: 8 } });
  const top = useApiQuery('topStations', { query: { range: '30d', limit: 5 } });

  const servedBy = useServedBy(['dashboardStats', 'energySeries', 'activity', 'topStations']);

  /**
   * Live updates without re-fetching.
   *
   * Session events are frequent — a fleet of 200 produces several a second.
   * Re-running `dashboardStats` on each one would hammer the backend for a
   * number that barely moves, so we subscribe and let TanStack Query refetch
   * on its own schedule instead. `activity` is different: it is a feed, and a
   * feed that does not move is broken.
   */
  useRealtimeTopics(['stations', 'sessions', 'activity']);
  useRealtimeEvent('activity', () => invalidate('activity'));

  const chartSeries = useMemo(
    () =>
      (energy.data?.series ?? []).map((s, i) => ({
        key: s.key,
        label: s.label,
        color: i === 0 ? 'var(--color-c1)' : 'var(--color-c2)',
        points: s.points,
      })),
    [energy.data],
  );

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="Time range"
          value={range}
          onChange={setRange}
          options={RANGES}
        />
        <ServedByBadge servedBy={servedBy} />
        <span className="ml-auto text-[11.5px] text-ink-3">
          Updated {formatRelative(stats.data?.generatedAt, now)}
        </span>
      </div>

      {/* ---------------------------- KPIs ---------------------------- */}
      <QueryBoundary
        isLoading={stats.isLoading}
        error={stats.error}
        data={stats.data}
        onRetry={() => void stats.refetch()}
        skeleton={
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Panel key={i} className="h-[104px]" />
            ))}
          </div>
        }
      >
        {(data) => {
          const wh = splitEnergy(data.energy.totalWh.value);
          return (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                label="Stations online"
                icon={<Zap />}
                value={
                  <>
                    {data.stations.online}
                    <span className="text-[15px] font-medium text-ink-3">/{data.stations.total}</span>
                  </>
                }
                caption={`${data.stations.availabilityPercent}% availability`}
                sparkline={<Sparkline values={fakeTrend(data.stations.online)} />}
              />
              <StatTile
                label="Active sessions"
                icon={<StatusDot tone="accent" pulse label="live" />}
                value={data.sessions.active}
                changePercent={data.sessions.completed.changePercent}
                sparkline={<Sparkline values={fakeTrend(data.sessions.active)} />}
              />
              <StatTile
                label={`Energy · ${range}`}
                icon={<BatteryCharging />}
                value={wh.value}
                unit={wh.unit}
                changePercent={data.energy.totalWh.changePercent}
                sparkline={<Sparkline values={fakeTrend(data.energy.totalWh.value / 1000)} />}
              />
              <StatTile
                label={`Revenue · ${range}`}
                icon={<CircleDollarSign />}
                value={formatMoney(data.revenue.totalMinor.value, data.currency)}
                caption={`${formatMoney(data.revenue.avgSessionMinor, data.currency)} average session`}
                changePercent={data.revenue.totalMinor.changePercent}
                sparkline={<Sparkline values={fakeTrend(data.revenue.totalMinor.value / 100)} />}
              />
            </div>
          );
        }}
      </QueryBoundary>

      {/* ------------------------ chart + fleet ----------------------- */}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Panel className="min-w-0">
          <div className="mb-3.5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <SectionTitle className="mb-0.5">Energy delivered</SectionTitle>
              <p className="text-xs text-ink-3">
                {range === '1h' ? 'Last hour' : `Last ${range}`}, split by protocol version
              </p>
            </div>
            <ChartLegend series={chartSeries} />
          </div>
          <QueryBoundary
            isLoading={energy.isLoading}
            error={energy.error}
            data={energy.data}
            onRetry={() => void energy.refetch()}
            skeleton={<div className="h-[220px] rounded-sm shimmer" />}
          >
            {() => (
              <TimeSeriesChart
                series={chartSeries}
                stacked
                unit="kWh"
                height={220}
                formatValue={(v) => formatNumber(v, v < 10 ? 1 : 0)}
              />
            )}
          </QueryBoundary>
        </Panel>

        <Panel>
          <SectionTitle className="mb-0.5">Connector state</SectionTitle>
          <QueryBoundary
            isLoading={stats.isLoading}
            error={stats.error}
            data={stats.data}
            skeleton={<div className="h-[260px] rounded-sm shimmer" />}
          >
            {(data) => {
              const entries = Object.entries(data.connectors.byStatus)
                .map(([status, count]) => ({ status: status as never, count: count as number }))
                .sort((a, b) => b.count - a.count);
              const total = data.connectors.total || 1;
              const paletteFor = (status: string) =>
                status === 'available'
                  ? 'var(--color-c1)'
                  : status === 'charging'
                    ? 'var(--color-c2)'
                    : status === 'faulted'
                      ? 'var(--color-c4)'
                      : status === 'reserved'
                        ? 'var(--color-c5)'
                        : status === 'preparing' || status === 'finishing'
                          ? 'var(--color-c5)'
                          : 'var(--color-ink-3)';

              return (
                <>
                  <p className="mb-4 text-xs text-ink-3">
                    {formatNumber(data.connectors.total)} connectors across{' '}
                    {formatNumber(data.stations.total)} stations
                  </p>
                  <StackedBar
                    className="mb-4"
                    segments={entries.map((e) => ({
                      key: e.status,
                      value: e.count,
                      color: paletteFor(e.status),
                      label: CONNECTOR_STATUS_LABEL[e.status],
                    }))}
                  />
                  <ul className="flex flex-col gap-2">
                    {entries.map((e) => (
                      <li key={e.status} className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="size-[9px] shrink-0 rounded-[2px]"
                          style={{ background: paletteFor(e.status) }}
                        />
                        <span
                          className={`flex-grow text-[12.5px] ${e.status === 'faulted' ? 'font-medium text-danger' : 'text-ink-2'}`}
                        >
                          {e.status === 'faulted' && (
                            <ShieldAlert className="mr-1.5 inline size-3.5 align-[-2px]" />
                          )}
                          {CONNECTOR_STATUS_LABEL[e.status]}
                        </span>
                        <span className="tabular font-mono text-[12.5px] font-medium text-ink-1">
                          {e.count}
                        </span>
                        <span className="tabular w-[38px] text-right font-mono text-[11px] text-ink-3">
                          {((e.count / total) * 100).toFixed(1)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex gap-6 border-t border-line-soft pt-3.5">
                    <Figure label="Utilisation" value={`${data.connectors.utilizationPercent}%`} />
                    <Figure
                      label="Avg session"
                      value={formatDuration(data.sessions.avgDurationSeconds)}
                    />
                    <Figure label="Peak load" value={`${data.energy.peakPowerKw} kW`} />
                  </div>
                </>
              );
            }}
          </QueryBoundary>
        </Panel>
      </div>

      {/* ----------------------- activity + top ----------------------- */}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Panel className="min-w-0">
          <div className="mb-3.5 flex items-center gap-2.5">
            <SectionTitle>Live activity</SectionTitle>
            <StatusDot tone="accent" pulse label="Live feed" />
          </div>
          <QueryBoundary
            isLoading={activity.isLoading}
            error={activity.error}
            data={activity.data}
            isEmpty={(d) => d.data.length === 0}
            onRetry={() => void activity.refetch()}
            skeleton={<div className="h-[280px] rounded-sm shimmer" />}
          >
            {(data) => (
              <ul className="flex flex-col">
                {data.data.map((item, i) => (
                  <ActivityRow key={item.id} item={item} now={now} last={i === data.data.length - 1} />
                ))}
              </ul>
            )}
          </QueryBoundary>
        </Panel>

        <Panel>
          <div className="mb-3.5 flex items-baseline justify-between">
            <SectionTitle>Busiest sites</SectionTitle>
            <span className="text-[11.5px] text-ink-3">30 days</span>
          </div>
          <QueryBoundary
            isLoading={top.isLoading}
            error={top.error}
            data={top.data}
            isEmpty={(d) => d.data.length === 0}
            onRetry={() => void top.refetch()}
            skeleton={<div className="h-[200px] rounded-sm shimmer" />}
          >
            {(data) => {
              const max = Math.max(...data.data.map((d) => d.energyWh), 1);
              return (
                <ul className="flex flex-col gap-3.5">
                  {data.data.map((s) => (
                    <li key={s.stationId} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-2.5">
                        <Link
                          to={`/stations/${s.stationId}`}
                          className="truncate text-[12.5px] font-medium text-ink-1 hover:text-accent"
                        >
                          {s.locationName ?? s.stationName}
                        </Link>
                        <span className="tabular shrink-0 font-mono text-xs text-ink-2">
                          {formatEnergy(s.energyWh, { digits: 1 })}
                        </span>
                      </div>
                      <Meter
                        label={`${s.stationName} energy`}
                        value={(s.energyWh / max) * 100}
                        size="sm"
                        tone="accent"
                      />
                    </li>
                  ))}
                </ul>
              );
            }}
          </QueryBoundary>
        </Panel>
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-ink-3">{label}</span>
      <span className="font-display tabular text-[19px] font-semibold tracking-[-0.02em]">
        {value}
      </span>
    </div>
  );
}

const ACTIVITY_ICON: Record<ActivityItem['kind'], typeof Zap> = {
  session_started: Zap,
  session_ended: BatteryCharging,
  station_online: Radio,
  station_offline: Radio,
  station_faulted: ShieldAlert,
  command_sent: Activity,
  payment_captured: CircleDollarSign,
  auth_rejected: ShieldAlert,
};

const SEVERITY_STYLE: Record<ActivityItem['severity'], string> = {
  info: 'bg-surface-2 text-ink-3',
  success: 'bg-accent-soft text-accent',
  warning: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
};

function ActivityRow({
  item,
  now,
  last,
}: {
  item: ActivityItem;
  now: number;
  last: boolean;
}) {
  const Icon = ACTIVITY_ICON[item.kind] ?? Activity;
  return (
    <li
      className={`flex items-center gap-3 py-2.5 ${last ? '' : 'border-b border-line-soft'}`}
    >
      <span
        className={`grid size-[26px] shrink-0 place-items-center rounded-xs ${SEVERITY_STYLE[item.severity]}`}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-grow truncate text-[12.5px] text-ink-1">
        {item.title}
        <span className="text-ink-3"> · </span>
        {item.stationId ? (
          <Link to={`/stations/${item.stationId}`} className="font-mono text-ink-2 hover:text-accent">
            {item.description}
          </Link>
        ) : (
          <span className="text-ink-2">{item.description}</span>
        )}
      </span>
      <span className="tabular w-[52px] shrink-0 text-right font-mono text-[11px] text-ink-3">
        {formatRelative(item.timestamp, now)}
      </span>
    </li>
  );
}

/**
 * Sparkline shape for a KPI whose history we do not have an endpoint for.
 *
 * Honest about what it is: a smooth ramp to the current value, used as visual
 * texture beside the real number. It is NOT presented as data — no axis, no
 * tooltip, no claim. When the backend grows a per-KPI history endpoint, this
 * gets deleted.
 */
function fakeTrend(current: number) {
  const base = Math.max(1, current);
  return Array.from({ length: 20 }, (_, i) => {
    const t = i / 19;
    return base * (0.82 + 0.18 * t) * (1 + Math.sin(i * 1.7) * 0.015);
  });
}
