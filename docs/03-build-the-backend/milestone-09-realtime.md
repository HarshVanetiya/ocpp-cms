# Milestone 9 — Realtime and logs

**Goal:** the dashboard stops polling. The frame inspector goes live.

**Time:** 3–4 hours.

**Endpoints:** 2 — `ocppLog`, `systemLog` — plus the WebSocket and its SSE
fallback.

---

## Why this exists

Two separate wins, and they share a mechanism.

**The frame inspector** is the most useful screen in the whole project. Every
OCPP message, in and out, stored verbatim, request stitched to response, with
timing and validation state. When a station misbehaves in the field, this is
where you look — and "I built a protocol inspector" is a much better sentence
in an interview than "I built a CRUD dashboard".

**Realtime** is what makes a CPMS feel like an operations tool rather than a
report. A dashboard that polls every 5 seconds is always up to 5 seconds wrong,
and 500 dashboards polling is 100 requests a second doing nothing.

---

## Build it

### 1. Log every frame, on the way past

You already have the `ocpp_frames` table from Milestone 4. Now fill it — in the
one place every frame goes through.

```ts
// src/ocpp/frame-log.ts
import { query } from '../db/index.js';
import { publish } from '../realtime/bus.js';
import { validateFrame } from './router.js';
import { logger } from '../logger.js';

export interface FrameRecord {
  stationId: string | null;
  stationIdentity: string;
  protocol: string;
  direction: 'inbound' | 'outbound';
  messageTypeId: number;
  messageId: string;
  action: string | null;
  payload: unknown;
  raw: string;
  errorCode?: string | null;
  errorDescription?: string | null;
  sessionId?: string | null;
}

/**
 * Never await this on the hot path.
 *
 * A station's Heartbeat must not wait for a disk write. If the database is
 * slow, OCPP responses get slow, stations time out, and a logging problem
 * becomes an availability problem. Fire and forget, and catch — a failed log
 * write must never propagate into the message handler.
 */
export function logFrame(record: FrameRecord) {
  void persist(record).catch((err) => logger.error({ err }, 'frame log write failed'));
  // Publishing is synchronous and in-memory, so the inspector is live even
  // if the database write is queued behind something.
  publishExchange(record);
}

async function persist(r: FrameRecord) {
  /**
   * Validation state is stored, not just computed.
   *
   * `validateFrame` runs the payload through the SAME Zod schema the
   * handler uses — you already wrote it, so this costs you nothing:
   *
   *   export function validateFrame(protocol, action, payload) {
   *     const handler = handlers[protocol].get(action);
   *     if (!handler) return null;                 // no schema, did not try
   *     const r = handler.schema.safeParse(payload);
   *     return r.success
   *       ? { valid: true, errors: null }
   *       : { valid: false, errors: r.error.issues.map(i =>
   *           `${i.path.join('.') || '(root)'}: ${i.message}`) };
   *   }
   *
   * Persisting the result turns the inspector into a conformance tool: "show
   * me every frame this station got wrong" is then one WHERE clause. Null
   * means we did not try — an action we have no schema for, which is honest
   * and different from "passed".
   */
  const check = r.action ? validateFrame(r.protocol, r.action, r.payload) : null;

  await query(
    `INSERT INTO ocpp_frames
       (occurred_at, station_id, station_identity, protocol, direction, message_type,
        message_id, action, payload, raw, error_code, error_description, session_id,
        valid, validation_errors)
     VALUES (now(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      r.stationId, r.stationIdentity, r.protocol, r.direction, r.messageTypeId,
      r.messageId, r.action, JSON.stringify(r.payload ?? null), r.raw,
      r.errorCode ?? null, r.errorDescription ?? null, r.sessionId ?? null,
      check ? check.valid : null,
      check && !check.valid ? check.errors : null,
    ],
  );
}
```

Call it from exactly two places in `src/ocpp/gateway.ts` — every inbound frame
and every outbound one:

```ts
// inbound, right after parseFrame
logFrame({
  stationIdentity: connection.identity,
  stationId: connection.stationId,
  protocol: connection.protocol,
  direction: 'inbound',
  messageTypeId: frame.type,
  messageId: frame.messageId,
  action: frame.action ?? null,
  payload: frame.payload,
  raw: text,
});
```

```ts
// outbound, in a small wrapper so nothing sends without being logged
function send(connection: Connection, frameText: string, meta: Omit<FrameRecord, 'raw'|'direction'>) {
  connection.socket.send(frameText);
  logFrame({ ...meta, direction: 'outbound', raw: frameText });
}
```

> **Store the raw string.** When a station sends `{"connectorId":"1"}` with a
> string where an integer belongs, your parsed version is either a coerced `1`
> or a parse failure — neither shows you what actually arrived. The raw column
> is the one that answers "is this our bug or theirs?", which is the question
> you will be asked.

### 2. Stitching request to response

A CALLRESULT carries only a message id. To show `BootNotification → Accepted
(43 ms)` you must pair it back to its request.

There are two designs, and the contract's comment tells you which one we chose
and why. We **write one row per frame** (append-only, no locks, fast) and
**join at read time** into exchanges.

```sql
-- The read-time stitch. A LATERAL join, so it stops at the first match
-- instead of building the full cross product.
SELECT
  req.id, req.message_id, req.occurred_at AS timestamp, req.station_id,
  req.station_identity, req.protocol, req.direction, req.action,
  to_jsonb(req.*) AS request,
  to_jsonb(res.*) AS response,
  EXTRACT(epoch FROM (res.occurred_at - req.occurred_at)) * 1000 AS duration_ms,
  CASE
    WHEN res.id IS NULL              THEN 'pending'
    WHEN res.message_type = 4        THEN 'error'
    ELSE 'ok'
  END AS outcome,
  req.session_id
FROM ocpp_frames req
LEFT JOIN LATERAL (
  SELECT * FROM ocpp_frames r
   WHERE r.message_id = req.message_id
     AND r.message_type IN (3, 4)          -- CALLRESULT or CALLERROR
     AND r.direction <> req.direction      -- the answer comes back the other way
     AND r.occurred_at >= req.occurred_at
   ORDER BY r.occurred_at
   LIMIT 1
) res ON true
WHERE req.message_type = 2                 -- only CALLs start an exchange
  AND ($1::text IS NULL OR req.station_identity = $1)
  AND ($2::timestamptz IS NULL OR req.occurred_at < $2)
ORDER BY req.occurred_at DESC
LIMIT $3;
```

Three details that matter:

- **`r.direction <> req.direction`.** Message ids are only unique per
  connection per direction. A station and a CSMS can both be using the id
  `"5"` at the same time, in opposite directions. Ignore direction and you
  will occasionally pair a station's answer with your own question.
- **`message_type = 2` only.** A CALLRESULT is never the start of an exchange.
- **`outcome = 'pending'`** covers both "still in flight" and "never answered".
  Milestone 3's timeout is what eventually makes the difference visible; a
  sweeper marking old pendings as `timeout` is a nice five-line addition.

### 3. Cursor pagination, and why the log is different

Every other list endpoint uses offset pagination. The log uses a cursor, and
the contract says why: **the table grows while you are reading it.** With
offset pagination, twenty new frames arriving between page 1 and page 2 push
everything down and you see the same rows twice.

```ts
// src/api/routes/logs.ts
import { OcppLogQuerySchema } from '@ocpp/contracts';

app.get('/logs/ocpp', async (request) => {
  const q = OcppLogQuerySchema.parse(request.query);

  /**
   * The cursor is an opaque string to the client and a (timestamp, id) pair
   * to us. Timestamp alone is not enough — frames arrive in the same
   * millisecond routinely, and a cursor that loses rows to ties is worse than
   * no cursor. Base64 so nobody is tempted to construct one by hand.
   */
  const after = q.cursor ? decodeCursor(q.cursor) : null;

  const rows = await query(STITCH_SQL, [
    q.stationIdentity ?? null,
    after?.timestamp ?? null,
    after?.id ?? null,
    q.limit + 1,           // fetch one extra to know whether there is more
    /* …the rest of the filters… */
  ]).then((r) => r.rows);

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page.at(-1);

  return {
    data: page.map(camelise),
    meta: {
      nextCursor: hasMore && last ? encodeCursor(last.timestamp, last.id) : null,
      hasMore,
    },
  };
});

const encodeCursor = (t: Date, id: string) =>
  Buffer.from(`${t.toISOString()}|${id}`).toString('base64url');

const decodeCursor = (c: string) => {
  const [timestamp, id] = Buffer.from(c, 'base64url').toString().split('|');
  // A malformed cursor is a client bug, not a server error: ignore it and
  // serve page one rather than returning a 500.
  return timestamp && id ? { timestamp: new Date(timestamp), id } : null;
};
```

And the matching WHERE, which must use the **same** compound ordering:

```sql
AND ($2::timestamptz IS NULL
     OR (req.occurred_at, req.id) < ($2::timestamptz, $3::bigint))
ORDER BY req.occurred_at DESC, req.id DESC
```

> Postgres compares row constructors left to right, so `(a, b) < (x, y)` is
> exactly the tie-break you want and it can still use the index. Writing it as
> `a < x OR (a = x AND b < y)` is the same thing, more typing, and easier to
> get wrong.

### 4. The realtime bus

Start with the in-process version. The Redis version in [the scaling
guide](../06-scaling/README.md) has the same interface — that is the point of
putting it behind one.

```ts
// src/realtime/bus.ts
import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@ocpp/contracts';

/**
 * Publish/subscribe, in one process.
 *
 * The interface is deliberately the one Redis pub/sub also offers — publish a
 * topic and a payload, subscribe to topic patterns. When you scale to several
 * gateway processes, the implementation behind this file changes and nothing
 * that calls it does. Designing that seam now is why the scaling chapter is a
 * chapter and not a rewrite.
 */
class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Each connected dashboard adds listeners. The default limit of 10 is for
    // catching leaks in small programs and is simply wrong here.
    this.emitter.setMaxListeners(0);
  }

  publish(topic: string, event: ServerEvent) {
    this.emitter.emit(topic, event);
    // Also emit on the wildcard parent, so `station:abc` reaches `stations`
    // subscribers without every publisher having to publish twice.
    const parent = PARENT[topic.split(':')[0]];
    if (parent) this.emitter.emit(parent, event);
  }

  subscribe(topic: string, handler: (e: ServerEvent) => void) {
    this.emitter.on(topic, handler);
    return () => this.emitter.off(topic, handler);
  }
}

const PARENT: Record<string, string> = {
  station: 'stations',
  session: 'sessions',
  ocpp: 'ocpp',
};

export const bus = new Bus();
export const publish = (topic: string, event: ServerEvent) => bus.publish(topic, event);
```

### 5. The WebSocket endpoint

```ts
// src/realtime/server.ts
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { ClientFrameSchema, type ServerEvent } from '@ocpp/contracts';
import { bus } from './bus.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * A SECOND WebSocket server, on a different path.
 *
 * `/ocpp/:identity` is for charge points and speaks OCPP.
 * `/api/v1/realtime` is for browsers and speaks our own event protocol.
 *
 * Do not merge them. They have different auth, different framing, different
 * lifetimes and different failure modes, and the only thing they share is the
 * word "WebSocket".
 */
export function attachRealtime(server: http.Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/v1/realtime') return;   // the OCPP server handles its own

    /**
     * Auth by query parameter, because browsers cannot set headers on a
     * WebSocket handshake. That is a real protocol limitation, not laziness.
     *
     * The cost: the token appears in access logs and proxy logs. Mitigations,
     * in order of effort — short-lived access tokens (we already have 15
     * minutes), or a one-time ticket endpoint, or connect unauthenticated and
     * require an `auth` frame within 5 seconds. Being able to name this
     * trade-off is worth more than picking the "right" one.
     */
    const token = url.searchParams.get('token');
    let user: { id: string; role: string };
    try {
      const claims = jwt.verify(token ?? '', config.JWT_SECRET, { issuer: 'ocpp-cms' });
      user = { id: String(claims.sub), role: String((claims as any).role) };
    } catch {
      // 401 before the upgrade completes. Do not accept the socket and then
      // close it — the client cannot tell the difference from a network fault
      // and will retry forever with backoff.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, user));
  });
}

function onConnection(ws: WebSocket, user: { id: string; role: string }) {
  const subscriptions = new Map<string, () => void>();
  let alive = true;

  const send = (event: ServerEvent) => {
    // Backpressure. If a client is not reading, `bufferedAmount` climbs and
    // the process holds the whole backlog in memory. One slow dashboard on a
    // train's wifi must not take the server down.
    if (ws.bufferedAmount > 1_000_000) {
      logger.warn({ user: user.id }, 'realtime client too slow, dropping');
      ws.close(1013, 'Too slow');
      return;
    }
    ws.send(JSON.stringify(event));
  };

  ws.on('message', (raw) => {
    const parsed = ClientFrameSchema.safeParse(JSON.parse(String(raw)));
    if (!parsed.success) return;              // ignore junk; do not crash
    const frame = parsed.data;

    switch (frame.type) {
      case 'subscribe':
        for (const topic of frame.topics) {
          if (subscriptions.has(topic)) continue;       // idempotent
          if (!maySubscribe(user, topic)) continue;     // a driver gets nothing fleet-wide
          subscriptions.set(topic, bus.subscribe(topic, send));
        }
        send({ type: 'subscribed', at: now(), data: { topics: [...subscriptions.keys()] } });
        break;

      case 'unsubscribe':
        for (const topic of frame.topics) {
          subscriptions.get(topic)?.();
          subscriptions.delete(topic);
        }
        break;

      case 'ping':
        send({ type: 'pong', at: now(), data: { t: frame.t } });
        break;
    }
  });

  // Server-side liveness. A client that vanishes without a close frame — a
  // laptop lid closing, a phone losing signal — leaves a socket that looks
  // open forever. ws's ping/pong is the only reliable way to notice.
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on('close', () => {
    clearInterval(heartbeat);
    // EVERY subscription, or you leak a bus listener per connection and the
    // process slowly dies. This is the single most common realtime bug.
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
  });
}
```

### 6. The SSE fallback

Twenty lines, and it rescues users behind proxies that break WebSocket
upgrades.

```ts
// src/api/routes/realtime-sse.ts
app.get('/realtime/sse', async (request, reply) => {
  const topics = String((request.query as any).topics ?? '').split(',').filter(Boolean);

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx buffers proxied responses by default, which turns a live stream
    // into nothing at all until the buffer fills. This header disables it.
    'x-accel-buffering': 'no',
  });

  const offs = topics
    .filter((t) => maySubscribe(request.user!, t))
    .map((t) => bus.subscribe(t, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }));

  // Comment frames keep intermediaries from closing an idle connection.
  const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 25_000);

  request.raw.on('close', () => {
    clearInterval(keepAlive);
    offs.forEach((off) => off());
  });
});
```

### 7. Publishing from the handlers

Now go back and publish from the places where things happen. This is the part
that makes it live.

```ts
// src/ocpp/handlers/status-notification.ts
publish(REALTIME_TOPICS.station(station.id), {
  type: 'connector.status',
  at: new Date().toISOString(),
  data: {
    stationId: station.id,
    stationIdentity: station.identity,
    evseId, connectorId,
    status: canonical,
    errorCode: payload.errorCode ?? null,
  },
});
```

```ts
// src/ocpp/handlers/meter-values.ts
publish(REALTIME_TOPICS.session(session.id), {
  type: 'meter.value',
  at: new Date().toISOString(),
  data: { sessionId: session.id, timestamp, energyWh, powerKw, currentA, voltageV, soc, temperatureC },
});
```

And the frame log itself, which is what makes the inspector stream:

```ts
// src/ocpp/frame-log.ts
function publishExchange(r: FrameRecord) {
  publish(r.stationId ? REALTIME_TOPICS.ocppStation(r.stationId) : REALTIME_TOPICS.ocpp, {
    type: 'ocpp.message',
    at: new Date().toISOString(),
    data: toExchange(r),
  });
}
```

> **A note on volume.** `ocpp` fleet-wide with 500 stations heartbeating every
> 300 seconds is only ~2 events/second — fine. The same topic with meter values
> every 10 seconds during 200 concurrent sessions is 20/second per connected
> dashboard, which is also fine, and 200/second at ten times the fleet, which
> is not. The fix is not a bigger server; it is that nobody actually watches
> unfiltered fleet-wide frames in production. Ship the filter, and say so.

---

## Prove it works

### 1. The inspector streams

Open `/logs` in the dashboard, then start a charge in the simulator. Rows
should appear **without refreshing**, newest first, with request and response
on one row and a duration in milliseconds.

Check:

- `BootNotification` shows `→ Accepted` and a duration under ~100 ms.
- A `MeterValues` row expands to show the full payload.
- The pause button stops the stream without losing what is already there.

### 2. Prove the stitch is right

Use the simulator's raw send to fire two CALLs before answering either:

```json
[2,"a","Heartbeat",{}]
[2,"b","Heartbeat",{}]
```

Answer `b` first, then `a`. Both rows must pair correctly. If they pair by
arrival order instead of message id, you did not implement the join — you
implemented a queue.

### 3. Prove the direction guard matters

Have the simulator send a CALL with message id `"1"` at the same moment your
server sends one with id `"1"` (remote start while the station heartbeats).
Both exchanges must stay separate. Remove `r.direction <> req.direction` from
the SQL, reload, and watch them cross-pair — then put it back.

### 4. Kill the connection

With the dashboard open and the inspector streaming, restart your server.

| Expect | Where |
|---|---|
| Connection badge goes amber, then green | dashboard header |
| Reconnect delay grows: ~1s, 2s, 4s… with jitter | network tab |
| Frames resume after reconnect | logs page |
| No duplicate subscription frames | server log |

That last one is the test for `subscribe` being idempotent. The client re-sends
all topics on every reconnect by design.

### 5. Check for listener leaks

Open and close the logs page thirty times, then:

```ts
// in a debug route
bus.listenerCount('ocpp')   // should be 0 with no dashboards open
```

If it climbs, your `ws.on('close')` is not unsubscribing everything.

### 6. Cursor pagination under load

Open `/logs`, scroll to load page 2, and keep the simulator running so new
frames arrive continuously. You must never see the same message id twice. Then
switch the endpoint to offset pagination temporarily and watch the duplicates
appear — it is a two-minute experiment that makes the reason stick.

---

## What you can now explain

- Why a CALLRESULT cannot be understood without remembering the CALL, and how
  you stitch them.
- Why message ids are only unique per connection *per direction*.
- Why the frame log is append-only on write and joined on read.
- Why the log uses cursor pagination when everything else uses offset.
- Why a WebSocket cannot carry an `Authorization` header, and the three ways
  around it.
- What backpressure is, and what one slow client does to a naive fan-out.
- Why the realtime bus is behind an interface — and what changes when you run
  more than one process.

---

Next: **[Milestone 10 — smart charging →](milestone-10-smart-charging.md)**
