# Scaling

**Goal:** take the architecture from chapter 4 from one box to a national
network, one justified step at a time.

This chapter scales **that** architecture — the stateful OCPP gateway, the
stateless core API, the realtime service, Postgres, Redis and a broker. It does
not survey alternatives. Every step below says what breaks, what you change,
and what signal tells you it is time.

---

## First: the numbers

Almost nobody needs most of this chapter, and knowing that is worth more than
knowing the techniques.

A charge point is a **very** quiet device.

| Message | Frequency | Notes |
|---|---|---|
| Heartbeat | every 300 s | and only when nothing else has been sent |
| StatusNotification | a handful per session | plus connector state changes |
| MeterValues | every 30–60 s **while charging** | the dominant load |
| Start/Stop | twice per session | |

So one **idle** station is 0.003 messages/second. One **charging** station is
about 0.03. A fleet of 10,000 stations at 10% utilisation is:

```
9,000 idle     × 0.0033 =  30 msg/s
1,000 charging × 0.033  =  33 msg/s
                          ─────────
                          ~63 msg/s
```

**Sixty messages a second.** A single Node process handles that without
noticing. The load is not the problem.

**Connections are the problem.** 10,000 stations means 10,000 concurrently open
TCP connections, each with a TLS session and a buffer, held for months.

| Resource | Per connection | At 10,000 |
|---|---|---|
| File descriptor | 1 | 10,000 (default `ulimit -n` is 1024 — raise it) |
| Kernel socket buffers | ~8–16 KB | ~150 MB |
| TLS session state | ~20–40 KB | ~300 MB |
| Your `Connection` object | ~1–2 KB | ~15 MB |

Roughly **0.5 GB of RAM for the connections alone**, before your application
allocates anything. That is what sizes a gateway, and it is why the gateway
scales on a completely different axis from everything else.

### What each stage actually buys

| Stage | Stations | Shape |
|---|---|---|
| **1** | up to ~500 | one process, one Postgres |
| **2** | up to ~2,000 | split processes, Redis, one of each |
| **3** | up to ~20,000 | multiple gateway and API pods, read replicas |
| **4** | 20,000+ | partitioned data, dedicated workers, time-series store |

Most operators live at stage 1 or 2 forever. **Do not build stage 3 for 200
stations** — you will spend a quarter on it and get a slower system with more
failure modes.

---

## Stage 1 → 2: split the processes

### What breaks

Nothing, yet. This step is preventative, and it is the most valuable one in the
chapter.

You move because of a **coupling** problem, not a load problem:

- A slow API request (some operator exports 90 days of CDRs) blocks the event
  loop, and OCPP responses go with it. A station times out and reconnects —
  because of a CSV download.
- Deploying a tariff change disconnects the fleet, because it is the same
  process.
- The gateway and the API want opposite things from a deploy: the API wants
  fast rollouts, the gateway wants almost none.

### What you change

```
                     ┌─────────────┐
   stations ─wss──►  │   gateway   │ ──┐
                     └─────────────┘   │
                                       ├──► Redis (registry + pub/sub)
                     ┌─────────────┐   │
   browsers ────────►│     api     │ ──┤
                     └─────────────┘   │
                                       ├──► Postgres
                     ┌─────────────┐   │
   browsers ─ws────► │  realtime   │ ──┘
                     └─────────────┘
```

Two swaps, both behind interfaces you already built:

```ts
// The registry moves from a Map to Redis-backed. Same interface.
// src/ocpp/registry.ts
export const registry = config.REDIS_URL
  ? new RedisConnectionRegistry()
  : new InMemoryConnectionRegistry();
```

```ts
// The bus moves from EventEmitter to Redis pub/sub. Same interface.
// src/realtime/bus.ts
class RedisBus {
  async publish(topic: string, event: ServerEvent) {
    // Local subscribers first — no round trip for events consumed in the same
    // process, which is most of them on the gateway.
    this.local.emit(topic, event);
    await this.pub.publish(topic, JSON.stringify(event));
  }

  subscribe(topic: string, handler: (e: ServerEvent) => void) {
    this.local.on(topic, handler);
    // Redis pattern subscriptions: one `psubscribe station:*` instead of one
    // subscription per station. With 10,000 stations the difference is
    // 10,000 Redis subscriptions versus one.
    void this.sub.psubscribe(patternFor(topic));
    return () => { /* … */ };
  }
}
```

> **Do not publish an event twice.** The naive version emits locally *and*
> receives its own Redis message, so every in-process subscriber fires twice
> and the frame log shows duplicates. Tag each message with the publishing
> instance id and ignore your own on the way back in.

### The signal to move

- p99 of `ocpp_call_duration_seconds` creeps up while CPU is fine (event-loop
  contention),
- or you avoid deploying because it disconnects the fleet.

That second one is a real engineering signal, not a feeling.

---

## Stage 2 → 3: more than one of each

### The central problem, restated

With two gateway pods, half your stations are on A and half on B. A remote
start hits the API, which must reach the right pod. Chapter 4 described the
mechanism; here is what it costs and how it fails.

```ts
// src/ocpp/call-distributed.ts
export async function callStation(identity: string, action: string, payload: unknown) {
  // 1. Local? Fast path, no Redis, no network.
  if (registry.hasLocal(identity)) return localCall(identity, action, payload);

  // 2. Ask Redis who holds it.
  const instance = await redis.get(`station:${identity}`);
  if (!instance) throw AppError.stationOffline(identity);

  // 3. Forward. Timeout SHORTER than the caller's, so a hung forward does
  //    not stack two timeouts into a 60-second HTTP request.
  try {
    return await forward(instance, { identity, action, payload }, { timeoutMs: 20_000 });
  } catch (err) {
    /**
     * The station moved between the lookup and the forward — it reconnected
     * to a different pod, or that pod died. Retry the lookup ONCE.
     *
     * Once, not in a loop: if the second attempt also misses, the station is
     * genuinely flapping and the honest answer is STATION_OFFLINE. A retry
     * loop here turns one station's reconnect storm into an amplifier.
     */
    if (err instanceof StationMovedError) {
      const again = await redis.get(`station:${identity}`);
      if (again && again !== instance) {
        return forward(again, { identity, action, payload }, { timeoutMs: 20_000 });
      }
    }
    throw AppError.stationOffline(identity);
  }
}
```

### Load balancing connections, which is not like balancing requests

A normal load balancer distributes *requests*. Here it distributes *connections
that last for months*, and that changes everything:

- **Round-robin is fine at connect time** and useless afterwards. You cannot
  rebalance without disconnecting someone.
- **Least-connections beats round-robin** here, because after a rolling
  restart the pods are wildly uneven: the pod that restarted last has zero
  connections while the others hold everything.
- **Pods drift out of balance over time.** A pod restarted three weeks ago
  holds more stations than one restarted yesterday. This is normal. Do not
  "fix" it by cycling pods — you would be trading a harmless imbalance for a
  real reconnect storm.

```yaml
# Kubernetes: a StatefulSet, not a Deployment.
#
# Not for storage — for STABLE NETWORK IDENTITY. `gateway-0.gateway.svc` is
# addressable, which is what makes command forwarding possible without
# service discovery. A Deployment's pod IPs change on every restart and
# Redis would be full of addresses that no longer resolve.
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: gateway }
spec:
  serviceName: gateway
  replicas: 3
  podManagementPolicy: Parallel   # do not start pods one at a time
  template:
    spec:
      terminationGracePeriodSeconds: 90
      containers:
        - name: gateway
          env:
            - name: INSTANCE_ID
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
          resources:
            # Memory is the binding constraint, not CPU. Size from the
            # connection arithmetic at the top of this chapter and leave
            # generous headroom for reconnect storms, when every station
            # sends a boot plus buffered messages at once.
            requests: { memory: 2Gi, cpu: 500m }
            limits:   { memory: 4Gi }
```

### Postgres: read replicas and where they lie

The dashboard is read-heavy; the gateway is write-heavy. Split them.

```ts
// src/db/index.ts
const primary = new Pool({ connectionString: config.DATABASE_URL });
const replica = new Pool({ connectionString: config.DATABASE_REPLICA_URL ?? config.DATABASE_URL });

/**
 * Replicas lag. Usually milliseconds, occasionally seconds under load.
 *
 * That is fine for a dashboard chart and NOT fine for read-after-write: an
 * operator creates a station, the UI re-fetches from a replica that has not
 * caught up, and the station appears to have vanished. The rule is simple
 * and absolute — anything in the same user action as a write reads from the
 * primary.
 */
export const query = (sql: string, params?: unknown[]) => primary.query(sql, params);
export const queryRead = (sql: string, params?: unknown[]) => replica.query(sql, params);
```

Route these to the replica: dashboard stats and series, session and CDR
history, the OCPP frame log, exports. Keep everything else on the primary.

### Meter values are 95% of your write volume

Re-read the arithmetic: 1,000 concurrent sessions sampled every 30 seconds is
33 inserts/second sustained, ~2.9 million rows a day. Each one is a single-row
`INSERT` with a round trip.

```ts
// src/db/meter-buffer.ts

/**
 * Batch meter values. One INSERT per 200 rows instead of 200 INSERTs.
 *
 * Throughput is roughly 20× better, and the flush interval bounds how stale
 * the data can be. One second is invisible on a live chart and turns a
 * write-per-sample workload into a trickle.
 *
 * The rule: buffer only what you can afford to lose. Meter values are
 * samples, and losing the last second of them on a crash costs you a pixel.
 * NEVER buffer a StopTransaction — that is a bill.
 */
class MeterValueBuffer {
  private rows: MeterRow[] = [];

  add(row: MeterRow) {
    this.rows.push(row);
    if (this.rows.length >= 200) void this.flush();
  }

  async flush() {
    if (this.rows.length === 0) return;
    const batch = this.rows;
    this.rows = [];
    // UNNEST turns arrays into rows: one statement, one parse, one plan,
    // whatever the batch size.
    await query(
      `INSERT INTO meter_values (session_id, measured_at, energy_wh, power_kw, soc)
       SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::bigint[], $4::numeric[], $5::smallint[])`,
      columns(batch),
    );
  }
}

setInterval(() => void buffer.flush(), 1_000).unref();
// And flush on shutdown, before the pool closes.
```

### Caching the overview

`/dashboard/stats` is the most-viewed endpoint and the most expensive query.

```ts
/**
 * Cache for 30 seconds. Operators do not need per-second accuracy on a
 * 30-day energy total, and 30 seconds removes essentially all of the load.
 *
 * `SETNX` on a lock key is what prevents a cache stampede: when the entry
 * expires with 50 dashboards open, exactly one recomputes and the rest serve
 * the stale value for a moment. Without it, expiry is a synchronised
 * thundering herd against your heaviest query.
 */
export async function cachedStats(range: TimeRange) {
  const key = `stats:${range}`;
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);

  const gotLock = await redis.set(`${key}:lock`, '1', 'EX', 10, 'NX');
  if (!gotLock) {
    const stale = await redis.get(`${key}:stale`);
    if (stale) return JSON.parse(stale);
  }

  const stats = await dashboardStats(range);
  await redis.multi()
    .set(key, JSON.stringify(stats), 'EX', 30)
    .set(`${key}:stale`, JSON.stringify(stats), 'EX', 300)
    .exec();
  return stats;
}
```

### The signal to move

- A single gateway pod above roughly 5,000 connections, or memory above ~70%,
- p95 on `/dashboard/stats` past ~300 ms,
- replica lag you can see, or a primary at 60%+ CPU.

> "We moved when p95 on the overview crossed 300 ms" is a much better answer
> than "we moved to microservices". Have a number.

---

## Stage 3 → 4: specialise

Past roughly 20,000 stations, three things dominate and each gets its own
treatment.

### Time-series data leaves Postgres

`meter_values` will be 100× every other table combined. Partitioning (which you
built in Milestone 4) buys you cheap retention; past a certain volume you want
compression and downsampling too.

| Option | Why |
|---|---|
| **TimescaleDB** | A Postgres extension. Same SQL, same client, ~10× compression, continuous aggregates. **Start here** — it is the smallest change. |
| ClickHouse | Far faster for analytics, a separate system to operate and a separate consistency story. |
| S3 + Parquet | Cheapest for cold data. Query with DuckDB or Athena. Pair with one of the above for recent data. |

```sql
-- Timescale, applied to the table you already have.
SELECT create_hypertable('meter_values', 'measured_at', migrate_data => true);

-- Continuous aggregates: the dashboard's hourly chart stops scanning raw
-- samples entirely and reads a materialised rollup instead.
CREATE MATERIALIZED VIEW meter_values_hourly
WITH (timescaledb.continuous) AS
SELECT session_id,
       time_bucket('1 hour', measured_at) AS bucket,
       max(energy_wh) AS energy_wh,
       avg(power_kw)  AS avg_power_kw,
       max(power_kw)  AS peak_power_kw
  FROM meter_values
 GROUP BY session_id, bucket;

-- Compress anything older than a week; typical ratios are 10–20×.
ALTER TABLE meter_values SET (timescaledb.compress);
SELECT add_compression_policy('meter_values', INTERVAL '7 days');
```

### Work that is not a request becomes a worker

CDR generation, OCPI pushes, report exports and the command sweeper are all
things nobody is waiting on. Give them their own process so a 40,000-row export
cannot slow down a charge.

```
gateway ──► broker ──► workers ──► Postgres
                          │
                          ├─ cdr-worker      price and write CDRs
                          ├─ ocpi-worker     push CDRs, sync locations
                          ├─ export-worker   CSV and PDF generation
                          └─ sweeper         command timeouts, stale sessions
```

Use the broker you already added in stage 2. The gateway already publishes
canonical events; workers are just more subscribers, which is the payoff for
having done it that way.

### Sharding, and why you probably should not

At tens of thousands of stations, people start talking about sharding Postgres.
Before you do, notice the shape of the data:

**You do not need a distributed database. You need less data in the hot
tables.** In order of effort:

1. **Retention.** Drop meter-value partitions older than 90 days. Most of your
   "scale problem" is data nobody has queried in a year.
2. **Archive.** Move CDRs older than a year to cold storage, queried on demand.
3. **Read replicas**, which you already have.
4. **Split by region.** If you operate in three countries, three independent
   deployments is often simpler and better than one sharded system — separate
   failure domains, separate data-residency stories, separate maintenance
   windows. Roaming between them is OCPI, which you have already built.

Sharding is the last resort, and "we split by country instead" is a stronger
answer than a hand-rolled shard key.

---

## Failure modes, and what each one looks like

The part that separates people who have run one of these from people who have
read about it.

### The reconnect storm

**Trigger:** any gateway restart, a network blip, a proxy upgrade.

**What happens:** every station reconnects at once, each sending a
BootNotification, a StatusNotification per connector, and any buffered offline
messages. A 5,000-station pod can produce 20,000+ messages in a few seconds.

**Defences, in layers:**

```ts
/**
 * 1. Accept the connection, then admit gradually.
 *
 * A token bucket on BootNotification processing. Stations that exceed it get
 * `status: "Pending"` with a short interval — a legitimate protocol answer
 * meaning "wait and ask again", which spreads the load without dropping
 * anyone.
 */
if (!bootBucket.tryConsume()) {
  return { status: 'Pending', currentTime: now(), interval: 10 + Math.random() * 20 };
}
```

```ts
/**
 * 2. Spread the drain on the way out (deployment chapter). Stations closed
 *    over 60 seconds come back over 60 seconds.
 *
 * 3. Vary the heartbeat interval you hand out. Sending every station
 *    `interval: 300` at boot synchronises the whole fleet's heartbeats onto
 *    the same second, forever — a self-inflicted spike every five minutes.
 */
const interval = 300 + Math.floor(Math.random() * 60) - 30;   // 270–330
```

That third one is a small detail with a large effect, and it is the kind of
thing that only shows up on a graph.

### Redis is down

The registry is gone. **Degrade, do not fail:**

- Local lookups still work, so every station still charges. OCPP is unaffected.
- Cross-instance commands fail with `STATION_OFFLINE` — honest, and recoverable.
- The realtime fan-out is per-instance, so a dashboard sees only the stations
  on the instance it is attached to.

The system keeps charging cars. That is the right priority, and designing for
it means never putting Redis on the OCPP hot path.

### Postgres is down

Worse, and the design still helps:

- Stations stay connected (the gateway holds sockets, not rows).
- Handlers that need a write must fail. **Return a CALLERROR** rather than
  hanging — a station that times out reconnects and makes everything worse.
- `Authorize` can fall back to a cached local list if you have one. This is
  what OCPP's local authorization list is *for*, and it is why stations
  implement it.

```ts
// The buffered-write temptation, and why to resist it.
//
// Buffering a StartTransaction in memory "until Postgres comes back" means
// your process now holds the only record of a car charging. One restart and
// that energy is unbilled and unexplainable. Fail loudly; let the station's
// own offline buffering do the job it was designed for.
```

### One station goes rogue

A firmware bug that sends MeterValues every 100 ms, or reconnects in a loop.

```ts
/**
 * Per-station rate limiting. A single misbehaving device must not degrade the
 * fleet — and it is always a device, never an attacker.
 *
 * Log it loudly and expose it in the dashboard: "station X sent 400 messages
 * in the last minute" is the diagnosis, and the fix is usually a firmware
 * ticket, not a code change.
 */
if (!stationBucket(identity).tryConsume()) {
  metrics.rateLimited.inc({ identity });
  return;   // drop the message; do not close the connection
}
```

### The slow query that took down charging

The one to tell as a story. An operator exports 90 days of sessions. The query
holds a connection, the pool exhausts, an OCPP handler cannot get a connection,
the station times out, it reconnects, and the reconnect needs a connection too.

Three independent fixes, and you want all three:

1. `statement_timeout` on the API's pool — an export is capped, not unbounded.
2. Separate pools for gateway and API, so exhausting one cannot starve the
   other. After stage 2 they are separate processes, which does this for free.
3. Exports go to a worker and return a download link, not a response body.

---

## Capacity planning, worked

For 10,000 stations at 15% utilisation:

| Component | Sizing | Reasoning |
|---|---|---|
| Gateway | 3 pods × 4 GB | ~3,300 connections each. The sockets are only ~0.2 GB — the headroom is for reconnect storms, when every station sends a boot plus its offline buffer at once |
| Core API | 3 pods × 1 GB | Request-driven; scale on p95 latency |
| Realtime | 2 pods × 1 GB | Sized by concurrent dashboards, not by fleet |
| Postgres | 8 vCPU, 32 GB, NVMe | ~200 writes/s (frames plus meter values). At 15% utilisation that is ~1.5 billion meter rows a year — a few hundred GB with indexes, before compression |
| PgBouncer | 1 (or 2 for HA) | Transaction mode; keeps backends under ~100 |
| Redis | 2 GB, 1 replica | ~10,000 keys plus pub/sub. Tiny. |
| Broker | 3 nodes | For quorum, not throughput |

**Total: roughly 20 vCPU and 60 GB of RAM for 10,000 charge points.** It is a
small system. The complexity is in the connection model, not in the volume —
and being able to say that, with the arithmetic behind it, is the point of this
chapter.

---

## What you can now explain

- Why a CPMS is connection-bound rather than throughput-bound, with numbers.
- Why splitting the processes before you need to is the highest-value step.
- How a command reaches a station on another pod, and how that fails.
- Why gateway pods drift out of balance and why that is fine.
- Why meter values are batched and stop transactions never are.
- What a cache stampede is and the one-line fix.
- Three independent defences against a reconnect storm, including randomising
  the heartbeat interval.
- What still works when Redis dies, and what you deliberately let fail when
  Postgres does.
- When splitting by region beats sharding.

---

Next: **[Interview prep →](../07-interview-prep.md)**
