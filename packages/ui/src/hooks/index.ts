import { useCallback, useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

export type ThemeMode = 'light' | 'dark' | 'system';

const THEME_KEY = 'ocpp.theme';

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Theme, stored per browser.
 *
 * `system` is a real third state, not "light". A user who has never chosen
 * should follow their OS, and should keep following it when they change it at
 * sunset — which only works if we store "system" rather than resolving it once.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark';
    return (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? 'dark';
  });

  const resolved: 'light' | 'dark' =
    mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // Private browsing can throw on write. The theme still applies for this
      // page load; only the memory of it is lost.
    }
  }, [mode, resolved]);

  // Follow the OS while in `system` mode.
  useEffect(() => {
    if (mode !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => (m === 'dark' ? 'light' : 'dark'));
  }, []);

  return { mode, resolved, setMode, toggle };
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota or private mode. Non-fatal by design.
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/* ------------------------------------------------------------------ *
 * Media query
 * ------------------------------------------------------------------ */

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/* ------------------------------------------------------------------ *
 * Interval
 * ------------------------------------------------------------------ */

/**
 * setInterval that survives re-renders without restarting.
 *
 * The naive version puts `callback` in the dependency array, which restarts
 * the timer on every render — so a 1s ticker in a component that re-renders
 * every 200ms never fires. Holding the callback in a ref fixes it.
 *
 * Pass `null` as the delay to pause.
 */
export function useInterval(callback: () => void, delay: number | null) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

/* ------------------------------------------------------------------ *
 * Debounce
 * ------------------------------------------------------------------ */

/** Debounced mirror of a value — for search boxes that hit the network. */
export function useDebounced<T>(value: T, delayMs = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/* ------------------------------------------------------------------ *
 * Clipboard
 * ------------------------------------------------------------------ */

export function useCopyToClipboard(resetMs = 1600) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        return false;
      }
    },
    [resetMs],
  );
  return { copied, copy };
}

/* ------------------------------------------------------------------ *
 * Live clock
 * ------------------------------------------------------------------ */

/** Re-renders on a tick, for "2m ago" labels and running session timers. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), intervalMs);
  return now;
}
