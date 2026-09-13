import type { EndpointId } from '@ocpp/contracts';

/**
 * The navigation model.
 *
 * `endpoints` on each entry is what powers the "this screen is still mocked"
 * badge and the build-progress checklist: a page knows which contract routes it
 * depends on, so it can tell you whether your backend is serving them yet.
 */
export interface NavEntry {
  to: string;
  label: string;
  icon: string;
  section: 'operate' | 'manage' | 'build';
  endpoints: EndpointId[];
  /** Milestone in the docs that makes this screen fully live. */
  milestone: number;
}

export const NAV: NavEntry[] = [
  { to: '/', label: 'Overview', icon: 'layout', section: 'operate', milestone: 8, endpoints: ['dashboardStats', 'energySeries', 'activity', 'topStations'] },
  { to: '/stations', label: 'Stations', icon: 'station', section: 'operate', milestone: 8, endpoints: ['listStations'] },
  { to: '/map', label: 'Map', icon: 'map', section: 'operate', milestone: 8, endpoints: ['listStations', 'listLocations'] },
  { to: '/sessions', label: 'Sessions', icon: 'activity', section: 'operate', milestone: 8, endpoints: ['listSessions'] },
  { to: '/logs', label: 'OCPP log', icon: 'code', section: 'operate', milestone: 9, endpoints: ['ocppLog'] },
  { to: '/users', label: 'Users', icon: 'users', section: 'manage', milestone: 8, endpoints: ['listUsers'] },
  { to: '/tokens', label: 'Tokens', icon: 'card', section: 'manage', milestone: 8, endpoints: ['listTokens'] },
  { to: '/tariffs', label: 'Tariffs', icon: 'tag', section: 'manage', milestone: 11, endpoints: ['listTariffs'] },
  { to: '/billing', label: 'Billing', icon: 'receipt', section: 'manage', milestone: 11, endpoints: ['listCdrs', 'listPayments'] },
  { to: '/ocpi', label: 'OCPI roaming', icon: 'globe', section: 'manage', milestone: 12, endpoints: ['listOcpiParties'] },
  { to: '/progress', label: 'Build progress', icon: 'check', section: 'build', milestone: 0, endpoints: [] },
  { to: '/settings', label: 'Settings', icon: 'settings', section: 'build', milestone: 0, endpoints: [] },
];

export function navFor(pathname: string) {
  // Longest matching prefix wins, so /stations/abc highlights Stations.
  return (
    [...NAV]
      .filter((n) => n.to !== '/' && pathname.startsWith(n.to))
      .sort((a, b) => b.to.length - a.to.length)[0] ??
    (pathname === '/' ? NAV[0] : undefined)
  );
}
