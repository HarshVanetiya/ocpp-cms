import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Clock, MapPin, Zap } from 'lucide-react';
import { CONNECTOR_TYPE_LABEL } from '@ocpp/contracts';
import { useApiQuery } from '@ocpp/api-client';
import { Badge, Panel, StatusDot, cn, formatMoney } from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

export default function LocationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useApiQuery('driverLocation', { params: { id } });

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
        <h1 className="min-w-0 truncate font-display text-[17px] font-semibold tracking-[-0.015em]">
          {location.data?.name ?? 'Site'}
        </h1>
      </header>

      <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={location.isLoading}
          error={location.error}
          data={location.data}
          onRetry={() => void location.refetch()}
        >
          {(loc) => (
            <>
              <Panel>
                <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  {loc.address}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge tone={loc.openNow ? 'accent' : 'warn'} dot="hollow">
                    <Clock className="size-3" />
                    {loc.openingHours.twentyFourSeven ? 'Open 24/7' : loc.openNow ? 'Open now' : 'Closed'}
                  </Badge>
                  <Badge tone="neutral">
                    <Zap className="size-3" />
                    up to {loc.maxPowerKw} kW
                  </Badge>
                  {loc.fromPriceMinor !== null && (
                    <Badge tone="neutral">
                      {formatMoney(loc.fromPriceMinor, loc.currency ?? 'EUR')}/kWh
                    </Badge>
                  )}
                </div>
                {loc.facilities.length > 0 && (
                  <p className="mt-3 border-t border-line-soft pt-3 text-[12px] capitalize text-ink-3">
                    {loc.facilities.map((f) => f.replace(/_/g, ' ')).join(' · ')}
                  </p>
                )}
              </Panel>

              <h2 className="mt-1 px-1 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                {loc.availableConnectorCount} of {loc.totalConnectorCount} connectors free
              </h2>

              <ul className="flex flex-col gap-2.5">
                {loc.connectors.map((c) => {
                  const body = (
                    <Panel
                      className={cn(
                        'flex items-center gap-3 transition-colors',
                        c.available ? 'hover:border-accent active:brightness-95' : 'opacity-60',
                      )}
                    >
                      <span
                        className={cn(
                          'grid size-10 shrink-0 place-items-center rounded-md border',
                          c.available
                            ? 'border-accent bg-accent-soft text-accent'
                            : 'border-line bg-surface-2 text-ink-3',
                        )}
                      >
                        <Zap className="size-5" />
                      </span>
                      <div className="min-w-0 flex-grow">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink-1">
                            {CONNECTOR_TYPE_LABEL[c.type]}
                          </span>
                          <span className="shrink-0 text-[12.5px] text-ink-3">{c.maxPowerKw} kW</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5">
                          <StatusDot
                            tone={c.available ? 'accent' : 'neutral'}
                            filled={c.available}
                            label={c.statusLabel}
                          />
                          <span className="text-[12px] text-ink-3">
                            {c.available ? 'Available' : c.statusLabel}
                            <span className="text-ink-3"> · {c.stationName.split('·').pop()?.trim()}</span>
                          </span>
                        </div>
                      </div>
                      {c.pricePerKwhMinor !== null && (
                        <span className="tabular shrink-0 text-right font-mono text-[13px] text-ink-1">
                          {formatMoney(c.pricePerKwhMinor, c.currency ?? 'EUR')}
                          <span className="block text-[10.5px] text-ink-3">per kWh</span>
                        </span>
                      )}
                    </Panel>
                  );

                  return (
                    <li key={c.id}>
                      {c.available ? (
                        <Link to={`/charge/${c.id}`} className="block">
                          {body}
                        </Link>
                      ) : (
                        body
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
