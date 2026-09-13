import { useState } from 'react';
import { Tag } from 'lucide-react';
import type { Tariff } from '@ocpp/contracts';
import { PRICE_COMPONENT_UNIT } from '@ocpp/contracts';
import { useApiMutation, useApiQuery, useServedBy } from '@ocpp/api-client';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Panel,
  SectionTitle,
  formatMoney,
  formatNumber,
  cn,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { ServedByBadge } from '../components/BackendIndicator';

export default function TariffsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tariffs = useApiQuery('listTariffs', { query: { pageSize: 50 } });
  const servedBy = useServedBy(['listTariffs']);

  const selected =
    tariffs.data?.data.find((t) => t.id === selectedId) ?? tariffs.data?.data[0] ?? null;

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <PageHeader
        title="Tariffs"
        description="Elements are evaluated top to bottom and the first match wins — so order matters."
        actions={<ServedByBadge servedBy={servedBy} />}
      />

      <QueryBoundary
        isLoading={tariffs.isLoading}
        error={tariffs.error}
        data={tariffs.data}
        isEmpty={(d) => d.data.length === 0}
        empty={<Panel><EmptyState icon={<Tag />} title="No tariffs yet" /></Panel>}
        onRetry={() => void tariffs.refetch()}
      >
        {(data) => (
          <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
            <Panel padded={false} className="h-fit overflow-hidden">
              <ul>
                {data.data.map((t, i) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors',
                        i < data.data.length - 1 && 'border-b border-line-soft',
                        selected?.id === t.id
                          ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]'
                          : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-ink-1">{t.name}</span>
                        {!t.active && <Badge tone="neutral">inactive</Badge>}
                      </span>
                      <span className="flex items-center gap-2 text-[11.5px] text-ink-3">
                        <Badge tone={t.kind === 'free' ? 'violet' : 'neutral'}>{t.kind.replace('_', ' ')}</Badge>
                        {t.stationCount} {t.stationCount === 1 ? 'station' : 'stations'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            {selected ? <TariffDetail tariff={selected} /> : null}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function TariffDetail({ tariff }: { tariff: Tariff }) {
  const [kwh, setKwh] = useState('22');
  const [minutes, setMinutes] = useState('75');
  const [parking, setParking] = useState('0');

  const preview = useApiMutation('previewTariff');

  function run() {
    preview.mutate({
      params: { id: tariff.id },
      body: {
        energyKwh: Number(kwh) || 0,
        durationMinutes: Number(minutes) || 0,
        parkingMinutes: Number(parking) || 0,
        startedAt: new Date().toISOString(),
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <SectionTitle className="mb-1">{tariff.name}</SectionTitle>
            <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-3">
              {tariff.description ?? 'No description.'}
            </p>
          </div>
          <Badge mono>{tariff.currency}</Badge>
        </div>

        <ol className="flex flex-col gap-3">
          {tariff.elements.map((el, i) => (
            <li key={el.id} className="rounded-sm border border-line-soft bg-surface-2 p-3.5">
              <div className="mb-2.5 flex items-center gap-2.5">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 font-mono text-[10.5px] font-semibold text-ink-2">
                  {i + 1}
                </span>
                <span className="text-[12.5px] font-medium text-ink-1">
                  {el.restrictions ? 'Applies when' : 'Applies always'}
                </span>
                {el.restrictions?.startTime && el.restrictions.endTime && (
                  <Badge tone="info" mono>
                    {el.restrictions.startTime}–{el.restrictions.endTime}
                  </Badge>
                )}
                {el.restrictions?.minKwh != null && (
                  <Badge tone="info" mono>≥ {el.restrictions.minKwh} kWh</Badge>
                )}
                {el.restrictions?.maxPowerKw != null && (
                  <Badge tone="info" mono>≤ {el.restrictions.maxPowerKw} kW</Badge>
                )}
              </div>
              <ul className="flex flex-col gap-1.5">
                {el.priceComponents.map((pc) => (
                  <li key={pc.kind} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                    <span className="text-ink-2 capitalize">{pc.kind.replace('_', ' ')}</span>
                    <span className="flex items-baseline gap-2">
                      <span className="tabular font-mono text-ink-1">
                        {formatMoney(pc.priceMinor, tariff.currency)}
                      </span>
                      <span className="text-[11px] text-ink-3">
                        per {PRICE_COMPONENT_UNIT[pc.kind]}
                        {pc.stepSize > 1 && ` · billed in steps of ${pc.stepSize}`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel>
        <SectionTitle className="mb-1">Price a session</SectionTitle>
        <p className="mb-3.5 text-[12.5px] text-ink-3">
          The fastest test for a pricing engine: type numbers, check the answer by hand.
        </p>
        <div className="mb-3.5 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">kWh</span>
            <Input className="w-[96px]" value={kwh} onChange={(e) => setKwh(e.target.value)} inputMode="decimal" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Minutes</span>
            <Input className="w-[96px]" value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Idle mins</span>
            <Input className="w-[96px]" value={parking} onChange={(e) => setParking(e.target.value)} inputMode="numeric" />
          </label>
          <Button variant="primary" loading={preview.isPending} onClick={run}>
            Calculate
          </Button>
        </div>

        {preview.error && (
          <p className="rounded-sm border border-danger bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {preview.error.userMessage}
          </p>
        )}

        {preview.data && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <table className="w-full text-left text-[12.5px]">
                <tbody>
                  {preview.data.breakdown.map((b) => (
                    <tr key={b.label} className="border-b border-line-soft">
                      <td className="py-2 text-ink-2">{b.label}</td>
                      <td className="tabular py-2 text-right font-mono text-ink-3">
                        {formatNumber(b.quantity, 3)} {b.unit}
                      </td>
                      <td className="tabular py-2 text-right font-mono text-ink-1">
                        {formatMoney(b.amountMinor, preview.data.currency)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2.5 font-semibold text-ink-1">Total</td>
                    <td />
                    <td className="tabular py-2.5 text-right font-mono text-[15px] font-semibold text-ink-1">
                      {formatMoney(preview.data.totalMinor, preview.data.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="rounded-sm border border-line-soft bg-surface-2 p-3.5">
              <span className="mb-2 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                Why this price
              </span>
              <ul className="flex flex-col gap-1.5">
                {preview.data.trace.map((t) => (
                  <li key={t.elementIndex} className="flex items-start gap-2 text-[11.5px]">
                    <span
                      className={cn(
                        'mt-1 size-1.5 shrink-0 rounded-full',
                        t.matched ? 'bg-accent' : 'bg-ink-3',
                      )}
                    />
                    <span className={t.matched ? 'text-ink-1' : 'text-ink-3'}>
                      <span className="font-mono">Element {t.elementIndex + 1}</span> — {t.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
