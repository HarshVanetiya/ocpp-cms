/**
 * Runtime configuration.
 *
 * Everything here is read once at module load from Vite's `import.meta.env`,
 * which inlines the values at build time. That means `LEARN_MODE` is a
 * compile-time constant in a production build, so the bundler can delete the
 * entire mock layer — see the comment on `LEARN_MODE` below.
 */

function env(key: string, fallback: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value && value.length > 0 ? value : fallback;
}

/** Where the CPMS backend you are building lives. */
export const API_URL = env('VITE_API_URL', 'http://localhost:3000');

/** Where the simulator backend you are building lives. */
export const SIM_API_URL = env('VITE_SIM_API_URL', 'http://localhost:3100');

/**
 * Learn mode.
 *
 * `npm run dev:learn` sets `VITE_LEARN_MODE=true`. In that mode the app starts
 * a mock backend in a service worker and falls back to it for any endpoint
 * your real backend does not answer yet — so the UI is fully usable on day
 * one, and each page goes live the moment you implement its endpoints.
 *
 * `npm run dev` and `npm run build` leave it false. No mock data is shipped,
 * imported or shown: an endpoint that is not implemented renders a real error
 * state, which is what you want once you are actually building.
 *
 * The `import.meta.env.DEV` guard matters — it makes the flag statically false
 * in a production build so the dynamic `import('@ocpp/mocks')` is dropped from
 * the bundle entirely rather than lazily loaded.
 */
export const LEARN_MODE = import.meta.env.DEV && env('VITE_LEARN_MODE', 'false') === 'true';

/** How long a request may take before we give up, in ms. */
export const REQUEST_TIMEOUT_MS = 15_000;

export const STORAGE_KEYS = {
  accessToken: 'ocpp.auth.access',
  refreshToken: 'ocpp.auth.refresh',
} as const;
