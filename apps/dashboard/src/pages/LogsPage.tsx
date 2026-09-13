import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Circle,
  Download,
  Pause,
  Play,
  Search,
} from 'lucide-react';
import type { OcppExchange, Protocol } from '@ocpp/contracts';
import { findMessage } from '@ocpp/ocpp';
import {
  useApiQuery,
  useRealtimeEvent,
  useRealtimeTopics,
  useServedBy,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  FilterChip,
  Input,
  JsonView,
  SegmentedControl,
  StatusDot,
  Tooltip,
  cn,
  formatTimeMs,
  useDebounced,
  useLocalStorage,
} from '@ocpp/ui';
import { ServedByBadge } from '../components/BackendIndicator';
import { ProtocolBadge } from '../components/StatusBadges';
import { ErrorState } from '../components/QueryBoundary';

/**
 * The OCPP frame inspector.
 *
 * This is the screen that makes the project worth showing to an interviewer, so
 * it earns more care than a CRUD table:
 *
 *  - Live tailing that can be PAUSED. Reading a log that scrolls away is
 *    impossible, and pausing is the first thing anyone reaches for.
 *  - Request and response stitched into one row, with the round-trip time.
 *  - A detail pane that EXPLAINS the message, not just pretty-prints it —
 *    what it is for, when it fires, and the specific thing that will bite you.
 *  - Schema failures highlighted, because a CSMS that quietly accepts
 *    malformed frames is worse than one that rejects them loudly.
 */

const MAX_LIVE_ROWS = 400;

export default function LogsPage() {
  const [live, setLive] = useLocalStorage('logs.live', true);
  const [protocol, setProtocol] = useState<Protocol | 'all'>('all');
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [invalidOnly, setInvalidOnly] = useState(false);
  const [stationFilter, setStationFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const q = useDebounced(query, 350);

  const history = useApiQuery('ocppLog', {
    query: {
      limit: 120,
      protocol: protocol === 'all' ? undefined : protocol,
      direction: direction === 'all' ? undefined : direction,
      invalidOnly: invalidOnly || undefined,
      q: q || undefined,
      stationIdentity: stationFilter ?? undefined,
    },
  });

  const servedBy = useServedBy(['ocppLog']);

  /**
   * Live rows live in component state, not in the query cache.
   *
   * Pushing every frame through TanStack Query would re-render every consumer
   * of that cache key several times a second. Keeping the tail local, and the
   * history in the cache, is the pattern that keeps a busy log screen at 60fps.
   */
  const [liveRows, setLiveRows] = useState<OcppExchange[]>([]);
  const liveRef = useRef(live);
  liveRef.current = live;

  useRealtimeTopics(['ocpp']);
  useRealtimeEvent(
    'ocpp.message',
    useCallback((exchange: OcppExchange) => {
      if (!liveRef.current) return;
      setLiveRows((prev) => {
        const next = [exchange, ...prev];
        // Bounded, or a tab left open overnight eats a gigabyte.
        if (next.length > MAX_LIVE_ROWS) next.length = MAX_LIVE_ROWS;
        return next;
      });
    }, []),
  );

  // Clear the live tail whenever the filters change, so what is on screen
  // always matches what the filter bar says.
  useEffect(() => {
    setLiveRows([]);
  }, [protocol, direction, invalidOnly, q, stationFilter]);

  const rows = useMemo(() => {
    const matchesFilters = (e: OcppExchange) => {
      if (protocol !== 'all' && e.protocol !== protocol) return false;
      if (direction !== 'all' && e.direction !== direction) return false;
      if (invalidOnly && e.request.valid !== false) return false;
      if (stationFilter && e.stationIdentity !== stationFilter) return false;
      if (q && !JSON.stringify(e.request.payload).toLowerCase().includes(q.toLowerCase())) {
        return false;
      }
      return true;
    };

    const seen = new Set<string>();
    const merged: OcppExchange[] = [];
    for (const e of [...liveRows.filter(matchesFilters), ...(history.data?.data ?? [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      merged.push(e);
    }
    return merged;
  }, [liveRows, history.data, protocol, direction, invalidOnly, q, stationFilter]);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;

  const rate = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    return rows.filter((r) => new Date(r.timestamp).getTime() >= cutoff).length;
  }, [rows]);

  function exportJson() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ocpp-log-${new Date().toISOString().slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-h-0 flex-grow flex-col">
      {/* ------------------------- filter bar ------------------------- */}
      <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line-soft px-5 py-2.5">
        <Badge tone={live ? 'accent' : 'neutral'} dot={live ? 'pulse' : 'hollow'}>
          {live ? 'LIVE' : 'PAUSED'}
        </Badge>
        <span className="tabular font-mono text-[11.5px] text-ink-3">
          {rows.length} frames · {rate}/min
        </span>

        <div className="mx-1 h-5 w-px bg-line-soft" />

        <SegmentedControl
          label="Protocol"
          size="sm"
          value={protocol}
          onChange={setProtocol}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ocpp1.6', label: '1.6J' },
            { value: 'ocpp2.0.1', label: '2.0.1' },
          ]}
        />
        <SegmentedControl
          label="Direction"
          size="sm"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'all', label: 'Both ways' },
            { value: 'inbound', label: 'Inbound' },
            { value: 'outbound', label: 'Outbound' },
          ]}
        />

        {stationFilter && (
          <FilterChip
            label="station"
            value={stationFilter}
            onRemove={() => setStationFilter(null)}
          />
        )}
        {invalidOnly && (
          <FilterChip
            label="schema"
            value="errors only"
            tone="danger"
            onRemove={() => setInvalidOnly(false)}
          />
        )}

        <div className="ml-auto flex items-center gap-2">
          <Input
            className="w-[240px]"
            mono
            icon={<Search />}
            placeholder="payload contains…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Tooltip content="Show only frames that failed schema validation">
            <Button
              size="sm"
              variant={invalidOnly ? 'danger' : 'secondary'}
              icon={<AlertCircle />}
              onClick={() => setInvalidOnly((v) => !v)}
            >
              Errors
            </Button>
          </Tooltip>
          <Button
            size="sm"
            icon={live ? <Pause /> : <Play />}
            onClick={() => setLive(!live)}
          >
            {live ? 'Pause' : 'Resume'}
          </Button>
          <Button size="sm" icon={<Download />} onClick={exportJson}>
            Export
          </Button>
          <ServedByBadge servedBy={servedBy} />
        </div>
      </div>

      {/* --------------------------- split ---------------------------- */}
      <div className="flex min-h-0 flex-grow">
        <div className="flex min-w-0 flex-grow flex-col border-r border-line-soft">
          <div
            className="grid shrink-0 gap-3 border-b border-line-soft bg-surface-1 px-5 py-2.5
                       text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-3"
            style={{ gridTemplateColumns: '92px 118px 52px 26px minmax(0,1fr) 104px 66px' }}
          >
            <span>Time</span>
            <span>Station</span>
            <span>Ver</span>
            {/* Direction arrow column: no visible header, but the cell must
                stay in the grid flow — `sr-only` is position:absolute and
                would silently shift every column after it. */}
            <span aria-hidden />
            <span>Action</span>
            <span>Result</span>
            <span className="text-right">RTT</span>
          </div>

          <div className="min-h-0 flex-grow overflow-y-auto">
            {history.error && rows.length === 0 ? (
              <div className="p-5">
                <ErrorState error={history.error} onRetry={() => void history.refetch()} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Circle />}
                title={history.isLoading ? 'Loading frames…' : 'No frames match'}
                description={
                  history.isLoading
                    ? undefined
                    : 'Connect a station in the simulator, or clear the filters.'
                }
              />
            ) : (
              rows.map((e) => (
                <LogRow
                  key={e.id}
                  exchange={e}
                  selected={selected?.id === e.id}
                  onSelect={() => setSelectedId(e.id)}
                  onFilterStation={() => setStationFilter(e.stationIdentity)}
                />
              ))
            )}
          </div>
        </div>

        <aside className="flex w-[468px] shrink-0 flex-col overflow-hidden bg-surface-1 max-xl:hidden">
          {selected ? <Inspector exchange={selected} /> : <NoSelection />}
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Row
 * ------------------------------------------------------------------ */

function LogRow({
  exchange,
  selected,
  onSelect,
  onFilterStation,
}: {
  exchange: OcppExchange;
  selected: boolean;
  onSelect: () => void;
  onFilterStation: () => void;
}) {
  const invalid = exchange.request.valid === false;
  const inbound = exchange.direction === 'inbound';
  const result =
    exchange.outcome === 'pending'
      ? { tone: 'neutral' as const, label: 'pending', filled: false }
      : invalid
        ? { tone: 'danger' as const, label: 'schema', filled: true }
        : exchange.outcome === 'error'
          ? { tone: 'danger' as const, label: 'error', filled: true }
          : { tone: 'accent' as const, label: resultLabel(exchange), filled: true };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'grid cursor-pointer items-center gap-3 border-b border-line-soft px-5 py-2 transition-colors',
        invalid && 'bg-danger-soft',
        selected
          ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-accent)]'
          : 'hover:bg-surface-2',
      )}
      style={{ gridTemplateColumns: '92px 118px 52px 26px minmax(0,1fr) 104px 66px' }}
    >
      <span className="tabular font-mono text-[11.5px] text-ink-3">
        {formatTimeMs(exchange.timestamp)}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onFilterStation();
        }}
        className="truncate text-left font-mono text-[11.5px] text-ink-2 hover:text-accent"
        title={`Filter to ${exchange.stationIdentity}`}
      >
        {exchange.stationIdentity}
      </button>
      <ProtocolBadge protocol={exchange.protocol} size="sm" />
      {inbound ? (
        <ArrowLeft className="size-3.5" style={{ color: 'var(--color-c1)' }} strokeWidth={2.4} />
      ) : (
        <ArrowRight className="size-3.5" style={{ color: 'var(--color-c2)' }} strokeWidth={2.4} />
      )}
      <span className="truncate font-mono text-xs text-ink-1">
        {exchange.action}
        {subtitleFor(exchange) && (
          <span className="ml-1.5 text-ink-3">{subtitleFor(exchange)}</span>
        )}
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-[11px]',
          result.tone === 'danger' ? 'font-semibold text-danger' : 'text-ink-2',
        )}
      >
        {result.tone === 'danger' ? (
          <AlertCircle className="size-[11px]" />
        ) : (
          <StatusDot tone={result.tone} filled={result.filled} label={result.label} />
        )}
        {result.label}
      </span>
      <span className="tabular text-right font-mono text-[11px] text-ink-3">
        {exchange.durationMs === null ? '—' : `${exchange.durationMs}ms`}
      </span>
    </div>
  );
}

/** Pull the one interesting value out of a response for the list row. */
function resultLabel(exchange: OcppExchange): string {
  const payload = exchange.response?.payload as Record<string, unknown> | undefined;
  if (!payload) return 'ok';
  const status =
    (payload.status as string | undefined) ??
    ((payload.idTagInfo as Record<string, unknown> | undefined)?.status as string | undefined) ??
    ((payload.idTokenInfo as Record<string, unknown> | undefined)?.status as string | undefined);
  return status ?? 'ok';
}

/** A one-word qualifier that makes a log line readable at a glance. */
function subtitleFor(exchange: OcppExchange): string | null {
  const p = exchange.request.payload as Record<string, unknown> | undefined;
  if (!p) return null;
  if (exchange.action === 'TransactionEvent') return (p.eventType as string) ?? null;
  if (exchange.action === 'Reset') return (p.type as string) ?? null;
  if (exchange.action === 'StatusNotification') {
    return ((p.status as string) ?? (p.connectorStatus as string)) ?? null;
  }
  if (exchange.action === 'StopTransaction') return (p.reason as string) ?? null;
  return null;
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

function NoSelection() {
  return (
    <div className="grid flex-grow place-items-center p-6 text-center">
      <p className="max-w-[240px] text-[13px] leading-relaxed text-ink-3">
        Select a frame to see the full exchange, and what the message is for.
      </p>
    </div>
  );
}

function Inspector({ exchange }: { exchange: OcppExchange }) {
  const [tab, setTab] = useState<'exchange' | 'fields' | 'raw'>('exchange');
  const doc = findMessage(exchange.protocol, exchange.action);
  const invalid = exchange.request.valid === false;

  return (
    <>
      <div className="shrink-0 border-b border-line-soft px-5 pb-3 pt-4">
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <h2 className="font-display text-base font-semibold tracking-[-0.01em]">
            {exchange.action}
          </h2>
          <ProtocolBadge protocol={exchange.protocol} />
          <Badge mono>CALL · 2</Badge>
        </div>

        {doc ? (
          <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-2">{doc.summary}.</p>
        ) : (
          <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-3">
            Not a message this catalogue knows — a vendor extension, or a typo in the action name.
          </p>
        )}

        <div className="flex flex-wrap gap-3.5 font-mono text-[11px] text-ink-3">
          <span>
            id <span className="text-ink-2">{exchange.messageId}</span>
          </span>
          <span>
            rtt <span className="text-ink-2">{exchange.durationMs ?? '—'} ms</span>
          </span>
          {exchange.sessionId && (
            <span>
              session <span className="text-accent">{exchange.sessionId.slice(0, 8)}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 gap-0.5 px-5 pt-2.5">
        {(['exchange', 'fields', 'raw'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'rounded-t-xs px-3 py-1.5 text-xs capitalize transition-colors',
              tab === t
                ? 'border border-b-0 border-line-soft bg-surface-2 font-semibold text-ink-1'
                : 'font-medium text-ink-3 hover:text-ink-1',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-grow overflow-y-auto px-5 pb-5">
        {tab === 'exchange' && (
          <div className="overflow-hidden rounded-b-sm rounded-tr-sm border border-line-soft bg-surface-2">
            <FrameHeader
              direction={exchange.direction}
              label={
                exchange.direction === 'inbound' ? 'REQUEST · STATION → CSMS' : 'REQUEST · CSMS → STATION'
              }
            />
            <div className="px-3.5 py-3">
              <JsonView
                value={exchange.request.payload}
                highlight={exchange.request.validationErrors?.map((e) => e.split(':')[0]) ?? []}
              />
            </div>

            {exchange.response ? (
              <>
                <FrameHeader
                  direction={exchange.direction === 'inbound' ? 'outbound' : 'inbound'}
                  label={
                    exchange.direction === 'inbound'
                      ? 'RESULT · CSMS → STATION'
                      : 'RESULT · STATION → CSMS'
                  }
                  suffix={exchange.durationMs !== null ? `+${exchange.durationMs} ms` : undefined}
                  bordered
                />
                <div className="px-3.5 py-3">
                  {exchange.response.errorCode ? (
                    <div className="flex flex-col gap-1.5 font-mono text-[11.5px]">
                      <span className="text-danger">{exchange.response.errorCode}</span>
                      <span className="text-ink-2">{exchange.response.errorDescription}</span>
                    </div>
                  ) : (
                    <JsonView value={exchange.response.payload} />
                  )}
                </div>
              </>
            ) : (
              <div className="border-t border-line-soft px-3.5 py-3 text-[11.5px] text-ink-3">
                Still waiting for a reply. If this never resolves, your pending-call timeout is
                what cleans it up — check you have one.
              </div>
            )}
          </div>
        )}

        {tab === 'fields' && <FieldDocs exchange={exchange} />}

        {tab === 'raw' && (
          <div className="flex flex-col gap-3 pt-3">
            <CodeBlock label="Request frame" code={exchange.request.raw ?? '—'} wrap />
            {exchange.response && (
              <CodeBlock label="Response frame" code={exchange.response.raw ?? '—'} wrap />
            )}
          </div>
        )}

        {invalid && (
          <div className="mt-3.5 rounded-sm border border-danger bg-danger-soft p-3.5">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-px size-[15px] shrink-0 text-danger" />
              <div>
                <div className="mb-1 text-xs font-semibold text-danger">
                  This frame failed schema validation
                </div>
                <ul className="flex list-none flex-col gap-1 text-[11.5px] leading-relaxed text-ink-2">
                  {exchange.request.validationErrors?.map((e) => (
                    <li key={e} className="font-mono">
                      {e}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
                  Your CSMS should answer this with a CALLERROR carrying{' '}
                  <span className="font-mono">FormationViolation</span> or{' '}
                  <span className="font-mono">TypeConstraintViolation</span> — never crash, never
                  silently accept.
                </p>
              </div>
            </div>
          </div>
        )}

        {doc && tab === 'exchange' && <Gotchas doc={doc} />}
      </div>
    </>
  );
}

function FrameHeader({
  direction,
  label,
  suffix,
  bordered,
}: {
  direction: 'inbound' | 'outbound';
  label: string;
  suffix?: string;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2',
        bordered ? 'border-y border-line-soft bg-surface-1' : 'border-b border-line-soft',
      )}
    >
      {direction === 'inbound' ? (
        <ArrowLeft className="size-3.5" style={{ color: 'var(--color-c1)' }} strokeWidth={2.4} />
      ) : (
        <ArrowRight className="size-3.5" style={{ color: 'var(--color-c2)' }} strokeWidth={2.4} />
      )}
      <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-3">{label}</span>
      {suffix && (
        <span className="tabular ml-auto font-mono text-[10.5px] text-ink-3">{suffix}</span>
      )}
    </div>
  );
}

/**
 * The field reference.
 *
 * This is where the inspector stops being a log viewer and starts being a
 * teaching tool: every field, what it means, and the specific trap in it.
 */
function FieldDocs({ exchange }: { exchange: OcppExchange }) {
  const doc = findMessage(exchange.protocol, exchange.action);
  if (!doc) {
    return (
      <p className="pt-4 text-[12.5px] text-ink-3">
        No field documentation for this action.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-3.5">
      <div className="flex flex-col gap-2 rounded-sm border border-line-soft bg-surface-2 p-3.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          When it fires
        </span>
        <p className="text-[12.5px] leading-relaxed text-ink-2">{doc.whenItFires}</p>
      </div>

      {doc.counterpart && (
        <div className="flex items-center gap-2 text-[12px] text-ink-3">
          <span>Equivalent in the other version:</span>
          <span className="font-mono text-ink-1">{doc.counterpart}</span>
        </div>
      )}

      {(['requestFields', 'responseFields'] as const).map((which) => {
        const fields = doc[which];
        if (fields.length === 0) return null;
        return (
          <div key={which} className="flex flex-col gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              {which === 'requestFields' ? 'Request fields' : 'Response fields'}
            </span>
            {fields.map((f) => (
              <div
                key={f.name}
                className="flex flex-col gap-1 rounded-sm border border-line-soft bg-surface-2 p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs font-medium text-ink-1">{f.name}</span>
                  <span className="font-mono text-[10.5px] text-ink-3">{f.type}</span>
                  {f.required && (
                    <span className="rounded-[3px] bg-surface-3 px-1.5 text-[9.5px] font-semibold uppercase text-ink-3">
                      required
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] leading-relaxed text-ink-2">{f.description}</p>
                {f.values && (
                  <p className="font-mono text-[10.5px] leading-relaxed text-ink-3">
                    {f.values.join(' · ')}
                  </p>
                )}
                {f.gotcha && (
                  <p className="mt-0.5 border-l-2 border-warn pl-2.5 text-[11.5px] leading-relaxed text-warn">
                    {f.gotcha}
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Surfaces the first field-level warning for the selected action. */
function Gotchas({ doc }: { doc: NonNullable<ReturnType<typeof findMessage>> }) {
  const field = [...doc.requestFields, ...doc.responseFields].find((f) => f.gotcha);
  if (!field?.gotcha) return null;
  return (
    <div className="mt-3.5 rounded-sm border border-warn bg-warn-soft p-3.5">
      <div className="flex items-start gap-2.5">
        <AlertCircle className="mt-px size-[15px] shrink-0 text-warn" />
        <div>
          <div className="mb-1 font-mono text-xs font-semibold text-warn">{field.name}</div>
          <p className="text-[11.5px] leading-relaxed text-ink-2">{field.gotcha}</p>
        </div>
      </div>
    </div>
  );
}
