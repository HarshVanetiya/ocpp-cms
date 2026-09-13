import { useNavigate, useParams } from 'react-router';
import { ArrowLeft, CheckCircle2, Download } from 'lucide-react';
import { useApiQuery } from '@ocpp/api-client';
import {
  Button,
  Panel,
  formatDateTime,
  formatDuration,
  formatEnergy,
  formatMoney,
  formatNumber,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

/**
 * The receipt.
 *
 * Note the line that matters most to a driver, and that most prepaid apps
 * bury: how much of their hold was released. Showing captured, released and
 * authorised together is what makes "we only charge what you use" believable
 * rather than a slogan.
 */
export default function ReceiptPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const receipt = useApiQuery('driverReceipt', { params: { id: sessionId } });

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-4">
        <button
          type="button"
          onClick={() => navigate('/history')}
          aria-label="Back"
          className="-ml-2.5 grid size-11 shrink-0 place-items-center rounded-sm text-ink-2 hover:bg-surface-2"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="font-display text-[17px] font-semibold tracking-[-0.015em]">Receipt</h1>
      </header>

      <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={receipt.isLoading}
          error={receipt.error}
          data={receipt.data}
          onRetry={() => void receipt.refetch()}
        >
          {(r) => (
            <>
              <Panel className="flex flex-col items-center gap-2 py-6 text-center">
                <CheckCircle2 className="size-9 text-accent" strokeWidth={1.8} />
                <span className="tabular font-display text-[34px] font-semibold tracking-[-0.035em]">
                  {formatMoney(r.totalMinor, r.currency)}
                </span>
                <span className="text-[13px] text-ink-3">
                  {formatEnergy(r.energyDeliveredWh)} over {formatDuration(r.durationSeconds)}
                </span>
                {r.refundedMinor > 0 && (
                  <span className="mt-1 rounded-full border border-accent bg-accent-soft px-3 py-1 text-[11.5px] font-medium text-accent">
                    {formatMoney(r.refundedMinor, r.currency)} released back to you
                  </span>
                )}
              </Panel>

              <Panel>
                <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Where
                </h2>
                <p className="text-[14px] font-medium text-ink-1">{r.locationName}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-3">{r.locationAddress}</p>
                <p className="mt-2 border-t border-line-soft pt-2 text-[12.5px] text-ink-2">
                  {r.stationName} · {r.connectorLabel}
                </p>
                <p className="mt-1.5 text-[12px] text-ink-3">
                  {formatDateTime(r.startedAt)} → {formatDateTime(r.endedAt)}
                </p>
              </Panel>

              <Panel>
                <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Breakdown
                </h2>
                <table className="w-full text-left text-[13px]">
                  <tbody>
                    {r.lines.map((l) => (
                      <tr key={l.label} className="border-b border-line-soft">
                        <td className="py-2 text-ink-2">
                          {l.label}
                          <span className="ml-1.5 text-[11.5px] text-ink-3">
                            {formatNumber(l.quantity, 2)} {l.unit} ×{' '}
                            {formatMoney(l.unitPriceMinor, r.currency)}
                          </span>
                        </td>
                        <td className="tabular py-2 text-right font-mono text-ink-1">
                          {formatMoney(l.amountMinor, r.currency)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-line-soft">
                      <td className="py-2 text-ink-3">Subtotal</td>
                      <td className="tabular py-2 text-right font-mono text-ink-2">
                        {formatMoney(r.subtotalMinor, r.currency)}
                      </td>
                    </tr>
                    {r.vatPercent !== null && (
                      <tr className="border-b border-line-soft">
                        <td className="py-2 text-ink-3">VAT {r.vatPercent}%</td>
                        <td className="tabular py-2 text-right font-mono text-ink-2">
                          {formatMoney(r.vatMinor, r.currency)}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="py-2.5 font-semibold text-ink-1">Total</td>
                      <td className="tabular py-2.5 text-right font-mono text-[15px] font-semibold text-ink-1">
                        {formatMoney(r.totalMinor, r.currency)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </Panel>

              <Panel tone="sunken">
                <h2 className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Payment
                </h2>
                <dl className="flex flex-col gap-1.5 text-[12.5px]">
                  <Row label="Held" value={formatMoney(r.authorizedAmountMinor, r.currency)} />
                  <Row label="Charged" value={formatMoney(r.totalMinor, r.currency)} />
                  <Row
                    label="Released"
                    value={formatMoney(r.refundedMinor, r.currency)}
                    accent
                  />
                  {r.paymentReference && <Row label="Reference" value={r.paymentReference} mono />}
                  <Row label="Receipt" value={r.reference} mono />
                </dl>
              </Panel>

              <Button
                icon={<Download />}
                fullWidth
                onClick={() => {
                  const blob = new Blob([JSON.stringify(r, null, 2)], {
                    type: 'application/json',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${r.reference}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download receipt
              </Button>
            </>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd
        className={`truncate text-right ${mono ? 'font-mono text-[12px]' : ''} ${accent ? 'font-medium text-accent' : 'text-ink-1'}`}
      >
        {value}
      </dd>
    </div>
  );
}
