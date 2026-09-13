import { Suspense, lazy } from 'react';
import { Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import { Monitor, Moon, Search, Sun } from 'lucide-react';
import {
  AppShell,
  Divider,
  DropdownMenu,
  IconButton,
  MainArea,
  Skeleton,
  ToastProvider,
  TooltipProvider,
  TopBar,
  useTheme,
} from '@ocpp/ui';
import { AppSidebar } from './components/AppSidebar';
import { navFor } from './lib/nav';

/**
 * Route-level code splitting.
 *
 * The overview is what people land on; the OCPI screen is opened once a month.
 * Lazy routes mean the first paint ships only what the first screen needs,
 * which matters more here than in most apps because the map and the log
 * inspector are both heavy.
 */
const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const StationsPage = lazy(() => import('./pages/StationsPage'));
const StationDetailPage = lazy(() => import('./pages/StationDetailPage'));
const MapPage = lazy(() => import('./pages/MapPage'));
const SessionsPage = lazy(() => import('./pages/SessionsPage'));
const SessionDetailPage = lazy(() => import('./pages/SessionDetailPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const TokensPage = lazy(() => import('./pages/TokensPage'));
const TariffsPage = lazy(() => import('./pages/TariffsPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const OcpiPage = lazy(() => import('./pages/OcpiPage'));
const ProgressPage = lazy(() => import('./pages/ProgressPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <DropdownMenu
      trigger={
        <IconButton label="Theme">
          {mode === 'dark' ? (
            <Moon className="size-4" />
          ) : mode === 'light' ? (
            <Sun className="size-4" />
          ) : (
            <Monitor className="size-4" />
          )}
        </IconButton>
      }
      items={[
        { key: 'dark', label: 'Dark', icon: <Moon />, onSelect: () => setMode('dark') },
        { key: 'light', label: 'Light', icon: <Sun />, onSelect: () => setMode('light') },
        { key: 'system', label: 'Match system', icon: <Monitor />, onSelect: () => setMode('system') },
      ]}
    />
  );
}

function Shell() {
  const { pathname } = useLocation();
  const current = navFor(pathname);

  return (
    <AppShell>
      <AppSidebar />
      <MainArea>
        <TopBar
          title={current?.label ?? 'Voltway'}
          actions={
            <>
              <button
                type="button"
                className="flex h-[34px] w-[260px] items-center gap-2 rounded-sm border border-line-soft bg-surface-2
                           px-[11px] text-left text-[12.5px] text-ink-3 transition-colors hover:border-line max-lg:hidden"
                onClick={() => {
                  // Deliberately inert in this build: a command palette is a
                  // genuinely good feature and a genuinely large one, and
                  // shipping a fake one is worse than not shipping it.
                }}
              >
                <Search className="size-[15px]" />
                Search stations, sessions, tokens
              </button>
              <ThemeToggle />
              <span className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface-3 text-xs font-semibold text-ink-2">
                AK
              </span>
            </>
          }
        />
        <Suspense fallback={<PageSkeleton />}>
          <Outlet />
        </Suspense>
      </MainArea>
    </AppShell>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-5">
      <Skeleton className="h-7 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
      <Skeleton className="h-[300px]" />
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'stations', element: <StationsPage /> },
      { path: 'stations/:id', element: <StationDetailPage /> },
      { path: 'map', element: <MapPage /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'sessions/:id', element: <SessionDetailPage /> },
      { path: 'logs', element: <LogsPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'tokens', element: <TokensPage /> },
      { path: 'tariffs', element: <TariffsPage /> },
      { path: 'billing', element: <BillingPage /> },
      { path: 'ocpi', element: <OcpiPage /> },
      { path: 'progress', element: <ProgressPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

function NotFound() {
  return (
    <div className="grid flex-grow place-items-center p-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="font-display text-4xl font-semibold tracking-tight">404</span>
        <p className="text-[13px] text-ink-3">That screen does not exist.</p>
      </div>
    </div>
  );
}

export function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </TooltipProvider>
  );
}

export { Divider };
