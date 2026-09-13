import { Link } from 'react-router';
import { ChevronRight, Receipt } from 'lucide-react';
import { useApiQuery } from '@ocpp/api-client';
import {
  Badge,
  EmptyState,
  Panel,
  formatDateTime,
  formatDuration,
  formatEnergy,
  formatMoney,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

export default function HistoryPage() {
  const history = useApiQuery('driverSessionHistory', { query: { pageSize: 30 } });

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <header className="shrink-0 px-4 pb-3 pt-5">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em]">History</h1>
        <p className="mt-0.5 text-[13px] text-ink-3">Every charge and what it cost</p>
      </header>

      <div className="flex min-h-0 flex-grow flex-col gap-2.5 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={history.isLoading}
          error={history.error}
          data={history.data}
          isEmpty={(d) => d.data.length === 0}
          empty={
            <Panel>
              <EmptyState
                icon={<Receipt />}
                title="No charges yet"
                description="Your finished sessions and their receipts will appear here."
              />
            </Panel>
          }
          onRetry={() => void history.refetch()}
          skeleton={
            <>
              {Array.from({ length: 6 }, (_, i) => (
                <Panel key={i} className="h-[84px]" />
              ))}
            </>
          }
        >
          {(data) =>
            data.data.map((s) => (
              <Link key={s.id} to={`/receipt/${s.id}`} className="block">
                <Panel className="flex items-center gap-3 transition-colors hover:border-line active:brightness-95">
                  <div className="min-w-0 flex-grow">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-ink-1">
                        {s.locationName}
                      </span>
                      {s.status !== 'completed' && (
                        <Badge tone={s.status === 'active' ? 'accent' : 'neutral'}>{s.status}</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-ink-3">
                      {formatDateTime(s.startedAt)} · {formatDuration(s.durationSeconds)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="tabular block font-mono text-[14px] font-medium text-ink-1">
                      {formatMoney(s.costMinor, s.currency)}
                    </span>
                    <span className="tabular block font-mono text-[11.5px] text-ink-3">
                      {formatEnergy(s.energyDeliveredWh)}
                    </span>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-ink-3" />
                </Panel>
              </Link>
            ))
          }
        </QueryBoundary>
      </div>
    </div>
  );
}
