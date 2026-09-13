import { useState } from 'react';
import { Receipt } from 'lucide-react';
import type { Cdr, Payment } from '@ocpp/contracts';
import { useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Badge,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  SegmentedControl,
  StatTile,
  formatDateTime,
  formatEnergy,
  formatMoney,
  type Column,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';
import { Pagination } from './StationsPage';

export default function BillingPage() {
  const [view, setView] = useState<'cdrs' | 'payments'>('cdrs');
  const [page, setPage] = useState(1);

  const cdrs = useApiQuery('listCdrs', { query: { page, pageSize: 25 } });
  const payments = useApiQuery('listPayments', { query: { page, pageSize: 25 } });
  const servedBy = useServedBy(['listCdrs', 'listPayments']);

  const totalRevenue = (cdrs.data?.data ?? []).reduce((a, c) => a + c.totalCostMinor, 0);
  const totalEnergy = (cdrs.data?.data ?? []).reduce((a, c) => a + c.energyDeliveredWh, 0);
  const held = (payments.data?.data ?? [])
    .filter((p) => p.status === 'authorized')
    .reduce((a, p) => a + p.authorizedAmountMinor, 0);

  const cdrColumns: Array<Column<Cdr>> = [
    {
      key: 'ref',
      header: 'Reference',
      width: '124px',
      render: (c) => <span className="font-mono text-[12.5px] text-ink-1">{c.reference}</span>,
    },
    {
      key: 'station',
      header: 'Station',
      width: 'minmax(140px,1fr)',
      render: (c) => <span className="truncate font-mono text-[12px] text-ink-2">{c.stationIdentity}</span>,
    },
    {
      key: 'user',
      header: 'Driver',
      width: 'minmax(120px,1fr)',
      render: (c) => <span className="truncate text-[12.5px] text-ink-2">{c.userName ?? '—'}</span>,
    },
    {
      key: 'energy',
      header: 'Energy',
      width: '92px',
      align: 'right',
      render: (c) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {formatEnergy(c.energyDeliveredWh)}
        </span>
      ),
    },
    {
      key: 'net',
      header: 'Net',
      width: '88px',
      align: 'right',
      render: (c) => (
        <span className="tabular font-mono text-[12.5px] text-ink-2">
          {formatMoney(
            c.totalCostMinor - Math.round(c.totalCostMinor * ((c.vatPercent ?? 0) / (100 + (c.vatPercent ?? 0)))),
            c.currency,
          )}
        </span>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      width: '92px',
      align: 'right',
      render: (c) => (
        <span className="tabular font-mono text-[12.5px] font-medium text-ink-1">
          {formatMoney(c.totalCostMinor, c.currency)}
        </span>
      ),
    },
    {
      key: 'ocpi',
      header: 'Roaming',
      width: '96px',
      render: (c) =>
        c.ocpiPushedAt ? (
          <Badge tone="accent" dot="solid">pushed</Badge>
        ) : (
          <span className="text-[11.5px] text-ink-3">local</span>
        ),
    },
    {
      key: 'issued',
      header: 'Issued',
      width: '150px',
      align: 'right',
      render: (c) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">{formatDateTime(c.issuedAt)}</span>
      ),
    },
  ];

  const paymentColumns: Array<Column<Payment>> = [
    {
      key: 'ref',
      header: 'Reference',
      width: '132px',
      render: (p) => <span className="font-mono text-[12.5px] text-ink-1">{p.reference}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '112px',
      render: (p) => (
        <Badge
          tone={
            p.status === 'captured'
              ? 'accent'
              : p.status === 'authorized'
                ? 'info'
                : p.status === 'failed'
                  ? 'danger'
                  : 'neutral'
          }
          dot="hollow"
        >
          {p.status}
        </Badge>
      ),
    },
    {
      key: 'user',
      header: 'Driver',
      width: 'minmax(120px,1fr)',
      render: (p) => <span className="truncate text-[12.5px] text-ink-2">{p.userName ?? '—'}</span>,
    },
    {
      key: 'auth',
      header: 'Authorised',
      width: '108px',
      align: 'right',
      render: (p) => (
        <span className="tabular font-mono text-[12.5px] text-ink-2">
          {formatMoney(p.authorizedAmountMinor, p.currency)}
        </span>
      ),
    },
    {
      key: 'captured',
      header: 'Captured',
      width: '104px',
      align: 'right',
      render: (p) => (
        <span className="tabular font-mono text-[12.5px] text-ink-1">
          {p.capturedAmountMinor === null ? '—' : formatMoney(p.capturedAmountMinor, p.currency)}
        </span>
      ),
    },
    {
      key: 'released',
      header: 'Released',
      width: '104px',
      align: 'right',
      render: (p) => (
        <span className="tabular font-mono text-[12.5px] text-accent">
          {p.refundedAmountMinor ? formatMoney(p.refundedAmountMinor, p.currency) : '—'}
        </span>
      ),
    },
    {
      key: 'at',
      header: 'Created',
      width: '150px',
      align: 'right',
      render: (p) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">{formatDateTime(p.createdAt)}</span>
      ),
    },
  ];

  const query = view === 'cdrs' ? cdrs : payments;

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 p-5">
      <PageHeader
        title="Billing"
        description="Charge detail records are immutable once issued. Corrections are new credit records, never edits."
        actions={<ServedByBadge servedBy={servedBy} />}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Revenue (this page)" value={formatMoney(totalRevenue, 'EUR')} />
        <StatTile label="Energy billed" value={formatEnergy(totalEnergy, { digits: 1 })} />
        <StatTile
          label="Currently held"
          value={formatMoney(held, 'EUR')}
          caption="Authorised but not yet captured"
        />
      </div>

      <SegmentedControl
        label="View"
        value={view}
        onChange={(v) => {
          setView(v);
          setPage(1);
        }}
        options={[
          { value: 'cdrs', label: 'Charge detail records' },
          { value: 'payments', label: 'Payments' },
        ]}
        className="self-start"
      />

      <Panel padded={false} className="flex min-h-0 flex-grow flex-col overflow-hidden">
        <QueryBoundary
          isLoading={query.isLoading}
          error={query.error}
          data={query.data}
          onRetry={() => void query.refetch()}
          skeleton={
            <DataTable
              columns={view === 'cdrs' ? cdrColumns : (paymentColumns as never)}
              rows={[]}
              rowKey={() => ''}
              loading
              skeletonRows={10}
            />
          }
        >
          {(data) => (
            <>
              {view === 'cdrs' ? (
                <DataTable
                  className="min-h-0 flex-grow"
                  columns={cdrColumns}
                  rows={data.data as Cdr[]}
                  rowKey={(c) => c.id}
                  empty={<EmptyState icon={<Receipt />} title="No records yet" />}
                />
              ) : (
                <DataTable
                  className="min-h-0 flex-grow"
                  columns={paymentColumns}
                  rows={data.data as Payment[]}
                  rowKey={(p) => p.id}
                  empty={<EmptyState icon={<Receipt />} title="No payments yet" />}
                />
              )}
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
