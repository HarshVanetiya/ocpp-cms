import { useState } from 'react';
import { Link } from 'react-router';
import { MapPin, Navigation, Zap } from 'lucide-react';
import { CONNECTOR_TYPE_LABEL } from '@ocpp/contracts';
import { useApiQuery } from '@ocpp/api-client';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  SearchInput,
  SegmentedControl,
  formatDistance,
  formatMoney,
  useDebounced,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

/**
 * Finding somewhere to charge.
 *
 * Sorted by distance and filtered to what is actually free, because a driver
 * looking at this screen has one question — "where can I plug in right now" —
 * and every extra control is in the way of answering it.
 */
export default function FindPage() {
  const [availableOnly, setAvailableOnly] = useState(true);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);

  // Fixed to Amsterdam rather than asking for geolocation: a permission prompt
  // on first load is hostile, and this is a demo. A real app would ask when the
  // driver taps "near me".
  const nearby = useApiQuery('driverNearby', {
    query: {
      latitude: 52.3376,
      longitude: 4.8721,
      radiusMeters: 60_000,
      availableOnly: availableOnly || undefined,
    },
  });

  const rows = (nearby.data?.data ?? []).filter((l) =>
    q ? `${l.name} ${l.address}`.toLowerCase().includes(q.toLowerCase()) : true,
  );

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <header className="shrink-0 px-4 pb-3 pt-5">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em]">Find a charger</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">Near Amsterdam Centraal</p>
      </header>

      <div className="flex shrink-0 flex-col gap-2.5 px-4 pb-3">
        <SearchInput
          placeholder="Search sites"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SegmentedControl
          label="Availability"
          value={availableOnly ? 'free' : 'all'}
          onChange={(v) => setAvailableOnly(v === 'free')}
          options={[
            { value: 'free', label: 'Available now' },
            { value: 'all', label: 'All sites' },
          ]}
        />
      </div>

      <div className="flex min-h-0 flex-grow flex-col gap-2.5 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={nearby.isLoading}
          error={nearby.error}
          data={nearby.data}
          onRetry={() => void nearby.refetch()}
          skeleton={
            <>
              {Array.from({ length: 5 }, (_, i) => (
                <Panel key={i} className="h-[108px]" />
              ))}
            </>
          }
        >
          {() =>
            rows.length === 0 ? (
              <Panel>
                <EmptyState
                  icon={<MapPin />}
                  title="Nothing nearby"
                  description={
                    availableOnly
                      ? 'Every charger around here is busy. Try showing all sites.'
                      : 'No sites match your search.'
                  }
                  action={
                    availableOnly && (
                      <Button onClick={() => setAvailableOnly(false)}>Show all sites</Button>
                    )
                  }
                />
              </Panel>
            ) : (
              rows.map((loc) => (
                <Link key={loc.id} to={`/location/${loc.id}`} className="block">
                  <Panel className="transition-colors hover:border-line active:brightness-95">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-[15px] font-semibold text-ink-1">{loc.name}</h2>
                        <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{loc.address}</p>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-[12px] text-ink-2">
                        <Navigation className="size-3.5" />
                        {formatDistance(loc.distanceMeters)}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        tone={loc.availableConnectorCount > 0 ? 'accent' : 'neutral'}
                        dot={loc.availableConnectorCount > 0 ? 'solid' : 'hollow'}
                      >
                        {loc.availableConnectorCount} of {loc.totalConnectorCount} free
                      </Badge>
                      <Badge tone="neutral">
                        <Zap className="size-3" />
                        up to {loc.maxPowerKw} kW
                      </Badge>
                      {loc.fromPriceMinor !== null && (
                        <span className="text-[12.5px] text-ink-2">
                          from{' '}
                          <span className="tabular font-medium text-ink-1">
                            {formatMoney(loc.fromPriceMinor, loc.currency ?? 'EUR')}
                          </span>
                          <span className="text-ink-3">/kWh</span>
                        </span>
                      )}
                    </div>

                    {loc.connectorTypes.length > 0 && (
                      <p className="mt-2 truncate text-[11.5px] text-ink-3">
                        {loc.connectorTypes.map((t) => CONNECTOR_TYPE_LABEL[t]).join(' · ')}
                      </p>
                    )}
                  </Panel>
                </Link>
              ))
            )
          }
        </QueryBoundary>
      </div>
    </div>
  );
}
