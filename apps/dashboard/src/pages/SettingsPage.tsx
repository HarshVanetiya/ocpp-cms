import { ExternalLink, Monitor, Moon, Sun } from 'lucide-react';
import {
  API_URL,
  LEARN_MODE,
  SIM_API_URL,
  useBackendReachability,
  useRealtimeConnection,
} from '@ocpp/api-client';
import { SERVICE_BASE_PATH, allEndpoints } from '@ocpp/contracts';
import {
  Badge,
  CodeBlock,
  KeyValue,
  PageHeader,
  Panel,
  SectionTitle,
  SegmentedControl,
  useTheme,
} from '@ocpp/ui';

export default function SettingsPage() {
  const { mode, setMode } = useTheme();
  const reachability = useBackendReachability();
  const connection = useRealtimeConnection();

  return (
    <div className="flex min-h-0 flex-grow flex-col gap-4 overflow-y-auto p-5">
      <PageHeader
        title="Settings"
        description="How this frontend is configured, and where it is pointed."
      />

      <Panel>
        <SectionTitle className="mb-3.5">Appearance</SectionTitle>
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
        <p className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
          {mode === 'dark' ? <Moon className="size-3.5" /> : mode === 'light' ? <Sun className="size-3.5" /> : <Monitor className="size-3.5" />}
          Stored per browser. &ldquo;System&rdquo; keeps following your OS, including when it
          changes at sunset.
        </p>
      </Panel>

      <Panel>
        <SectionTitle className="mb-3.5">Connection</SectionTitle>
        <KeyValue
          columns={2}
          items={[
            { label: 'Core API', value: API_URL, mono: true },
            { label: 'Simulator API', value: SIM_API_URL, mono: true },
            { label: 'API base path', value: SERVICE_BASE_PATH.core, mono: true },
            { label: 'Simulator base path', value: SERVICE_BASE_PATH.sim, mono: true },
            {
              label: 'Backend',
              value: (
                <Badge tone={reachability === 'online' ? 'accent' : 'neutral'} dot="hollow">
                  {reachability}
                </Badge>
              ),
            },
            {
              label: 'Realtime',
              value: (
                <Badge tone={connection === 'open' ? 'accent' : 'neutral'} dot="hollow">
                  {connection}
                </Badge>
              ),
            },
            {
              label: 'Mode',
              value: (
                <Badge tone={LEARN_MODE ? 'info' : 'neutral'}>
                  {LEARN_MODE ? 'learn (mocks available)' : 'normal (no mocks)'}
                </Badge>
              ),
            },
            { label: 'Contract endpoints', value: String(allEndpoints.length), mono: true },
          ]}
        />
        <p className="mt-4 text-[12.5px] leading-relaxed text-ink-3">
          These come from Vite environment variables, inlined at build time. Change them by
          creating <span className="font-mono">.env.local</span> next to{' '}
          <span className="font-mono">apps/dashboard/package.json</span>.
        </p>
        <CodeBlock
          className="mt-3"
          label=".env.local"
          code={`VITE_API_URL=${API_URL}\nVITE_SIM_API_URL=${SIM_API_URL}`}
        />
      </Panel>

      <Panel>
        <SectionTitle className="mb-3.5">Running the apps</SectionTitle>
        <CodeBlock
          label="From the repository root"
          code={[
            '# Everything, with the mock backend — nothing else required',
            'npm run dev:learn',
            '',
            '# Everything, against your own backend only',
            'npm run dev',
            '',
            '# One app at a time',
            'npm run dev:dashboard   # http://localhost:5173',
            'npm run dev:simulator   # http://localhost:5174',
            'npm run dev:driver      # http://localhost:5175',
            '',
            '# Regenerate the OpenAPI spec after changing the contract',
            'npm run contracts:openapi',
          ].join('\n')}
        />
        <div className="mt-4 flex flex-wrap gap-4">
          <a
            href="https://github.com/HarshVanetiya/ocpp-cms/blob/main/docs/00-start-here.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
          >
            Start here guide
            <ExternalLink className="size-3.5" />
          </a>
          <a
            href="https://github.com/HarshVanetiya/ocpp-cms/blob/main/docs/04-architecture/README.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
          >
            Architecture
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      </Panel>
    </div>
  );
}
