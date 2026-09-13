import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Zap } from 'lucide-react';
import type { Protocol, StationStatus, StationSummary } from '@ocpp/contracts';
import { useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Button,
  DataTable,
  EmptyState,
  Panel,
  PageHeader,
  SearchInput,
  SegmentedControl,
  Select,
  formatNumber,
  formatRelative,
  useNow,
  type Column,
  useDebounced,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';
import { ConnectorPips, ProtocolBadge, StationStatusBadge } from '../components/StatusBadges';

export default function StationsPage() {
  const navigate = useNavigate();
  const now = useNow(30_000);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StationStatus | ''>('');
  const [protocol, setProtocol] = useState<Protocol | 'all'>('all');
  const [page, setPage] = useState(1);

  // Debounced so typing does not fire a request per keystroke.
  const q = useDebounced(search, 300);

  const stations = useApiQuery('listStations', {
    query: {
      page,
      pageSize: 25,
      search: q || undefined,
      status: status || undefined,
      protocol: protocol === 'all' ? undefined : protocol,
    },
  });

  const servedBy = useServedBy(['listStations']);

  const columns: Array<Column<StationSummary>> = [
    {
      key: 'identity',
      header: 'Station',
      width: 'minmax(200px, 1.6fr)',
      render: (s) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[12.5px] font-medium text-ink-1">
            {s.identity}
          </span>
          <span className="truncate text-[11.5px] text-ink-3">{s.name}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '150px',
      render: (s) => <StationStatusBadge status={s.status} />,
    },
    {
      key: 'protocol',
      header: 'Protocol',
      width: '86px',
      render: (s) => <ProtocolBadge protocol={s.protocol} size="sm" />,
    },
    {
      key: 'connectors',
      header: 'Connectors',
      width: '130px',
      render: (s) => (
        <div className="flex items-center gap-2">
          <ConnectorPips
            statuses={[
              ...Array<'charging'>(s.chargingConnectorCount).fill('charging'),
              ...Array<'available'>(s.availableConnectorCount).fill('available'),
              ...Array<'faulted'>(s.faultedConnectorCount).fill('faulted'),
            ].slice(0, 6)}
          />
          <span className="tabular font-mono text-[11px] text-ink-3">
            {s.availableConnectorCount}/{s.connectorCount}
          </span>
        </div>
      ),
    },
    {
      key: 'location',
      header: 'Site',
      width: 'minmax(140px, 1fr)',
      render: (s) => (
        <span className="truncate text-[12.5px] text-ink-2">{s.locationName ?? '—'}</span>
      ),
    },
    {
      key: 'power',
      header: 'Max power',
      width: '96px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[12.5px] text-ink-2">{s.maxPowerKw} kW</span>
      ),
    },
    {
      key: 'heartbeat',
      header: 'Last seen',
      width: '104px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {formatRelative(s.lastHeartbeatAt, now)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 p-5">
      <PageHeader
        title="Stations"
        description={
          stations.data
            ? `${formatNumber(stations.data.meta.total)} registered charge points`
            : 'Registered charge points'
        }
        actions={
          <>
            <ServedByBadge servedBy={servedBy} />
            <Button variant="primary" icon={<Plus />}>
              Register station
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="w-[260px]"
          placeholder="Identity, name, vendor"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SegmentedControl
          label="Protocol"
          size="sm"
          value={protocol}
          onChange={(v) => {
            setProtocol(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ocpp1.6', label: '1.6J' },
            { value: 'ocpp2.0.1', label: '2.0.1' },
          ]}
        />
        <Select
          className="w-[168px]"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StationStatus | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'Any status' },
            { value: 'online', label: 'Online' },
            { value: 'offline', label: 'Offline' },
            { value: 'pending', label: 'Pending boot' },
            { value: 'unavailable', label: 'Out of service' },
          ]}
        />
      </div>

      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <QueryBoundary
          isLoading={stations.isLoading}
          error={stations.error}
          data={stations.data}
          onRetry={() => void stations.refetch()}
          skeleton={
            <DataTable
              columns={columns}
              rows={[]}
              rowKey={() => ''}
              loading
              skeletonRows={10}
            />
          }
        >
          {(data) => (
            <>
              <DataTable
                className="min-h-0 flex-grow"
                columns={columns}
                rows={data.data}
                rowKey={(s) => s.id}
                onRowClick={(s) => navigate(`/stations/${s.id}`)}
                empty={
                  <EmptyState
                    icon={<Zap />}
                    title="No stations match"
                    description="Try clearing the filters, or register your first charge point."
                  />
                }
              />
              <Pagination
                page={data.meta.page}
                totalPages={data.meta.totalPages}
                total={data.meta.total}
                onPage={setPage}
              />
            </>
          )}
        </QueryBoundary>
      </Panel>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) {
    return (
      <div className="shrink-0 border-t border-line-soft px-5 py-2.5 text-[11.5px] text-ink-3">
        {total} {total === 1 ? 'result' : 'results'}
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line-soft px-5 py-2.5">
      <span className="text-[11.5px] text-ink-3">
        Page {page} of {totalPages} · {total} results
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
