import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, Info, ShieldCheck, Zap } from 'lucide-react';
import { useApiMutation, useApiQuery } from '@ocpp/api-client';
import {
  Button,
  Panel,
  cn,
  currencySymbol,
  formatMoney,
  useToast,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';
import { CONNECTOR_TYPE_LABEL } from '@ocpp/contracts';

/**
 * "How much do you want to spend?"
 *
 * The heart of the prepaid flow, and the screen that ties the whole project
 * together. What happens when the driver taps the button:
 *
 *   1. The amount is AUTHORISED with the payment provider — held, not taken.
 *   2. A session is created in `pending`.
 *   3. A remote start goes to the station, carrying an energy cap derived from
 *      the amount. Nothing else stops the car drawing more than was paid for.
 *   4. The app waits. The session only becomes `active` when the station
 *      reports a real transaction, which is after the driver plugs in.
 *
 * Step 4 is why this screen hands off to a waiting state rather than straight
 * to "charging": there is a real gap, and pretending otherwise is a lie the
 * driver will notice.
 */

const PRESETS = [1000, 2000, 3000, 5000];

export default function AmountPage() {
  const { connectorId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [amountMinor, setAmountMinor] = useState(2000);
  const [custom, setCustom] = useState('');

  const connector = useApiQuery('driverResolveConnector', { body: { code: connectorId } });

  const start = useApiMutation('driverStartCharge', {
    invalidates: ['driverActiveSessions'],
    onSuccess: (res) => {
      toast({ tone: 'success', title: 'Payment held', description: res.message });
      navigate(`/charging/${res.sessionId}`);
    },
    onError: (e) =>
      toast({
        tone: 'error',
        title: e.code === 'PAYMENT_DECLINED' ? 'Payment declined' : 'Could not start',
        description: e.userMessage,
      }),
  });

  const pricePerKwh = connector.data?.pricePerKwhMinor ?? null;
  const currency = connector.data?.currency ?? 'EUR';
  const symbol = currencySymbol(currency);

  const estimate = useMemo(() => {
    if (!pricePerKwh || pricePerKwh <= 0) return null;
    const kwh = amountMinor / pricePerKwh;
    const kw = connector.data?.maxPowerKw ?? 11;
    return { kwh, minutes: Math.round((kwh / kw) * 60) };
  }, [amountMinor, pricePerKwh, connector.data]);

  function applyCustom(value: string) {
    setCustom(value);
    // The UI collects a decimal; everything below this line is integer minor
    // units. That conversion happens exactly once, here.
    const parsed = Number.parseFloat(value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) setAmountMinor(Math.round(parsed * 100));
  }

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="-ml-2.5 grid size-11 shrink-0 place-items-center rounded-sm text-ink-2 hover:bg-surface-2"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="font-display text-[17px] font-semibold tracking-[-0.015em]">
          How much to charge?
        </h1>
      </header>

      <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={connector.isLoading}
          error={connector.error}
          data={connector.data}
          onRetry={() => void connector.refetch()}
        >
          {(c) => (
            <>
              <Panel className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-md border border-accent bg-accent-soft text-accent">
                  <Zap className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium text-ink-1">{c.stationName}</p>
                  <p className="truncate text-[12.5px] text-ink-3">
                    EVSE {c.evseId} · {CONNECTOR_TYPE_LABEL[c.type]} · {c.maxPowerKw} kW
                  </p>
                </div>
                {pricePerKwh !== null && (
                  <span className="tabular ml-auto shrink-0 text-right font-mono text-[13px] text-ink-1">
                    {formatMoney(pricePerKwh, currency)}
                    <span className="block text-[10.5px] text-ink-3">per kWh</span>
                  </span>
                )}
              </Panel>

              {/* ------------------------- amount ------------------------- */}
              <Panel>
                <div className="mb-4 flex items-end justify-center gap-1 py-2">
                  <span className="font-display text-[28px] font-medium text-ink-3">{symbol}</span>
                  <span className="tabular font-display text-[52px] font-semibold leading-none tracking-[-0.04em]">
                    {(amountMinor / 100).toFixed(2)}
                  </span>
                </div>

                <div className="mb-3 grid grid-cols-4 gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setAmountMinor(p);
                        setCustom('');
                      }}
                      className={cn(
                        'h-11 rounded-sm border text-[14px] font-semibold transition-colors',
                        amountMinor === p && custom === ''
                          ? 'border-accent bg-accent text-accent-ink'
                          : 'border-line bg-surface-2 text-ink-1 hover:border-line',
                      )}
                    >
                      {symbol}
                      {p / 100}
                    </button>
                  ))}
                </div>

                <label className="flex items-center gap-2 rounded-sm border border-line bg-surface-2 px-3">
                  <span className="shrink-0 text-[13px] text-ink-3">Other</span>
                  <span className="text-[13px] text-ink-3">{symbol}</span>
                  <input
                    inputMode="decimal"
                    placeholder="0.00"
                    value={custom}
                    onChange={(e) => applyCustom(e.target.value)}
                    className="h-11 w-full bg-transparent text-[15px] text-ink-1 outline-none placeholder:text-ink-3"
                  />
                </label>

                {estimate && (
                  <p className="mt-3 flex items-start gap-2 rounded-sm border border-line-soft bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                    About{' '}
                    <strong className="whitespace-nowrap font-semibold text-ink-1">
                      {estimate.kwh.toFixed(1)} kWh
                    </strong>{' '}
                    at this price — roughly {estimate.minutes} minutes at {c.maxPowerKw} kW.
                  </p>
                )}
              </Panel>

              <Panel tone="sunken" className="flex items-start gap-2.5">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
                <p className="text-[12.5px] leading-relaxed text-ink-2">
                  We hold{' '}
                  <strong className="font-semibold text-ink-1">
                    {formatMoney(amountMinor, currency)}
                  </strong>{' '}
                  now and charge only what you actually use. Anything you do not use is released
                  when you stop.
                </p>
              </Panel>
            </>
          )}
        </QueryBoundary>
      </div>

      <div className="safe-bottom shrink-0 border-t border-line-soft bg-surface-1 px-4 pt-3.5">
        <Button
          variant="primary"
          size="lg"
          fullWidth
          icon={<Zap />}
          disabled={!connector.data || amountMinor <= 0}
          loading={start.isPending}
          onClick={() =>
            start.mutate({
              body: {
                connectorId: connector.data!.id,
                amountMinor,
                currency,
                idempotencyKey: crypto.randomUUID(),
              },
            })
          }
        >
          Hold {formatMoney(amountMinor, currency)} and start
        </Button>
      </div>
    </div>
  );
}
