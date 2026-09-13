/**
 * Formatting.
 *
 * Every number a user sees in this project goes through one of these. They
 * live in the design system rather than in each app because "how do we show
 * energy" is a design decision, and because three apps disagreeing about
 * whether it is "8.4 kWh" or "8.42kWh" looks amateurish.
 */

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/**
 * Minor units to a display string.
 *
 * Remember the rule from the contracts package: money is ALWAYS an integer in
 * minor units until the moment it is rendered. This function is that moment,
 * and it should be the only place a division by 100 happens.
 */
export function formatMoney(
  minor: number | null | undefined,
  currency = 'EUR',
  opts: { showSymbol?: boolean; maximumFractionDigits?: number } = {},
) {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '—';
  const { showSymbol = true, maximumFractionDigits = 2 } = opts;
  return new Intl.NumberFormat(undefined, {
    style: showSymbol ? 'currency' : 'decimal',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(minor / 100);
}

/** Just the symbol, for a label beside a big number. */
export function currencySymbol(currency = 'EUR') {
  const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? currency;
}

/* ------------------------------------------------------------------ *
 * Energy and power
 * ------------------------------------------------------------------ */

/**
 * Watt-hours to a human string, choosing the unit by magnitude.
 *
 * We store Wh everywhere (see the contracts package) and only convert here.
 * A session is kWh, a site's monthly total is MWh, and showing "18400000 Wh"
 * to an operator is technically correct and completely useless.
 */
export function formatEnergy(wh: number | null | undefined, opts: { digits?: number } = {}) {
  if (wh === null || wh === undefined || !Number.isFinite(wh)) return '—';
  const abs = Math.abs(wh);
  const digits = opts.digits;
  if (abs >= 1_000_000)
    return `${(wh / 1_000_000).toFixed(digits ?? 1)} MWh`;
  if (abs >= 1_000) return `${(wh / 1_000).toFixed(digits ?? 2)} kWh`;
  return `${Math.round(wh)} Wh`;
}

/** Splits the value from the unit, for the big-number + small-unit layout. */
export function splitEnergy(wh: number | null | undefined, digits?: number) {
  if (wh === null || wh === undefined || !Number.isFinite(wh)) return { value: '—', unit: '' };
  const abs = Math.abs(wh);
  if (abs >= 1_000_000) return { value: (wh / 1_000_000).toFixed(digits ?? 1), unit: 'MWh' };
  if (abs >= 1_000) return { value: (wh / 1_000).toFixed(digits ?? 2), unit: 'kWh' };
  return { value: String(Math.round(wh)), unit: 'Wh' };
}

export function formatPower(kw: number | null | undefined, digits = 1) {
  if (kw === null || kw === undefined || !Number.isFinite(kw)) return '—';
  return `${kw.toFixed(digits)} kW`;
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/**
 * Seconds to a compact duration.
 *
 * Sessions run from seconds to many hours, so a fixed format is always wrong
 * for half of them. Under an hour we say "46 min"; over, "2h 14m".
 */
export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${h}h ${String(rem).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Zero-padded clock for a running timer: 02:14:38. */
export function formatClock(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });

/**
 * "just now", "4m ago", "3d ago".
 *
 * Pass `now` so a list of 200 rows shares one clock reading. Calling
 * `Date.now()` inside the loop makes rows disagree by milliseconds, which is
 * invisible but means React sees new strings and re-renders more than needed.
 */
export function formatRelative(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = (then - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return RELATIVE.format(Math.round(diff / 3600), 'hour');
  if (abs < 2_592_000) return RELATIVE.format(Math.round(diff / 86_400), 'day');
  return RELATIVE.format(Math.round(diff / 2_592_000), 'month');
}

export function formatTime(iso: string | null | undefined) {
  if (!iso) return '—';
  // hour12:false always. A protocol log in 12-hour time is wider, harder to
  // sort by eye, and differs between the developer's machine and the server's.
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** With milliseconds — the frame log needs them to order fast exchanges. */
export function formatTimeMs(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const clock = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${clock}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ *
 * Numbers
 * ------------------------------------------------------------------ */

export function formatNumber(n: number | null | undefined, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Compact counts for badges: 1.2k, 3.4M. */
export function formatCompact(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatPercent(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function formatDistance(metres: number | null | undefined) {
  if (metres === null || metres === undefined || !Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Never show a full token on screen; support tickets get screenshotted. */
export function maskToken(value: string, visible = 4) {
  if (value.length <= visible) return value;
  return `${'•'.repeat(Math.min(8, value.length - visible))}${value.slice(-visible)}`;
}
