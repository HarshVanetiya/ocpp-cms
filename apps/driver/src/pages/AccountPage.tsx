import { Leaf, Moon, Sun, Zap } from 'lucide-react';
import { useApiQuery } from '@ocpp/api-client';
import {
  Badge,
  Panel,
  SegmentedControl,
  StatTile,
  formatEnergy,
  formatMoney,
  formatNumber,
  formatRelative,
  useTheme,
  useNow,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

export default function AccountPage() {
  const { mode, setMode } = useTheme();
  const now = useNow(60_000);
  const profile = useApiQuery('driverProfile');

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      <header className="shrink-0 px-4 pb-3 pt-5">
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em]">Account</h1>
      </header>

      <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto px-4 pb-4">
        <QueryBoundary
          isLoading={profile.isLoading}
          error={profile.error}
          data={profile.data}
          onRetry={() => void profile.refetch()}
        >
          {(p) => (
            <>
              <Panel className="flex items-center gap-3.5">
                <span className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-surface-3 text-[15px] font-semibold text-ink-2">
                  {p.name
                    .split(' ')
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join('')}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-ink-1">{p.name}</p>
                  <p className="truncate text-[12.5px] text-ink-3">{p.email}</p>
                </div>
                {p.balanceMinor !== null && (
                  <span className="ml-auto shrink-0 text-right">
                    <span className="tabular block font-display text-[17px] font-semibold tracking-[-0.02em]">
                      {formatMoney(p.balanceMinor, p.currency)}
                    </span>
                    <span className="block text-[10.5px] text-ink-3">balance</span>
                  </span>
                )}
              </Panel>

              <div className="grid grid-cols-2 gap-2.5">
                <StatTile label="Charges" value={formatNumber(p.stats.sessionCount)} icon={<Zap />} />
                <StatTile
                  label="Energy"
                  value={formatEnergy(p.stats.totalEnergyWh, { digits: 1 })}
                />
                <StatTile
                  label="Spent"
                  value={formatMoney(p.stats.totalSpentMinor, p.currency)}
                />
                <StatTile
                  label="CO₂ avoided"
                  value={`${formatNumber(p.stats.co2SavedKg, 1)} kg`}
                  icon={<Leaf />}
                />
              </div>

              <Panel>
                <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Your cards and app access
                </h2>
                <ul className="flex flex-col gap-2.5">
                  {p.tokens.map((t) => (
                    <li key={t.id} className="flex items-center gap-3">
                      <div className="min-w-0 flex-grow">
                        <p className="truncate text-[13px] text-ink-1">{t.label ?? t.type}</p>
                        <p className="truncate font-mono text-[11.5px] text-ink-3">
                          {t.maskedValue}
                          {t.lastUsedAt && ` · used ${formatRelative(t.lastUsedAt, now)}`}
                        </p>
                      </div>
                      <Badge tone={t.status === 'active' ? 'accent' : 'danger'} dot="hollow">
                        {t.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 border-t border-line-soft pt-3 text-[11.5px] leading-relaxed text-ink-3">
                  Only the last four characters are ever sent to this app. Losing one card does not
                  affect the others — each can be blocked on its own.
                </p>
              </Panel>

              <Panel>
                <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                  Appearance
                </h2>
                <SegmentedControl
                  label="Theme"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'System' },
                  ]}
                />
                <p className="mt-2.5 flex items-center gap-2 text-[11.5px] text-ink-3">
                  {mode === 'light' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                  Saved on this device.
                </p>
              </Panel>
            </>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
