import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Cable,
  CreditCard,
  Plug,
  PlugZap,
  Power,
  RotateCcw,
  Square,
  Unplug,
} from 'lucide-react';
import type { SimAction, SimStation } from '@ocpp/contracts';
import { CONNECTOR_STATUS_LABEL, CONNECTOR_TYPE_LABEL } from '@ocpp/contracts';
import {
  getSimRealtimeClient,
  useApiMutation,
  useApiQuery,
  useInvalidate,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  EmptyState,
  KeyValue,
  Panel,
  SearchInput,
  SectionTitle,
  StatusDot,
  Switch,
  Tooltip,
  cn,
  formatClock,
  formatNumber,
  useDebounced,
  useToast,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { WireLogPane } from '../components/WireLogPane';

/**
 * The simulator's main screen.
 *
 * Three panes: the fleet, the selected station's controls, and the wire log.
 * The point of the middle pane is that the buttons are PHYSICAL EVENTS —
 * "plug in the cable", "swipe the card" — not OCPP messages. The messages are
 * a consequence, and watching that causal chain in the log beside it is the
 * fastest way to internalise the protocol.
 */
export default function FleetPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const invalidate = useInvalidate();

  const stations = useApiQuery('listSimStations', { query: { pageSize: 100 } });

  // The simulator's realtime channel pushes station state on every change, so
  // the fleet list never goes stale while you are clicking around.
  useEffect(() => {
    const client = getSimRealtimeClient();
    return client.onSim('sim.station', () => invalidate('listSimStations', 'getSimStation'));
  }, [invalidate]);

  const rows = useMemo(() => {
    const all = stations.data?.data ?? [];
    if (!q) return all;
    const needle = q.toLowerCase();
    return all.filter((s) => s.identity.toLowerCase().includes(needle));
  }, [stations.data, q]);

  const selected = rows.find((s) => s.id === selectedId) ?? rows[0] ?? null;

  return (
    <div className="flex min-h-0 flex-grow">
      {/* ------------------------- fleet list ------------------------- */}
      <aside className="flex w-[272px] shrink-0 flex-col border-r border-line-soft bg-surface-1 max-lg:hidden">
        <div className="shrink-0 border-b border-line-soft p-3.5">
          <SearchInput
            placeholder="Filter fleet"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex min-h-0 flex-grow flex-col gap-1.5 overflow-y-auto p-2">
          <QueryBoundary
            isLoading={stations.isLoading}
            error={stations.error}
            data={stations.data}
            onRetry={() => void stations.refetch()}
          >
            {() =>
              rows.length === 0 ? (
                <EmptyState title="No stations" description="Add one to get started." />
              ) : (
                rows.map((s) => (
                  <FleetCard
                    key={s.id}
                    station={s}
                    selected={selected?.id === s.id}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))
              )
            }
          </QueryBoundary>
        </div>
      </aside>

      {/* ----------------------- control panel ------------------------ */}
      <main className="flex min-w-0 flex-grow flex-col gap-3 overflow-y-auto p-4">
        {selected ? (
          <StationControls station={selected} />
        ) : (
          <Panel className="grid flex-grow place-items-center">
            <EmptyState
              icon={<PlugZap />}
              title="No station selected"
              description="Create a virtual charge point and connect it to your CSMS."
            />
          </Panel>
        )}
      </main>

      {/* -------------------------- wire log -------------------------- */}
      <aside className="flex w-[388px] shrink-0 flex-col border-l border-line-soft bg-surface-1 max-xl:hidden">
        <WireLogPane stationId={selected?.id ?? null} title="Wire log" />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fleet card
 * ------------------------------------------------------------------ */

function connectorColor(status: string) {
  switch (status) {
    case 'charging':
      return 'var(--color-c2)';
    case 'available':
      return 'var(--color-c1)';
    case 'faulted':
      return 'var(--color-c4)';
    case 'preparing':
    case 'finishing':
      return 'var(--color-c5)';
    default:
      return 'var(--color-ink-3)';
  }
}

function FleetCard({
  station,
  selected,
  onSelect,
}: {
  station: SimStation;
  selected: boolean;
  onSelect: () => void;
}) {
  const connected = station.connectionState === 'connected';
  const faulted = station.connectors.some((c) => c.status === 'faulted');

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border p-3 text-left transition-colors',
        selected
          ? 'border-info bg-surface-3 elev-2'
          : 'border-line-soft bg-surface-2 hover:border-line',
        !connected && 'opacity-60',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <StatusDot
          tone={faulted ? 'danger' : connected ? 'accent' : 'neutral'}
          filled={connected}
          label={station.connectionState}
        />
        <span className="min-w-0 flex-grow truncate font-mono text-xs font-medium text-ink-1">
          {station.identity}
        </span>
        <span
          className="rounded-[4px] px-1.5 font-mono text-[9.5px] font-semibold"
          style={{
            background: station.protocol === 'ocpp1.6' ? 'var(--color-accent-soft)' : 'var(--color-info-soft)',
            color: station.protocol === 'ocpp1.6' ? 'var(--color-accent)' : 'var(--color-info)',
          }}
        >
          {station.protocol === 'ocpp1.6' ? '1.6J' : '2.0.1'}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        {station.connectors.map((c) => (
          <span
            key={`${c.evseId}-${c.connectorId}`}
            title={CONNECTOR_STATUS_LABEL[c.status]}
            className="h-1 flex-grow rounded-full"
            style={{ background: connectorColor(c.status) }}
          />
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span
          className={cn('text-[10.5px]', faulted ? 'text-danger' : 'text-ink-3')}
        >
          {faulted
            ? 'Faulted · injected'
            : connected
              ? `${station.connectors.length} EVSE · ${station.connectors[0]?.maxPowerKw ?? 0} kW ${station.connectors[0]?.powerType === 'dc' ? 'DC' : 'AC'}`
              : 'Disconnected'}
        </span>
        <span className="tabular font-mono text-[10.5px] text-ink-3">
          {formatNumber(station.messagesSent)} msg
        </span>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function StationControls({ station }: { station: SimStation }) {
  const { toast } = useToast();
  const invalidate = useInvalidate();

  const act = useApiMutation('simAction', {
    invalidates: ['listSimStations', 'getSimStation', 'simFrames', 'simHealth'],
    onSuccess: (res) => {
      if (res.message) toast({ tone: 'info', title: res.message });
    },
    onError: (e) => toast({ tone: 'error', title: 'Action failed', description: e.userMessage }),
  });

  const update = useApiMutation('updateSimStation', {
    invalidates: ['listSimStations', 'getSimStation'],
  });

  const run = useCallback(
    (action: SimAction, evseId?: number) => {
      act.mutate({ params: { id: station.id }, body: { action, evseId } });
    },
    [act, station.id],
  );

  const setFault = (key: keyof SimStation['faults'], value: boolean | number) => {
    update.mutate({
      params: { id: station.id },
      body: { faults: { [key]: value } as never },
    });
    invalidate('listSimStations');
  };

  const connected = station.connectionState === 'connected';
  const uptime = station.connectedAt
    ? Math.floor((Date.now() - new Date(station.connectedAt).getTime()) / 1000)
    : 0;

  return (
    <>
      {/* -------------------------- header -------------------------- */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
              <h1 className="font-display font-mono text-[19px] font-semibold tracking-[-0.01em]">
                {station.identity}
              </h1>
              <Badge
                tone={connected ? 'accent' : station.connectionState === 'error' ? 'danger' : 'neutral'}
                dot={connected ? 'solid' : 'hollow'}
              >
                {station.connectionState}
              </Badge>
            </div>
            <p className="text-[12.5px] text-ink-2">
              {station.vendor} {station.model} · firmware {station.firmwareVersion} · serial{' '}
              {station.serialNumber}
            </p>
            {station.lastError && (
              <p className="mt-2 rounded-xs border border-warn bg-warn-soft px-2.5 py-1.5 text-[11.5px] text-warn">
                {station.lastError}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button icon={<RotateCcw />} onClick={() => run('reboot')} disabled={!connected}>
              Reboot
            </Button>
            {connected ? (
              <Button variant="danger" icon={<Power />} onClick={() => run('disconnect')}>
                Disconnect
              </Button>
            ) : (
              <Button variant="primary" icon={<Plug />} onClick={() => run('connect')}>
                Connect
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3.5 border-t border-line-soft pt-3.5">
          <KeyValue
            items={[
              { label: 'Uptime', value: connected ? formatClock(uptime) : '—', mono: true },
              { label: 'Heartbeat', value: `${station.heartbeatIntervalSeconds}s`, mono: true },
              { label: 'Meter sample', value: `${station.meterValueIntervalSeconds}s`, mono: true },
              {
                label: 'Sent / received',
                value: `${station.messagesSent} / ${station.messagesReceived}`,
                mono: true,
              },
              { label: 'ID token', value: station.defaultIdToken, mono: true },
            ]}
          />
        </div>
      </Panel>

      {/* --------------------------- EVSEs -------------------------- */}
      <div className="grid gap-3 xl:grid-cols-2">
        {station.connectors.map((c) => {
          const charging = c.status === 'charging';
          const plugged = c.cablePluggedIn;
          return (
            <Panel
              key={`${c.evseId}-${c.connectorId}`}
              className={cn(charging && 'border-accent')}
            >
              <div className="mb-3.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <SectionTitle className="text-[14.5px]">EVSE {c.evseId}</SectionTitle>
                  <span className="text-[11.5px] text-ink-3">
                    {CONNECTOR_TYPE_LABEL[c.type]} · {c.maxPowerKw} kW
                  </span>
                </div>
                <Badge
                  tone={
                    charging
                      ? 'accent'
                      : c.status === 'faulted'
                        ? 'danger'
                        : c.status === 'preparing'
                          ? 'info'
                          : 'neutral'
                  }
                  dot={charging ? 'solid' : 'hollow'}
                  className={cn(charging && 'bg-accent text-accent-ink font-semibold')}
                >
                  {CONNECTOR_STATUS_LABEL[c.status]}
                </Badge>
              </div>

              <div className="mb-3.5 grid grid-cols-3 gap-3 rounded-sm border border-line-soft bg-surface-2 px-3.5 py-3">
                <Metric label="Power" value={c.powerKw.toFixed(1)} unit="kW" />
                <Metric
                  label="Cable"
                  value={plugged ? 'Plugged' : 'Free'}
                  tone={plugged ? 'info' : undefined}
                />
                {/*
                  The station's LIFETIME meter register, in Wh — not the energy
                  delivered this session. Session energy is meterStop minus
                  meterStart, which only the CSMS can compute. Labelling this
                  "delivered" would teach exactly the wrong thing.
                */}
                <Metric label="Meter (Wh)" value={formatNumber(c.meterWh)} mono />
              </div>

              <div className="flex flex-wrap gap-2">
                {charging ? (
                  <>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Square />}
                      onClick={() => run('stop_charging', c.evseId)}
                    >
                      Stop charging
                    </Button>
                    <Button size="sm" onClick={() => run('suspend_ev', c.evseId)}>
                      Car pauses
                    </Button>
                  </>
                ) : plugged ? (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<CreditCard />}
                    disabled={!connected}
                    onClick={() => run('start_charging', c.evseId)}
                  >
                    Swipe &amp; start
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    icon={<Cable />}
                    disabled={!connected}
                    onClick={() => run('plug_in', c.evseId)}
                  >
                    Plug in cable
                  </Button>
                )}

                {plugged && (
                  <Button size="sm" icon={<Unplug />} onClick={() => run('plug_out', c.evseId)}>
                    Unplug
                  </Button>
                )}

                {c.status === 'faulted' ? (
                  <Button size="sm" onClick={() => run('clear_fault', c.evseId)}>
                    Clear fault
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!connected}
                    onClick={() => run('trigger_fault', c.evseId)}
                  >
                    Trigger fault
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!connected}
                  onClick={() => run('send_meter_values', c.evseId)}
                >
                  MeterValues
                </Button>
              </div>
            </Panel>
          );
        })}
      </div>

      {/* ---------------------- fault injection --------------------- */}
      <Panel>
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          <AlertTriangle className="size-4 shrink-0 text-warn" />
          <SectionTitle className="whitespace-nowrap text-[14.5px]">Fault injection</SectionTitle>
          <span className="flex-grow text-xs text-ink-3">
            Break things on purpose — a CPMS that has only seen well-behaved stations is not
            finished.
          </span>
        </div>

        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          <Switch
            label="Drop connection"
            description="No close frame, like a real mobile outage"
            checked={station.faults.dropConnection}
            onCheckedChange={(v) => setFault('dropConnection', v)}
          />
          <Switch
            label="Ignore commands"
            description="Tests your pending-call timeout"
            tone="warn"
            checked={station.faults.ignoreRemoteCommands}
            onCheckedChange={(v) => setFault('ignoreRemoteCommands', v)}
          />
          <Switch
            label="Invalid payloads"
            description="Tests your schema validation"
            checked={station.faults.sendInvalidPayloads}
            onCheckedChange={(v) => setFault('sendInvalidPayloads', v)}
          />
          <Switch
            label="Reply CALLERROR"
            description="Tests your error propagation"
            checked={station.faults.respondWithErrors}
            onCheckedChange={(v) => setFault('respondWithErrors', v)}
          />
          <Switch
            label="Report Faulted"
            description="GroundFailure on next status change"
            checked={station.faults.reportFaulted}
            onCheckedChange={(v) => setFault('reportFaulted', v)}
          />
          <div className="flex flex-col gap-2 rounded-sm border border-line-soft bg-surface-2 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[12.5px] font-medium text-ink-1">Response delay</span>
              <span className="tabular font-mono text-[11.5px] text-ink-2">
                {station.faults.responseDelayMs} ms
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={5000}
              step={50}
              aria-label="Response delay in milliseconds"
              value={station.faults.responseDelayMs}
              onChange={(e) => setFault('responseDelayMs', Number(e.target.value))}
              className="accent-[var(--color-info)]"
            />
            <span className="text-[10.5px] text-ink-3">
              Tests whether your UI has real loading states.
            </span>
          </div>
        </div>
      </Panel>

      {/* ----------------------- raw messages ----------------------- */}
      <Panel>
        <SectionTitle className="mb-1 text-[14.5px]">Send a single message</SectionTitle>
        <p className="mb-3.5 text-xs text-ink-3">
          For poking one specific message at your CSMS without the physical event around it.
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['send_boot_notification', 'BootNotification'],
              ['send_heartbeat', 'Heartbeat'],
              ['send_status_notification', 'StatusNotification'],
              ['send_authorize', 'Authorize'],
              ['send_meter_values', 'MeterValues'],
              ['send_data_transfer', 'DataTransfer'],
              ['send_diagnostics_status', 'DiagnosticsStatus'],
              ['send_firmware_status', 'FirmwareStatus'],
              ['send_security_event', 'SecurityEvent'],
            ] as Array<[SimAction, string]>
          ).map(([action, label]) => (
            <Tooltip key={action} content={`Send ${label} now`}>
              <Button size="sm" variant="ghost" disabled={!connected} onClick={() => run(action)}>
                {label}
              </Button>
            </Tooltip>
          ))}
        </div>
      </Panel>
    </>
  );
}

function Metric({
  label,
  value,
  unit,
  mono,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  mono?: boolean;
  tone?: 'info';
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] text-ink-3">{label}</span>
      <span
        className={cn(
          'tabular font-semibold tracking-[-0.02em]',
          mono ? 'font-mono text-sm' : 'font-display text-[17px]',
          tone === 'info' && 'text-info',
        )}
      >
        {value}
        {unit && <span className="ml-0.5 text-[11px] font-medium text-ink-3">{unit}</span>}
      </span>
    </div>
  );
}
