# The architecture

**One target shape, and everything in this project is built toward it.**

There is a version of this chapter that surveys six architectures and leaves
you to choose. This is not that chapter. A CPMS has one unusual constraint that
rules most options out, and pretending otherwise would waste your time.

---

## The constraint everything follows from

> **A charge point holds a WebSocket open for months, and that connection lives
> in exactly one process.**

Read that again, because almost every architectural decision in this project is
downstream of it.

A normal web service is stateless. Any request can go to any instance; a
load balancer sprays traffic; scaling is "run more copies". None of that is
true here:

- A TCP connection is held by **one process on one machine**. No other process
  can write to it. There is no way to "look it up" from elsewhere.
- The connection lives for **weeks or months**, not milliseconds. It is not a
  request; it is a relationship.
- When you want to send `RemoteStartTransaction` to `STATION-042`, the
  request arrives at whichever HTTP instance the load balancer picked, and
  `STATION-042` is almost certainly connected to a **different** one.

So a CPMS is not a stateless web service with a WebSocket bolted on. It is a
**stateful connection tier** with a stateless service tier around it, and the
interesting engineering is the boundary between them.

Everything else — Postgres, Redis, the broker — is ordinary. This one thing is
not, and it is the thing worth being able to explain.

---

## The target architecture

```
                        ┌──────────────┐  ┌──────────────┐  ┌────────────┐
   browsers ───────────►│  dashboard   │  │  simulator   │  │   driver   │
                        └──────┬───────┘  └──────┬───────┘  └─────┬──────┘
                               │                 │                │
                    ═══════════╪═════════════════╪════════════════╪═══════
                               ▼                 ▼                ▼
                        ┌──────────────────────────────────────────────┐
                        │             API gateway / ingress            │
                        └───────┬──────────────────────────┬───────────┘
                                │                          │
                    ┌───────────▼────────────┐   ┌─────────▼─────────────┐
                    │      core API          │   │   realtime service    │
                    │   (STATELESS, N pods)  │   │  (browser WebSocket)  │
                    │  REST, auth, pricing   │   │   fan-out only        │
                    └───────────┬────────────┘   └─────────┬─────────────┘
                                │                          │
       ┌────────────────────────┼──────────────────────────┼──────────────┐
       │                        ▼                          ▼              │
       │   ┌────────────┐  ┌─────────┐  ┌─────────────┐  ┌─────────────┐  │
       │   │  Postgres  │  │  Redis  │  │   broker    │  │   object    │  │
       │   │            │  │registry │  │  (NATS /    │  │   storage   │  │
       │   │            │  │ + cache │  │   Kafka)    │  │  (logs/CDR) │  │
       │   └─────┬──────┘  └────┬────┘  └──────┬──────┘  └─────────────┘  │
       └─────────┼──────────────┼──────────────┼────────────────────────  ┘
                 │              │              │
                 ▼              ▼              ▼
       ┌───────────────────────────────────────────────────┐
       │            OCPP gateway  (STATEFUL, N pods)       │
       │   holds the station WebSockets · framing · RPC    │
       │   translates 1.6 and 2.0.1 → canonical model      │
       └───────────────────────┬───────────────────────────┘
                               │  wss://  (months-long connections)
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         ┌─────────┐      ┌─────────┐     ┌─────────┐
         │ station │      │ station │     │ station │   … thousands
         │  1.6J   │      │ 2.0.1   │     │  1.6J   │
         └─────────┘      └─────────┘     └─────────┘
```

Four tiers, and each exists for one reason:

| Tier | State | Why it is separate |
|---|---|---|
| **OCPP gateway** | **stateful** — owns the sockets | Scales on *connection count*, cannot be load-balanced normally, must drain slowly on deploy |
| **Core API** | stateless | Scales on *request rate*, deploys freely, restarts are invisible |
| **Realtime service** | soft state — browser subscriptions | Scales on *viewer count*, a different number from either of the above |
| **Data** | durable | Postgres for truth, Redis for "who holds which socket", broker for fan-out |

---

## Why this and not something else

Three alternatives get proposed constantly. Each is wrong here for a specific
reason, and knowing the reason is more useful than knowing the conclusion.

### "Just one big stateless service behind a load balancer"

This is where you start, and it is correct up to a point — see the staging plan
below. It breaks the moment you need a **second instance**, because a remote
start arriving at instance B cannot reach a station connected to instance A.
The connection is not in a database; it is a file descriptor.

People discover this in production, usually as "remote start works about half
the time".

### "Full microservices — a service per domain"

Tempting, and wrong for the wrong reasons. Splitting *stations*, *sessions*,
*tariffs* and *users* into separate services gives you distributed transactions
across things that change together (a `StopTransaction` writes a session, a
CDR and a payment, atomically) and buys you nothing, because they all scale the
same way.

The split that *is* justified is the one above, and it is justified by a
physical constraint rather than by an org chart. **Split on scaling axis and
state, not on nouns.** That is the sentence to remember.

### "Serverless"

A Lambda cannot hold a WebSocket for three months. API Gateway's WebSocket
support exists, bills per minute of connection, and gives you a callback API
rather than a socket — which means no subprotocol negotiation, no control over
close codes, and a per-message round trip through a service you do not control.
For a protocol whose whole model is a long-lived stateful link, it is the wrong
shape at any price.

---

## The seams are already in your code

Here is the useful part: **you have already built this architecture.** It is
currently running in one process, and the boundaries are real.

```
src/
├── ocpp/        ← becomes the OCPP gateway
├── realtime/    ← becomes the realtime service
├── api/         ← becomes the core API
├── domain/      ← shared library, or duplicated — it is stateless logic
└── db/          ← shared
```

Two rules from Milestone 1 are what make the split a move rather than a rewrite:

1. **`domain/` may not import `ocpp/`.** Business logic knows nothing about the
   protocol. So the core API can run without the gateway's code.
2. **Everything crossing a tier already goes through an interface.** The
   connection registry (Milestone 2) and the realtime bus (Milestone 9) are
   both small classes with a handful of methods. Swapping the implementation is
   the whole job.

```ts
// Milestone 2. In-process today.
registry.get(identity)        // → Connection | null
registry.isOnline(identity)

// Milestone 9. In-process today.
bus.publish(topic, event)
bus.subscribe(topic, handler)
```

Neither caller cares what is behind them. That is the point.

---

## The one hard problem: routing a command to the right socket

When the gateway is more than one process, `registry.get()` cannot answer
locally. Here is the mechanism, in full, because this is the part an interviewer
will push on.

### Step 1 — Redis as the connection registry

Every gateway instance records which stations it holds:

```ts
// src/ocpp/registry-redis.ts

/**
 * `station:<identity>` → the instance that holds the socket.
 *
 * A TTL, refreshed on every heartbeat, is what makes this self-healing: an
 * instance that dies leaves its keys to expire rather than leaving permanent
 * lies in Redis. Pick a TTL comfortably longer than the OCPP heartbeat
 * interval (300s default) — 900s means at most 15 minutes of staleness, and a
 * clean shutdown deletes the keys immediately anyway.
 */
async add(connection: Connection) {
  this.local.set(connection.identity, connection);
  await redis.set(`station:${connection.identity}`, INSTANCE_ID, 'EX', 900);
}

async whereIs(identity: string): Promise<string | null> {
  // Always check locally first: most lookups on a given instance are for
  // stations that instance holds, and a local Map is free.
  if (this.local.has(identity)) return INSTANCE_ID;
  return redis.get(`station:${identity}`);
}
```

### Step 2 — forward the command to that instance

Two designs, and the choice is a real one:

**(a) Direct HTTP between instances.** The core API asks Redis where the
station is, then POSTs to that gateway pod's internal address.

- Simple. One hop. Easy to debug — you can curl it.
- Needs stable, addressable pods (a Kubernetes `StatefulSet` with a headless
  service gives you `gateway-0.gateway.svc`, which is exactly this).
- A dead pod produces a connection error you must translate into
  `STATION_OFFLINE`.

**(b) A broker topic per instance.** The core API publishes to
`gateway.<instance>.commands`; each gateway subscribes to its own topic.

- No service discovery, no direct pod addressing.
- Survives a pod moving: the message waits.
- One more component in the path, and debugging is "read the broker".

**Pick (a) to start and (b) when you have a broker for other reasons.** Both
are correct; what matters is that the caller cannot tell:

```ts
// src/ocpp/call-distributed.ts
export async function callStation(identity: string, action: string, payload: unknown) {
  const instance = await registry.whereIs(identity);
  if (!instance) throw AppError.stationOffline(identity);

  // Same process: the Milestone 3 path, unchanged and fast.
  if (instance === INSTANCE_ID) return localCall(identity, action, payload);

  // Another process: forward and wait. The timeout must be SHORTER than the
  // caller's, or a hung forward produces two stacked timeouts and a confusing
  // 60-second HTTP request.
  return forwardToInstance(instance, { identity, action, payload });
}
```

> **The correctness trap.** Between reading Redis and forwarding, the station
> may have reconnected to a different instance. The forward then lands on an
> instance that no longer holds it. The fix is not a lock: it is that the
> receiving instance checks its own local map and answers `STATION_OFFLINE`,
> and the caller retries the lookup **once**. Cheap, correct, and no
> distributed coordination. Systems that reach for a lock here usually end up
> with the lock as the bottleneck.

### Step 3 — events flow the other way, through the broker

The gateway does not call the API. It publishes canonical events:

```
station.booted        session.started      connector.status
session.updated       session.ended        meter.value
```

Anyone can subscribe: the core API to write them down, the realtime service to
fan them out to browsers, and later a billing worker, an analytics sink, an
alerting service. **The gateway's job ends at "translate the protocol and say
what happened".**

This is also what stops the gateway from needing the database on the hot path,
which matters more than it looks: a slow query must never be able to make an
OCPP response slow enough for a station to time out.

---

## What runs where, concretely

| Component | Instances | Scales with | Restart cost |
|---|---|---|---|
| OCPP gateway | 2+ | open connections | **high** — stations reconnect |
| Core API | 2+ | requests/sec | none |
| Realtime service | 2+ | connected browsers | low — clients reconnect |
| Postgres | 1 primary + replicas | data volume, write rate | high |
| Redis | 1 + replica | connection count | low — rebuilt from gateways |
| Broker | 3 | event rate | low |

The "restart cost" column is the one people miss. Deploying the core API is
free. Deploying the gateway disconnects every station it holds, and they all
reconnect at once — which is why the deployment chapter spends so much time on
draining and jitter.

---

## How you get there, in stages

You do not build this on day one. You build it in the order the pain arrives.

### Stage 1 — one process (Milestones 0–13)

Everything in one Node process, one Postgres. **Handles a few hundred stations
comfortably.** This is not a toy: plenty of real regional operators run
something close to it.

The only thing you must not do is bake in an assumption that makes stage 2
expensive — and you have already avoided that, twice, by putting the registry
and the bus behind interfaces.

### Stage 2 — split the processes, still one of each

Same machine or same cluster, three processes: gateway, API, realtime. Redis
appears, holding the registry and the pub/sub.

**Why this is the important step:** it is where you find every hidden
assumption that the gateway and the API share memory. Do it *before* you need
it, while the stakes are low. If you can run two processes, you can run twenty.

### Stage 3 — scale each tier independently

More gateway pods, more API pods, Postgres read replicas. Command forwarding
becomes real. **Thousands of stations.**

### Stage 4 — specialise

Meter values to a time-series store, CDR generation to a worker, a read model
for the dashboard. **Tens of thousands.** Most people never get here, and the
scaling chapter is honest about which signals justify each move.

---

## What this costs you

An architecture chapter that only lists benefits is marketing. The real costs:

- **Deploys are no longer simple.** A gateway rollout is a careful, slow,
  connection-draining operation, not `kubectl rollout restart`.
- **You now have distributed failure modes.** Redis says a station is on an
  instance that is gone. The broker is behind. A forwarded command times out
  for reasons that have nothing to do with the station.
- **Local development is heavier.** Mitigated by the seams: the single-process
  mode you built still works, and should keep working. Keep it — running the
  whole system in one process is the best debugging tool you have.
- **Debugging crosses processes.** Which is why every frame carries a message
  id, every request carries a request id, and both end up in the logs.

The honest summary: **stage 1 is the right architecture for most fleets, and
this design's real value is that stage 2 costs a week rather than a quarter.**

---

## What you can now explain

- Why a CPMS cannot be a normal stateless service, in one sentence about file
  descriptors.
- Why the split is gateway / API / realtime rather than station / session /
  tariff — scaling axis and state, not nouns.
- How a command reaches a station connected to a different process, and what
  happens when the station moved between the lookup and the forward.
- Why the gateway publishes events instead of writing to the database.
- Why serverless is the wrong shape for a months-long connection.
- Which stage a given fleet size actually needs.

---

Next: **[Deployment →](../05-deployment/README.md)**
