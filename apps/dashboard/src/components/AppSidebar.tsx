import { NavLink, useLocation } from 'react-router';
import { Zap } from 'lucide-react';
import { useApiQuery } from '@ocpp/api-client';
import { Sidebar, SidebarSection, cn } from '@ocpp/ui';
import { NAV } from '../lib/nav';
import { NAV_ICONS } from './icons';
import { BackendIndicator } from './BackendIndicator';

const SECTION_LABEL: Record<string, string> = {
  operate: 'OPERATE',
  manage: 'MANAGE',
  build: 'BUILD',
};

export function AppSidebar() {
  const { pathname } = useLocation();

  // Counts in the nav make it feel alive. They are cheap because both queries
  // are already cached by the pages that use them.
  const stations = useApiQuery('listStations', { query: { pageSize: 1 } });
  const active = useApiQuery('listSessions', { query: { status: 'active', pageSize: 1 } });

  return (
    <Sidebar>
      <div className="flex items-center gap-2.5 px-[18px] pb-5 pt-[18px]">
        <span className="grid size-[30px] place-items-center rounded-sm bg-accent elev-1">
          <Zap className="size-[18px] text-accent-ink" strokeWidth={2.2} />
        </span>
        <span className="flex flex-col leading-tight">
          <span className="font-display text-[14.5px] font-semibold tracking-[-0.01em]">
            Voltway
          </span>
          <span className="text-[10.5px] tracking-[0.05em] text-ink-3">CPMS CONSOLE</span>
        </span>
      </div>

      <nav className="flex flex-grow flex-col gap-0.5 px-3" aria-label="Main">
        {(['operate', 'manage', 'build'] as const).map((section) => (
          <SidebarSection key={section} label={SECTION_LABEL[section]}>
            {NAV.filter((n) => n.section === section).map((entry) => {
              const isActive =
                entry.to === '/' ? pathname === '/' : pathname.startsWith(entry.to);
              const count =
                entry.to === '/stations'
                  ? stations.data?.meta.total
                  : entry.to === '/sessions'
                    ? active.data?.meta.total
                    : undefined;

              return (
                <NavLink
                  key={entry.to}
                  to={entry.to}
                  end={entry.to === '/'}
                  className={cn(
                    'flex h-[34px] items-center gap-2.5 rounded-sm px-2.5 text-[13px] transition-colors',
                    '[&>svg]:size-4 [&>svg]:shrink-0',
                    isActive
                      ? 'bg-surface-3 font-medium text-ink-1 elev-1 [&>svg]:text-accent'
                      : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1',
                  )}
                >
                  {NAV_ICONS[entry.icon]}
                  <span className="truncate">{entry.label}</span>
                  {count !== undefined && count > 0 && (
                    <span
                      className={cn(
                        'tabular ml-auto shrink-0 text-[11px]',
                        entry.to === '/sessions'
                          ? 'inline-flex items-center gap-1.5 font-semibold text-accent'
                          : 'text-ink-3',
                      )}
                    >
                      {entry.to === '/sessions' && (
                        <span className="size-1.5 rounded-full bg-accent pulse-dot" />
                      )}
                      {count}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </SidebarSection>
        ))}
      </nav>

      <BackendIndicator />
    </Sidebar>
  );
}
