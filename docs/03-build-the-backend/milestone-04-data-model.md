# Milestone 4 — The data model

**Goal:** Postgres running, a schema that will survive contact with real
hardware, and a station lookup that means you can stop accepting strangers.

**Time:** 2 hours.

---

## Why this exists

Almost every hard problem in a CPMS is a data-modelling problem wearing a
protocol costume:

- Two protocol versions with different transaction ids → **use your own UUID**.
- Meter values arriving thousands per session → **a table that will grow to
  billions of rows**.
- Tariffs that change while sessions are running → **freeze a copy on the CDR**.
- The same charger reconnecting from a different IP → **identity, not address**.

Get the schema right now and the rest of the project is filling in behaviour.
Get it wrong and you will be writing migrations at Milestone 11.

---

## Build it

### 1. Postgres and Redis

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: ocpp
      POSTGRES_PASSWORD: ocpp
      POSTGRES_DB: ocpp
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ocpp']
      interval: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    command: ['redis-server', '--appendonly', 'yes']

volumes:
  pgdata:
```

```bash
docker compose up -d
docker compose ps      # both healthy
```

### 2. The schema

```sql
-- migrations/001_initial.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ══════════════════════════════════════════════════════════════════
--  Locations — physical sites
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  street        TEXT        NOT NULL,
  city          TEXT        NOT NULL,
  postal_code   TEXT        NOT NULL,
  country       CHAR(2)     NOT NULL,
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),
  -- Needed to apply tariff time windows. A site in Amsterdam and one in
  -- Lisbon disagree about what "23:00" means, and the cheap-rate window is
  -- defined in LOCAL time.
  time_zone     TEXT        NOT NULL DEFAULT 'UTC',
  grid_capacity_kw NUMERIC(8,2),
  opening_hours JSONB       NOT NULL DEFAULT '{"twentyFourSeven":true}',
  facilities    TEXT[]      NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════
--  Stations
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE stations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The OCPP identity, from the WebSocket URL. Unique across the fleet,
  -- chosen by whoever installs the hardware. We keep our own UUID as the
  -- primary key so foreign keys never depend on a field a field engineer
  -- can retype.
  identity      TEXT        NOT NULL UNIQUE,

  name          TEXT        NOT NULL,
  protocol      TEXT        NOT NULL CHECK (protocol IN ('ocpp1.6','ocpp2.0.1')),
  status        TEXT        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('online','offline','pending','rejected','unavailable')),

  vendor            TEXT,
  model             TEXT,
  serial_number     TEXT,
  firmware_version  TEXT,
  iccid             TEXT,
  imsi              TEXT,

  location_id   UUID REFERENCES locations(id) ON DELETE SET NULL,
  latitude      NUMERIC(9,6),
  longitude     NUMERIC(9,6),

  heartbeat_interval_seconds INT NOT NULL DEFAULT 300,
  last_heartbeat_at TIMESTAMPTZ,
  last_boot_at      TIMESTAMPTZ,
  connected_at      TIMESTAMPTZ,
  disconnected_at   TIMESTAMPTZ,

  security_profile  SMALLINT NOT NULL DEFAULT 1 CHECK (security_profile BETWEEN 0 AND 3),
  -- Security profile 1/2 uses HTTP Basic. Store a HASH, never the password.
  auth_password_hash TEXT,

  tariff_id     UUID,
  max_power_kw  NUMERIC(8,2) NOT NULL DEFAULT 22,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  note          TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stations_status   ON stations(status);
CREATE INDEX idx_stations_location ON stations(location_id);

-- ══════════════════════════════════════════════════════════════════
--  EVSEs and connectors
--
--  Three levels, because OCPP 2.0.1 has three. An EVSE is "a place exactly
--  one car can charge". A DC unit with a CCS cable and a CHAdeMO cable that
--  serves one car at a time is ONE EVSE with TWO connectors.
--
--  OCPP 1.6 has no EVSE level, so we project onto this: each 1.6 connector
--  becomes its own EVSE with one connector. Do that once, in the gateway,
--  and everything above is protocol-blind.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE evses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id  UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  evse_id     INT  NOT NULL,            -- 1-based, as it appears on the wire
  UNIQUE (station_id, evse_id)
);

CREATE TABLE connectors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evse_id       UUID NOT NULL REFERENCES evses(id) ON DELETE CASCADE,
  connector_id  INT  NOT NULL,          -- 1-based within the EVSE
  type          TEXT NOT NULL,
  power_type    TEXT NOT NULL CHECK (power_type IN ('ac_1_phase','ac_3_phase','dc')),
  max_power_kw  NUMERIC(8,2) NOT NULL,

  status        TEXT NOT NULL DEFAULT 'unavailable',
  -- 1.6 only: 2.0.1 reports faults through NotifyEvent instead, so this is
  -- NULL for 2.0.1 stations. A null here is informative, not missing data.
  error_code        TEXT,
  vendor_error_code TEXT,
  status_updated_at TIMESTAMPTZ,

  UNIQUE (evse_id, connector_id)
);

-- ══════════════════════════════════════════════════════════════════
--  People and tokens
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE user_groups (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name     TEXT NOT NULL,
  tariff_id UUID,
  monthly_budget_minor BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,    -- case-insensitive; see note below
  name          TEXT   NOT NULL,
  phone         TEXT,
  role          TEXT   NOT NULL DEFAULT 'driver'
                CHECK (role IN ('admin','operator','viewer','driver')),
  status        TEXT   NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','invited','suspended')),
  password_hash TEXT,
  balance_minor BIGINT NOT NULL DEFAULT 0,
  currency      CHAR(3) NOT NULL DEFAULT 'EUR',
  group_id      UUID REFERENCES user_groups(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CREATE EXTENSION citext;  -- run this first, or use TEXT + lower() index

CREATE TABLE tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Store the NORMALISED form: uppercase, no separators. RFID readers
  -- disagree about case and byte order for the same physical card, so
  -- normalise on the way in and compare normalised to normalised, always.
  value       TEXT NOT NULL UNIQUE,

  type        TEXT NOT NULL DEFAULT 'rfid',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','blocked','expired','pending')),
  label       TEXT,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id    UUID REFERENCES user_groups(id) ON DELETE SET NULL,
  valid_from  TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  in_local_list BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  use_count   INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tokens_user ON tokens(user_id);

-- ══════════════════════════════════════════════════════════════════
--  Sessions
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The protocol-level id, as TEXT even for 1.6 where it is an integer.
  -- 1.6: the CSMS allocates an integer. 2.0.1: the STATION allocates a
  -- string of up to 36 characters. One column serves both, and neither is
  -- ever a primary key — a 1.6 station will happily restart its numbering
  -- at 1 after a reboot.
  transaction_id TEXT,

  protocol      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','suspended','completed','failed','cancelled')),

  station_id    UUID NOT NULL REFERENCES stations(id) ON DELETE RESTRICT,
  evse_id       INT  NOT NULL,
  connector_id  INT  NOT NULL,

  token_id      UUID REFERENCES tokens(id) ON DELETE SET NULL,
  -- Denormalised: the raw value as it arrived, even if the token is later
  -- deleted. A CDR must remain explicable years afterwards.
  token_value   TEXT NOT NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,

  -- Watt-hours as integers, always. Never kWh, never floats: 0.1 + 0.2 is
  -- 0.30000000000000004, and a CDR that is off by a hundredth of a cent is a
  -- billing dispute.
  meter_start_wh BIGINT,
  meter_stop_wh  BIGINT,
  energy_wh      BIGINT NOT NULL DEFAULT 0,

  stop_reason   TEXT,
  tariff_id     UUID,
  currency      CHAR(3) NOT NULL DEFAULT 'EUR',
  cost_minor    BIGINT NOT NULL DEFAULT 0,
  cost_breakdown JSONB NOT NULL DEFAULT '[]',

  payment_id    UUID,
  authorized_amount_minor BIGINT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The index that matters: "what is running right now" is the most frequent
-- query in the whole system. Partial, so it stays small however much history
-- accumulates.
CREATE INDEX idx_sessions_active ON sessions(station_id, evse_id, connector_id)
  WHERE status IN ('pending','active','suspended');

CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_user    ON sessions(user_id, started_at DESC);

-- A station may not have two live transactions on one connector. Enforce it
-- in the DATABASE, not in application code — the race is real when a station
-- replays buffered messages after an outage.
CREATE UNIQUE INDEX idx_sessions_one_live_per_connector
  ON sessions(station_id, evse_id, connector_id)
  WHERE status IN ('pending','active','suspended');

-- ══════════════════════════════════════════════════════════════════
--  Meter values — the table that grows fastest
--
--  One session sampled every 10 seconds for six hours is 2,160 rows. A
--  thousand sessions a day is 2 million rows a day. This WILL be your
--  largest table by two orders of magnitude, so it is partitioned from the
--  start: dropping last year's data becomes DROP TABLE rather than a DELETE
--  that runs for a day.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE meter_values (
  session_id  UUID NOT NULL,
  measured_at TIMESTAMPTZ NOT NULL,
  energy_wh   BIGINT,
  power_kw    NUMERIC(9,3),
  current_a   NUMERIC(9,2),
  voltage_v   NUMERIC(9,2),
  soc         SMALLINT,
  temperature_c NUMERIC(5,1),
  extra       JSONB
) PARTITION BY RANGE (measured_at);

CREATE TABLE meter_values_2026_09 PARTITION OF meter_values
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
-- …create the next partition monthly, from a scheduled job.

CREATE INDEX idx_meter_values_session ON meter_values(session_id, measured_at DESC);

-- ══════════════════════════════════════════════════════════════════
--  Authorization log — "my card did not work" is the #1 support ticket
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE authorizations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  station_id   UUID REFERENCES stations(id) ON DELETE SET NULL,
  evse_id      INT,
  token_value  TEXT NOT NULL,
  token_id     UUID REFERENCES tokens(id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  result       TEXT NOT NULL,
  reason       TEXT,
  source       TEXT NOT NULL DEFAULT 'csms',
  latency_ms   INT
);

CREATE INDEX idx_auth_occurred ON authorizations(occurred_at DESC);
CREATE INDEX idx_auth_token    ON authorizations(token_value, occurred_at DESC);

-- ══════════════════════════════════════════════════════════════════
--  OCPP frame log — every message, verbatim
--
--  Store the RAW frame, not your parsed version. When a station sends
--  something malformed you need to see the malformed thing; a log containing
--  only successfully-parsed messages is useless exactly when you need it.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE ocpp_frames (
  id           BIGSERIAL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  station_id   UUID,
  station_identity TEXT NOT NULL,
  protocol     TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_type SMALLINT NOT NULL,
  message_id   TEXT NOT NULL,
  action       TEXT,
  payload      JSONB,
  raw          TEXT NOT NULL,
  error_code   TEXT,
  error_description TEXT,
  session_id   UUID,
  valid        BOOLEAN,
  validation_errors TEXT[]
) PARTITION BY RANGE (occurred_at);

CREATE TABLE ocpp_frames_2026_09 PARTITION OF ocpp_frames
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE INDEX idx_frames_station ON ocpp_frames(station_identity, occurred_at DESC);
CREATE INDEX idx_frames_msgid   ON ocpp_frames(message_id);
```

> **Why partition from day one.** Retention is a legal question — many
> operators must keep billing data for seven years and are required to delete
> telemetry sooner. With partitions, "delete everything older than 90 days" is
> `DROP TABLE meter_values_2026_06`: instant, no bloat, no vacuum storm.
> Without them it is a `DELETE` that locks a table for hours. Adding
> partitioning to a billion-row table later is a migration nobody enjoys.

### 3. A thin query layer

```ts
// src/db/index.ts
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * A connection POOL, not a connection.
 *
 * Postgres forks a process per connection, so they are expensive and finite —
 * the default limit is 100. Every WebSocket opening its own connection is how
 * you exhaust that at 3am. A pool of 10–20 serves hundreds of concurrent
 * requests, because queries are short and connections are reused.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  const result = await pool.query<T>(text, params);
  const ms = Date.now() - started;
  // Surface slow queries while the dataset is small enough to fix them.
  if (ms > 200) logger.warn({ ms, text: text.slice(0, 120) }, 'slow query');
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run several statements atomically.
 *
 * You need this the moment a StopTransaction has to write the session, the
 * CDR and the payment capture together. Half-applied billing is much worse
 * than a failed request.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();   // ALWAYS. A leaked client removes one from the pool forever.
  }
}
```

```bash
npm install pg
npm install -D @types/pg
psql postgres://ocpp:ocpp@localhost:5432/ocpp -f migrations/001_initial.sql
```

### 4. Use it: reject unknown stations

```ts
// src/domain/stations.ts
import { one, query } from '../db/index.js';

export interface StationRow {
  id: string;
  identity: string;
  protocol: 'ocpp1.6' | 'ocpp2.0.1';
  status: string;
  heartbeat_interval_seconds: number;
}

export function findByIdentity(identity: string) {
  return one<StationRow>('SELECT * FROM stations WHERE identity = $1', [identity]);
}

export async function recordBoot(
  identity: string,
  info: { vendor?: string; model?: string; serialNumber?: string; firmwareVersion?: string },
) {
  await query(
    `UPDATE stations
        SET status = 'online',
            vendor = COALESCE($2, vendor),
            model = COALESCE($3, model),
            serial_number = COALESCE($4, serial_number),
            firmware_version = COALESCE($5, firmware_version),
            last_boot_at = now(),
            connected_at = COALESCE(connected_at, now()),
            updated_at = now()
      WHERE identity = $1`,
    [identity, info.vendor, info.model, info.serialNumber, info.firmwareVersion],
  );
}
```

Now replace the placeholder in the BootNotification handler:

```ts
const station = await findByIdentity(ctx.identity);

if (!station && !config.ALLOW_UNKNOWN_STATIONS) {
  log.warn('rejected: station is not registered');
  return {
    status: 'Rejected',
    currentTime: new Date().toISOString(),
    // On Rejected this is the RETRY interval. Keep it generous — some
    // firmware retries very aggressively and will hammer you.
    interval: 300,
  };
}

if (station) {
  await recordBoot(ctx.identity, {
    vendor: payload.chargePointVendor,
    model: payload.chargePointModel,
    serialNumber: payload.chargePointSerialNumber ?? payload.chargeBoxSerialNumber,
    firmwareVersion: payload.firmwareVersion,
  });
}

ctx.connection.booted = true;
return {
  status: 'Accepted',
  currentTime: new Date().toISOString(),
  interval: station?.heartbeat_interval_seconds ?? config.HEARTBEAT_INTERVAL,
};
```

---

## Prove it works

```sql
INSERT INTO stations (identity, name, protocol, max_power_kw)
VALUES ('SIM-AMS-001', 'Simulator 1', 'ocpp1.6', 22);

INSERT INTO evses (station_id, evse_id)
SELECT id, 1 FROM stations WHERE identity = 'SIM-AMS-001';

INSERT INTO connectors (evse_id, connector_id, type, power_type, max_power_kw)
SELECT id, 1, 'iec_62196_t2', 'ac_3_phase', 22 FROM evses;
```

Set `ALLOW_UNKNOWN_STATIONS=false` and restart. Connect `SIM-AMS-001` — it is
accepted. Connect `SIM-UTR-007` — rejected, and the simulator shows it.

```sql
SELECT identity, status, vendor, model, last_boot_at FROM stations;
```

---

## What you can now explain

- Why the transaction id is not the primary key — the two protocol versions
  disagree about who allocates it and what type it is.
- Why money and energy are integers.
- Why `meter_values` is partitioned before it has a single row.
- Why a partial unique index enforces "one live session per connector" better
  than application code — the race is real when a station replays buffered
  messages after an outage.
- What a connection pool is for, and what happens without one.

---

Next: **[Milestone 5 — the OCPP 1.6 core profile →](milestone-05-core-profile.md)**
