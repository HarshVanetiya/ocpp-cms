import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Activity } from 'lucide-react';
import type { Session, SessionStatus } from '@ocpp/contracts';
import { useApiQuery, useInvalidate, useRealtimeEvent, useRealtimeTopics, useServedBy } from '@ocpp/api-client';
import {
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  Select,
  formatDuration,
  formatEnergy,
  formatMoney,
  formatNumber,
  formatRelative,
  useNow,
  type Column,
  useDebounced,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';
import { ProtocolBadge, SessionStatusBadge } from '../components/StatusBadges';
import { Pagination } from './StationsPage';

export default function SessionsPage() {
  const navigate = useNavigate();
  const now = useNow(1000);
  const invalidate = useInvalidate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SessionStatus | ''>('');
  const [protocol, setProtocol] = useState<'all' | 'ocpp1.6' | 'ocpp2.0.1'>('all');
  const [page, setPage] = useState(1);
  const q = useDebounced(search, 300);

  const sessions = useApiQuery('listSessions', {
    query: {
      page,
      pageSize: 25,
      search: q || undefined,
      status: status || undefined,
      protocol: protocol === 'all' ? undefined : protocol,
    },
  });

  const servedBy = useServedBy(['listSessions']);

  // A session list that does not notice a session starting is a list people
  // stop trusting. Refetch on lifecycle events only, not on every meter value.
  useRealtimeTopics(['sessions']);
  useRealtimeEvent('session.started', () => invalidate('listSessions'));
  useRealtimeEvent('session.ended', () => invalidate('listSessions'));

  const columns: Array<Column<Session>> = [
    {
      key: 'station',
      header: 'Station',
      width: 'minmax(180px, 1.3fr)',
      render: (s) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[12.5px] text-ink-1">{s.stationIdentity}</span>
          <span className="truncate text-[11px] text-ink-3">
            EVSE {s.evseId} · connector {s.connectorId}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '116px',
      render: (s) => <SessionStatusBadge status={s.status} />,
    },
    {
      key: 'protocol',
      header: 'Ver',
      width: '56px',
      render: (s) => <ProtocolBadge protocol={s.protocol} size="sm" />,
    },
    {
      key: 'driver',
      header: 'Driver',
      width: 'minmax(120px, 1fr)',
      render: (s) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[12.5px] text-ink-2">{s.idToken.userName ?? 'Unknown'}</span>
          <span className="truncate font-mono text-[11px] text-ink-3">{s.idToken.value}</span>
        </div>
      ),
    },
    {
      key: 'energy',
      header: 'Energy',
      width: '92px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {formatEnergy(s.energyDeliveredWh)}
        </span>
      ),
    },
    {
      key: 'power',
      header: 'Power',
      width: '80px',
      align: 'right',
      render: (s) =>
        s.currentPowerKw !== null ? (
          <span className="tabular font-mono text-[12.5px] text-accent">
            {s.currentPowerKw.toFixed(1)} kW
          </span>
        ) : (
          <span className="text-[12.5px] text-ink-3">—</span>
        ),
    },
    {
      key: 'duration',
      header: 'Duration',
      width: '86px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[12.5px] text-ink-2">
          {formatDuration(s.durationSeconds)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      width: '92px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {formatMoney(s.costMinor, s.currency)}
        </span>
      ),
    },
    {
      key: 'started',
      header: 'Started',
      width: '100px',
      align: 'right',
      render: (s) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {formatRelative(s.startedAt, now)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 p-5">
      <PageHeader
        title="Sessions"
        description={
          sessions.data ? `${formatNumber(sessions.data.meta.total)} charging sessions` : 'Charging sessions'
        }
        actions={<ServedByBadge servedBy={servedBy} />}
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="w-[260px]"
          placeholder="Station, token, driver"
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
          className="w-[160px]"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as SessionStatus | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'pending', label: 'Pending' },
            { value: 'completed', label: 'Completed' },
            { value: 'failed', label: 'Failed' },
          ]}
        />
      </div>

      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <QueryBoundary
          isLoading={sessions.isLoading}
          error={sessions.error}
          data={sessions.data}
          onRetry={() => void sessions.refetch()}
          skeleton={<DataTable columns={columns} rows={[]} rowKey={() => ''} loading skeletonRows={12} />}
        >
          {(data) => (
            <>
              <DataTable
                className="min-h-0 flex-grow"
                columns={columns}
                rows={data.data}
                rowKey={(s) => s.id}
                onRowClick={(s) => navigate(`/sessions/${s.id}`)}
                empty={
                  <EmptyState
                    icon={<Activity />}
                    title="No sessions match"
                    description="Charge something with the simulator and it will appear here."
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
