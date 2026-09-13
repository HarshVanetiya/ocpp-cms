# Milestone 8 — The REST API

**Goal:** the dashboard stops using mock data. All of it.

**Time:** 6–8 hours. The longest milestone, and the most satisfying.

**Endpoints:** 35. This is the big one.

---

## Why this exists

Everything so far has been invisible. Rows appeared in Postgres and you read
them with `psql`. This milestone connects what you built to the thing people
actually look at.

There is a specific moment coming: you implement `GET /dashboard/stats`, refresh
the dashboard, and the four tiles at the top switch from mock numbers to *your
fleet's* numbers. Watch for it. That is the moment the project becomes real.

### How the frontend decides

Open `/progress` in the dashboard. Every endpoint in the contract is listed,
grouped by milestone, with a state:

- **grey** — the UI has not called it this session
- **amber** — called, and served by the mock (your server answered 404 or 501)
- **green** — called, and **your** server answered

The mechanism is in `packages/mocks/src/handlers/resolver.ts` and it is worth
understanding, because it is what makes this milestone a checklist instead of a
cliff:

```
browser request
      │
      ▼
  mock service worker
      │
      ├─► forward to your backend
      │       │
      │       ├─ 200/4xx (not 404/501) → return YOUR response, untouched
      │       └─ 404 or 501            → fall through to the mock
      │
      └─ your server unreachable → circuit breaker opens, mock serves
                                    everything for 10 seconds, then retries
```

So a clean 404 from an unbuilt route is not a failure — it is the handshake.
This is why Milestone 1 insisted on a proper `setNotFoundHandler`.

> **`npm run dev` has no mocks at all.** The mock worker is behind
> `import.meta.env.DEV` and a mode check, so a production build does not
> contain it. `dev:learn` is the training-wheels mode; `dev` is the real thing
> pointed at your server. When you finish this milestone, run `npm run dev` and
> the dashboard should be fully functional with no fallback anywhere.

---

## Build it

### 1. Auth: sessions, not just tokens

```ts
// src/domain/auth.ts
import { randomBytes, createHash } from 'node:crypto';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { query } from '../db/index.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Two tokens, and they are not the same kind of thing.
 *
 *   ACCESS  — a signed JWT, 15 minutes, sent on every request. Stateless:
 *             we verify the signature and never touch the database.
 *   REFRESH — an opaque random string, 30 days, stored HASHED in the
 *             database, used only to mint new access tokens.
 *
 * Why the asymmetry? Because you need both "cheap to verify" and "possible to
 * revoke", and no single token gives you both. A JWT cannot be revoked before
 * it expires — that is the whole point of it being stateless. So we keep the
 * JWT short-lived and put revocability in the refresh token, which IS a
 * database row you can delete.
 *
 * This means: logging out is instant for the refresh token and takes up to 15
 * minutes for the access token. That trade-off is a normal, defensible answer
 * to "how do you revoke a session?" — much better than "JWTs can't be
 * revoked".
 */

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 30;

export async function login(email: string, password: string, meta: RequestMeta) {
  const user = await query(
    `SELECT id, email, name, role, status, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  ).then((r) => r.rows[0]);

  /**
   * Verify a hash even when the user does not exist.
   *
   * Without this, a wrong email returns in 1ms and a wrong password in 80ms,
   * and anyone can enumerate which email addresses have accounts by timing
   * the response. Burn the same CPU either way.
   */
  const hash = user?.password_hash ?? DUMMY_HASH;
  const ok = await argon2.verify(hash, password).catch(() => false);

  // One message for both failures. "No such user" tells an attacker something.
  if (!user || !ok) throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect', 401);
  if (user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', 'This account is disabled', 403);

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  return issueTokens(user, meta);
}

async function issueTokens(user: { id: string; role: string }, meta: RequestMeta) {
  const accessToken = jwt.sign(
    { sub: user.id, role: user.role },
    config.JWT_SECRET,
    { expiresIn: ACCESS_TTL_SECONDS, issuer: 'ocpp-cms' },
  );

  const refreshToken = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)`,
    // Hash it. A leaked database backup must not hand over live sessions —
    // the same reasoning as password hashing, and people forget it here.
    [user.id, sha256(refreshToken), String(REFRESH_TTL_DAYS), meta.userAgent, meta.ip],
  );

  return {
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      tokenType: 'Bearer' as const,
    },
  };
}

export async function refresh(refreshToken: string, meta: RequestMeta) {
  const row = await query(
    `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at
       FROM refresh_tokens rt WHERE rt.token_hash = $1`,
    [sha256(refreshToken)],
  ).then((r) => r.rows[0]);

  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw AppError.unauthorized();
  }

  /**
   * Rotation: every refresh invalidates the token that was used.
   *
   * If a refresh token is ever used twice, one of the two users of it is an
   * attacker — and you cannot tell which. The safe response is to revoke the
   * whole family, forcing a real login. This is standard practice and a good
   * thing to be able to describe.
   */
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);

  const user = await query(`SELECT id, role, status FROM users WHERE id=$1`, [row.user_id])
    .then((r) => r.rows[0]);
  if (!user || user.status !== 'active') throw AppError.unauthorized();

  return issueTokens(user, meta);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A real argon2 hash of a random string, so the timing matches a real verify. */
const DUMMY_HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + '…';
```

```sql
-- migrations/005_auth.sql
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The HASH, never the token.
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
```

```ts
// src/api/auth-plugin.ts
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; role: string };
  }
}

/**
 * `fastify-plugin` wraps this so the decorators leak OUT of the plugin scope.
 * Without fp(), Fastify encapsulates it and `request.user` is undefined in
 * every route — a genuinely confusing hour if you have not met it before.
 */
export const authPlugin = fp(async (app) => {
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', async (request) => {
    // Endpoints mark themselves public; everything else needs a token. The
    // default is CLOSED — a route you forget to annotate fails safe.
    if (isPublic(request.routeOptions?.url, request.method)) return;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();

    try {
      const claims = jwt.verify(header.slice(7), config.JWT_SECRET, { issuer: 'ocpp-cms' });
      request.user = { id: String(claims.sub), role: String((claims as any).role) };
    } catch {
      // Do not distinguish "expired" from "invalid" in the message; the
      // client retries with the refresh token either way, and the frontend's
      // api-client already does exactly that on a 401.
      throw AppError.unauthorized();
    }
  });
});

const PUBLIC = new Set([
  'GET /api/v1/health',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
]);
const isPublic = (url = '', method = '') => PUBLIC.has(`${method} ${url}`);
```

> **Roles.** `admin` | `operator` | `viewer` | `driver`. A `viewer` may GET but
> not mutate; a `driver` may only reach `/driver/*`. A tiny `requireRole()`
> hook on the mutating routes is enough — do not build a permission engine for
> four roles.

### 2. The thing nobody warns you about: case mapping

Postgres gives you `meter_start_wh`. The contract says `meterStartWh`. If you
convert by hand in every route you will get one wrong, and the frontend's
response validation will tell you so in a way that is annoying to trace.

Do it once:

```ts
// src/db/case.ts

/**
 * snake_case rows → camelCase objects.
 *
 * The alternative — aliasing every column in every query
 * (`meter_start_wh AS "meterStartWh"`) — works and is arguably more explicit,
 * but it puts the API's naming convention inside your SQL, and you will
 * forget one. Convert at the boundary instead.
 *
 * Deliberately NOT recursive into arrays of non-objects, and it leaves `Date`
 * and `Buffer` alone: a generic deep-transform that mangles a timestamp is a
 * bug you will spend an afternoon on.
 */
export function camelise<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camelise(v)) as T;
  if (value === null || typeof value !== 'object') return value as T;
  if (value instanceof Date || Buffer.isBuffer(value)) return value as T;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = camelise(v);
  }
  return out as T;
}
```

And two more conversions that bite:

```ts
// src/db/index.ts
import pg from 'pg';

/**
 * node-postgres returns BIGINT as a STRING, because a 64-bit integer does not
 * fit in a JS number. Our bigints are watt-hours and minor-unit money — both
 * comfortably inside Number.MAX_SAFE_INTEGER (9 quadrillion) — so parsing
 * them as numbers is safe HERE and would not be for, say, a Twitter id.
 *
 * Without this, `energyWh` arrives at the frontend as "8420" and Zod rejects
 * it. That is your contract validation earning its keep.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** NUMERIC also comes back as a string, for the same reason. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
```

> **Timestamps.** `pg` gives you `Date` objects; the contract wants ISO
> strings with a `Z`. `JSON.stringify` does the right thing for `Date`
> automatically (`toISOString()`), so Fastify's serializer handles it — but
> only if the column is `TIMESTAMPTZ`. A plain `TIMESTAMP` loses the zone and
> you will serve times that are wrong by your server's offset. Your schema
> uses `TIMESTAMPTZ` everywhere for exactly this reason.

### 3. A list endpoint, properly

`GET /stations` is the pattern for the other fourteen list endpoints. Build it
once, carefully.

```ts
// src/api/routes/stations.ts
import { StationListQuerySchema } from '@ocpp/contracts';
import { camelise } from '../../db/case.js';

app.get('/stations', async (request) => {
  const q = StationListQuerySchema.parse(request.query);

  /**
   * Dynamic WHERE without string concatenation.
   *
   * Never build SQL by joining user input into a string. Collect parameters
   * in an array and emit $1, $2, … — `pg` sends them out-of-band and they
   * cannot become SQL. This pattern is verbose and it is worth it.
   */
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (q.status)     add('s.status = ?', q.status);
  if (q.protocol)   add('s.protocol = ?', q.protocol);
  if (q.locationId) add('s.location_id = ?', q.locationId);
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(s.name ILIKE $${params.length} OR s.identity ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  /**
   * Sorting from user input, safely: an ALLOW-LIST, never interpolation.
   * `sort=name; DROP TABLE stations--` must map to "unknown field, use the
   * default", not to a parameterised anything. There is no way to
   * parameterise a column name in SQL, so the allow-list is the mechanism.
   */
  const SORTABLE: Record<string, string> = {
    name: 's.name',
    identity: 's.identity',
    status: 's.status',
    createdAt: 's.created_at',
    lastHeartbeatAt: 's.last_heartbeat_at',
  };
  const desc = q.sort?.startsWith('-');
  const sortKey = (q.sort ?? '').replace(/^-/, '');
  const orderBy = `${SORTABLE[sortKey] ?? 's.name'} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;

  params.push(q.pageSize, (q.page - 1) * q.pageSize);

  /**
   * One query, not N+1.
   *
   * The obvious implementation fetches stations, then loops and fetches each
   * station's connectors: 26 queries for a page of 25. With a lateral join
   * and json aggregation it is one. This is THE performance lesson of the
   * milestone — a dashboard that does N+1 feels fine with your ten test
   * stations and falls over at two hundred.
   */
  const sql = `
    SELECT s.*,
           l.name AS location_name,
           l.city AS location_city,
           COALESCE(c.connectors, '[]'::json) AS connectors,
           COALESCE(c.total, 0)              AS connector_count,
           COALESCE(c.available, 0)          AS connectors_available
      FROM stations s
      LEFT JOIN locations l ON l.id = s.location_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 'id', con.id, 'evseId', e.evse_id, 'connectorId', con.connector_id,
                 'type', con.type, 'status', con.status, 'maxPowerKw', con.max_power_kw
               ) ORDER BY e.evse_id, con.connector_id) AS connectors,
               count(*)                                        AS total,
               count(*) FILTER (WHERE con.status = 'available') AS available
          FROM evses e
          JOIN connectors con ON con.evse_id = e.id
         WHERE e.station_id = s.id
      ) c ON true
      ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const [rows, total] = await Promise.all([
    query(sql, params).then((r) => r.rows),
    query(`SELECT count(*)::int AS n FROM stations s ${whereSql}`,
          params.slice(0, params.length - 2)).then((r) => r.rows[0].n),
  ]);

  return {
    data: rows.map((row) => camelise(withLiveState(row))),
    meta: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize) || 1,
    },
  };
});

/**
 * The database says what we last persisted; the registry says what is true
 * right now. A station whose process crashed still has `status='online'` in
 * Postgres until something notices. Overlay live state at read time.
 */
function withLiveState(row: Record<string, unknown>) {
  const online = registry.isOnline(row.identity as string);
  return { ...row, status: online ? row.status : row.status === 'online' ? 'offline' : row.status };
}
```

> **The `count(*)` question.** Running a second count query doubles the work.
> For tables under a few hundred thousand rows it is fine and it is what the
> contract's `meta.total` needs. Past that, people switch to an estimate from
> `pg_class.reltuples` or to cursor pagination. Knowing that the exact count is
> the expensive half of pagination is the point.

### 4. Dashboard stats

The most-viewed screen must not be the slowest.

```ts
// src/domain/dashboard.ts

/**
 * Everything the overview needs, in four queries rather than fourteen.
 *
 * The `FILTER (WHERE …)` clause is the tool: one pass over the table
 * producing many counts. Writing this as separate COUNT queries would scan
 * the same rows four times.
 */
export async function dashboardStats(range: TimeRange) {
  const { start, previousStart } = rangeBounds(range);

  const [fleet, connectors, sessions, energy] = await Promise.all([
    query(`
      SELECT count(*)::int                                          AS total,
             count(*) FILTER (WHERE status = 'online')::int          AS online,
             count(*) FILTER (WHERE status = 'offline')::int         AS offline,
             count(*) FILTER (WHERE status = 'unavailable')::int     AS faulted
        FROM stations`),

    query(`
      SELECT status, count(*)::int AS n
        FROM connectors GROUP BY status`),

    query(`
      SELECT
        count(*) FILTER (WHERE status IN ('active','suspended','pending'))::int AS active,
        count(*) FILTER (WHERE status = 'completed' AND started_at >= $1)::int  AS completed,
        count(*) FILTER (WHERE status = 'completed'
                          AND started_at >= $2 AND started_at < $1)::int        AS completed_prev,
        count(*) FILTER (WHERE status = 'failed'   AND started_at >= $1)::int   AS failed,
        COALESCE(avg(extract(epoch FROM (ended_at - started_at)))
                 FILTER (WHERE status='completed' AND started_at >= $1), 0)     AS avg_duration_seconds,
        COALESCE(avg(energy_wh) FILTER (WHERE status='completed' AND started_at >= $1), 0) AS avg_energy_wh
      FROM sessions`, [start, previousStart]),

    query(`
      SELECT COALESCE(sum(energy_wh) FILTER (WHERE started_at >= $1), 0)::bigint AS total_wh,
             COALESCE(sum(energy_wh) FILTER (WHERE started_at >= $2
                                              AND started_at < $1), 0)::bigint   AS previous_wh,
             COALESCE(sum(cost_minor) FILTER (WHERE started_at >= $1), 0)::bigint AS revenue_minor,
             COALESCE(sum(cost_minor) FILTER (WHERE started_at >= $2
                                              AND started_at < $1), 0)::bigint   AS revenue_prev_minor
        FROM sessions`, [start, previousStart]),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of connectors.rows) byStatus[row.status] = row.n;

  return {
    range,
    generatedAt: new Date().toISOString(),
    currency: 'EUR',
    stations: {
      ...fleet.rows[0],
      availabilityPercent: pct(fleet.rows[0].online, fleet.rows[0].total),
    },
    connectors: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      // Partial by design — the contract uses z.partialRecord here precisely
      // so a fleet with no reserved connectors does not have to send a zero.
      byStatus,
      utilizationPercent: pct(
        (byStatus.charging ?? 0) + (byStatus.suspended_ev ?? 0),
        Object.values(byStatus).reduce((a, b) => a + b, 0),
      ),
    },
    sessions: {
      active: sessions.rows[0].active,
      completed: trend(sessions.rows[0].completed, sessions.rows[0].completed_prev),
      failed: sessions.rows[0].failed,
      avgDurationSeconds: Math.round(sessions.rows[0].avg_duration_seconds),
      avgEnergyWh: Math.round(sessions.rows[0].avg_energy_wh),
    },
    energy: {
      totalWh: trend(energy.rows[0].total_wh, energy.rows[0].previous_wh),
      peakPowerKw: await peakPower(start),
    },
    revenue: {
      totalMinor: trend(energy.rows[0].revenue_minor, energy.rows[0].revenue_prev_minor),
      avgSessionMinor: sessions.rows[0].completed
        ? Math.round(energy.rows[0].revenue_minor / sessions.rows[0].completed)
        : 0,
    },
    protocolSplit: await protocolSplit(),
  };
}

/**
 * `changePercent` is null, not 0, when the previous period was zero.
 *
 * Going from 0 to 5 sessions is not "+500%" and it is not "no change" — it is
 * undefined, and the UI renders a dash for it. Sending 0 would draw a
 * confident green "no change" arrow next to a number that just appeared out of
 * nothing.
 */
const trend = (value: number, previous: number) => ({
  value,
  previous,
  changePercent: previous === 0 ? null : ((value - previous) / previous) * 100,
});

const pct = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);
```

### 5. Time series, bucketed in the database

```ts
// src/domain/dashboard.ts (continued)

/**
 * Bucket width is chosen from the range, not by the caller.
 *
 * 90 days at 1-hour buckets is 2,160 points per series. No chart can show
 * that, no human can read it, and it is 200 KB of JSON. Pick a width that
 * lands between 24 and 200 points and say which one you used — the contract
 * has a `bucket` field for exactly this, so the UI can label the axis
 * honestly.
 */
const BUCKETS: Record<TimeRange, string> = {
  '1h':  '5 minutes',
  '24h': '1 hour',
  '7d':  '6 hours',
  '30d': '1 day',
  '90d': '1 day',
  '12m': '1 month',
};

export async function energySeries(q: TimeSeriesQuery) {
  const bucket = BUCKETS[q.range];
  const { start } = rangeBounds(q.range);

  const groupExpr = {
    none:     `'total'`,
    protocol: `s.protocol`,
    location: `COALESCE(l.name, 'Unassigned')`,
    station:  `s.name`,
  }[q.groupBy];

  /**
   * `generate_series` + LEFT JOIN, not `GROUP BY` alone.
   *
   * A plain GROUP BY omits buckets with no data, and a line chart then draws
   * a straight line across the gap — which reads as "steady" when the truth
   * is "nothing happened". Generate every bucket and join onto it, so empty
   * hours are explicit zeroes.
   */
  const { rows } = await query(`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('hour', $1::timestamptz), now(), $2::interval
      ) AS t
    )
    SELECT b.t,
           ${groupExpr} AS key,
           COALESCE(sum(ses.energy_wh), 0)::bigint AS value
      FROM buckets b
      LEFT JOIN sessions ses
             ON ses.started_at >= b.t
            AND ses.started_at <  b.t + $2::interval
      LEFT JOIN stations  s ON s.id = ses.station_id
      LEFT JOIN locations l ON l.id = s.location_id
     GROUP BY b.t, ${groupExpr}
     ORDER BY b.t`, [start, bucket]);

  return {
    metric: 'energy',
    unit: 'Wh',
    range: q.range,
    bucket,
    series: groupRows(rows),
  };
}
```

### 6. The remaining routes, grouped

You now have every pattern you need. The rest is volume — work down
`/progress` and tick them off.

| Group | Routes | Notes |
|---|---|---|
| **Auth** | `login`, `refresh`, `logout`, `me` | `logout` revokes the refresh token row |
| **Dashboard** | `stats`, `series/energy`, `series/sessions`, `activity`, `top-stations` | `activity` is a UNION over sessions, commands and station events |
| **Stations** | list, get, create, update, delete, stats | `create` registers a station *before* it connects |
| **Sessions** | list, get, meter-values, authorizations | meter-values needs downsampling — see below |
| **Locations** | list, get, create, update, delete | list carries aggregate connector counts for the map |
| **Users** | list, get, create, update, delete, groups | never return `password_hash`. Ever. |
| **Tokens** | list, get, create, update, delete | normalise `value` on write: uppercase, strip separators |

Three that deserve a note:

**`GET /sessions/:id/meter-values`** — a six-hour session sampled every ten
seconds is 2,160 rows. The chart is 600 pixels wide. Downsample in the
database:

```sql
-- Every Nth row, cheaply, without loading them all.
SELECT * FROM (
  SELECT *, row_number() OVER (ORDER BY measured_at) AS rn
    FROM meter_values WHERE session_id = $1
) t
WHERE rn % GREATEST(1, (SELECT count(*) FROM meter_values WHERE session_id=$1) / $2) = 0
ORDER BY measured_at;
```

**`DELETE /stations/:id`** — refuse it when sessions exist. Your schema already
does (`ON DELETE RESTRICT`), so catch the foreign key violation and turn it
into a clean `409 CONFLICT` with a message the operator can act on. A raw
Postgres error reaching the UI is a bug, not a feature.

```ts
catch (err) {
  if ((err as { code?: string }).code === '23503') {
    throw AppError.conflict('This station has charging sessions and cannot be deleted');
  }
  throw err;
}
```

**`POST /stations`** — creating a station is not the same as it connecting.
You are registering an identity you *expect*, with `status: 'pending'`. When a
station with that identity dials in, Milestone 3's BootNotification handler
finds it and flips it online. Whether you accept identities you have never seen
is the `ALLOW_UNKNOWN_STATIONS` config flag from Milestone 1 — off in
production, on while you are learning.

### 7. Registering it all

```ts
// src/api/index.ts
import { authPlugin } from './auth-plugin.js';

export async function registerApi(app: FastifyInstance) {
  await app.register(authPlugin);

  await app.register(async (v1) => {
    await v1.register(authRoutes);
    await v1.register(dashboardRoutes);
    await v1.register(stationRoutes);
    await v1.register(commandRoutes);      // Milestone 6
    await v1.register(sessionRoutes);
    await v1.register(locationRoutes);
    await v1.register(userRoutes);
    await v1.register(tokenRoutes);
  }, { prefix: '/api/v1' });
}
```

> **Why `/api/v1` and not `/api`.** Not because you will ever ship a v2 — most
> people do not. Because the prefix is the seam a reverse proxy routes on when
> you split this into services later, and adding it afterwards means changing
> every client. It costs nothing now.

---

## Prove it works

### 1. The moment

With your server running and the frontend on `npm run dev:learn`, implement
`GET /dashboard/stats` and hard-refresh the overview.

The four tiles change. The sparklines change. Open `/progress` and
`dashboardStats` is green.

### 2. Turn the mocks off

```bash
npm run dev     # no mocks, no fallback, no safety net
```

Now every screen either works or is visibly broken. Work through them:

| Screen | Needs |
|---|---|
| `/` overview | `stats`, both series, `activity`, `top-stations` |
| `/stations` | `listStations` |
| `/stations/:id` | `getStation`, `getStationStats`, `listSessions`, `listCommands`, `getStationConfiguration` |
| `/sessions` | `listSessions` |
| `/sessions/:id` | `getSession`, `getSessionMeterValues` |
| `/map` | `listLocations` |
| `/users` | `listUsers`, `listGroups` |
| `/tokens` | `listTokens` |

When all eight work under `npm run dev`, **the dashboard is yours**. Nothing
fake is left in it.

### 3. Check the contract is actually satisfied

Open the browser console. The api-client validates every response against the
same Zod schema the mocks use, and logs a grouped error when a response does
not match:

```
[contract] GET /stations response did not match
  data.0.connectorCount: Expected number, received string
```

That is `pg` handing back a BIGINT as a string — the type parser from step 2.
Every one of these messages is the contract catching a real mismatch before it
becomes a rendering bug. Get to zero.

### 4. Prove the auth flow

```bash
# Log in
curl -s localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"password123"}' | jq .tokens

# Use it
curl -s localhost:3000/api/v1/stations -H "authorization: Bearer $ACCESS" | jq .meta

# Without it
curl -s localhost:3000/api/v1/stations | jq .error.code
# "UNAUTHORIZED"
```

Then let an access token expire (set the TTL to 30 seconds temporarily), leave
the dashboard open, and watch the network tab: one 401, one `POST
/auth/refresh`, then the original request replayed and succeeding. The
frontend's `http.ts` already does this; your job is to make the refresh work.

### 5. Break it deliberately

| Do this | Expect |
|---|---|
| `GET /stations?sort=name;DROP TABLE stations--` | Sorted by name. Nothing dropped. |
| `GET /stations?pageSize=100000` | `400` — the contract caps it at 200 |
| `DELETE` a station with sessions | `409 CONFLICT`, readable message |
| `GET /users` as a `driver` | `403` |
| Look for `password_hash` in any response | Not there |

Run the last one as an actual grep, not by eye:

```bash
curl -s localhost:3000/api/v1/users -H "authorization: Bearer $ACCESS" | grep -c password
# 0
```

---

## What you can now explain

- Why access and refresh tokens are different *kinds* of thing, and what each
  one buys you.
- What refresh token rotation defends against.
- Why you verify a password hash even when the user does not exist.
- How you avoid N+1 on a list endpoint, and how to spot one.
- Why an allow-list is the only safe way to sort by a user-supplied field.
- Why `changePercent` is null rather than zero.
- Why empty time buckets must be generated rather than omitted.
- Why the exact row count is the expensive half of pagination.

> **This is a complete, defensible project.** Two OCPP versions, real sessions,
> remote commands, and a professional dashboard driven entirely by your API.
> Everything after this is depth, and depth is where the good interview
> questions are.

---

Next: **[Milestone 9 — realtime and logs →](milestone-09-realtime.md)**
