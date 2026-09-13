import { useMemo } from 'react';
import { CheckCircle2, CircleDashed, FlaskConical, Loader2, PlugZap } from 'lucide-react';
import { NavLink } from 'react-router';
import {
  API_URL,
  LEARN_MODE,
  useBackendReachability,
  useBackendStatus,
  useRealtimeConnection,
} from '@ocpp/api-client';
import { allEndpoints } from '@ocpp/contracts';
import { Tooltip, cn } from '@ocpp/ui';

/**
 * The sidebar footer.
 *
 * This little panel is the most useful thing in learn mode: it tells you at a
 * glance whether your backend is up, how much of the contract it answers, and
 * whether the realtime channel is connected. Without it, "why is this screen
 * showing fake data" is a five-minute investigation every time.
 */
export function BackendIndicator() {
  const reachability = useBackendReachability();
  const statuses = useBackendStatus();
  const connection = useRealtimeConnection();

  const { implemented, touched } = useMemo(() => {
    const real = statuses.filter((s) => s.servedBy === 'backend');
    return { implemented: real.length, touched: statuses.length };
  }, [statuses]);

  const total = allEndpoints.length;

  const state =
    reachability === 'online' ? 'online' : reachability === 'offline' ? 'offline' : 'unknown';

  return (
    <div className="m-3 rounded-md border border-line-soft bg-surface-2 p-3">
      <div className="mb-2 flex items-center gap-2">
        {state === 'online' ? (
          <span className="size-[7px] shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)]" />
        ) : state === 'offline' ? (
          <PlugZap className="size-3.5 shrink-0 text-ink-3" />
        ) : (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-ink-3" />
        )}
        <span className="text-xs font-semibold text-ink-1">
          {state === 'online'
            ? 'Backend connected'
            : state === 'offline'
              ? LEARN_MODE
                ? 'Running on mocks'
                : 'Backend offline'
              : 'Checking backend'}
        </span>
      </div>

      <div className="flex flex-col gap-1 font-mono text-[10.5px] leading-relaxed text-ink-3">
        <span className="truncate" title={API_URL}>
          {API_URL.replace(/^https?:\/\//, '')}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'size-1.5 rounded-full',
              connection === 'open'
                ? 'bg-accent'
                : connection === 'reconnecting' || connection === 'connecting'
                  ? 'bg-warn'
                  : 'bg-ink-3',
            )}
          />
          realtime {connection}
        </span>
      </div>

      {LEARN_MODE && (
        <>
          <div className="mt-2.5 flex items-center justify-between text-[10.5px]">
            <span className="inline-flex items-center gap-1.5 text-info">
              <FlaskConical className="size-3" />
              learn mode
            </span>
            <Tooltip
              content={`${implemented} of the ${total} contract endpoints have answered from your backend this session. The rest fell back to mocks.`}
            >
              <span className="tabular cursor-help font-mono text-ink-2">
                {implemented}/{total}
              </span>
            </Tooltip>
          </div>
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${(implemented / total) * 100}%` }}
            />
          </div>
          <NavLink
            to="/progress"
            className="mt-2 inline-flex items-center gap-1.5 text-[10.5px] text-ink-3 hover:text-ink-1"
          >
            {implemented > 0 ? (
              <CheckCircle2 className="size-3 text-accent" />
            ) : (
              <CircleDashed className="size-3" />
            )}
            {touched === 0 ? 'Nothing called yet' : 'See what is left to build'}
          </NavLink>
        </>
      )}
    </div>
  );
}

/**
 * Per-screen badge: is what I am looking at real?
 *
 * Placed in the page header of every data screen. It turns the abstract
 * question "have I implemented this endpoint" into a visible property of the
 * page you are staring at.
 */
export function ServedByBadge({ servedBy }: { servedBy: 'backend' | 'mock' | 'error' | 'unknown' }) {
  if (!LEARN_MODE || servedBy === 'unknown') return null;

  if (servedBy === 'backend') {
    return (
      <Tooltip content="This screen is reading from your backend.">
        <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-accent bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent">
          <CheckCircle2 className="size-3" />
          live
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content="Your backend does not answer these routes yet, so this screen is showing mock data. Implement them and it switches over automatically.">
      <span className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-info bg-info-soft px-2 py-0.5 text-[10.5px] font-semibold text-info">
        <FlaskConical className="size-3" />
        mocked
      </span>
    </Tooltip>
  );
}
