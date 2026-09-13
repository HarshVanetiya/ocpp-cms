import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  Ban,
  Bell,
  Play,
  Power,
  RefreshCw,
  Settings2,
  Square,
  Unlock,
} from 'lucide-react';
import type { Command, CommandName } from '@ocpp/contracts';
import { COMMAND_LABEL } from '@ocpp/contracts';
import {
  useApiMutation,
  useApiQuery,
  useInvalidate,
  useRealtimeEvent,
  useRealtimeTopics,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  Divider,
  EmptyState,
  Input,
  KeyValue,
  Panel,
  SectionTitle,
  StatTile,
  Tooltip,
  cn,
  formatDateTime,
  formatDuration,
  formatEnergy,
  formatMoney,
  formatRelative,
  useNow,
  useToast,
  type Column,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ConnectorStatusBadge, ProtocolBadge, StationStatusBadge } from '../components/StatusBadges';

type Tab = 'connectors' | 'sessions' | 'configuration' | 'commands';

export default function StationDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const now = useNow(5000);
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('connectors');
  const [confirm, setConfirm] = useState<CommandName | null>(null);

  const station = useApiQuery('getStation', { params: { id } });
  const stats = useApiQuery('getStationStats', { params: { id } });

  // Live status for this station only — subscribing to the whole fleet here
  // would deliver hundreds of irrelevant events.
  useRealtimeTopics([`station:${id}`]);
  useRealtimeEvent('connector.status', () => invalidate('getStation'));

  const sendCommand = useApiMutation('sendCommand', {
    invalidates: ['listCommands', 'getStation'],
    onSuccess: (cmd) => {
      toast({
        tone: 'success',
        title: `${COMMAND_LABEL[cmd.command]} sent`,
        // The honest message: "Accepted" is not "done". The station has only
        // agreed to try; the real outcome arrives as a separate message.
        description: 'Station accepted the request. Waiting for the follow-up event.',
      });
    },
    onError: (err) => {
      toast({ tone: 'error', title: 'Command failed', description: err.userMessage });
    },
  });

  function run(command: CommandName, payload: Record<string, unknown> = {}) {
    sendCommand.mutate({ params: { id }, body: { command, payload } } as never);
    setConfirm(null);
  }

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <QueryBoundary
        isLoading={station.isLoading}
        error={station.error}
        data={station.data}
        onRetry={() => void station.refetch()}
      >
        {(s) => (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/stations')}
                  className="inline-flex w-fit items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink-1"
                >
                  <ArrowLeft className="size-3.5" />
                  All stations
                </button>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-display font-mono text-[22px] font-semibold tracking-[-0.015em]">
                    {s.identity}
                  </h1>
                  <StationStatusBadge status={s.status} />
                  <ProtocolBadge protocol={s.protocol} />
                </div>
                <p className="text-[13px] text-ink-2">
                  {s.vendor} {s.model} · firmware {s.firmwareVersion ?? 'unknown'}
                  {s.serialNumber && ` · serial ${s.serialNumber}`}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Tooltip content="Ask the station to re-send its status right now">
                  <Button
                    icon={<Bell />}
                    loading={sendCommand.isPending}
                    onClick={() =>
                      run('trigger_message', { requestedMessage: 'StatusNotification' })
                    }
                  >
                    Refresh status
                  </Button>
                </Tooltip>
                <Button icon={<Settings2 />} onClick={() => setTab('configuration')}>
                  Configuration
                </Button>
                <Button
                  variant="danger"
                  icon={<Power />}
                  onClick={() => setConfirm('reset')}
                >
                  Reset
                </Button>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                label="Sessions · 30d"
                value={stats.data?.sessions30d ?? '—'}
                caption={`${stats.data?.sessionsTotal ?? 0} all time`}
              />
              <StatTile
                label="Energy · 30d"
                value={formatEnergy(stats.data?.energy30dWh ?? null, { digits: 1 })}
              />
              <StatTile
                label="Revenue · 30d"
                value={formatMoney(stats.data?.revenue30dMinor ?? null, stats.data?.currency)}
              />
              <StatTile
                label="Uptime · 30d"
                value={stats.data ? `${stats.data.uptimePercent30d}%` : '—'}
                caption={`${stats.data?.faultCount30d ?? 0} faults`}
              />
            </div>

            <Panel padded={false}>
              <div className="flex flex-wrap gap-x-8 gap-y-4 p-5">
                <KeyValue
                  items={[
                    { label: 'Site', value: s.locationId ? <Link className="text-accent" to="/map">{s.name}</Link> : s.name },
                    { label: 'Last heartbeat', value: formatRelative(s.lastHeartbeatAt, now), mono: true },
                    { label: 'Heartbeat interval', value: `${s.heartbeatIntervalSeconds}s`, mono: true },
                    { label: 'Security profile', value: `Profile ${s.securityProfile}`, mono: true },
                    { label: 'Connected since', value: formatDateTime(s.connectedAt) },
                    { label: 'Last boot', value: formatDateTime(s.lastBootAt) },
                  ]}
                />
              </div>
              <Divider />
              <div className="flex gap-0.5 px-5 pt-2.5">
                {(
                  [
                    ['connectors', 'Connectors'],
                    ['sessions', 'Sessions'],
                    ['configuration', 'Configuration'],
                    ['commands', 'Commands'],
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
                {tab === 'connectors' && <ConnectorsTab station={s} onCommand={run} />}
                {tab === 'sessions' && <SessionsTab stationId={s.id} />}
                {tab === 'configuration' && <ConfigurationTab stationId={s.id} />}
                {tab === 'commands' && <CommandsTab stationId={s.id} />}
              </div>
            </Panel>

            <Dialog
              open={confirm === 'reset'}
              onOpenChange={(o) => setConfirm(o ? 'reset' : null)}
              title="Reset this station?"
              description={
                hasActiveSession(s)
                  ? 'A session is running on this station. An immediate reset will end it and you may not get a clean StopTransaction.'
                  : 'The station will reboot and reconnect. This normally takes under a minute.'
              }
              footer={
                <>
                  <Button onClick={() => setConfirm(null)}>Cancel</Button>
                  <Button
                    variant="secondary"
                    onClick={() => run('reset', { type: 'on_idle' })}
                  >
                    Reset when idle
                  </Button>
                  <Button
                    variant="dangerSolid"
                    onClick={() => run('reset', { type: 'immediate' })}
                  >
                    Reset now
                  </Button>
                </>
              }
            >
              <p className="text-[13px] leading-relaxed text-ink-2">
                <strong className="text-ink-1">Reset when idle</strong> waits for any running
                transaction to finish — it maps to <span className="font-mono">Soft</span> in OCPP
                1.6 and <span className="font-mono">OnIdle</span> in 2.0.1.{' '}
                <strong className="text-ink-1">Reset now</strong> is a hard power cycle.
              </p>
            </Dialog>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function hasActiveSession(station: { evses: Array<{ connectors: Array<{ activeSessionId: string | null }> }> }) {
  return station.evses.some((e) => e.connectors.some((c) => c.activeSessionId !== null));
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

function ConnectorsTab({
  station,
  onCommand,
}: {
  station: NonNullable<ReturnType<typeof useApiQuery<'getStation'>>['data']>;
  onCommand: (command: CommandName, payload?: Record<string, unknown>) => void;
}) {
  const [idToken, setIdToken] = useState('');

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {station.evses.map((evse) =>
        evse.connectors.map((c) => (
          <Panel key={c.id} tone="sunken">
            <div className="mb-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <SectionTitle className="text-[14.5px]">
                  EVSE {evse.evseId}
                  {evse.connectors.length > 1 && ` · connector ${c.connectorId}`}
                </SectionTitle>
                <span className="text-[11.5px] text-ink-3">
                  {c.powerType === 'dc' ? 'DC' : 'AC'} · {c.maxPowerKw} kW
                </span>
              </div>
              <ConnectorStatusBadge status={c.status} />
            </div>

            {c.errorCode && c.errorCode !== 'NoError' && (
              <p className="mb-3 rounded-xs border border-danger bg-danger-soft px-2.5 py-1.5 font-mono text-[11.5px] text-danger">
                {c.errorCode}
                {c.vendorErrorCode && ` · vendor ${c.vendorErrorCode}`}
              </p>
            )}

            <div className="mb-3.5 flex flex-wrap gap-2">
              {c.activeSessionId ? (
                <>
                  <Link to={`/sessions/${c.activeSessionId}`}>
                    <Button size="sm" variant="secondary">
                      View session
                    </Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Square />}
                    onClick={() => onCommand('remote_stop', { sessionId: c.activeSessionId })}
                  >
                    Stop charging
                  </Button>
                </>
              ) : (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <Input
                    className="w-[180px]"
                    mono
                    placeholder="idTag to bill"
                    value={idToken}
                    onChange={(e) => setIdToken(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Play />}
                    disabled={idToken.length === 0 || c.status !== 'available'}
                    onClick={() =>
                      onCommand('remote_start', {
                        evseId: evse.evseId,
                        connectorId: c.connectorId,
                        idToken,
                      })
                    }
                  >
                    Remote start
                  </Button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-line-soft pt-3">
              <Button
                size="sm"
                icon={<Unlock />}
                onClick={() =>
                  onCommand('unlock_connector', {
                    evseId: evse.evseId,
                    connectorId: c.connectorId,
                  })
                }
              >
                Unlock
              </Button>
              <Button
                size="sm"
                icon={<Ban />}
                onClick={() =>
                  onCommand('change_availability', {
                    operational: c.status === 'unavailable' ? 'operative' : 'inoperative',
                    evseId: evse.evseId,
                    connectorId: c.connectorId,
                  })
                }
              >
                {c.status === 'unavailable' ? 'Return to service' : 'Take out of service'}
              </Button>
            </div>
          </Panel>
        )),
      )}
    </div>
  );
}

function SessionsTab({ stationId }: { stationId: string }) {
  const now = useNow(10_000);
  const sessions = useApiQuery('listSessions', { query: { stationId, pageSize: 15 } });

  return (
    <QueryBoundary
      isLoading={sessions.isLoading}
      error={sessions.error}
      data={sessions.data}
      isEmpty={(d) => d.data.length === 0}
      empty={<EmptyState title="No sessions on this station yet" />}
      onRetry={() => void sessions.refetch()}
    >
      {(data) => (
        <ul className="flex flex-col">
          {data.data.map((s, i) => (
            <li
              key={s.id}
              className={cn(
                'flex flex-wrap items-center gap-3 py-2.5',
                i < data.data.length - 1 && 'border-b border-line-soft',
              )}
            >
              <Link
                to={`/sessions/${s.id}`}
                className="w-[140px] shrink-0 font-mono text-[12.5px] text-ink-1 hover:text-accent"
              >
                {s.transactionId ?? s.id.slice(0, 8)}
              </Link>
              <span className="w-[150px] shrink-0 truncate text-[12.5px] text-ink-2">
                {s.idToken.userName ?? s.idToken.value}
              </span>
              <span className="tabular w-[88px] shrink-0 text-right font-mono text-[12.5px] text-ink-1">
                {formatEnergy(s.energyDeliveredWh)}
              </span>
              <span className="tabular w-[76px] shrink-0 text-right font-mono text-[12.5px] text-ink-2">
                {formatDuration(s.durationSeconds)}
              </span>
              <span className="tabular w-[80px] shrink-0 text-right font-mono text-[12.5px] text-ink-1">
                {formatMoney(s.costMinor, s.currency)}
              </span>
              <span className="tabular ml-auto shrink-0 font-mono text-[11.5px] text-ink-3">
                {formatRelative(s.startedAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryBoundary>
  );
}

function ConfigurationTab({ stationId }: { stationId: string }) {
  const config = useApiQuery('getStationConfiguration', { params: { id: stationId } });

  return (
    <QueryBoundary
      isLoading={config.isLoading}
      error={config.error}
      data={config.data}
      onRetry={() => void config.refetch()}
    >
      {(data) => (
        <>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-ink-3">
            {data.protocol === 'ocpp1.6'
              ? 'OCPP 1.6 configuration keys — a flat list of strings, read with GetConfiguration.'
              : 'OCPP 2.0.1 device-model variables, read with GetVariables. Shown flattened as component.variable so one table serves both versions.'}
          </p>
          <div className="overflow-hidden rounded-sm border border-line-soft">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-surface-2">
                <tr className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                  <th scope="col" className="px-3.5 py-2 font-semibold">Key</th>
                  <th scope="col" className="px-3.5 py-2 font-semibold">Value</th>
                  <th scope="col" className="w-[92px] px-3.5 py-2 font-semibold">Access</th>
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.key} className="border-t border-line-soft">
                    <td className="px-3.5 py-2 font-mono text-ink-1">
                      {k.component ? (
                        <>
                          <span className="text-ink-3">{k.component}.</span>
                          {k.variable}
                        </>
                      ) : (
                        k.key
                      )}
                    </td>
                    <td className="px-3.5 py-2 font-mono text-ink-2">
                      <span className="line-clamp-2">{k.value ?? '—'}</span>
                    </td>
                    <td className="px-3.5 py-2">
                      <Badge tone={k.readonly ? 'neutral' : 'accent'}>
                        {k.readonly ? 'read only' : 'writable'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </QueryBoundary>
  );
}

function CommandsTab({ stationId }: { stationId: string }) {
  const now = useNow(5000);
  const commands = useApiQuery('listCommands', { params: { id: stationId }, query: { pageSize: 20 } });

  const columns: Array<Column<Command>> = [
    {
      key: 'command',
      header: 'Command',
      width: 'minmax(160px,1fr)',
      render: (c) => <span className="text-[12.5px] text-ink-1">{COMMAND_LABEL[c.command]}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (c) => (
        <Badge
          tone={
            c.status === 'succeeded'
              ? 'accent'
              : c.status === 'rejected' || c.status === 'failed' || c.status === 'timeout'
                ? 'danger'
                : c.status === 'accepted'
                  ? 'info'
                  : 'neutral'
          }
          dot={c.status === 'succeeded' ? 'solid' : 'hollow'}
        >
          {c.status}
        </Badge>
      ),
    },
    {
      key: 'by',
      header: 'By',
      width: '140px',
      render: (c) => <span className="text-[12.5px] text-ink-2">{c.requestedByName ?? 'System'}</span>,
    },
    {
      key: 'msg',
      header: 'Message id',
      width: '128px',
      render: (c) => <span className="font-mono text-[11.5px] text-ink-3">{c.ocppMessageId ?? '—'}</span>,
    },
    {
      key: 'at',
      header: 'Sent',
      width: '104px',
      align: 'right',
      render: (c) => (
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {formatRelative(c.createdAt, now)}
        </span>
      ),
    },
  ];

  return (
    <QueryBoundary
      isLoading={commands.isLoading}
      error={commands.error}
      data={commands.data}
      isEmpty={(d) => d.data.length === 0}
      empty={
        <EmptyState
          icon={<RefreshCw />}
          title="No commands issued yet"
          description="Remote starts, resets and configuration writes will be listed here with their outcome."
        />
      }
      onRetry={() => void commands.refetch()}
    >
      {(data) => (
        <DataTable columns={columns} rows={data.data} rowKey={(c) => c.id} dense />
      )}
    </QueryBoundary>
  );
}
