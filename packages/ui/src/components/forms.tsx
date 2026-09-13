import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../lib/cn';

/* ------------------------------------------------------------------ *
 * Field — label + control + help/error
 * ------------------------------------------------------------------ */

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
}

/**
 * Wires up the accessibility plumbing that hand-written forms always forget:
 * a real `<label for>`, `aria-describedby` pointing at the hint AND the error,
 * and `aria-invalid` on the control.
 *
 * Using a render prop rather than cloning children keeps it explicit — you can
 * see exactly which element receives the id.
 */
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={id}
          className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3"
        >
          {label}
          {required && (
            <span className="ml-1 text-danger" aria-hidden>
              *
            </span>
          )}
        </label>
      )}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

const controlBase =
  'w-full bg-surface-2 border border-line rounded-sm text-ink-1 placeholder:text-ink-3 ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger-soft';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  suffix?: ReactNode;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { icon, suffix, mono, className, ...rest },
  ref,
) {
  const field = (
    <input
      ref={ref}
      className={cn(
        controlBase,
        'h-9 px-3 text-[13px]',
        mono && 'font-mono',
        icon && 'pl-9',
        suffix && 'pr-9',
        className,
      )}
      {...rest}
    />
  );
  if (!icon && !suffix) return field;
  return (
    <div className="relative">
      {icon && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 [&>svg]:size-4"
        >
          {icon}
        </span>
      )}
      {field}
      {suffix && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 [&>svg]:size-4">
          {suffix}
        </span>
      )}
    </div>
  );
});

export const SearchInput = forwardRef<HTMLInputElement, InputProps>(function SearchInput(
  { placeholder = 'Search', ...rest },
  ref,
) {
  return <Input ref={ref} type="search" icon={<Search />} placeholder={placeholder} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(controlBase, 'resize-y px-3 py-2 text-[13px] leading-relaxed', className)}
        {...rest}
      />
    );
  },
);

/* ------------------------------------------------------------------ *
 * Select (native — deliberately)
 * ------------------------------------------------------------------ */

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

/**
 * A native `<select>`, not a custom dropdown.
 *
 * Custom listboxes are a large amount of code to get right for keyboards,
 * screen readers and mobile. The native control is already correct everywhere
 * and looks fine once styled. Reach for a custom one only when you genuinely
 * need multi-select with search — and then use a tested library.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, className, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(controlBase, 'h-9 appearance-none pl-3 pr-9 text-[13px]', className)}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3"
      />
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * Switch
 * ------------------------------------------------------------------ */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: string;
  tone?: 'accent' | 'warn' | 'info';
  disabled?: boolean;
  className?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  tone = 'accent',
  disabled,
  className,
}: SwitchProps) {
  const on =
    tone === 'warn' ? 'bg-warn' : tone === 'info' ? 'bg-info' : 'bg-accent';
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-sm border p-3 transition-colors',
        checked
          ? tone === 'warn'
            ? 'border-warn bg-warn-soft'
            : tone === 'info'
              ? 'border-info bg-info-soft'
              : 'border-accent bg-accent-soft'
          : 'border-line-soft bg-surface-2',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200',
          checked ? on : 'bg-line',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 size-4 rounded-full transition-[left] duration-200',
            checked ? 'left-[18px] bg-surface-1' : 'left-0.5 bg-ink-3',
          )}
        />
      </button>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-ink-1">{label}</span>
        {description && <span className="text-[10.5px] text-ink-3">{description}</span>}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Checkbox
 * ------------------------------------------------------------------ */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest },
  ref,
) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2.5', className)}>
      <span className="relative inline-flex">
        <input ref={ref} type="checkbox" className="peer sr-only" {...rest} />
        <span
          aria-hidden
          className={cn(
            'inline-flex size-4 items-center justify-center rounded-[4px] border border-line bg-surface-2',
            'transition-colors peer-checked:border-accent peer-checked:bg-accent',
            'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          )}
        >
          <Check className="size-3 text-accent-ink opacity-0 peer-checked:opacity-100" />
        </span>
      </span>
      {label && <span className="text-[13px] text-ink-1">{label}</span>}
    </label>
  );
});

/* ------------------------------------------------------------------ *
 * SegmentedControl
 * ------------------------------------------------------------------ */

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  /** Accessible name for the group, e.g. "Time range". */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The range pickers and protocol filters across all three apps.
 *
 * Built on real radio semantics (`role="radiogroup"`), so arrow keys work and
 * a screen reader announces "2 of 4". A row of buttons would not.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-[3px] rounded-sm border border-line-soft bg-surface-2 p-[3px]',
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-xs font-medium transition-colors duration-150',
              size === 'sm' ? 'px-2.5 py-1 text-[11.5px]' : 'px-3 py-1.5 text-xs',
              selected
                ? 'bg-surface-3 font-semibold text-ink-1 elev-1'
                : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * FilterChip
 * ------------------------------------------------------------------ */

export interface FilterChipProps {
  label: string;
  value: string;
  onRemove: () => void;
  tone?: 'neutral' | 'danger' | 'accent';
}

export function FilterChip({ label, value, onRemove, tone = 'neutral' }: FilterChipProps) {
  return (
    <span
      className={cn(
        'inline-flex h-[30px] items-center gap-2 rounded-sm border px-2.5 text-xs',
        tone === 'danger'
          ? 'border-danger bg-danger-soft font-medium text-danger'
          : tone === 'accent'
            ? 'border-accent bg-accent-soft font-medium text-accent'
            : 'border-line bg-surface-2 text-ink-1',
      )}
    >
      <span className="font-mono text-ink-3">{label}</span>
      {value}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        className="-mr-1 grid size-4 place-items-center rounded-xs hover:bg-surface-3"
      >
        <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}
