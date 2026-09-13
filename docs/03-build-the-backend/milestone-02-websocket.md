# Milestone 2 — The WebSocket

**Goal:** a real charge point connects to your server, says hello, and you
answer.

**Time:** 1–2 hours. This is the milestone where it starts feeling real.

---

## Why this exists

Everything in OCPP rides one WebSocket that the **station** opens and holds
open for months. Three things happen in the handshake and all three are easy to
get wrong:

1. **The identity is in the URL.** `wss://you/ocpp/CP-AMS-0001` — the last path
   segment. There is no login message; that string is who they are.
2. **The version is in a header.** `Sec-WebSocket-Protocol: ocpp1.6`, and **you
   must echo it back**. Miss this and well-behaved clients disconnect
   immediately, with no error you can see. It is the single most common reason
   a first CSMS never receives a message.
3. **Nothing is authenticated yet.** That is Milestone 13.

---

## Build it

```bash
npm install ws
npm install -D @types/ws
```

### 1. The connection registry

```ts
// src/ocpp/registry.ts
import type { WebSocket } from 'ws';

export type Protocol = 'ocpp1.6' | 'ocpp2.0.1';

export interface Connection {
  identity: string;
  protocol: Protocol;
  socket: WebSocket;
  connectedAt: Date;
  lastSeenAt: Date;
  /** Set once BootNotification has been accepted. */
  booted: boolean;
  /** Calls we have sent and are waiting on. See Milestone 3. */
  pending: Map<string, { action: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

/**
 * Which stations are connected to THIS process.
 *
 * An in-memory Map, and that is a deliberate, temporary decision worth
 * understanding: a WebSocket is a TCP connection held by one process. You
 * cannot look it up from another process, because it does not exist there.
 *
 * With one server, this Map is the whole answer. With several, you also need a
 * shared registry (Redis) saying WHICH process holds a given station, plus a
 * way to forward a command to that process. That is the central problem of
 * scaling a CPMS and it is covered in `docs/06-scaling`.
 *
 * Build the single-process version first. The interface below does not change
 * when you scale it; only the implementation behind `get` does.
 */
class ConnectionRegistry {
  private readonly byIdentity = new Map<string, Connection>();

  add(connection: Connection) {
    // A station reconnecting before we noticed the old socket died leaves a
    // zombie. Close the old one explicitly rather than leaking it.
    const existing = this.byIdentity.get(connection.identity);
    if (existing && existing.socket !== connection.socket) {
      existing.socket.close(1000, 'Replaced by a newer connection');
    }
    this.byIdentity.set(connection.identity, connection);
  }

  get(identity: string) {
    return this.byIdentity.get(identity) ?? null;
  }

  remove(identity: string) {
    const c = this.byIdentity.get(identity);
    if (!c) return;
    // Reject everything still waiting — otherwise those promises hang forever.
    for (const [, p] of c.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Station disconnected'));
    }
    this.byIdentity.delete(identity);
  }

  isOnline(identity: string) {
    return this.byIdentity.has(identity);
  }

  count() {
    return this.byIdentity.size;
  }

  all() {
    return [...this.byIdentity.values()];
  }
}

export const registry = new ConnectionRegistry();
```

### 2. The gateway

```ts
// src/ocpp/gateway.ts
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { registry, type Protocol } from './registry.js';
import { stationLogger, logger } from '../logger.js';
import { config } from '../config.js';

const SUPPORTED: Protocol[] = ['ocpp1.6', 'ocpp2.0.1'];

/** Pull `CP-AMS-0001` out of `/ocpp/CP-AMS-0001` or `/ocpp/1.6/CP-AMS-0001`. */
function identityFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split('?')[0] ?? '';
  const last = path.split('/').filter(Boolean).pop();
  if (!last) return null;
  // Identities are ASCII, 1–48 chars, per the specification.
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(last) ? last : null;
}

export function attachOcppGateway(server: Server) {
  /**
   * `noServer: true` means we handle the HTTP upgrade ourselves.
   *
   * That is what lets us reject a connection BEFORE the WebSocket exists —
   * with a real HTTP status the station's logs will show. Letting `ws` do the
   * upgrade and then closing the socket gives the field engineer nothing.
   */
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const identity = identityFromUrl(request.url);

    if (!identity) {
      logger.warn({ url: request.url }, 'upgrade rejected: no identity in path');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    /**
     * Subprotocol negotiation.
     *
     * The client sends a comma-separated list of what it can speak. We pick
     * the first we support and MUST echo it in the response — `ws` does that
     * when we pass it as the third argument to handleUpgrade.
     */
    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .toString()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const chosen = SUPPORTED.find((p) => offered.includes(p));

    if (offered.length > 0 && !chosen) {
      stationLogger(identity).warn({ offered }, 'upgrade rejected: unsupported protocol');
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // No header at all: some 1.6 firmware omits it. Assume 1.6 and log it.
    const protocol = chosen ?? 'ocpp1.6';
    if (!chosen) {
      stationLogger(identity).warn('no subprotocol offered, assuming ocpp1.6');
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      onConnection(ws, identity, protocol);
    });
  });

  logger.info({ protocols: SUPPORTED }, 'OCPP gateway attached');
  return wss;
}

function onConnection(socket: WebSocket, identity: string, protocol: Protocol) {
  const log = stationLogger(identity);
  log.info({ protocol }, 'station connected');

  const connection = {
    identity,
    protocol,
    socket,
    connectedAt: new Date(),
    lastSeenAt: new Date(),
    booted: false,
    pending: new Map(),
  };
  registry.add(connection);

  socket.on('message', (raw) => {
    connection.lastSeenAt = new Date();
    // Milestone 3 replaces this with the real router.
    log.debug({ raw: raw.toString().slice(0, 500) }, 'frame in');
  });

  socket.on('close', (code, reason) => {
    log.info({ code, reason: reason.toString() }, 'station disconnected');
    registry.remove(identity);
  });

  socket.on('error', (err) => {
    log.error({ err }, 'socket error');
  });

  /**
   * Liveness, at the TCP level.
   *
   * OCPP heartbeats tell you the station's software is alive. A WebSocket ping
   * tells you the SOCKET is alive — and those are different failures. A dead
   * socket can sit in CLOSE_WAIT for a very long time without either side
   * noticing, so we ping and drop anything that does not pong.
   */
  let alive = true;
  socket.on('pong', () => {
    alive = true;
  });

  const pingTimer = setInterval(() => {
    if (!alive) {
      log.warn('no pong, terminating socket');
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 30_000);

  socket.on('close', () => clearInterval(pingTimer));
}
```

### 3. Wire it to the HTTP server

Fastify owns the HTTP server; we attach the upgrade handler to it.

```ts
// src/index.ts
import { attachOcppGateway } from './ocpp/gateway.js';

await app.listen({ port: config.PORT, host: '0.0.0.0' });
attachOcppGateway(app.server);   // `app.server` is the raw node:http server
```

Update health to advertise what you now support:

```ts
app.get('/api/v1/health', async () => ({
  status: 'ok' as const,
  version: '0.2.0',
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  protocols: ['ocpp1.6', 'ocpp2.0.1'],
  dependencies: [],
}));
```

---

## Prove it works

**1. With `wscat`, to see the raw handshake:**

```bash
npx wscat -c ws://localhost:3000/ocpp/CP-TEST-0001 -s ocpp1.6
```

Your server logs `station connected`.

**2. With the simulator — this is the real test.** Open
http://localhost:5174, select `SIM-AMS-001`, check the CSMS URL says
`ws://localhost:3000/ocpp`, and press **Connect**.

> **This needs the simulator service running on port 3100**, which you have
> not built yet. Under `npm run dev:learn` the simulator UI is answered by
> mocks, so **Connect** looks like it works and no WebSocket reaches your
> server. Use `wscat` for now, and build
> [the simulator](../08-build-the-simulator/README.md) once Milestone 3 is
> done — it takes about an evening to get to a station that really connects.

Your terminal:

```
10:22:07 INFO: station connected  station=SIM-AMS-001 protocol=ocpp1.6
10:22:07 DEBUG: frame in  station=SIM-AMS-001 raw=[2,"a41f","BootNotification",{...}]
```

A real OCPP frame, from something pretending to be hardware. You are not
answering it yet — that is Milestone 3.

**3. Prove the subprotocol rule.** Connect without it:

```bash
npx wscat -c ws://localhost:3000/ocpp/CP-TEST-0002
```

Your log says `no subprotocol offered, assuming ocpp1.6`. Now try an
unsupported one:

```bash
npx wscat -c ws://localhost:3000/ocpp/CP-TEST-0003 -s ocpp1.5
```

`400 Bad Request`. Try it with the rejection code removed and you will see the
symptom people spend hours on: a connection that opens and silently dies.

---

## What you can now explain

- Why the station dials the server and not the other way round, and what that
  implies for scaling. (Answer: the socket lives in one process's memory, so
  routing a command to a specific station becomes a distributed-systems
  problem. See [scaling](../06-scaling/README.md).)
- What subprotocol negotiation is and why failing to echo the header breaks
  everything silently.
- The difference between an OCPP heartbeat and a WebSocket ping — application
  liveness versus socket liveness.
- Why you handle the HTTP upgrade yourself instead of letting the library do
  it: so a rejection is an HTTP status a field engineer can read.

---

Next: **[Milestone 3 — the OCPP RPC layer →](milestone-03-rpc.md)**
