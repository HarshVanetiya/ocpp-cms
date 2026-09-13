import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Pause, Play } from 'lucide-react';
import type { SimFrame } from '@ocpp/contracts';
import { getSimRealtimeClient, useApiQuery } from '@ocpp/api-client';
import { Button, EmptyState, StatusDot, cn, formatTimeMs, useLocalStorage } from '@ocpp/ui';

/**
 * The simulator's side of the wire.
 *
 * ## Directions are reversed here versus the CPMS
 *
 * In the dashboard's frame log, `inbound` means "into the CSMS". Here the
 * simulator IS the station, so `outbound` means "leaving the station, heading
 * for the CSMS". Two logs of the same conversation, each from its own point of
 * view — which is exactly what you get in real life with a charger's own
 * diagnostics next to your server log, and exactly why lining them up side by
 * side is such an effective way to debug.
 */
const MAX_LIVE = 250;

export function WireLogPane({
  stationId,
  title = 'Wire log',
  className,
}: {
  stationId: string | null;
  title?: string;
  className?: string;
}) {
  const [live, setLive] = useLocalStorage('sim.wirelog.live', true);
  const [frames, setFrames] = useState<SimFrame[]>([]);

  const history = useApiQuery('simFrames', {
    query: { limit: 60, stationId: stationId ?? undefined },
  });

  useEffect(() => {
    setFrames([]);
  }, [stationId]);

  useEffect(() => {
    if (!live) return;
    const client = getSimRealtimeClient();
    return client.onSim('sim.frame', (data) => {
      const frame = data as SimFrame;
      if (stationId && frame.stationId !== stationId) return;
      setFrames((prev) => {
        const next = [frame, ...prev];
        if (next.length > MAX_LIVE) next.length = MAX_LIVE;
        return next;
      });
    });
  }, [live, stationId]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: SimFrame[] = [];
    for (const f of [...frames, ...(history.data?.data ?? [])]) {
      if (seen.has(f.id)) continue;
      if (stationId && f.stationId !== stationId) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out;
  }, [frames, history.data, stationId]);

  return (
    <div className={cn('flex min-h-0 flex-grow flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line-soft px-4 py-3">
        <h3 className="font-display text-sm font-semibold tracking-[-0.01em]">{title}</h3>
        <StatusDot tone={live ? 'accent' : 'neutral'} filled pulse={live} label={live ? 'live' : 'paused'} />
        <div className="flex-grow" />
        <Button size="sm" variant="ghost" icon={live ? <Pause /> : <Play />} onClick={() => setLive(!live)}>
          {live ? 'Pause' : 'Resume'}
        </Button>
      </div>

      <div className="flex min-h-0 flex-grow flex-col gap-1.5 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing on the wire yet"
            description="Connect a station and press a button — every frame it sends appears here."
          />
        ) : (
          rows.map((f) => <FrameCard key={f.id} frame={f} />)
        )}
      </div>
    </div>
  );
}

function FrameCard({ frame }: { frame: SimFrame }) {
  const outbound = frame.direction === 'outbound';
  const isError = frame.messageTypeId === 4;

  return (
    <article
      className={cn(
        'rounded-sm border border-line-soft bg-surface-2 px-3 py-2.5',
        isError ? 'border-l-2 border-l-danger' : outbound ? 'border-l-2' : 'border-l-2',
      )}
      style={
        !isError
          ? { borderLeftColor: outbound ? 'var(--color-c1)' : 'var(--color-c2)' }
          : undefined
      }
    >
      <div className="mb-1.5 flex items-center gap-2">
        {outbound ? (
          <ArrowRight className="size-3 shrink-0" style={{ color: 'var(--color-c1)' }} strokeWidth={2.6} />
        ) : (
          <ArrowLeft className="size-3 shrink-0" style={{ color: 'var(--color-c2)' }} strokeWidth={2.6} />
        )}
        <span className="min-w-0 flex-grow truncate font-mono text-[11.5px] font-semibold text-ink-1">
          {frame.action ?? (frame.messageTypeId === 3 ? 'CALLRESULT' : 'CALLERROR')}
        </span>
        {frame.durationMs !== null && (
          <span className="tabular shrink-0 font-mono text-[10px] text-ink-3">
            {frame.durationMs}ms
          </span>
        )}
        <span className="tabular shrink-0 font-mono text-[10px] text-ink-3">
          {formatTimeMs(frame.timestamp).slice(0, 8)}
        </span>
      </div>
      <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-ink-3">
        {frame.raw.length > 220 ? `${frame.raw.slice(0, 220)}…` : frame.raw}
      </pre>
      {frame.errorCode && (
        <p className="mt-1.5 font-mono text-[10.5px] text-danger">
          {frame.errorCode}: {frame.errorDescription}
        </p>
      )}
    </article>
  );
}
