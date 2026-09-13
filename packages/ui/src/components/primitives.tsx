import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

/* ------------------------------------------------------------------ *
 * Panel — the base surface
 * ------------------------------------------------------------------ */

export type PanelTone = 'default' | 'raised' | 'sunken' | 'flush';

const panelTone: Record<PanelTone, string> = {
  default: 'bg-surface-1 border border-line-soft elev-2',
  raised: 'bg-surface-3 border border-line elev-3',
  sunken: 'bg-surface-2 border border-line-soft',
  flush: 'bg-surface-1 border border-line-soft',
};

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: PanelTone;
  /** Adds the standard 20px inset. Turn off for tables and lists. */
  padded?: boolean;
}

/**
 * Every card, sidebar and dialog in all three apps is a Panel. Keeping the
 * elevation vocabulary in one component is what stops a design system drifting
 * into forty slightly different card styles.
 */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { tone = 'default', padded = true, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-lg', panelTone[tone], padded && 'p-5', className)}
      {...rest}
    />
  );
});

/* ------------------------------------------------------------------ *
 * Button
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';
export type ButtonSize = 'sm' | 'md' | 'lg';

const buttonVariant: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink border border-accent font-semibold ' +
    'hover:brightness-110 active:brightness-95 shadow-[var(--shadow-1)]',
  secondary:
    'bg-surface-2 text-ink-1 border border-line elev-1 hover:bg-surface-3 active:brightness-95',
  ghost: 'bg-transparent text-ink-2 border border-transparent hover:bg-surface-2 hover:text-ink-1',
  danger: 'bg-transparent text-danger border border-danger hover:bg-danger-soft',
  dangerSolid: 'bg-danger text-surface-1 border border-danger font-semibold hover:brightness-110',
};

const buttonSize: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-sm',
  md: 'h-9 px-4 text-[13.5px] gap-2 rounded-sm',
  lg: 'h-11 px-5 text-sm gap-2 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks. Keeps the label so width does not jump. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    fullWidth,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button must not be clickable, but we keep it focusable so a
      // keyboard user is not thrown out of the form while a request is in flight.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap font-medium',
        'transition-[filter,background-color,color] duration-150',
        'disabled:opacity-50 disabled:pointer-events-none',
        buttonVariant[variant],
        buttonSize[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control is invisible to a screen reader without it. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, ...rest },
  ref,
) {
  const box = size === 'sm' ? 'size-8' : size === 'lg' ? 'size-11' : 'size-9';
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-sm transition-colors duration-150',
        'disabled:opacity-50 disabled:pointer-events-none',
        buttonVariant[variant],
        box,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */

export type Tone = 'neutral' | 'accent' | 'info' | 'warn' | 'danger' | 'violet';

const badgeTone: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2 border-line',
  accent: 'bg-accent-soft text-accent border-accent',
  info: 'bg-info-soft text-info border-info',
  warn: 'bg-warn-soft text-warn border-warn',
  danger: 'bg-danger-soft text-danger border-danger',
  violet: 'bg-violet-soft text-violet border-violet',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Renders a leading dot. `solid` means "energy is moving right now". */
  dot?: 'none' | 'hollow' | 'solid' | 'pulse';
  mono?: boolean;
}

export function Badge({
  tone = 'neutral',
  dot = 'none',
  mono,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-2.5 py-1',
        'text-[11.5px] font-medium leading-none',
        mono && 'font-mono',
        badgeTone[tone],
        className,
      )}
      {...rest}
    >
      {dot !== 'none' && (
        <span
          aria-hidden
          className={cn(
            'size-[7px] shrink-0 rounded-full',
            dot === 'hollow' ? 'border-[1.5px] border-current' : 'bg-current',
            dot === 'pulse' && 'pulse-dot',
          )}
        />
      )}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * StatusDot
 * ------------------------------------------------------------------ */

export interface StatusDotProps {
  tone?: Tone;
  filled?: boolean;
  pulse?: boolean;
  /** A dot alone never conveys meaning — give it an accessible name. */
  label: string;
  className?: string;
}

const dotTone: Record<Tone, string> = {
  neutral: 'text-ink-3',
  accent: 'text-accent',
  info: 'text-info',
  warn: 'text-warn',
  danger: 'text-danger',
  violet: 'text-violet',
};

export function StatusDot({
  tone = 'neutral',
  filled = true,
  pulse,
  label,
  className,
}: StatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-block size-[7px] shrink-0 rounded-full',
        filled ? 'bg-current' : 'border-[1.5px] border-current',
        pulse && 'pulse-dot',
        dotTone[tone],
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Typography helpers
 * ------------------------------------------------------------------ */

export function SectionTitle({ className, children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('font-display text-[15.5px] font-semibold tracking-[-0.01em]', className)}
      {...rest}
    >
      {children}
    </h2>
  );
}

export function Overline({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3',
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export function Muted({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-xs text-ink-3', className)} {...rest}>
      {children}
    </p>
  );
}

/** Horizontal rule that matches the hairline vocabulary. */
export function Divider({ className, ...rest }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cn('border-0 border-t border-line-soft', className)} {...rest} />;
}
