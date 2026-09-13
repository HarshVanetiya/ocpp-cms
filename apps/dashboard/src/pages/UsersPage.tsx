import { useState } from 'react';
import { Users as UsersIcon } from 'lucide-react';
import type { User, UserRole } from '@ocpp/contracts';
import { useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SearchInput,
  SegmentedControl,
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
import { Pagination } from './StationsPage';

const ROLE_TONE = {
  admin: 'danger',
  operator: 'info',
  viewer: 'neutral',
  driver: 'accent',
} as const;

export default function UsersPage() {
  const now = useNow(60_000);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRole | 'all'>('all');
  const [page, setPage] = useState(1);
  const q = useDebounced(search, 300);

  const users = useApiQuery('listUsers', {
    query: { page, pageSize: 25, search: q || undefined, role: role === 'all' ? undefined : role },
  });
  const servedBy = useServedBy(['listUsers']);

  const columns: Array<Column<User>> = [
    {
      key: 'name',
      header: 'Name',
      width: 'minmax(180px,1.4fr)',
      render: (u) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-full border border-line bg-surface-3 text-[11px] font-semibold text-ink-2">
            {u.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[12.5px] text-ink-1">{u.name}</span>
            <span className="truncate text-[11px] text-ink-3">{u.email}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '104px',
      render: (u) => <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '104px',
      render: (u) => (
        <Badge
          tone={u.status === 'active' ? 'accent' : u.status === 'suspended' ? 'danger' : 'warn'}
          dot="hollow"
        >
          {u.status}
        </Badge>
      ),
    },
    {
      key: 'group',
      header: 'Group',
      width: 'minmax(120px,1fr)',
      render: (u) => <span className="truncate text-[12.5px] text-ink-2">{u.groupName ?? '—'}</span>,
    },
    {
      key: 'tokens',
      header: 'Tokens',
      width: '72px',
      align: 'right',
      render: (u) => <span className="tabular font-mono text-[12.5px] text-ink-2">{u.tokenCount}</span>,
    },
    {
      key: 'sessions',
      header: 'Sessions',
      width: '84px',
      align: 'right',
      render: (u) => <span className="tabular font-mono text-[12.5px] text-ink-2">{u.sessionCount}</span>,
    },
    {
      key: 'energy',
      header: 'Energy',
      width: '96px',
      align: 'right',
      render: (u) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {formatEnergy(u.totalEnergyWh, { digits: 1 })}
        </span>
      ),
    },
    {
      key: 'spent',
      header: 'Spent',
      width: '92px',
      align: 'right',
      render: (u) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {formatMoney(u.totalSpentMinor, u.currency ?? 'EUR')}
        </span>
      ),
    },
    {
      key: 'login',
      header: 'Last login',
      width: '100px',
      align: 'right',
      render: (u) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {formatRelative(u.lastLoginAt, now)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 p-5">
      <PageHeader
        title="Users"
        description={users.data ? `${formatNumber(users.data.meta.total)} accounts` : 'Accounts'}
        actions={<ServedByBadge servedBy={servedBy} />}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        <SearchInput
          className="w-[260px]"
          placeholder="Name, email, group"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <SegmentedControl
          label="Role"
          size="sm"
          value={role}
          onChange={(v) => {
            setRole(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'driver', label: 'Drivers' },
            { value: 'operator', label: 'Operators' },
            { value: 'admin', label: 'Admins' },
          ]}
        />
      </div>
      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <QueryBoundary
          isLoading={users.isLoading}
          error={users.error}
          data={users.data}
          onRetry={() => void users.refetch()}
          skeleton={<DataTable columns={columns} rows={[]} rowKey={() => ''} loading skeletonRows={10} />}
        >
          {(data) => (
            <>
              <DataTable
                className="min-h-0 flex-grow"
                columns={columns}
                rows={data.data}
                rowKey={(u) => u.id}
                empty={<EmptyState icon={<UsersIcon />} title="No users match" />}
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
