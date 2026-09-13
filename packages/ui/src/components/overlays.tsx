import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import * as RMenu from '@radix-ui/react-dropdown-menu';
import * as RTooltip from '@radix-ui/react-tooltip';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '../lib/cn';

/* ------------------------------------------------------------------ *
 * Dialog
 * ------------------------------------------------------------------ */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Built on Radix rather than hand-rolled.
 *
 * A correct modal needs a focus trap, focus restore on close, `aria-modal`,
 * inert background content, Escape handling and scroll locking. That is a lot
 * of subtle code to get wrong, and getting it wrong locks keyboard users out.
 * This is the right place to take a dependency.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const width = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg';
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in-up" />
        <RDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-line bg-surface-1 elev-3 data-[state=open]:animate-in-up',
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
            <div className="flex flex-col gap-1">
              <RDialog.Title className="font-display text-[16px] font-semibold tracking-[-0.01em]">
                {title}
              </RDialog.Title>
              {description && (
                <RDialog.Description className="text-[13px] leading-relaxed text-ink-3">
                  {description}
                </RDialog.Description>
              )}
            </div>
            <RDialog.Close
              aria-label="Close"
              className="-mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-sm text-ink-3 hover:bg-surface-2 hover:text-ink-1"
            >
              <X className="size-4" />
            </RDialog.Close>
          </div>
          {children && <div className="px-5 py-4">{children}</div>}
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-3.5">
              {footer}
            </div>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const DialogClose = RDialog.Close;

/* ------------------------------------------------------------------ *
 * Dropdown menu
 * ------------------------------------------------------------------ */

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function DropdownMenu({
  trigger,
  items,
  align = 'end',
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <RMenu.Root>
      <RMenu.Trigger asChild>{trigger}</RMenu.Trigger>
      <RMenu.Portal>
        <RMenu.Content
          align={align}
          sideOffset={6}
          className="z-50 min-w-[184px] rounded-md border border-line bg-surface-3 p-1 elev-3 data-[state=open]:animate-in-up"
        >
          {items.map((it) => (
            <div key={it.key}>
              {it.separatorBefore && <RMenu.Separator className="my-1 h-px bg-line-soft" />}
              <RMenu.Item
                disabled={it.disabled}
                onSelect={it.onSelect}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-xs px-2.5 py-1.5 text-[13px] outline-none',
                  'data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  it.destructive ? 'text-danger' : 'text-ink-1',
                  '[&>svg]:size-4 [&>svg]:text-ink-3',
                )}
              >
                {it.icon}
                {it.label}
              </RMenu.Item>
            </div>
          ))}
        </RMenu.Content>
      </RMenu.Portal>
    </RMenu.Root>
  );
}

/* ------------------------------------------------------------------ *
 * Tooltip
 * ------------------------------------------------------------------ */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={300} skipDelayDuration={200}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-[260px] rounded-sm border border-line bg-surface-3 px-2.5 py-1.5 text-xs leading-relaxed text-ink-1 elev-3"
        >
          {content}
          <RTooltip.Arrow className="fill-surface-3" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const toastIcon: Record<ToastTone, ReactNode> = {
  info: <Info className="size-4 text-info" />,
  success: <CheckCircle2 className="size-4 text-accent" />,
  warning: <AlertTriangle className="size-4 text-warn" />,
  error: <XCircle className="size-4 text-danger" />,
};

export function ToastProvider({
  children,
  duration = 5000,
}: {
  children: ReactNode;
  duration?: number;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...t, id }]);
  }, []);

  // One timer per toast, cleaned up on unmount. A single shared timer would
  // dismiss toasts that only just appeared.
  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), duration));
    return () => timers.forEach(clearTimeout);
  }, [toasts, duration, dismiss]);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* `aria-live=polite` so a screen reader announces without interrupting. */}
      <div
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-md border border-line bg-surface-3 p-3.5 elev-3 animate-in-up"
          >
            <span className="mt-px shrink-0">{toastIcon[t.tone]}</span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-ink-1">{t.title}</span>
              {t.description && (
                <span className="text-xs leading-relaxed text-ink-3">{t.description}</span>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-1 -mt-1 ml-auto grid size-6 shrink-0 place-items-center rounded-xs text-ink-3 hover:bg-surface-2 hover:text-ink-1"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
