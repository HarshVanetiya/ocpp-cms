import { STORAGE_KEYS } from './config';

/**
 * Token storage.
 *
 * ## Why localStorage, and what it costs you
 *
 * Tokens in localStorage are readable by any script on the page, so an XSS bug
 * becomes an account takeover. The safer production answer is an httpOnly,
 * SameSite=Strict cookie that JavaScript cannot read at all.
 *
 * We use localStorage here because it works without you configuring CORS
 * credentials, cookie domains and CSRF tokens on day one — and because the
 * point of this project is OCPP, not auth infrastructure. The security
 * milestone in the docs shows the cookie migration, and knowing WHY you would
 * migrate is the part worth carrying into an interview.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

let accessToken: string | null = null;
let refreshToken: string | null = null;

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode. The session still works until the tab closes.
  }
}

// Hydrate synchronously so the first render already knows if we are signed in.
if (typeof window !== 'undefined') {
  accessToken = read(STORAGE_KEYS.accessToken);
  refreshToken = read(STORAGE_KEYS.refreshToken);
}

export const auth = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  isAuthenticated: () => accessToken !== null,

  setTokens(tokens: { accessToken: string; refreshToken: string } | null) {
    accessToken = tokens?.accessToken ?? null;
    refreshToken = tokens?.refreshToken ?? null;
    write(STORAGE_KEYS.accessToken, accessToken);
    write(STORAGE_KEYS.refreshToken, refreshToken);
    listeners.forEach((l) => l());
  },

  clear() {
    auth.setTokens(null);
  },

  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * Single-flight refresh.
 *
 * Without this, five parallel requests that all get a 401 fire five refresh
 * calls. Four of them use a refresh token that the first has already rotated,
 * so four fail and the user is signed out for no reason. Holding one shared
 * promise is the whole fix.
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshOnce(doRefresh: () => Promise<boolean>): Promise<boolean> {
  refreshInFlight ??= doRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
