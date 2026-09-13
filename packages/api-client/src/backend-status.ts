import type { EndpointId } from '@ocpp/contracts';

/**
 * Which parts of the backend actually exist yet.
 *
 * This is the bookkeeping behind the best feature of learn mode: the UI can
 * tell you, per screen, whether you are looking at your own data or at mock
 * data. Every response records how it was served, and the dashboard renders a
 * live checklist of your progress against the contract.
 *
 * It is a tiny external store rather than React state because the recording
 * happens inside the fetch layer, which has no component to live in.
 */

export type ServedBy = 'backend' | 'mock' | 'error';

export interface EndpointStatus {
  id: EndpointId | string;
  servedBy: ServedBy;
  status: number | null;
  at: number;
  durationMs: number | null;
}

const statuses = new Map<string, EndpointStatus>();
const listeners = new Set<() => void>();

/** Cached snapshot so `useSyncExternalStore` sees a stable reference. */
let snapshot: EndpointStatus[] = [];

function emit() {
  snapshot = [...statuses.values()];
  listeners.forEach((l) => l());
}

export const backendStatus = {
  record(entry: EndpointStatus) {
    const prev = statuses.get(entry.id);
    // Skip the notify when nothing meaningful changed — otherwise every poll
    // re-renders the whole progress panel.
    if (prev && prev.servedBy === entry.servedBy && prev.status === entry.status) {
      statuses.set(entry.id, entry);
      return;
    }
    statuses.set(entry.id, entry);
    emit();
  },

  get(id: string) {
    return statuses.get(id) ?? null;
  },

  getSnapshot() {
    return snapshot;
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** How many distinct endpoints your backend has answered this session. */
  implementedCount() {
    let n = 0;
    for (const s of statuses.values()) if (s.servedBy === 'backend') n += 1;
    return n;
  },

  reset() {
    statuses.clear();
    emit();
  },
};

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

export type Reachability = 'unknown' | 'online' | 'offline';

let reachability: Reachability = 'unknown';
const reachListeners = new Set<() => void>();

export const backendReachability = {
  get: () => reachability,
  set(next: Reachability) {
    if (next === reachability) return;
    reachability = next;
    reachListeners.forEach((l) => l());
  },
  subscribe(listener: () => void) {
    reachListeners.add(listener);
    return () => reachListeners.delete(listener);
  },
};
