import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  GraduationCap,
  Play,
  Square,
  XCircle,
} from 'lucide-react';
import type { SimRun, SimScenario } from '@ocpp/contracts';
import { getSimRealtimeClient, useApiMutation, useApiQuery, useInvalidate } from '@ocpp/api-client';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  SectionTitle,
  SegmentedControl,
  Select,
  cn,
  useToast,
} from '@ocpp/ui';
import { QueryBoundary } from '../components/QueryBoundary';

/**
 * Scenarios.
 *
 * A scripted sequence of physical events with assertions on what your CSMS
 * replied. This is where the simulator stops being a toy and becomes a test
 * suite: run them after every backend change and you have conformance testing
 * for free.
 *
 * Each scenario states its learning goal, because a test you do not understand
 * teaches you nothing when it fails.
 */

const CATEGORY_LABEL: Record<SimScenario['category'], string> = {
  basics: 'Basics',
  authorization: 'Authorisation',
  transactions: 'Transactions',
  remote_control: 'Remote control',
  smart_charging: 'Smart charging',
  reliability: 'Reliability',
  security: 'Security',
  roaming: 'Roaming',
};

const DIFFICULTY_TONE = {
  beginner: 'accent',
  intermediate: 'violet',
  advanced: 'warn',
} as const;

export default function ScenariosPage() {
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stationId, setStationId] = useState<string>('');
  const [category, setCategory] = useState<'all' | SimScenario['category']>('all');
  const [run, setRun] = useState<SimRun | null>(null);

  const scenarios = useApiQuery('listScenarios');
  const stations = useApiQuery('listSimStations', { query: { pageSize: 100 } });

  useEffect(() => {
    if (!stationId && stations.data?.data[0]) setStationId(stations.data.data[0].id);
  }, [stations.data, stationId]);

  // The run advances step by step over the realtime channel, so the runner
  // animates rather than snapping from "queued" to "done".
  useEffect(() => {
    const client = getSimRealtimeClient();
    return client.onSim('sim.run', (data) => setRun(data as SimRun));
  }, []);

  const start = useApiMutation('runScenario', {
    invalidates: ['listRuns'],
    onSuccess: (r) => {
      setRun(r);
      invalidate('simFrames');
    },
    onError: (e) => toast({ tone: 'error', title: 'Could not start', description: e.userMessage }),
  });

  const abort = useApiMutation('abortRun', { invalidates: ['listRuns'] });

  const all = scenarios.data?.data ?? [];
  const visible = category === 'all' ? all : all.filter((s) => s.category === category);
  const selected = visible.find((s) => s.id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <SegmentedControl
          label="Category"
          size="sm"
          value={category}
          onChange={setCategory}
          options={[
            { value: 'all', label: 'All' },
            { value: 'basics', label: 'Basics' },
            { value: 'transactions', label: 'Transactions' },
            { value: 'authorization', label: 'Auth' },
            { value: 'reliability', label: 'Reliability' },
          ]}
        />
        <Select
          className="w-[220px]"
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          options={(stations.data?.data ?? []).map((s) => ({ value: s.id, label: s.identity }))}
          placeholder="Choose a station"
        />
      </div>

      <QueryBoundary
        isLoading={scenarios.isLoading}
        error={scenarios.error}
        data={scenarios.data}
        isEmpty={(d) => d.data.length === 0}
        empty={<Panel><EmptyState icon={<GraduationCap />} title="No scenarios available" /></Panel>}
        onRetry={() => void scenarios.refetch()}
      >
        {() => (
          <div className="grid min-h-0 gap-3 lg:grid-cols-[320px_1fr]">
            <Panel padded={false} className="h-fit overflow-hidden">
              <ul>
                {visible.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(s.id)}
                      className={cn(
                        'flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors',
                        i < visible.length - 1 && 'border-b border-line-soft',
                        selected?.id === s.id
                          ? 'bg-surface-2 shadow-[inset_3px_0_0_var(--color-info)]'
                          : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="text-[13px] font-medium text-ink-1">{s.name}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={DIFFICULTY_TONE[s.difficulty]}>{s.difficulty}</Badge>
                        <Badge tone="neutral">{CATEGORY_LABEL[s.category]}</Badge>
                        <span className="text-[10.5px] text-ink-3">{s.steps.length} steps</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>

            {selected && (
              <div className="flex flex-col gap-3">
                <Panel>
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <SectionTitle className="mb-1">{selected.name}</SectionTitle>
                      <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
                        {selected.description}
                      </p>
                    </div>
                    {run && run.status === 'running' ? (
                      <Button
                        variant="danger"
                        icon={<Square />}
                        onClick={() => abort.mutate({ params: { id: run.id } })}
                      >
                        Abort
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        icon={<Play />}
                        disabled={!stationId}
                        loading={start.isPending}
                        onClick={() =>
                          start.mutate({
                            body: { scenarioId: selected.id, stationId, speed: 1 },
                          })
                        }
                      >
                        Run scenario
                      </Button>
                    )}
                  </div>

                  <div className="flex items-start gap-2.5 rounded-sm border border-info bg-info-soft p-3.5">
                    <GraduationCap className="mt-px size-4 shrink-0 text-info" />
                    <div>
                      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-info">
                        What this teaches
                      </span>
                      <p className="text-[12.5px] leading-relaxed text-ink-2">
                        {selected.learningGoal}
                      </p>
                    </div>
                  </div>
                </Panel>

                <Panel padded={false}>
                  <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
                    <SectionTitle className="text-[14.5px]">Steps</SectionTitle>
                    {run && run.scenarioId === selected.id && (
                      <Badge
                        tone={
                          run.status === 'passed'
                            ? 'accent'
                            : run.status === 'failed'
                              ? 'danger'
                              : run.status === 'aborted'
                                ? 'neutral'
                                : 'info'
                        }
                        dot={run.status === 'running' ? 'pulse' : 'hollow'}
                      >
                        {run.status} ·{' '}
                        {run.steps.filter((s) => s.status === 'passed').length}/{run.steps.length}
                      </Badge>
                    )}
                  </div>
                  <ol>
                    {selected.steps.map((step, i) => {
                      const result =
                        run && run.scenarioId === selected.id ? run.steps[i] : undefined;
                      const state = result?.status ?? 'pending';
                      return (
                        <li
                          key={step.id}
                          className={cn(
                            'flex flex-wrap items-start gap-3 px-5 py-3',
                            i < selected.steps.length - 1 && 'border-b border-line-soft',
                            state === 'running' && 'bg-info-soft',
                            state === 'failed' && 'bg-danger-soft',
                          )}
                        >
                          <StepIcon state={state} />
                          <div className="flex min-w-0 flex-grow flex-col gap-1">
                            <span className="text-[12.5px] font-medium text-ink-1">
                              {step.label}
                            </span>
                            {step.note && (
                              <span className="text-[11.5px] leading-relaxed text-ink-3">
                                {step.note}
                              </span>
                            )}
                            {result?.assertion && (
                              <span
                                className={cn(
                                  'font-mono text-[11px]',
                                  result.assertion.passed ? 'text-accent' : 'text-danger',
                                )}
                              >
                                expect {result.assertion.expected} → {result.assertion.actual}
                              </span>
                            )}
                            {result?.error && (
                              <span className="font-mono text-[11px] text-danger">{result.error}</span>
                            )}
                          </div>
                          {step.expect && (
                            <span className="shrink-0 font-mono text-[10.5px] text-ink-3">
                              asserts {step.expect.field}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </Panel>
              </div>
            )}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

function StepIcon({ state }: { state: string }) {
  if (state === 'passed') return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" />;
  if (state === 'failed') return <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />;
  if (state === 'running')
    return (
      <span className="mt-0.5 size-4 shrink-0 animate-spin rounded-full border-2 border-info border-t-transparent" />
    );
  if (state === 'skipped') return <CircleDashed className="mt-0.5 size-4 shrink-0 text-ink-3" />;
  return <Circle className="mt-0.5 size-4 shrink-0 text-ink-3" />;
}
