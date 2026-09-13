import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

/* ------------------------------------------------------------------ *
 * AppShell
 * ------------------------------------------------------------------ */

export function AppShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-dvh overflow-hidden bg-ground text-ink-1', className)}>{children}</div>
  );
}

export function Sidebar({
  children,
  width = 232,
  className,
}: {
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  return (
    <aside
      style={{ width }}
      className={cn(
        'flex shrink-0 flex-col border-r border-line-soft bg-surface-1',
        'max-md:hidden',
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function SidebarSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && (
        <span className="px-2 pb-1.5 pt-4 text-[10.5px] font-semibold tracking-[0.1em] text-ink-3">
          {label}
        </span>
      )}
      {children}
    </div>
  );
}

export interface NavItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  /** Right-aligned count or live indicator. */
  trailing?: ReactNode;
  onClick?: () => void;
  href?: string;
  as?: 'a' | 'button';
}

export function NavItem({ icon, label, active, trailing, onClick, href, as }: NavItemProps) {
  const className = cn(
    'flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2.5 text-[13px] transition-colors',
    active
      ? 'bg-surface-3 font-medium text-ink-1 elev-1 [&>svg]:text-accent'
      : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1',
    '[&>svg]:size-4 [&>svg]:shrink-0',
  );
  const content = (
    <>
      {icon}
      <span className="truncate">{label}</span>
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </>
  );
  if (as === 'a' || href) {
    return (
      <a href={href} aria-current={active ? 'page' : undefined} className={className}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={className}>
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * TopBar
 * ------------------------------------------------------------------ */

export function TopBar({
  title,
  children,
  actions,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex h-15 shrink-0 items-center gap-3.5 border-b border-line-soft bg-surface-1 px-5',
        className,
      )}
    >
      {title && (
        <h1 className="font-display text-[19px] font-semibold tracking-[-0.015em]">{title}</h1>
      )}
      {children}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function MainArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-grow flex-col', className)}>{children}</div>
  );
}

export function PageBody({
  children,
  className,
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-grow flex-col gap-4 p-5',
        scroll ? 'overflow-y-auto' : 'overflow-hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.015em]">{title}</h2>
        {description && <p className="text-[13px] text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
