import { z } from 'zod';
import {
  ApiErrorSchema,
  SERVICE_BASE_PATH,
  buildPath,
  endpoints,
  type EndpointDef,
  type EndpointId,
} from '@ocpp/contracts';
import { API_URL, REQUEST_TIMEOUT_MS, SIM_API_URL } from './config';
import { ApiClientError, schemaError } from './errors';
import { auth, refreshOnce } from './auth';
import { backendReachability, backendStatus } from './backend-status';

/* ------------------------------------------------------------------ *
 * Types derived from the registry
 * ------------------------------------------------------------------ */

/**
 * Pull `:param` names straight out of the path string at the type level.
 *
 * `'/stations/:id/commands'` becomes the union `'id'`. It means
 * `api.getStation({ params: { id } })` is checked by the compiler and a typo
 * in a parameter name is a build error rather than a 404 at runtime.
 */
type PathParams<S extends string> = S extends `${string}:${infer P}/${infer Rest}`
  ? P | PathParams<`/${Rest}`>
  : S extends `${string}:${infer P}`
    ? P
    : never;

type ParamsOf<E extends EndpointDef> = PathParams<E['path']>;

type QueryOf<E extends EndpointDef> = E extends { query: infer Q }
  ? Q extends z.ZodTypeAny
    ? z.input<Q>
    : never
  : never;

type BodyOf<E extends EndpointDef> = E extends { body: infer B }
  ? B extends z.ZodTypeAny
    ? z.input<B>
    : never
  : never;

export type ResponseOf<E extends EndpointDef> = E['response'] extends z.ZodTypeAny
  ? z.infer<E['response']>
  : never;

type BaseOptions = {
  signal?: AbortSignal;
  /** Skip response validation for one call. Rarely what you want. */
  skipValidation?: boolean;
};

export type CallOptions<E extends EndpointDef> = BaseOptions &
  ([ParamsOf<E>] extends [never]
    ? { params?: undefined }
    : { params: Record<ParamsOf<E>, string | number> }) &
  ([QueryOf<E>] extends [never] ? { query?: undefined } : { query?: QueryOf<E> }) &
  ([BodyOf<E>] extends [never] ? { body?: undefined } : { body: BodyOf<E> });

/* ------------------------------------------------------------------ *
 * Core request
 * ------------------------------------------------------------------ */

function baseUrlFor(service: EndpointDef['service']) {
  return service === 'sim' ? SIM_API_URL : API_URL;
}

/**
 * How a response was served.
 *
 * In learn mode the mock service worker adds this header when it answered from
 * mock data rather than passing the request through to your backend. That is
 * what lets the UI say "this screen is still mocked" per screen.
 */
const SERVED_BY_HEADER = 'x-ocpp-served-by';

async function parseError(res: Response, endpointId: string): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not every error has a JSON body — an nginx 502 certainly does not.
  }

  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiClientError({
      message: e.message,
      // The contract's codes are a closed set; anything else becomes INTERNAL
      // rather than being trusted blindly into the union.
      code: (e.code as ApiClientError['code']) ?? 'INTERNAL',
      status: res.status,
      details: e.details,
      requestId: e.requestId ?? null,
      endpoint: endpointId,
    });
  }

  const code =
    res.status === 401
      ? 'UNAUTHORIZED'
      : res.status === 403
        ? 'FORBIDDEN'
        : res.status === 404
          ? 'NOT_FOUND'
          : res.status === 409
            ? 'CONFLICT'
            : res.status === 429
              ? 'RATE_LIMITED'
              : 'INTERNAL';

  return new ApiClientError({
    message: `${res.status} ${res.statusText || 'Request failed'}`,
    code,
    status: res.status,
    endpoint: endpointId,
  });
}

async function rawRequest(
  def: EndpointDef,
  options: {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const path = buildPath(def, options.params, options.query as Record<string, unknown> | undefined);
  const url = `${baseUrlFor(def.service)}${path}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const token = auth.getAccessToken();
  if (def.auth && token) headers.Authorization = `Bearer ${token}`;

  // Time out ourselves rather than waiting on the browser's default, which can
  // be minutes. Combine with any caller-supplied signal so both can cancel.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  return fetch(url, {
    method: def.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal,
  });
}

async function request<E extends EndpointDef>(
  def: E,
  options: CallOptions<E> = {} as CallOptions<E>,
): Promise<ResponseOf<E>> {
  const started = performance.now();
  const opts = options as {
    params?: Record<string, string | number>;
    query?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
    skipValidation?: boolean;
  };

  let res: Response;
  try {
    res = await rawRequest(def, opts);
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === 'AbortError';
    const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
    backendStatus.record({
      id: def.id,
      servedBy: 'error',
      status: null,
      at: Date.now(),
      durationMs: performance.now() - started,
    });
    if (!aborted) backendReachability.set('offline');
    throw new ApiClientError({
      message: timedOut ? 'Request timed out' : aborted ? 'Request cancelled' : 'Network error',
      code: timedOut ? 'TIMEOUT' : aborted ? 'ABORTED' : 'NETWORK',
      endpoint: def.id,
      cause,
    });
  }

  const servedBy = (res.headers.get(SERVED_BY_HEADER) as 'mock' | null) ?? 'backend';
  backendStatus.record({
    id: def.id,
    servedBy: res.ok ? servedBy : 'error',
    status: res.status,
    at: Date.now(),
    durationMs: performance.now() - started,
  });
  if (servedBy === 'backend' && res.ok) backendReachability.set('online');

  /**
   * One automatic retry on 401, after refreshing.
   *
   * `def.id !== 'refresh'` stops the obvious infinite loop where the refresh
   * call itself 401s and triggers another refresh.
   */
  if (res.status === 401 && def.auth && def.id !== 'refresh' && auth.getRefreshToken()) {
    const refreshed = await refreshOnce(async () => {
      try {
        const r = await rawRequest(endpoints.refresh, {
          body: { refreshToken: auth.getRefreshToken() },
        });
        if (!r.ok) return false;
        const tokens = (await r.json()) as { accessToken: string; refreshToken: string };
        auth.setTokens(tokens);
        return true;
      } catch {
        return false;
      }
    });

    if (refreshed) {
      res = await rawRequest(def, opts);
    } else {
      auth.clear();
    }
  }

  if (!res.ok) throw await parseError(res, def.id);

  // 204 and friends have no body; the contract's AckSchema tolerates this.
  if (res.status === 204) return { success: true } as ResponseOf<E>;

  let json: unknown;
  try {
    json = await res.json();
  } catch (cause) {
    throw new ApiClientError({
      message: 'Response was not valid JSON',
      code: 'SCHEMA',
      status: res.status,
      endpoint: def.id,
      cause,
    });
  }

  if (opts.skipValidation) return json as ResponseOf<E>;

  /**
   * Validate every response against the contract.
   *
   * This is the single most useful thing in this client while you are building
   * a backend. Without it, a missing field surfaces as a blank cell or a crash
   * in a component far from the cause. With it, you get the exact path and the
   * exact mismatch the moment the response arrives.
   */
  const parsed = (def.response as z.ZodTypeAny).safeParse(json);
  if (!parsed.success) {
    throw schemaError(def.id, parsed.error.issues);
  }
  return parsed.data as ResponseOf<E>;
}

/* ------------------------------------------------------------------ *
 * The typed client
 * ------------------------------------------------------------------ */

export type ApiClient = {
  [K in EndpointId]: (
    ...args: [CallOptions<(typeof endpoints)[K]>] extends [Record<string, never>]
      ? [options?: CallOptions<(typeof endpoints)[K]>]
      : [options: CallOptions<(typeof endpoints)[K]>]
  ) => Promise<ResponseOf<(typeof endpoints)[K]>>;
};

/**
 * `api.listStations({ query: { page: 1 } })`, fully typed, no hand-written
 * URLs anywhere. Built by walking the registry once at module load rather than
 * writing ninety wrapper functions that would drift from the contract.
 */
export const api = Object.fromEntries(
  Object.entries(endpoints).map(([key, def]) => [
    key,
    (options?: unknown) => request(def as EndpointDef, (options ?? {}) as never),
  ]),
) as unknown as ApiClient;

/** Escape hatch for anything not in the registry (vendor extensions, probes). */
export { request as rawApiRequest, baseUrlFor };

/* ------------------------------------------------------------------ *
 * Health probe
 * ------------------------------------------------------------------ */

/**
 * Is the backend up?
 *
 * Deliberately does NOT go through `request()`: we want a plain answer without
 * recording an endpoint status or triggering the refresh dance, and we want a
 * short timeout so app boot is never held up by a dead backend.
 */
export async function probeBackend(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}${SERVICE_BASE_PATH.core}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    const ok = res.ok;
    backendReachability.set(ok ? 'online' : 'offline');
    return ok;
  } catch {
    backendReachability.set('offline');
    return false;
  }
}

export async function probeSimulator(timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${SIM_API_URL}${SERVICE_BASE_PATH.sim}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}
