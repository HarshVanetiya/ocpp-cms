import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, CircleDashed, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import type { EndpointDef } from '@ocpp/contracts';
import { allEndpoints, endpointPath, endpointsByMilestone } from '@ocpp/contracts';
import {
  API_URL,
  LEARN_MODE,
  backendStatus,
  probeBackend,
  useBackendReachability,
  useBackendStatus,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  Meter,
  PageHeader,
  Panel,
  SectionTitle,
  SegmentedControl,
  StatTile,
  cn,
} from '@ocpp/ui';

/**
 * The build checklist.
 *
 * The whole project's teaching loop lives on this screen: a list of every route
 * in the contract, grouped by the milestone that introduces it, showing exactly
 * which ones your backend has answered. Implement one, refresh, watch it turn
 * green.
 *
 * Note the honest caveat rendered at the top: an endpoint only appears as
 * "live" once the UI has actually called it this session. Nothing here probes
 * routes behind your back — a progress screen that fired 90 requests on load
 * would be a menace.
 */

const MILESTONE_TITLES: Record<number, string> = {
  0: 'Milestone 0 · Setup and health',
  2: 'Milestone 2 · First WebSocket and the simulator',
  5: 'Milestone 5 · Scenario runner',
  6: 'Milestone 6 · Remote commands',
  8: 'Milestone 8 · The REST API for the dashboard',
  9: 'Milestone 9 · Logging and realtime',
  11: 'Milestone 11 · Tariffs, payments and the driver flow',
  12: 'Milestone 12 · OCPI roaming',
  13: 'Milestone 13 · Security and audit',
};

type Filter = 'all' | 'todo' | 'done';

export default function ProgressPage() {
  const statuses = useBackendStatus();
  const reachability = useBackendReachability();
  const [filter, setFilter] = useState<Filter>('all');
  const [probing, setProbing] = useState(false);

  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const grouped = useMemo(() => endpointsByMilestone(), []);

  const implemented = statuses.filter((s) => s.servedBy === 'backend').length;
  const mocked = statuses.filter((s) => s.servedBy === 'mock').length;
  const failing = statuses.filter((s) => s.servedBy === 'error').length;

  async function recheck() {
    setProbing(true);
    backendStatus.reset();
    await probeBackend();
    setProbing(false);
  }

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <PageHeader
        title="Build progress"
        description="Every endpoint in the contract, and whether your backend answers it yet."
        actions={
          <Button icon={<RefreshCw />} loading={probing} onClick={recheck}>
            Re-check
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Implemented"
          value={implemented}
          caption={`of ${allEndpoints.length} endpoints`}
        />
        <StatTile label="Still mocked" value={mocked} caption="answered by learn mode" />
        <StatTile label="Erroring" value={failing} caption="answered, but not correctly" />
        <StatTile
          label="Backend"
          value={reachability === 'online' ? 'Up' : reachability === 'offline' ? 'Down' : '—'}
          caption={API_URL.replace(/^https?:\/\//, '')}
        />
      </div>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Overall</SectionTitle>
          <SegmentedControl
            label="Filter"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'todo', label: 'Not done' },
              { value: 'done', label: 'Done' },
            ]}
          />
        </div>
        <Meter
          label="Endpoints implemented"
          value={(implemented / allEndpoints.length) * 100}
          showValue
        />
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          An endpoint is marked live once the app has called it and your backend answered. Screens
          you have not opened yet will show as untouched — that is not a failure, just an
          unvisited route.
          {!LEARN_MODE && (
            <>
              {' '}
              You are running <span className="font-mono">npm run dev</span>, so nothing falls back
              to mocks: unimplemented routes show real errors.
            </>
          )}
        </p>
      </Panel>

      {[...grouped.entries()].map(([milestone, defs]) => {
        const visible = defs.filter((d) => {
          const status = byId.get(d.id);
          const done = status?.servedBy === 'backend';
          if (filter === 'done') return done;
          if (filter === 'todo') return !done;
          return true;
        });
        if (visible.length === 0) return null;

        const done = defs.filter((d) => byId.get(d.id)?.servedBy === 'backend').length;

        return (
          <Panel key={milestone} padded={false}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <SectionTitle className="text-[14.5px]">
                  {MILESTONE_TITLES[milestone] ?? `Milestone ${milestone}`}
                </SectionTitle>
                <Badge tone={done === defs.length ? 'accent' : 'neutral'} mono>
                  {done}/{defs.length}
                </Badge>
              </div>
              <a
                href={`https://github.com/HarshVanetiya/ocpp-cms/blob/main/docs/03-build-the-backend/milestone-${String(milestone).padStart(2, '0')}.md`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-accent"
              >
                Read the guide
                <ExternalLink className="size-3.5" />
              </a>
            </div>
            <ul>
              {visible.map((def, i) => (
                <EndpointRow
                  key={def.id}
                  def={def}
                  status={byId.get(def.id)}
                  last={i === visible.length - 1}
                />
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}

function EndpointRow({
  def,
  status,
  last,
}: {
  def: EndpointDef;
  status: ReturnType<typeof useBackendStatus>[number] | undefined;
  last: boolean;
}) {
  const state = status?.servedBy ?? 'untouched';

  const icon =
    state === 'backend' ? (
      <CheckCircle2 className="size-4 text-accent" />
    ) : state === 'error' ? (
      <XCircle className="size-4 text-danger" />
    ) : state === 'mock' ? (
      <CircleDashed className="size-4 text-info" />
    ) : (
      <Circle className="size-4 text-ink-3" />
    );

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-3 px-5 py-2.5',
        !last && 'border-b border-line-soft',
      )}
    >
      {icon}
      <span className="w-[62px] shrink-0 font-mono text-[11px] font-semibold text-ink-3">
        {def.method}
      </span>
      <span className="min-w-0 flex-grow truncate font-mono text-[12.5px] text-ink-1">
        {endpointPath(def)}
      </span>
      <span className="hidden min-w-0 flex-grow truncate text-[12px] text-ink-3 lg:block">
        {def.summary}
      </span>
      {status?.durationMs != null && state === 'backend' && (
        <span className="tabular w-[56px] shrink-0 text-right font-mono text-[11px] text-ink-3">
          {Math.round(status.durationMs)}ms
        </span>
      )}
      <span className="w-[76px] shrink-0 text-right">
        {state === 'backend' ? (
          <Badge tone="accent">live</Badge>
        ) : state === 'mock' ? (
          <Badge tone="info">mocked</Badge>
        ) : state === 'error' ? (
          <Badge tone="danger">error</Badge>
        ) : (
          <span className="text-[11px] text-ink-3">untouched</span>
        )}
      </span>
    </li>
  );
}
