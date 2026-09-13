# Deployment

**Goal:** run the architecture from the previous chapter somewhere real,
without dropping a fleet every time you deploy.

This chapter is deliberately concrete. Every file here is one you can copy.

---

## The one thing that makes CPMS deployment different

A normal rolling deploy is invisible: in-flight requests finish, new pods take
over, nobody notices.

A gateway deploy **disconnects every station on the pod**. They notice. And
then they all come back at the same moment, which is the problem:

```
   pod terminated
        │
        ▼
   200 stations disconnect simultaneously
        │
        ▼
   200 stations reconnect within ~1 second      ← thundering herd
        │
        ▼
   200 BootNotifications, 200 StatusNotifications per connector,
   200 sets of buffered offline messages, all at once
        │
        ▼
   the new pod falls over, they all reconnect again
```

Two mitigations, and you need both. **Drain slowly** (below), and make sure
your stations reconnect with **jitter** — which you cannot control on real
hardware, so the server side has to absorb it.

---

## Containers

### The Dockerfile

```dockerfile
# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually
# change. Copying the source first is the single most common reason a Docker
# build takes four minutes instead of ten seconds.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# Do not run as root. If the process is compromised, this is the difference
# between "an attacker in a container" and "an attacker who can write to a
# mounted volume".
RUN addgroup -S app && adduser -S app -G app

# tini as PID 1. Node does not reap zombies and does not forward signals to
# children the way an init does — without this, SIGTERM handling is subtly
# unreliable, which matters a great deal for the drain below.
RUN apk add --no-cache tini

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/migrations ./migrations
COPY --chown=app:app package.json ./

USER app
ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

> **One image, three roles.** The gateway, the API and the realtime service are
> the same build with a different `ROLE` environment variable. Three images
> that must stay in lockstep is three chances to ship a version skew.

```ts
// src/index.ts
const ROLE = process.env.ROLE ?? 'all';   // 'all' | 'gateway' | 'api' | 'realtime'

if (ROLE === 'all' || ROLE === 'api')      await registerApi(app);
if (ROLE === 'all' || ROLE === 'realtime') attachRealtime(server);
if (ROLE === 'all' || ROLE === 'gateway')  attachOcppGateway(server);

// `all` is not a fallback for production. It is the mode you develop in, and
// keeping it working is what keeps local debugging pleasant.
```

### Compose, for a single box

This runs the whole system and is a perfectly good production deployment for a
few hundred stations.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
      POSTGRES_DB: ocpp
    volumes:
      - pgdata:/var/lib/postgresql/data
      # A named volume, not a bind mount. Bind mounts on Docker Desktop are
      # slow enough to change your query plans, which makes local performance
      # testing lie to you.
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres']
      interval: 5s
      retries: 10
    secrets: [pg_password]

  redis:
    image: redis:7-alpine
    # Redis holds the connection registry, which is rebuildable from the
    # gateways. Persistence off is the correct choice: a Redis restart costs
    # you a few seconds of stale lookups, and AOF fsyncs cost you latency on
    # every connection.
    command: redis-server --save '' --appendonly no --maxmemory 512mb --maxmemory-policy noeviction
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s

  migrate:
    build: .
    command: node dist/migrate.js
    environment:
      DATABASE_URL: postgres://postgres@postgres:5432/ocpp
    depends_on:
      postgres: { condition: service_healthy }
    # Runs to completion, then exits. The app services wait for it, so a bad
    # migration stops the deploy instead of producing half-migrated pods.
    restart: 'no'

  api:
    build: .
    environment: { ROLE: api, PORT: '3000' }
    depends_on:
      migrate: { condition: service_completed_successfully }
    deploy: { replicas: 2 }

  gateway:
    build: .
    environment: { ROLE: gateway, PORT: '3000' }
    depends_on:
      migrate: { condition: service_completed_successfully }
    # NOT replicated here. Two gateways behind Compose's round-robin DNS with
    # no sticky routing and no Redis registry would break command delivery —
    # see the architecture chapter. One gateway until you have stage 2.
    stop_grace_period: 90s

  caddy:
    image: caddy:2-alpine
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data

volumes: { pgdata: {}, caddydata: {} }
secrets:
  pg_password: { file: ./secrets/pg_password }
```

### TLS termination

```caddyfile
# Caddyfile
cms.example.com {
    # Automatic Let's Encrypt. For a CPMS this is the right default: stations
    # trust public CAs out of the box, and a self-signed cert means touching
    # firmware on every unit in the field.
    encode gzip

    # OCPP stations. Long-lived, so the timeouts must be generous — a proxy
    # that closes idle WebSockets after 60 seconds will disconnect a station
    # between heartbeats and you will blame the station.
    handle /ocpp/* {
        reverse_proxy gateway:3000 {
            transport http {
                read_timeout 0        # no idle timeout. This is the important line.
                write_timeout 0
            }
        }
    }

    handle /api/v1/realtime* {
        reverse_proxy realtime:3000 {
            transport http { read_timeout 0 }
        }
    }

    handle /api/* { reverse_proxy api:3000 }
    handle /ocpi/* { reverse_proxy api:3000 }
}
```

> **The idle-timeout trap.** Default proxy timeouts are 60 seconds. The OCPP
> heartbeat default is 300. So out of the box, every station disconnects every
> minute, reconnects, re-boots, and your logs fill with reconnections that look
> like flaky hardware. It is the proxy. Set the read timeout to zero and keep
> the WebSocket ping from Milestone 9 as the real liveness check.

---

## The graceful drain

This is the part worth getting right, and it is about twenty lines.

```ts
// src/shutdown.ts

/**
 * Shutting down a gateway without dropping a fleet.
 *
 * The order matters and each step has a reason:
 *
 *  1. FAIL READINESS FIRST. The load balancer stops sending new connections
 *     while the old ones are still being served. Skipping this means new
 *     stations connect to a pod that is about to die.
 *
 *  2. WAIT for the load balancer to notice. Kubernetes removes a pod from
 *     endpoints asynchronously — typically a few seconds. Closing immediately
 *     after failing readiness races that removal, which is exactly the bug
 *     that produces "some connections refused during every deploy".
 *
 *  3. CLOSE THE STATIONS SLOWLY, spread over the grace period. This is the
 *     thundering-herd fix: 200 stations closed over 60 seconds reconnect over
 *     60 seconds. Closed all at once, they reconnect all at once.
 *
 *  4. Use close code 1001 ("going away"). Well-behaved firmware treats it as
 *     "reconnect promptly" rather than "something is wrong, back off".
 *
 *  5. THEN drain HTTP, then the database pool.
 */
let ready = true;
export const isReady = () => ready;

export async function shutdown(signal: string) {
  logger.info({ signal }, 'shutdown starting');
  ready = false;                                              // 1

  await sleep(config.DRAIN_DELAY_MS);                         // 2  (5s)

  const connections = registry.all();
  const window = config.DRAIN_WINDOW_MS;                      // 3  (60s)
  const gap = connections.length > 0 ? window / connections.length : 0;

  logger.info({ count: connections.length, window }, 'draining stations');

  for (const connection of connections) {
    // Deregister from Redis as we go, so commands stop being routed here
    // before the socket actually closes.
    await registry.remove(connection.identity);
    connection.socket.close(1001, 'Server restarting');       // 4
    if (gap > 0) await sleep(gap);
  }

  await app.close();                                          // 5
  await pool.end();
  await redis.quit();

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

And the matching Kubernetes config — the grace period **must** exceed
`DRAIN_DELAY_MS + DRAIN_WINDOW_MS`, or the kubelet SIGKILLs you mid-drain and
every remaining station drops at once anyway:

```yaml
terminationGracePeriodSeconds: 90    # 5s delay + 60s window + headroom
```

---

## Health, readiness and startup

Three different questions. Wiring one endpoint to all three is a classic and
costly mistake.

```ts
// src/api/routes/health.ts

/**
 * LIVENESS — "is this process wedged?"
 *
 * Must NOT check the database. If Postgres goes down and liveness checks it,
 * Kubernetes restarts every pod, they all reconnect to a database that is
 * still down, and you have turned an outage into a crash loop that also
 * destroys every station connection. Liveness answers 200 unless the event
 * loop itself is stuck.
 */
app.get('/healthz', async () => ({ status: 'ok' }));

/**
 * READINESS — "should I receive traffic?"
 *
 * This one DOES check dependencies, and it is what the drain flips first.
 */
app.get('/readyz', async (_request, reply) => {
  if (!isReady()) return reply.code(503).send({ status: 'draining' });
  try {
    await query('SELECT 1');
    await redis.ping();
    return { status: 'ready', connections: registry.count() };
  } catch (err) {
    return reply.code(503).send({ status: 'degraded', error: String(err) });
  }
});

/**
 * STARTUP — "has it finished booting?"
 *
 * Separate because the first boot may run migrations and warm caches. Without
 * a startup probe you must set a liveness `initialDelaySeconds` long enough
 * for the worst case, which then delays detection of real hangs forever after.
 */
app.get('/startupz', async (_request, reply) =>
  migrationsComplete ? { status: 'started' } : reply.code(503).send({ status: 'starting' }));
```

```ts
/**
 * The PUBLIC health endpoint the frontend probes is a different thing again.
 * It is the contract's `GET /api/v1/health`, it is unauthenticated, and it
 * advertises which protocols you speak — that is what flips the dashboard out
 * of mock mode. Do not merge it with /readyz: one is for Kubernetes, the
 * other is a feature.
 */
app.get('/api/v1/health', async () => ({
  status: 'ok',
  version: config.VERSION,
  protocols: ['ocpp1.6', 'ocpp2.0.1'],
  time: new Date().toISOString(),
}));
```

---

## Migrations

```ts
// src/migrate.ts

/**
 * Run migrations as a separate job, before the app starts. Never on boot.
 *
 * Three pods booting simultaneously and all running migrations is a race that
 * corrupts your schema in ways that are tedious to unpick. A job runs once,
 * and if it fails the deploy stops with the pods still on the old version —
 * which is exactly what you want.
 *
 * The advisory lock makes it safe even if someone runs it twice by hand.
 */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      )`);

    const applied = await client.query('SELECT version, checksum FROM schema_migrations');
    const seen = new Map(applied.rows.map((r) => [r.version, r.checksum]));

    for (const file of await listMigrationFiles()) {
      const sql = await readFile(file.path, 'utf8');
      const checksum = sha256(sql);

      if (seen.has(file.version)) {
        /**
         * An applied migration whose content changed means someone edited a
         * file that has already run somewhere. Refuse loudly: environments
         * are now silently different from each other, and finding that out in
         * six months is much worse than failing this deploy.
         */
        if (seen.get(file.version) !== checksum) {
          throw new Error(`Migration ${file.version} was modified after being applied`);
        }
        continue;
      }

      logger.info({ version: file.version }, 'applying migration');
      // Each migration in its own transaction, so a failure leaves the
      // earlier ones applied and the schema at a known point.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [file.version, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    client.release();
  }
}
```

> **Expand, migrate, contract.** During a rolling deploy, old and new code run
> at the same time, so every migration must be compatible with the version
> before it. Adding a NOT NULL column with no default breaks every old pod
> instantly. The safe sequence is three deploys: add the column nullable →
> deploy code that writes it → backfill and add the constraint. Tedious, and
> the alternative is downtime.

---

## Configuration

```ts
// src/config.ts — the full production surface
export const config = ConfigSchema.parse(process.env);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['all', 'gateway', 'api', 'realtime']).default('all'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string(),
  // Per POD, not in total. 10 pods × 20 = 200 connections, and Postgres's
  // default max_connections is 100. This is the most common way to take a
  // system down by scaling it up — see the pooling note below.
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // No default. A JWT secret with a default WILL reach production.
  JWT_SECRET: z.string().min(32),

  CORS_ORIGINS: z.string(),
  ALLOW_UNKNOWN_STATIONS: z.coerce.boolean().default(false),
  CALL_TIMEOUT_MS: z.coerce.number().default(30_000),
  DRAIN_DELAY_MS: z.coerce.number().default(5_000),
  DRAIN_WINDOW_MS: z.coerce.number().default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})
  .refine((c) => c.NODE_ENV !== 'production' || !c.ALLOW_UNKNOWN_STATIONS, {
    message: 'ALLOW_UNKNOWN_STATIONS must be false in production',
  });
```

> **Connection pooling is where scaling up takes you down.** Postgres forks a
> backend process per connection; a few hundred is expensive and a thousand is
> fatal. Put **PgBouncer** in transaction mode in front of it before you
> exceed roughly 100 total, and then keep the per-pod pool small — 5 is
> usually plenty behind a pooler. Transaction mode breaks session-level
> features (`LISTEN/NOTIFY`, session advisory locks, prepared statements), so
> if you used `LISTEN/NOTIFY` for pub/sub you must have moved to Redis first.
> This is why the realtime bus is on Redis and not on Postgres notifications.

---

## Observability

Three things, in the order they earn their keep.

### Structured logs with a request id

```ts
app.addHook('onRequest', async (request) => {
  // Accept an inbound id so a trace crosses service boundaries; generate one
  // otherwise. Everything logged during this request carries it, and "find
  // every line for the request that failed" becomes one grep.
  request.id = (request.headers['x-request-id'] as string) ?? randomUUID();
});
```

For OCPP the equivalent is the **message id**, which you already log on every
frame. A support question — "the station says the start failed at 14:32" —
becomes: find the frame, take the message id, pull every line that mentions it.

### Metrics that actually tell you something

```ts
// src/metrics.ts
export const metrics = {
  // THE number for a CPMS. If it drops, something is wrong, and it is the
  // first graph to put on a wall.
  stationsConnected: new Gauge({ name: 'ocpp_stations_connected' }),

  // Split by protocol, because a bug in one version's handler shows up here
  // before it shows up anywhere else.
  messagesTotal: new Counter({ name: 'ocpp_messages_total', labelNames: ['protocol', 'action', 'direction'] }),

  // A station that answers slowly is a station about to time out.
  callDuration: new Histogram({
    name: 'ocpp_call_duration_seconds',
    labelNames: ['action'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  }),

  // Commands that were accepted and never produced their effect — Milestone
  // 6's sweeper. A rising number means stations are accepting and not acting.
  commandOutcomes: new Counter({ name: 'command_outcomes_total', labelNames: ['command', 'status'] }),

  sessionsActive: new Gauge({ name: 'sessions_active' }),
  // Undelivered CDRs are unbilled revenue. Alert on this one.
  ocpiQueueDepth: new Gauge({ name: 'ocpi_push_queue_depth', labelNames: ['status'] }),
};
```

### Alerts worth waking someone for

| Alert | Condition | Why |
|---|---|---|
| Fleet offline | `stations_connected` drops >20% in 5 min | Your problem, not theirs |
| Boot storm | BootNotification rate > 10× baseline | Reconnect loop somewhere |
| Command failure rate | >10% failed/timeout over 15 min | Gateway or routing broken |
| CDR queue stuck | `ocpi_push_queue_depth{status="failed"}` > 0 | Money not being billed |
| Session never closed | active session older than 24h | Lost StopTransaction |
| Auth failures | station auth failures > 50/min | Attack, or a botched rotation |

Notice what is *not* there: CPU, memory, request rate. Those are diagnostics.
**Alert on the things a customer would notice.**

---

## Backups

```bash
# Daily base backup + continuous WAL archiving.
# The distinction that matters: a nightly dump means you can lose up to 24
# hours of CDRs — which is revenue you cannot reconstruct, because the
# stations do not keep it either. WAL archiving makes recovery
# point-in-time, so the worst case is seconds.
pg_basebackup -D /backup/base -Ft -z -Xs -P
archive_command = 'aws s3 cp %p s3://backups/wal/%f'
```

**Test the restore.** An untested backup is a hypothesis. Restore into a scratch
database quarterly and run one query: does the newest CDR match production's?

---

## The deployment checklist

Before the first real station connects:

- [ ] TLS with a **publicly trusted** certificate (stations do not have your CA)
- [ ] Security profile 2 enforced; profile 0 refused in production
- [ ] `JWT_SECRET` from a secret store, not an env file in git
- [ ] Proxy idle timeouts disabled on `/ocpp/*` and the realtime path
- [ ] `terminationGracePeriodSeconds` > drain delay + drain window
- [ ] Migrations as a job, not on boot
- [ ] Liveness does **not** check the database
- [ ] WAL archiving on, and a restore tested
- [ ] `stations_connected` graphed and alerted
- [ ] Log redaction verified: `grep -i password` over a full run returns nothing
- [ ] A retention policy on `meter_values` and `ocpp_frames`, with the partition
      drop job scheduled

---

## What you can now explain

- Why a gateway deploy is fundamentally different from an API deploy.
- What a thundering herd is, and the two things that prevent one.
- Why liveness must not check the database.
- Why migrations run as a job with an advisory lock and a checksum.
- Why expand-migrate-contract exists, in three deploys.
- Why per-pod connection pools multiply, and when PgBouncer becomes mandatory.
- Which metrics matter for a CPMS specifically, and which are just noise.

---

Next: **[Scaling →](../06-scaling/README.md)**
