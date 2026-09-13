import { Suspense, lazy, useState } from 'react';
import { NavLink, Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { Activity, Code2, Moon, Plus, Sun, Zap } from 'lucide-react';
import {
  SIM_API_URL,
  useApiQuery,
  useRealtimeConnection,
  getSimRealtimeClient,
} from '@ocpp/api-client';
import {
  Badge,
  Button,
  IconButton,
  Skeleton,
  ToastProvider,
  TooltipProvider,
  cn,
  useTheme,
} from '@ocpp/ui';
import { CreateStationDialog } from './components/CreateStationDialog';

const FleetPage = lazy(() => import('./pages/FleetPage'));
const ScenariosPage = lazy(() => import('./pages/ScenariosPage'));
const WireLogPage = lazy(() => import('./pages/WireLogPage'));

function Shell() {
  const { mode, toggle } = useTheme();
  const [creating, setCreating] = useState(false);
  const connection = useRealtimeConnection(getSimRealtimeClient());
  const health = useApiQuery('simHealth', undefined, { refetchInterval: 15_000 });

  return (
    <div
      data-app="simulator"
      className="flex h-dvh flex-col overflow-hidden bg-ground text-ink-1"
    >
      <header className="flex h-[58px] shrink-0 flex-wrap items-center gap-3.5 border-b border-line-soft bg-surface-1 px-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-sm bg-info elev-1">
            <Zap className="size-4 text-surface-1" strokeWidth={2.3} />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="font-display text-[14.5px] font-semibold tracking-[-0.01em]">
              Station Simulator
            </span>
            <span className="text-[10.5px] tracking-[0.04em] text-ink-3">VIRTUAL HARDWARE</span>
          </span>
        </div>

        <div className="mx-1 h-6 w-px bg-line-soft" />

        <div className="flex h-8 items-center gap-2 rounded-sm border border-line-soft bg-surface-2 px-[11px] max-md:hidden">
          <span className="text-[11px] text-ink-3">CSMS</span>
          <span className="font-mono text-xs text-ink-1">
            {health.data?.defaultCsmsUrl ?? 'ws://localhost:3000/ocpp'}
          </span>
          <span
            className={cn(
              'size-1.5 rounded-full',
              connection === 'open' ? 'bg-accent' : 'bg-ink-3',
            )}
          />
        </div>

        {health.data && (
          <Badge tone="neutral">
            <span className="tabular font-semibold text-ink-1">{health.data.stationCount}</span>
            &nbsp;stations
            <span className="text-ink-3">·</span>
            <span className="tabular font-semibold" style={{ color: 'var(--color-c1)' }}>
              {health.data.connectedCount}
            </span>
            &nbsp;connected
          </Badge>
        )}

        <nav className="ml-2 flex items-center gap-1" aria-label="Main">
          {[
            { to: '/', label: 'Fleet', icon: <Zap className="size-4" /> },
            { to: '/scenarios', label: 'Scenarios', icon: <Activity className="size-4" /> },
            { to: '/logs', label: 'Wire log', icon: <Code2 className="size-4" /> },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex h-8 items-center gap-2 rounded-sm px-3 text-[12.5px] transition-colors',
                  isActive
                    ? 'bg-surface-3 font-semibold text-ink-1 elev-1'
                    : 'font-medium text-ink-3 hover:text-ink-1',
                )
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <IconButton label="Toggle theme" onClick={toggle}>
            {mode === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </IconButton>
          <Button
            icon={<Plus />}
            className="border-info bg-info font-semibold text-surface-1 hover:brightness-110"
            onClick={() => setCreating(true)}
          >
            Add station
          </Button>
        </div>
      </header>

      <Suspense
        fallback={
          <div className="flex flex-grow gap-3 p-4">
            <Skeleton className="w-[272px]" />
            <Skeleton className="flex-grow" />
            <Skeleton className="w-[388px]" />
          </div>
        }
      >
        <Outlet />
      </Suspense>

      <CreateStationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <FleetPage /> },
      { path: 'scenarios', element: <ScenariosPage /> },
      { path: 'logs', element: <WireLogPage /> },
      { path: '*', element: <FleetPage /> },
    ],
  },
]);

export function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </TooltipProvider>
  );
}

export { SIM_API_URL };
