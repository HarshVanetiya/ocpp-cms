import { Suspense, lazy } from 'react';
import { NavLink, Outlet, RouterProvider, createBrowserRouter } from 'react-router';
import { Map, Receipt, User, Zap } from 'lucide-react';
import { Skeleton, ToastProvider, TooltipProvider, cn } from '@ocpp/ui';

const FindPage = lazy(() => import('./pages/FindPage'));
const LocationPage = lazy(() => import('./pages/LocationPage'));
const AmountPage = lazy(() => import('./pages/AmountPage'));
const ChargingPage = lazy(() => import('./pages/ChargingPage'));
const HistoryPage = lazy(() => import('./pages/HistoryPage'));
const ReceiptPage = lazy(() => import('./pages/ReceiptPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));

const TABS = [
  { to: '/', label: 'Find', icon: Map },
  { to: '/charging', label: 'Charging', icon: Zap },
  { to: '/history', label: 'History', icon: Receipt },
  { to: '/account', label: 'Account', icon: User },
];

function Shell() {
  return (
    /*
     * `h-dvh` not `h-screen`: on mobile Safari `100vh` includes the address
     * bar, so a `h-screen` layout puts its bottom bar off-screen until you
     * scroll. `dvh` tracks the actual visible viewport.
     */
    <div className="mx-auto flex h-dvh max-w-[520px] flex-col overflow-hidden bg-ground text-ink-1">
      <Suspense
        fallback={
          <div className="flex flex-grow flex-col gap-3 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-48" />
            <Skeleton className="h-32" />
          </div>
        }
      >
        <Outlet />
      </Suspense>

      <nav
        className="safe-bottom flex h-16 shrink-0 items-stretch border-t border-line-soft bg-surface-1"
        aria-label="Main"
      >
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-grow flex-col items-center justify-center gap-1 transition-colors',
                isActive ? 'text-accent' : 'text-ink-3',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="size-5" strokeWidth={isActive ? 2.2 : 2} />
                <span className={cn('text-[10.5px]', isActive && 'font-semibold')}>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <FindPage /> },
      { path: 'location/:id', element: <LocationPage /> },
      { path: 'charge/:connectorId', element: <AmountPage /> },
      { path: 'charging', element: <ChargingPage /> },
      { path: 'charging/:sessionId', element: <ChargingPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'receipt/:sessionId', element: <ReceiptPage /> },
      { path: 'account', element: <AccountPage /> },
      { path: '*', element: <FindPage /> },
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
