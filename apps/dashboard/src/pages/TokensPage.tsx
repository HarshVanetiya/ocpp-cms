import { useState } from 'react';
import { BadgeCheck } from 'lucide-react';
import type { Token, TokenStatus } from '@ocpp/contracts';
import { useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
  StatusDot,
  Tooltip,
  formatRelative,
  useNow,
  type Column,
  useDebounced,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';
import { Pagination } from './StationsPage';

export default function TokensPage() {
  const now = useNow(60_000);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TokenStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const q = useDebounced(search, 300);

  const tokens = useApiQuery('listTokens', {
    query: { page, pageSize: 25, search: q || undefined, status: status === 'all' ? undefined : status },
  });
  const servedBy = useServedBy(['listTokens']);

  const columns: Array<Column<Token>> = [
    {
      key: 'value',
      header: 'Token',
      width: 'minmax(160px,1fr)',
      render: (t) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-[12.5px] font-medium text-ink-1">{t.value}</span>
          <span className="truncate text-[11px] text-ink-3">{t.label ?? '—'}</span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: '110px',
      render: (t) => <Badge mono>{t.type}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '104px',
      render: (t) => (
        <Badge
          tone={t.status === 'active' ? 'accent' : t.status === 'blocked' ? 'danger' : 'warn'}
          dot="hollow"
        >
          {t.status}
        </Badge>
      ),
    },
    {
      key: 'user',
      header: 'Assigned to',
      width: 'minmax(140px,1fr)',
      render: (t) => <span className="truncate text-[12.5px] text-ink-2">{t.userName ?? 'Unassigned'}</span>,
    },
    {
      key: 'local',
      header: 'Local list',
      width: '96px',
      render: (t) => (
        <Tooltip
          content={
            t.inLocalList
              ? 'Included in the offline authorisation list pushed to stations, so it still works when a site loses its network.'
              : 'Not in the local list — this token cannot charge while a station is offline.'
          }
        >
          <span className="inline-flex cursor-help items-center gap-1.5 text-[11.5px] text-ink-2">
            <StatusDot tone={t.inLocalList ? 'accent' : 'neutral'} filled={t.inLocalList} label={t.inLocalList ? 'in list' : 'not in list'} />
            {t.inLocalList ? 'Yes' : 'No'}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'uses',
      header: 'Uses',
      width: '72px',
      align: 'right',
      render: (t) => <span className="tabular font-mono text-[12.5px] text-ink-2">{t.useCount}</span>,
    },
    {
      key: 'used',
      header: 'Last used',
      width: '104px',
      align: 'right',
      render: (t) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {formatRelative(t.lastUsedAt, now)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 p-5">
      <PageHeader
        title="Tokens"
        description="RFID cards and app identities. Blocking a token is not enough on its own — clear the station auth cache too."
        actions={<ServedByBadge servedBy={servedBy} />}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="w-[260px]"
          placeholder="Token value, label, holder"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SegmentedControl
          label="Status"
          size="sm"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'blocked', label: 'Blocked' },
            { value: 'expired', label: 'Expired' },
          ]}
        />
      </div>
      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <QueryBoundary
          isLoading={tokens.isLoading}
          error={tokens.error}
          data={tokens.data}
          onRetry={() => void tokens.refetch()}
          skeleton={<DataTable columns={columns} rows={[]} rowKey={() => ''} loading skeletonRows={10} />}
        >
          {(data) => (
            <>
              <DataTable
                className="min-h-0 flex-grow"
                columns={columns}
                rows={data.data}
                rowKey={(t) => t.id}
                empty={<EmptyState icon={<BadgeCheck />} title="No tokens match" />}
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
