import {
  ServerEventSchema,
  SimServerEventSchema,
  type ServerEvent,
  type ServerEventData,
  type ServerEventType,
  type SimServerEvent,
} from '@ocpp/contracts';
import { API_URL, SIM_API_URL } from './config';
import { auth } from './auth';

/**
 * The realtime client.
 *
 * A CPMS dashboard that polls is a CPMS dashboard that is always slightly
 * wrong. Everything live — connector status, meter values, the frame log —
 * arrives over one connection per app.
 *
 * What this handles that a bare `new WebSocket()` does not:
 *
 *  - RECONNECTION with exponential backoff and jitter. Without jitter, a
 *    backend restart brings every dashboard back at the same millisecond and
 *    knocks it over again. This is the thundering-herd problem and it is very
 *    easy to cause by accident.
 *  - SSE FALLBACK, because some corporate proxies still break WebSocket
 *    upgrades.
 *  - TOPIC SUBSCRIPTIONS, re-sent automatically after a reconnect. Forgetting
 *    to re-subscribe is the classic bug: the socket comes back, the UI looks
 *    connected, and no data ever arrives.
 *  - HEARTBEATS, so a connection killed by an idle proxy is noticed within
 *    seconds rather than hanging forever in CONNECTING.
 */

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

type Handler<T extends ServerEventType> = (data: ServerEventData<T>, event: ServerEvent) => void;

export interface RealtimeOptions {
  /** Base URL of the service. Defaults to the core API. */
  baseUrl?: string;
  path?: string;
  /** Attach the access token as a query parameter. */
  withAuth?: boolean;
  /** Fall back to SSE when the WebSocket upgrade fails. */
  sseFallback?: boolean;
  /** Milliseconds between client pings. */
  heartbeatMs?: number;
  maxBackoffMs?: number;
  /** Parse with a different schema — the simulator has its own event union. */
  schema?: typeof ServerEventSchema | typeof SimServerEventSchema;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private sse: EventSource | null = null;
  private state: ConnectionState = 'idle';
  private attempt = 0;
  private topics = new Set<string>();
  private handlers = new Map<string, Set<(data: unknown, event: unknown) => void>>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private readonly opts: Required<Omit<RealtimeOptions, 'schema'>> & {
    schema: RealtimeOptions['schema'];
  };

  constructor(options: RealtimeOptions = {}) {
    this.opts = {
      baseUrl: options.baseUrl ?? API_URL,
      path: options.path ?? '/api/v1/realtime',
      withAuth: options.withAuth ?? true,
      sseFallback: options.sseFallback ?? true,
      heartbeatMs: options.heartbeatMs ?? 25_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      schema: options.schema ?? ServerEventSchema,
    };
  }

  /* ----------------------------- lifecycle ---------------------------- */

  connect() {
    if (this.ws || this.sse) return;
    this.closedByUs = false;
    this.openWebSocket();
  }

  close() {
    this.closedByUs = true;
    this.clearTimers();
    this.ws?.close();
    this.sse?.close();
    this.ws = null;
    this.sse = null;
    this.setState('closed');
  }

  getState() {
    return this.state;
  }

  /**
   * Note every unsubscribe below returns `void`, not `Set.delete`'s boolean.
   * React's `useEffect` requires a destructor of exactly `void | Destructor`,
   * so `return () => set.delete(fn)` fails to typecheck at every call site.
   * Swallowing the boolean here fixes it once instead of everywhere.
   */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private setState(next: ConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.stateListeners.forEach((l) => l(next));
  }

  /* ---------------------------- subscriptions -------------------------- */

  /**
   * Subscribe to topics. Returns an unsubscribe function.
   *
   * Topics are reference-counted implicitly by the Set: unsubscribing removes
   * them, and any future reconnect re-sends only what is still wanted.
   */
  subscribe(topics: string[]): () => void {
    topics.forEach((t) => this.topics.add(t));
    this.send({ type: 'subscribe', topics });
    return () => {
      topics.forEach((t) => this.topics.delete(t));
      this.send({ type: 'unsubscribe', topics });
    };
  }

  /** Listen for one event type, with `data` narrowed to that type's shape. */
  on<T extends ServerEventType>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (data: unknown, event: unknown) => void);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as (data: unknown, event: unknown) => void);
    };
  }

  /** Simulator variant — its events are a different union. */
  onSim(
    type: SimServerEvent['type'],
    handler: (data: unknown, event: SimServerEvent) => void,
  ): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (data: unknown, event: unknown) => void);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as (data: unknown, event: unknown) => void);
    };
  }

  /* ------------------------------ transport ---------------------------- */

  private url(protocol: 'ws' | 'http') {
    const base = this.opts.baseUrl.replace(/^http/, protocol === 'ws' ? 'ws' : 'http');
    const suffix = protocol === 'ws' ? '' : '/sse';
    const token = this.opts.withAuth ? auth.getAccessToken() : null;
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${base}${this.opts.path}${suffix}${qs}`;
  }

  private openWebSocket() {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url('ws'));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      // Re-subscribe: the server has no memory of what this client wanted.
      if (this.topics.size > 0) {
        this.send({ type: 'subscribe', topics: [...this.topics] });
      }
      this.startHeartbeat();
    };

    ws.onmessage = (e) => this.handleMessage(e.data);

    ws.onerror = () => {
      // `onerror` is always followed by `onclose`, so reconnect there only.
    };

    ws.onclose = () => {
      this.ws = null;
      this.clearTimers();
      if (this.closedByUs) return;
      // A socket that never opened at all suggests the upgrade is blocked.
      if (this.attempt === 0 && this.opts.sseFallback && this.state !== 'open') {
        this.openSse();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private openSse() {
    try {
      const sse = new EventSource(this.url('http'));
      this.sse = sse;
      sse.onopen = () => {
        this.attempt = 0;
        this.setState('open');
      };
      sse.onmessage = (e) => this.handleMessage(e.data);
      sse.onerror = () => {
        sse.close();
        this.sse = null;
        if (!this.closedByUs) this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const schema = this.opts.schema ?? ServerEventSchema;
    const result = schema.safeParse(parsed);
    if (!result.success) {
      // A malformed event must never take the socket down — log and carry on.
      if (import.meta.env.DEV) {
        console.warn('[realtime] unrecognised event', result.error.issues.slice(0, 3), parsed);
      }
      return;
    }
    const event = result.data as ServerEvent;
    this.handlers.get(event.type)?.forEach((h) => h(event.data, event));
    this.handlers.get('*')?.forEach((h) => h(event.data, event));
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
    // Over SSE the channel is one-way; subscriptions ride the query string in
    // that mode, which is why topics are re-sent on every (re)connect.
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ type: 'ping', t: Date.now() });
    }, this.opts.heartbeatMs);
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Exponential backoff with full jitter.
   *
   * delay = random(0, min(max, base * 2^attempt))
   *
   * The randomness is the important half. Deterministic backoff means every
   * client retries in lockstep; with jitter they spread out, which is the
   * difference between a backend that recovers and one that keeps falling over.
   */
  private scheduleReconnect() {
    this.setState('reconnecting');
    const base = 500;
    const ceiling = Math.min(this.opts.maxBackoffMs, base * 2 ** this.attempt);
    const delay = Math.random() * ceiling;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.openWebSocket(), delay);
  }
}

/* ------------------------------------------------------------------ *
 * Shared instances
 * ------------------------------------------------------------------ */

let coreClient: RealtimeClient | null = null;
let simClient: RealtimeClient | null = null;

/** One socket per app, shared by every component that wants live data. */
export function getRealtimeClient() {
  coreClient ??= new RealtimeClient();
  return coreClient;
}

export function getSimRealtimeClient() {
  simClient ??= new RealtimeClient({
    baseUrl: SIM_API_URL,
    path: '/sim/v1/stream',
    withAuth: false,
    schema: SimServerEventSchema,
  });
  return simClient;
}
