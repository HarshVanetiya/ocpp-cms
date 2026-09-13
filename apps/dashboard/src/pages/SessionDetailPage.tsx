import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Square } from 'lucide-react';
import type { TimeSeriesChartProps } from '@ocpp/ui';
import {
  useApiMutation,
  useApiQuery,
  useRealtimeEvent,
  useRealtimeTopics,
} from '@ocpp/api-client';
import {
  Button,
  ChartLegend,
  Divider,
  KeyValue,
  Panel,
  SectionTitle,
  SegmentedControl,
  StatTile,
  TimeSeriesChart,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPower,
  splitEnergy,
  useToast,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ProtocolBadge, SessionStatusBadge } from '../components/StatusBadges';

type Metric = 'powerKw' | 'energyWh' | 'soc';

const METRICS: Array<{ value: Metric; label: string; unit: string }> = [
  { value: 'powerKw', label: 'Power', unit: 'kW' },
  { value: 'energyWh', label: 'Energy', unit: 'kWh' },
  { value: 'soc', label: 'State of charge', unit: '%' },
];

export default function SessionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [metric, setMetric] = useState<Metric>('powerKw');

  const session = useApiQuery('getSession', { params: { id } });
  const meter = useApiQuery('getSessionMeterValues', {
    params: { id },
    query: { resolution: '1m' },
  });

  useRealtimeTopics([`session:${id}`]);
  useRealtimeEvent('session.updated', () => void session.refetch());

  const stop = useApiMutation('stopSession', {
    invalidates: ['getSession', 'listSessions'],
    onSuccess: () =>
      toast({
        tone: 'success',
        title: 'Stop requested',
        description: 'The session ends once the station confirms.',
      }),
    onError: (e) => toast({ tone: 'error', title: 'Could not stop', description: e.userMessage }),
  });

  const active = METRICS.find((m) => m.value === metric)!;

  const series: TimeSeriesChartProps['series'] = [
    {
      key: metric,
      label: active.label,
      color: 'var(--color-c1)',
      points:
        meter.data?.data.map((p) => ({
          t: p.timestamp,
          value:
            metric === 'energyWh'
              ? (p.energyWh ?? 0) / 1000
              : metric === 'soc'
                ? (p.soc ?? 0)
                : (p.powerKw ?? 0),
        })) ?? [],
    },
  ];

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <QueryBoundary
        isLoading={session.isLoading}
        error={session.error}
        data={session.data}
        onRetry={() => void session.refetch()}
      >
        {(s) => {
          const energy = splitEnergy(s.energyDeliveredWh);
          return (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/sessions')}
                    className="inline-flex w-fit items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink-1"
                  >
                    <ArrowLeft className="size-3.5" />
                    All sessions
                  </button>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h1 className="font-display text-[22px] font-semibold tracking-[-0.015em]">
                      Session {s.transactionId ?? s.id.slice(0, 8)}
                    </h1>
                    <SessionStatusBadge status={s.status} />
                    <ProtocolBadge protocol={s.protocol} />
                  </div>
                  <p className="text-[13px] text-ink-2">
                    <Link to={`/stations/${s.stationId}`} className="font-mono text-accent">
                      {s.stationIdentity}
                    </Link>{' '}
                    · EVSE {s.evseId} · connector {s.connectorId}
                    {s.locationName && ` · ${s.locationName}`}
                  </p>
                </div>

                {s.status === 'active' && (
                  <Button
                    variant="danger"
                    icon={<Square />}
                    loading={stop.isPending}
                    onClick={() => stop.mutate({ params: { id: s.id }, body: { reason: 'remote' } })}
                  >
                    Stop session
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatTile label="Energy delivered" value={energy.value} unit={energy.unit} />
                <StatTile label="Duration" value={formatDuration(s.durationSeconds)} />
                <StatTile
                  label="Power now"
                  value={s.currentPowerKw !== null ? formatPower(s.currentPowerKw) : '—'}
                  caption={s.currentSoc !== null ? `${s.currentSoc}% battery` : undefined}
                />
                <StatTile
                  label="Cost"
                  value={formatMoney(s.costMinor, s.currency)}
                  caption={s.tariffName ?? undefined}
                />
              </div>

              <Panel>
                <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
                  <SectionTitle>Meter values</SectionTitle>
                  <div className="flex items-center gap-3">
                    <ChartLegend series={series} />
                    <SegmentedControl
                      label="Metric"
                      size="sm"
                      value={metric}
                      onChange={setMetric}
                      options={METRICS.map((m) => ({ value: m.value, label: m.label }))}
                    />
                  </div>
                </div>
                <QueryBoundary
                  isLoading={meter.isLoading}
                  error={meter.error}
                  data={meter.data}
                  skeleton={<div className="h-[240px] rounded-sm shimmer" />}
                  onRetry={() => void meter.refetch()}
                >
                  {() => (
                    <TimeSeriesChart
                      series={series}
                      height={240}
                      unit={active.unit}
                      formatValue={(v) => formatNumber(v, v < 10 ? 1 : 0)}
                      emptyLabel="No meter samples recorded for this session"
                    />
                  )}
                </QueryBoundary>
              </Panel>

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel>
                  <SectionTitle className="mb-3.5">Session</SectionTitle>
                  <KeyValue
                    columns={2}
                    items={[
                      { label: 'Protocol transaction id', value: s.transactionId ?? 'not yet issued', mono: true },
                      { label: 'Internal id', value: s.id.slice(0, 18), mono: true },
                      { label: 'Started', value: formatDateTime(s.startedAt) },
                      { label: 'Ended', value: formatDateTime(s.endedAt) },
                      { label: 'Meter start', value: formatNumber(s.meterStartWh ?? 0) + ' Wh', mono: true },
                      { label: 'Meter stop', value: s.meterStopWh ? `${formatNumber(s.meterStopWh)} Wh` : '—', mono: true },
                      { label: 'Stop reason', value: s.stopReason ?? '—' },
                      { label: 'Token', value: s.idToken.value, mono: true },
                    ]}
                  />
                  <Divider className="my-4" />
                  <p className="text-[12px] leading-relaxed text-ink-3">
                    Energy delivered is <span className="font-mono">meterStop − meterStart</span>,
                    not <span className="font-mono">meterStop</span>. Both readings are lifetime
                    register values from the station&apos;s meter.
                  </p>
                </Panel>

                <Panel>
                  <SectionTitle className="mb-3.5">Cost breakdown</SectionTitle>
                  {s.costBreakdown.length === 0 ? (
                    <p className="text-[13px] text-ink-3">
                      Nothing priced yet. Cost appears once the session has energy and a tariff.
                    </p>
                  ) : (
                    <>
                      <table className="w-full text-left text-[12.5px]">
                        <thead>
                          <tr className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                            <th scope="col" className="pb-2 font-semibold">Component</th>
                            <th scope="col" className="pb-2 text-right font-semibold">Quantity</th>
                            <th scope="col" className="pb-2 text-right font-semibold">Unit price</th>
                            <th scope="col" className="pb-2 text-right font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.costBreakdown.map((b) => (
                            <tr key={b.label} className="border-t border-line-soft">
                              <td className="py-2 text-ink-1">{b.label}</td>
                              <td className="tabular py-2 text-right font-mono text-ink-2">
                                {b.quantity} {b.unit}
                              </td>
                              <td className="tabular py-2 text-right font-mono text-ink-3">
                                {formatMoney(b.unitPriceMinor, s.currency)}
                              </td>
                              <td className="tabular py-2 text-right font-mono text-ink-1">
                                {formatMoney(b.amountMinor, s.currency)}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t border-line">
                            <td className="py-2.5 font-semibold text-ink-1">Total</td>
                            <td />
                            <td />
                            <td className="tabular py-2.5 text-right font-mono font-semibold text-ink-1">
                              {formatMoney(s.costMinor, s.currency)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      {s.authorizedAmountMinor !== null && (
                        <p className="mt-3.5 rounded-sm border border-line-soft bg-surface-2 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
                          Prepaid session. {formatMoney(s.authorizedAmountMinor, s.currency)} was
                          held before charging;{' '}
                          {formatMoney(Math.min(s.costMinor, s.authorizedAmountMinor), s.currency)}{' '}
                          is captured and the remainder released.
                        </p>
                      )}
                    </>
                  )}
                </Panel>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </div>
  );
}
