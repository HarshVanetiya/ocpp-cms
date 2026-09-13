import { useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import type { OcpiParty } from '@ocpp/contracts';
import { useApiMutation, useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  KeyValue,
  PageHeader,
  Panel,
  SectionTitle,
  SegmentedControl,
  StatusDot,
  Tooltip,
  cn,
  formatEnergy,
  formatMoney,
  formatRelative,
  useNow,
  useToast,
  type Column,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';

const STATUS_TONE = {
  connected: 'accent',
  registering: 'info',
  error: 'danger',
  not_registered: 'neutral',
  suspended: 'warn',
} as const;

export default function OcpiPage() {
  const now = useNow(30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'traffic' | 'tokens' | 'cdrs'>('traffic');
  const { toast } = useToast();

  const parties = useApiQuery('listOcpiParties', { query: { pageSize: 50 } });
  const servedBy = useServedBy(['listOcpiParties']);

  const selected = parties.data?.data.find((p) => p.id === selectedId) ?? parties.data?.data[0] ?? null;

  const sync = useApiMutation('syncOcpiParty', {
    invalidates: ['listOcpiParties'],
    onSuccess: () => toast({ tone: 'success', title: 'Sync started' }),
    onError: (e) => toast({ tone: 'error', title: 'Sync failed', description: e.userMessage }),
  });

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <PageHeader
        title="OCPI roaming"
        description="Partners your network exchanges locations, tokens and billing records with."
        actions={<ServedByBadge servedBy={servedBy} />}
      />

      <QueryBoundary
        isLoading={parties.isLoading}
        error={parties.error}
        data={parties.data}
        isEmpty={(d) => d.data.length === 0}
        empty={
          <Panel>
            <EmptyState
              icon={<Globe />}
              title="No roaming partners"
              description="OCPI is how your chargers become usable by other networks' customers, and theirs by yours."
            />
          </Panel>
        }
        onRetry={() => void parties.refetch()}
      >
        {(data) => (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <Panel padded={false} className="h-fit overflow-hidden">
              <ul>
                {data.data.map((p, i) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors',
                        i < data.data.length - 1 && 'border-b border-line-soft',
                        selected?.id === p.id
                          ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]'
                          : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <StatusDot
                          tone={STATUS_TONE[p.status]}
                          filled={p.status === 'connected'}
                          label={p.status}
                        />
                        <span className="truncate text-[13px] font-medium text-ink-1">{p.name}</span>
                      </span>
                      <span className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
                        {p.countryCode}-{p.partyId} · {p.role}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            {selected && (
              <div className="flex flex-col gap-4">
                <PartyOverview
                  party={selected}
                  now={now}
                  syncing={sync.isPending}
                  onSync={() =>
                    sync.mutate({
                      params: { id: selected.id },
                      body: { modules: ['locations', 'cdrs', 'tokens'], full: false },
                    })
                  }
                />

                <Panel padded={false}>
                  <div className="flex gap-0.5 px-5 pt-2.5">
                    {(
                      [
                        ['traffic', 'HTTP traffic'],
                        ['tokens', 'Partner tokens'],
                        ['cdrs', 'Pushed CDRs'],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTab(key)}
                        className={cn(
                          'rounded-t-xs px-3.5 py-2 text-[13px] transition-colors',
                          tab === key
                            ? 'border border-b-0 border-line-soft bg-surface-2 font-semibold text-ink-1'
                            : 'font-medium text-ink-3 hover:text-ink-1',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-line-soft p-5">
                    {tab === 'traffic' && <TrafficTab partyId={selected.id} now={now} />}
                    {tab === 'tokens' && <TokensTab />}
                    {tab === 'cdrs' && <CdrsTab now={now} />}
                  </div>
                </Panel>
              </div>
            )}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function PartyOverview({
  party,
  now,
  syncing,
  onSync,
}: {
  party: OcpiParty;
  now: number;
  syncing: boolean;
  onSync: () => void;
}) {
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2.5">
            <SectionTitle>{party.name}</SectionTitle>
            <Badge tone={STATUS_TONE[party.status]} dot={party.status === 'connected' ? 'solid' : 'hollow'}>
              {party.status.replace('_', ' ')}
            </Badge>
            <Badge mono>{party.role}</Badge>
          </div>
          <p className="font-mono text-[12px] text-ink-3">{party.versionsUrl}</p>
        </div>
        <Button icon={<RefreshCw />} loading={syncing} onClick={onSync}>
          Sync now
        </Button>
      </div>

      {party.lastError && (
        <p className="mb-4 rounded-sm border border-danger bg-danger-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
          {party.lastError}
        </p>
      )}

      <KeyValue
        columns={4}
        items={[
          { label: 'Version', value: party.selectedVersion ?? '—', mono: true },
          { label: 'Last handshake', value: formatRelative(party.lastHandshakeAt, now) },
          { label: 'Last sync', value: formatRelative(party.lastSyncAt, now) },
          { label: 'Modules', value: String(party.modules.length) },
          { label: 'Locations pushed', value: String(party.locationsPushed), mono: true },
          { label: 'CDRs pushed', value: String(party.cdrsPushed), mono: true },
          { label: 'Tokens received', value: String(party.tokensReceived), mono: true },
          { label: 'Commands received', value: String(party.commandsReceived), mono: true },
        ]}
      />

      {/*
        The two tokens, shown side by side with their direction spelled out.
        This is the single most confusing part of OCPI and the reason people
        get the handshake wrong, so the UI states it rather than implying it.
      */}
      <div className="mt-4 grid gap-3 border-t border-line-soft pt-4 sm:grid-cols-2">
        <Tooltip content="They send this to us on every request they make. Rotate it by re-running the credentials handshake.">
          <div className="cursor-help rounded-sm border border-line-soft bg-surface-2 p-3">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              Token they use → us
            </span>
            <span className="font-mono text-[12.5px] text-ink-1">
              {party.tokenForUsPreview ?? 'not issued yet'}
            </span>
          </div>
        </Tooltip>
        <Tooltip content="We send this to them on every request we make. They issued it during the handshake.">
          <div className="cursor-help rounded-sm border border-line-soft bg-surface-2 p-3">
            <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              Token we use → them
            </span>
            <span className="font-mono text-[12.5px] text-ink-1">
              {party.tokenForThemPreview ?? 'not received yet'}
            </span>
          </div>
        </Tooltip>
      </div>
    </Panel>
  );
}

function TrafficTab({ partyId, now }: { partyId: string; now: number }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const logs = useApiQuery('ocpiLog', {
    query: { partyId, pageSize: 25, failedOnly: failedOnly || undefined },
  });

  return (
    <>
      <SegmentedControl
        className="mb-3.5"
        label="Filter"
        size="sm"
        value={failedOnly ? 'failed' : 'all'}
        onChange={(v) => setFailedOnly(v === 'failed')}
        options={[
          { value: 'all', label: 'All requests' },
          { value: 'failed', label: 'Failures only' },
        ]}
      />
      <QueryBoundary
        isLoading={logs.isLoading}
        error={logs.error}
        data={logs.data}
        isEmpty={(d) => d.data.length === 0}
        empty={<EmptyState title="No traffic recorded" />}
        onRetry={() => void logs.refetch()}
      >
        {(data) => (
          <ul className="flex flex-col">
            {data.data.map((l, i) => {
              const failed = (l.statusCode ?? 200) >= 400;
              return (
                <li
                  key={l.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 py-2.5',
                    i < data.data.length - 1 && 'border-b border-line-soft',
                  )}
                >
                  <Badge tone={l.direction === 'outgoing' ? 'info' : 'accent'} mono>
                    {l.direction === 'outgoing' ? '→ out' : '← in'}
                  </Badge>
                  <span className="w-[52px] shrink-0 font-mono text-[11.5px] font-semibold text-ink-2">
                    {l.method}
                  </span>
                  <span className="min-w-0 flex-grow truncate font-mono text-[12px] text-ink-1">
                    {l.url}
                  </span>
                  <span
                    className={cn(
                      'tabular w-[42px] shrink-0 text-right font-mono text-[12px]',
                      failed ? 'font-semibold text-danger' : 'text-ink-2',
                    )}
                  >
                    {l.statusCode ?? '—'}
                  </span>
                  <Tooltip content={`OCPI status ${l.ocpiStatusCode}: ${l.ocpiStatusMessage ?? ''}`}>
                    <span className="tabular w-[48px] shrink-0 cursor-help text-right font-mono text-[11px] text-ink-3">
                      {l.ocpiStatusCode ?? '—'}
                    </span>
                  </Tooltip>
                  <span className="tabular w-[60px] shrink-0 text-right font-mono text-[11px] text-ink-3">
                    {l.durationMs}ms
                  </span>
                  <span className="tabular w-[64px] shrink-0 text-right font-mono text-[11px] text-ink-3">
                    {formatRelative(l.timestamp, now)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </>
  );
}

function TokensTab() {
  const tokens = useApiQuery('listOcpiTokens', { query: { pageSize: 25 } });

  const columns: Array<Column<NonNullable<typeof tokens.data>['data'][number]>> = [
    { key: 'uid', header: 'UID', width: '140px', render: (t) => <span className="font-mono text-[12px] text-ink-1">{t.uid}</span> },
    { key: 'contract', header: 'eMAID', width: 'minmax(180px,1fr)', render: (t) => <span className="truncate font-mono text-[11.5px] text-ink-2">{t.contractId}</span> },
    { key: 'issuer', header: 'Issuer', width: 'minmax(120px,1fr)', render: (t) => <span className="truncate text-[12.5px] text-ink-2">{t.issuer}</span> },
    { key: 'type', header: 'Type', width: '104px', render: (t) => <Badge mono>{t.type}</Badge> },
    { key: 'whitelist', header: 'Whitelist', width: '134px', render: (t) => <Badge tone={t.whitelist === 'NEVER' ? 'danger' : 'neutral'} mono>{t.whitelist}</Badge> },
    { key: 'valid', header: 'Valid', width: '76px', render: (t) => <StatusDot tone={t.valid ? 'accent' : 'danger'} filled label={t.valid ? 'valid' : 'invalid'} /> },
  ];

  return (
    <QueryBoundary
      isLoading={tokens.isLoading}
      error={tokens.error}
      data={tokens.data}
      isEmpty={(d) => d.data.length === 0}
      empty={<EmptyState title="No partner tokens cached" description="An eMSP pushes their token list to you; you authorise against the cache." />}
      onRetry={() => void tokens.refetch()}
    >
      {(data) => <DataTable columns={columns} rows={data.data} rowKey={(t) => t.id} dense />}
    </QueryBoundary>
  );
}

function CdrsTab({ now }: { now: number }) {
  const cdrs = useApiQuery('listOcpiCdrs', { query: { pageSize: 25 } });

  const columns: Array<Column<NonNullable<typeof cdrs.data>['data'][number]>> = [
    { key: 'id', header: 'Reference', width: '124px', render: (c) => <span className="font-mono text-[12px] text-ink-1">{c.ocpiId}</span> },
    { key: 'party', header: 'Partner', width: 'minmax(140px,1fr)', render: (c) => <span className="truncate text-[12.5px] text-ink-2">{c.partyName}</span> },
    { key: 'energy', header: 'Energy', width: '92px', align: 'right', render: (c) => <span className="tabular font-mono text-[12.5px] text-ink-1">{formatEnergy(c.energyWh)}</span> },
    { key: 'cost', header: 'Cost', width: '88px', align: 'right', render: (c) => <span className="tabular font-mono text-[12.5px] text-ink-1">{formatMoney(c.totalCostMinor, c.currency)}</span> },
    {
      key: 'status',
      header: 'Delivery',
      width: '124px',
      render: (c) => (
        <Badge
          tone={c.status === 'acknowledged' ? 'accent' : c.status === 'failed' ? 'danger' : 'info'}
          dot="hollow"
        >
          {c.status}
        </Badge>
      ),
    },
    { key: 'attempts', header: 'Tries', width: '62px', align: 'right', render: (c) => <span className="tabular font-mono text-[12px] text-ink-3">{c.attempts}</span> },
    { key: 'at', header: 'Last try', width: '104px', align: 'right', render: (c) => <span className="tabular font-mono text-[11.5px] text-ink-3">{formatRelative(c.lastAttemptAt, now)}</span> },
  ];

  return (
    <QueryBoundary
      isLoading={cdrs.isLoading}
      error={cdrs.error}
      data={cdrs.data}
      isEmpty={(d) => d.data.length === 0}
      empty={<EmptyState title="No CDRs pushed yet" />}
      onRetry={() => void cdrs.refetch()}
    >
      {(data) => (
        <>
          <DataTable columns={columns} rows={data.data} rowKey={(c) => c.id} dense />
          <p className="mt-3.5 text-[12px] leading-relaxed text-ink-3">
            A failed push must be retried with backoff, not dropped — an unsent CDR is revenue you
            never collect. Note the attempt counter: that is your retry loop doing its job.
          </p>
        </>
      )}
    </QueryBoundary>
  );
}
