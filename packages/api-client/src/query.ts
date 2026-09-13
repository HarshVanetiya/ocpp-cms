import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { EndpointId, ServerEventData, ServerEventType } from '@ocpp/contracts';
import { endpoints } from '@ocpp/contracts';
import { ApiClientError } from './errors';
import { api, type ApiClient, type CallOptions, type ResponseOf } from './http';
import { backendReachability, backendStatus } from './backend-status';
import { getRealtimeClient, type ConnectionState, type RealtimeClient } from './realtime';

/* ------------------------------------------------------------------ *
 * Query client
 * ------------------------------------------------------------------ */

/**
 * Defaults chosen for an operations console, not a blog.
 *
 * `staleTime: 15s` — fleet data changes constantly, but refetching on every
 * component mount makes tab-switching feel laggy and hammers a backend you are
 * still writing. Realtime events invalidate precisely, so staleness is short
 * but not zero.
 *
 * `retry` — never retry a 4xx. A 404 will still be a 404 in 200ms, and
 * retrying a rejected command can issue it twice. Only network-ish failures
 * are worth a second try.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiClientError) {
            if (!error.retryable) return false;
            return failureCount < 2;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        // A mutation that failed already did something, or did not. Retrying it
        // automatically risks doing it twice. Let the user decide.
        retry: false,
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * Query keys
 * ------------------------------------------------------------------ */

/**
 * Keys are `[endpointId, params, query]`.
 *
 * Deriving them from the registry means a key can never drift from the call it
 * describes, and `invalidate('listStations')` reliably matches every variant
 * of that query regardless of filters.
 */
export function queryKey(id: EndpointId, options?: { params?: unknown; query?: unknown }) {
  return [id, options?.params ?? null, options?.query ?? null] as const;
}

/** Invalidate every cached variant of an endpoint. */
export function useInvalidate() {
  const qc = useQueryClient();
  return useCallback(
    (...ids: EndpointId[]) => {
      ids.forEach((id) => void qc.invalidateQueries({ queryKey: [id] }));
    },
    [qc],
  );
}

/* ------------------------------------------------------------------ *
 * Typed hooks
 * ------------------------------------------------------------------ */

type EndpointsMap = typeof endpoints;

export type ApiQueryOptions<K extends EndpointId> = Omit<
  UseQueryOptions<ResponseOf<EndpointsMap[K]>, ApiClientError>,
  'queryKey' | 'queryFn'
>;

/**
 * `useApiQuery('listStations', { query: { page } })`.
 *
 * One hook for every GET in the contract. The endpoint id gives you the return
 * type, the parameter types and the cache key with nothing to wire up.
 */
export function useApiQuery<K extends EndpointId>(
  id: K,
  options?: CallOptions<EndpointsMap[K]>,
  queryOptions?: ApiQueryOptions<K>,
) {
  return useQuery<ResponseOf<EndpointsMap[K]>, ApiClientError>({
    queryKey: queryKey(id, options as { params?: unknown; query?: unknown } | undefined),
    queryFn: ({ signal }) =>
      (api[id] as (o: unknown) => Promise<ResponseOf<EndpointsMap[K]>>)({
        ...(options ?? {}),
        signal,
      }),
    ...queryOptions,
  });
}

export type ApiMutationOptions<K extends EndpointId, TVars> = Omit<
  UseMutationOptions<ResponseOf<EndpointsMap[K]>, ApiClientError, TVars>,
  'mutationFn'
> & {
  /** Endpoints to invalidate on success. */
  invalidates?: EndpointId[];
};

/**
 * `useApiMutation('sendCommand', { invalidates: ['listCommands'] })`.
 *
 * The variables you pass to `mutate()` are the call options, so the same typed
 * params/body checking applies.
 */
export function useApiMutation<K extends EndpointId>(
  id: K,
  options?: ApiMutationOptions<K, CallOptions<EndpointsMap[K]>>,
) {
  const qc = useQueryClient();
  const { invalidates, onSuccess, ...rest } = options ?? {};
  return useMutation<ResponseOf<EndpointsMap[K]>, ApiClientError, CallOptions<EndpointsMap[K]>>({
    mutationFn: (vars) =>
      (api[id] as (o: unknown) => Promise<ResponseOf<EndpointsMap[K]>>)(vars ?? {}),
    // Spread rather than naming the callback arguments: TanStack Query has
    // added parameters to this signature across minor versions, and forwarding
    // them blind keeps this wrapper working across upgrades.
    onSuccess: (...args) => {
      invalidates?.forEach((key) => void qc.invalidateQueries({ queryKey: [key] }));
      onSuccess?.(...args);
    },
    ...rest,
  });
}

/* ------------------------------------------------------------------ *
 * Backend status hooks
 * ------------------------------------------------------------------ */

/** Live list of which endpoints your backend has answered this session. */
export function useBackendStatus() {
  return useSyncExternalStore(
    backendStatus.subscribe,
    backendStatus.getSnapshot,
    backendStatus.getSnapshot,
  );
}

/** Is your backend reachable at all? Drives the sidebar indicator. */
export function useBackendReachability() {
  return useSyncExternalStore(
    backendReachability.subscribe,
    backendReachability.get,
    backendReachability.get,
  );
}

/**
 * How this particular screen is being served.
 *
 * Pass the endpoints a screen depends on and get back whether they are all
 * real yet. This is what puts the "still mocked" badge on a page in learn mode
 * and removes it the moment you implement the route.
 */
export function useServedBy(ids: EndpointId[]) {
  const statuses = useBackendStatus();
  const relevant = statuses.filter((s) => ids.includes(s.id as EndpointId));
  if (relevant.length === 0) return 'unknown' as const;
  if (relevant.every((s) => s.servedBy === 'backend')) return 'backend' as const;
  if (relevant.some((s) => s.servedBy === 'mock')) return 'mock' as const;
  return 'error' as const;
}

/* ------------------------------------------------------------------ *
 * Realtime hooks
 * ------------------------------------------------------------------ */

/**
 * Subscribe to topics for as long as the component is mounted.
 *
 * The dependency on `topics.join()` rather than `topics` is deliberate: an
 * inline array literal is a new reference on every render, which would
 * unsubscribe and resubscribe in a loop.
 */
export function useRealtimeTopics(topics: string[], client: RealtimeClient = getRealtimeClient()) {
  const joined = topics.join('|');
  useEffect(() => {
    if (topics.length === 0) return;
    return client.subscribe(joined.split('|'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, client]);
}

/** Run a handler on every event of one type. */
export function useRealtimeEvent<T extends ServerEventType>(
  type: T,
  handler: (data: ServerEventData<T>) => void,
  client: RealtimeClient = getRealtimeClient(),
) {
  useEffect(() => client.on(type, handler), [type, handler, client]);
}

export function useRealtimeConnection(client: RealtimeClient = getRealtimeClient()) {
  const subscribe = useCallback(
    (cb: () => void) => client.onStateChange(() => cb()),
    [client],
  );
  const get = useCallback(() => client.getState(), [client]);
  return useSyncExternalStore(subscribe, get, () => 'idle' as ConnectionState);
}

export type { ApiClient };
