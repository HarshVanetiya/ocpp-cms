import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Cable, Clock, Square, Zap } from 'lucide-react';
import type { DriverSession } from '@ocpp/contracts';
import {
  useApiMutation,
  useApiQuery,
  useRealtimeEvent,
  useRealtimeTopics,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Meter,
  Panel,
  RingGauge,
  Sparkline,
  formatDuration,
  formatMoney,
  formatPower,
  splitEnergy,
  useToast,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

/**
 * The live charging screen.
 *
 * Two states, and the difference between them is the whole lesson:
 *
 *   PENDING — money is held, the station has accepted the remote start, but no
 *   transaction exists yet because nobody has plugged in. The app says so
 *   plainly and shows a deadline.
 *
 *   ACTIVE — a real transaction is running and meter values are arriving.
 *
 * An app that jumps straight to "charging" after payment is lying, and the
 * driver finds out when they walk back to a car with an empty battery.
 */
export default function ChargingPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const [powerHistory, setPowerHistory] = useState<number[]>([]);

  const active = useApiQuery('driverActiveSessions', undefined, {
    refetchInterval: 5000,
  });
  const single = useApiQuery(
    'driverSession',
    { params: { id: sessionId ?? '' } },
    { enabled: Boolean(sessionId), refetchInterval: 3000 },
  );

  const session: DriverSession | undefined = sessionId
    ? single.data
    : active.data?.data[0];

  useRealtimeTopics(session ? [`session:${session.id}`] : []);
  useRealtimeEvent('session.updated', () => {
    void (sessionId ? single.refetch() : active.refetch());
  });

  // A short rolling trace so the live screen has some texture. It is the
  // session's own reported power, not invented data.
  useEffect(() => {
    if (session?.currentPowerKw == null) return;
    setPowerHistory((prev) => [...prev, session.currentPowerKw!].slice(-40));
  }, [session?.currentPowerKw]);

  const stop = useApiMutation('driverStopSession', {
    invalidates: ['driverActiveSessions', 'driverSessionHistory'],
    onSuccess: (s) => {
      setConfirmStop(false);
      toast({ tone: 'success', title: 'Charging stopped' });
      navigate(`/receipt/${s.id}`);
    },
    onError: (e) => toast({ tone: 'error', title: 'Could not stop', description: e.userMessage }),
  });

  const loading = sessionId ? single.isLoading : active.isLoading;
  const error = sessionId ? single.error : active.error;

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <QueryBoundary
        isLoading={loading}
        error={error}
        data={session === undefined && !loading ? null : session}
        onRetry={() => void (sessionId ? single.refetch() : active.refetch())}
      >
        {(s) =>
          s === null ? (
            <div className="grid flex-grow place-items-center p-4">
              <EmptyState
                icon={<Cable />}
                title="Not charging"
                description="Find a charger and start a session — it will appear here."
                action={
                  <Link to="/">
                    <Button variant="primary" icon={<Zap />}>
                      Find a charger
                    </Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <>
              <header className="flex shrink-0 items-start gap-3 px-4 pb-2 pt-5">
                <div className="min-w-0 flex-grow">
                  <h1 className="truncate font-display text-[17px] font-semibold tracking-[-0.015em]">
                    {s.locationName}
                  </h1>
                  <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{s.connectorLabel}</p>
                </div>
                <Badge
                  tone={s.status === 'active' ? 'accent' : s.status === 'pending' ? 'info' : 'neutral'}
                  dot={s.status === 'active' ? 'pulse' : 'hollow'}
                >
                  {s.status}
                </Badge>
              </header>

              <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-4 pb-4">
                {s.status === 'pending' ? <WaitingState /> : <LiveState session={s} history={powerHistory} />}

                <Panel>
                  <div className="mb-2.5 flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] text-ink-2">Spent so far</span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="tabular font-display text-[21px] font-semibold tracking-[-0.025em]">
                        {formatMoney(s.costMinor, s.currency)}
                      </span>
                      <span className="text-[12.5px] text-ink-3">
                        of {formatMoney(s.authorizedAmountMinor, s.currency)}
                      </span>
                    </span>
                  </div>
                  <Meter
                    label="Budget used"
                    value={s.budgetUsedPercent}
                    tone={s.budgetUsedPercent > 90 ? 'warn' : 'accent'}
                  />
                  <div className="mt-2.5 flex items-center justify-between text-[11.5px]">
                    <span className="text-ink-3">
                      Only what you use is charged; the rest is released.
                    </span>
                    {s.estimatedKwhRemaining !== null && (
                      <span className="shrink-0 text-ink-2">
                        ~{s.estimatedKwhRemaining} kWh left
                      </span>
                    )}
                  </div>
                </Panel>

                <div className="grid grid-cols-3 gap-2.5">
                  <Stat label="Time" value={formatDuration(s.durationSeconds)} />
                  <Stat
                    label="Power"
                    value={s.currentPowerKw !== null ? formatPower(s.currentPowerKw) : '—'}
                  />
                  <Stat
                    label="Battery"
                    value={s.currentSoc !== null ? `${s.currentSoc}%` : '—'}
                  />
                </div>
              </div>

              <div className="safe-bottom shrink-0 border-t border-line-soft bg-surface-1 px-4 pt-3.5">
                <Button
                  variant="danger"
                  size="lg"
                  fullWidth
                  icon={<Square />}
                  disabled={!s.canStop}
                  onClick={() => setConfirmStop(true)}
                >
                  {s.status === 'pending' ? 'Waiting for you to plug in' : 'Stop charging'}
                </Button>
                <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-3">
                  {s.statusMessage}
                </p>
              </div>

              <Dialog
                open={confirmStop}
                onOpenChange={setConfirmStop}
                size="sm"
                title="Stop charging?"
                description={`You will be charged ${formatMoney(s.costMinor, s.currency)} and the rest of your hold is released.`}
                footer={
                  <>
                    <Button onClick={() => setConfirmStop(false)}>Keep charging</Button>
                    <Button
                      variant="dangerSolid"
                      loading={stop.isPending}
                      onClick={() => stop.mutate({ params: { id: s.id } })}
                    >
                      Stop
                    </Button>
                  </>
                }
              />
            </>
          )
        }
      </QueryBoundary>
    </div>
  );
}

function WaitingState() {
  return (
    <Panel className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="grid size-14 place-items-center rounded-full border-2 border-dashed border-info text-info">
        <Cable className="size-6" />
      </span>
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.015em]">
          Plug in your cable
        </h2>
        <p className="mx-auto mt-1.5 max-w-[280px] text-[13px] leading-relaxed text-ink-3">
          Your payment is held and the charger is ready. Charging starts the moment the station
          sees your car.
        </p>
      </div>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[11.5px] text-ink-2">
        <Clock className="size-3.5" />
        Hold released automatically if you do not plug in
      </span>
    </Panel>
  );
}

function LiveState({ session, history }: { session: DriverSession; history: number[] }) {
  const energy = splitEnergy(session.energyDeliveredWh);

  return (
    <>
      <div className="flex justify-center py-1">
        <RingGauge
          percent={session.budgetUsedPercent}
          size={244}
          label="Budget used"
          tone={session.budgetUsedPercent > 90 ? 'warn' : 'accent'}
        >
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-accent">
            <Zap className="size-3" strokeWidth={2.4} />
            CHARGING
          </span>
          <span className="tabular font-display text-[50px] font-semibold leading-none tracking-[-0.04em]">
            {energy.value}
          </span>
          <span className="text-[13px] text-ink-2">{energy.unit} delivered</span>
          <span className="mt-1.5 rounded-full border border-line-soft bg-surface-2 px-3 py-1">
            <span className="tabular font-mono text-xs text-ink-2">
              {session.currentPowerKw !== null ? formatPower(session.currentPowerKw) : '—'}
              {session.currentSoc !== null && ` · ${session.currentSoc}% battery`}
            </span>
          </span>
        </RingGauge>
      </div>

      {history.length > 3 && (
        <Panel>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12.5px] text-ink-2">Power this session</span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent">
              <span className="size-1.5 rounded-full bg-current pulse-dot" />
              live
            </span>
          </div>
          <Sparkline values={history} width={460} height={58} filled className="w-full" />
        </Panel>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Panel className="flex flex-col gap-1 px-3 py-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        {label}
      </span>
      <span className="tabular font-display text-[18px] font-semibold tracking-[-0.02em]">
        {value}
      </span>
    </Panel>
  );
}
