import { useState } from 'react';
import { Link } from 'react-router';
import { MapPin } from 'lucide-react';
import type { StationSummary } from '@ocpp/contracts';
import { useApiQuery, useRealtimeEvent, useRealtimeTopics, useServedBy } from '@ocpp/api-client';
import {
  Panel,
  SearchInput,
  SegmentedControl,
  StatusDot,
  cn,
  formatRelative,
  useDebounced,
  useNow,
} from '@ocpp/ui';
import { FleetMap } from '../components/FleetMap';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';
import { ConnectorPips, ProtocolBadge, StationStatusBadge } from '../components/StatusBadges';

export default function MapPage() {
  const now = useNow(30_000);
  const [selected, setSelected] = useState<StationSummary | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'charging' | 'faulted' | 'offline'>('all');
  const q = useDebounced(search, 300);

  // One big page — every station with coordinates, not paginated. A map that
  // only shows page 1 of your fleet is worse than no map.
  const stations = useApiQuery('listStations', {
    query: { pageSize: 200, search: q || undefined },
  });

  const servedBy = useServedBy(['listStations']);

  useRealtimeTopics(['stations']);
  useRealtimeEvent('connector.status', () => void stations.refetch());

  const rows = (stations.data?.data ?? []).filter((s) => {
    if (filter === 'charging') return s.chargingConnectorCount > 0;
    if (filter === 'faulted') return s.faultedConnectorCount > 0;
    if (filter === 'offline') return s.status !== 'online';
    return true;
  });

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="w-[240px]"
          placeholder="Find a station"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SegmentedControl
          label="Show"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'charging', label: 'Charging' },
            { value: 'faulted', label: 'Faulted' },
            { value: 'offline', label: 'Offline' },
          ]}
        />
        <ServedByBadge servedBy={servedBy} />
        <span className="ml-auto text-[11.5px] text-ink-3">{rows.length} stations shown</span>
      </div>

      <div className="grid min-h-0 flex-grow gap-3 lg:grid-cols-[1fr_320px]">
        <Panel padded={false} className="min-h-[420px] overflow-hidden">
          <QueryBoundary
            isLoading={stations.isLoading}
            error={stations.error}
            data={stations.data}
            onRetry={() => void stations.refetch()}
            skeleton={<div className="size-full shimmer" />}
          >
            {() => (
              <FleetMap
                className="size-full"
                stations={rows}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
            )}
          </QueryBoundary>
        </Panel>

        <Panel padded={false} className="flex min-h-0 flex-col overflow-hidden max-lg:min-h-[300px]">
          {selected ? (
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    to={`/stations/${selected.id}`}
                    className="truncate font-mono text-[13px] font-medium text-ink-1 hover:text-accent"
                  >
                    {selected.identity}
                  </Link>
                  <span className="truncate text-[11.5px] text-ink-3">{selected.name}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-[11.5px] text-ink-3 hover:text-ink-1"
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StationStatusBadge status={selected.status} />
                <ProtocolBadge protocol={selected.protocol} />
              </div>
              <dl className="flex flex-col gap-2 border-t border-line-soft pt-3 text-[12.5px]">
                <Row label="Site" value={selected.locationName ?? '—'} />
                <Row label="Connectors" value={`${selected.availableConnectorCount} free of ${selected.connectorCount}`} />
                <Row label="Charging now" value={String(selected.chargingConnectorCount)} />
                <Row label="Max power" value={`${selected.maxPowerKw} kW`} />
                <Row label="Last seen" value={formatRelative(selected.lastHeartbeatAt, now)} />
              </dl>
              <Link
                to={`/stations/${selected.id}`}
                className="rounded-sm border border-line bg-surface-2 px-3 py-2 text-center text-[12.5px] font-medium text-ink-1 elev-1 hover:bg-surface-3"
              >
                Open station
              </Link>
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-line-soft px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-3">
                Stations
              </div>
              <ul className="min-h-0 flex-grow overflow-y-auto">
                {rows.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(s)}
                      className={cn(
                        'flex w-full items-center gap-2.5 border-b border-line-soft px-4 py-2.5 text-left transition-colors hover:bg-surface-2',
                      )}
                    >
                      <StatusDot
                        tone={
                          s.status !== 'online'
                            ? 'neutral'
                            : s.faultedConnectorCount > 0
                              ? 'danger'
                              : s.chargingConnectorCount > 0
                                ? 'info'
                                : 'accent'
                        }
                        filled
                        label={s.status}
                      />
                      <span className="min-w-0 flex-grow truncate font-mono text-[12px] text-ink-1">
                        {s.identity}
                      </span>
                      <ConnectorPips
                        statuses={[
                          ...Array<'charging'>(s.chargingConnectorCount).fill('charging'),
                          ...Array<'available'>(s.availableConnectorCount).fill('available'),
                          ...Array<'faulted'>(s.faultedConnectorCount).fill('faulted'),
                        ].slice(0, 4)}
                      />
                    </button>
                  </li>
                ))}
                {rows.length === 0 && (
                  <li className="grid place-items-center gap-2 px-4 py-10 text-center">
                    <MapPin className="size-5 text-ink-3" />
                    <span className="text-[12.5px] text-ink-3">No stations match</span>
                  </li>
                )}
              </ul>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="truncate text-right text-ink-1">{value}</dd>
    </div>
  );
}
