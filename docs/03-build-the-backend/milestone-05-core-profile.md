# Milestone 5 — The OCPP 1.6 core profile

**Goal:** a complete charging session, from card swipe to stored CDR.

**Time:** 3–4 hours. This is the milestone where you have actually built a CSMS.

---

## Why this exists

Five more handlers and you can charge a car:

| Message | What it does |
|---|---|
| `StatusNotification` | A connector changed state |
| `Authorize` | May this card charge? |
| `StartTransaction` | Energy is about to flow — **you** allocate the id |
| `MeterValues` | Periodic measurements |
| `StopTransaction` | It ended — **this is the one that produces a bill** |

Treat `StopTransaction` as the most important message in the protocol. Lose it
and you have a session that never closes, a connector that never frees, and
revenue you never collect.

---

## Build it

### 1. StatusNotification

```ts
// src/ocpp/handlers/status-notification.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { query } from '../../db/index.js';
import { stationLogger } from '../../logger.js';

const Status16 = z.enum([
  'Available', 'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE',
  'Finishing', 'Reserved', 'Unavailable', 'Faulted',
]);

const CANONICAL: Record<z.infer<typeof Status16>, string> = {
  Available: 'available',
  Preparing: 'preparing',
  Charging: 'charging',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Finishing: 'finishing',
  Reserved: 'reserved',
  Unavailable: 'unavailable',
  Faulted: 'faulted',
};

registerHandler('StatusNotification', {
  schema: z.object({
    connectorId: z.number().int().min(0),
    errorCode: z.string(),
    status: Status16,
    timestamp: z.string().optional(),
    info: z.string().max(50).optional(),
    vendorId: z.string().optional(),
    vendorErrorCode: z.string().optional(),
  }),

  async handle(payload, ctx) {
    const log = stationLogger(ctx.identity);
    const status = CANONICAL[payload.status];

    /**
     * connectorId 0 means THE STATION, not a connector.
     *
     * There is no connector zero. A Faulted on 0 means the whole charge point
     * is broken. Handling this explicitly is the difference between a correct
     * dashboard and one showing phantom connectors — and it is the single
     * most common bug in a first CSMS.
     */
    if (payload.connectorId === 0) {
      log.info({ status, errorCode: payload.errorCode }, 'station-level status');
      await query(
        `UPDATE stations
            SET status = CASE WHEN $2 = 'faulted' THEN 'unavailable' ELSE 'online' END,
                updated_at = now()
          WHERE identity = $1`,
        [ctx.identity, status],
      );
      return {};
    }

    /**
     * In OCPP 1.6 a connector number is flat: 1, 2, 3. We store the 2.0.1
     * shape, so map connector N onto EVSE N, connector 1. Do the projection
     * here, once, and nothing above this line knows there are two protocols.
     */
    await query(
      `UPDATE connectors c
          SET status = $3,
              error_code = $4,
              vendor_error_code = $5,
              status_updated_at = now()
         FROM evses e
         JOIN stations s ON s.id = e.station_id
        WHERE c.evse_id = e.id
          AND s.identity = $1
          AND e.evse_id = $2
          AND c.connector_id = 1`,
      [
        ctx.identity,
        payload.connectorId,
        status,
        payload.errorCode === 'NoError' ? null : payload.errorCode,
        payload.vendorErrorCode ?? null,
      ],
    );

    if (payload.errorCode !== 'NoError') {
      log.warn(
        { connectorId: payload.connectorId, errorCode: payload.errorCode, vendor: payload.vendorErrorCode },
        'connector fault',
      );
    }

    // StatusNotification has an EMPTY response. Not `{status:"Accepted"}` —
    // empty. Sending anything else is a protocol violation some stations
    // will reject.
    return {};
  },
});
```

> **Store both timestamps.** The `timestamp` field is optional in 1.6 and is
> frequently absent or wrong, because station clocks drift and reset. Record
> the station's timestamp *and* your own received-at time, and show yours in
> the UI.

### 2. Authorize

```ts
// src/ocpp/handlers/authorize.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { authorizeToken } from '../../domain/authorization.js';

registerHandler('Authorize', {
  schema: z.object({ idTag: z.string().min(1).max(20) }),

  async handle(payload, ctx) {
    const decision = await authorizeToken(payload.idTag, {
      stationIdentity: ctx.identity,
      source: 'csms',
    });

    return {
      idTagInfo: {
        status: decision.status,
        ...(decision.expiryDate ? { expiryDate: decision.expiryDate } : {}),
        ...(decision.parentIdTag ? { parentIdTag: decision.parentIdTag } : {}),
      },
    };
  },
});
```

```ts
// src/domain/authorization.ts
import { one, query } from '../db/index.js';

export type AuthStatus = 'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx';

/**
 * The one place a charging decision is made.
 *
 * Every path — RFID swipe, remote start, OCPI partner — goes through here, so
 * there is exactly one answer to "may this token charge" and exactly one place
 * that logs it.
 */
export async function authorizeToken(
  rawValue: string,
  context: { stationIdentity: string; evseId?: number; source?: string },
): Promise<{ status: AuthStatus; expiryDate?: string; parentIdTag?: string; reason?: string }> {
  const started = Date.now();

  // Normalise. Readers disagree about case and separators for the same card.
  const value = rawValue.trim().toUpperCase().replace(/[\s:-]/g, '');

  const token = await one<{
    id: string; user_id: string | null; status: string;
    valid_until: string | null; group_id: string | null;
  }>(`SELECT id, user_id, status, valid_until, group_id FROM tokens WHERE value = $1`, [value]);

  let status: AuthStatus = 'Invalid';
  let reason: string | undefined;

  if (!token) {
    status = 'Invalid';
    reason = 'Unknown token';
  } else if (token.status === 'blocked') {
    status = 'Blocked';
    reason = 'Token is blocked';
  } else if (token.valid_until && new Date(token.valid_until) < new Date()) {
    status = 'Expired';
    reason = `Validity ended ${token.valid_until}`;
  } else {
    /**
     * ConcurrentTx — this token is already charging somewhere else.
     *
     * Whether to refuse is a business decision, not a protocol one. A family
     * sharing one card legitimately wants two cars charging; a shared fleet
     * card being passed around does not. The specification gives you the
     * status; you decide the policy.
     */
    const live = await one<{ count: string }>(
      `SELECT count(*) FROM sessions
        WHERE token_id = $1 AND status IN ('pending','active','suspended')`,
      [token.id],
    );
    if (Number(live?.count ?? 0) > 0) {
      status = 'ConcurrentTx';
      reason = 'Token already has a session running';
    } else {
      status = 'Accepted';
    }
  }

  // Log EVERY decision. "My card did not work" is the number one support
  // ticket in charging, and without this table you cannot answer it.
  await query(
    `INSERT INTO authorizations
       (station_id, evse_id, token_value, token_id, user_id, result, reason, source, latency_ms)
     VALUES ((SELECT id FROM stations WHERE identity = $1), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      context.stationIdentity, context.evseId ?? null, value,
      token?.id ?? null, token?.user_id ?? null,
      status.toLowerCase(), reason ?? null, context.source ?? 'csms', Date.now() - started,
    ],
  );

  if (status === 'Accepted' && token) {
    await query(
      `UPDATE tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`,
      [token.id],
    );
  }

  return {
    status,
    reason,
    ...(token?.valid_until ? { expiryDate: new Date(token.valid_until).toISOString() } : {}),
  };
}
```

### 3. StartTransaction

```ts
// src/ocpp/handlers/start-transaction.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { authorizeToken } from '../../domain/authorization.js';
import { transaction } from '../../db/index.js';
import { stationLogger } from '../../logger.js';

registerHandler('StartTransaction', {
  schema: z.object({
    connectorId: z.number().int().min(1),
    idTag: z.string().min(1).max(20),
    meterStart: z.number().int().min(0),
    reservationId: z.number().int().optional(),
    timestamp: z.string(),
  }),

  async handle(payload, ctx) {
    const log = stationLogger(ctx.identity);

    /**
     * Authorize AGAIN, here.
     *
     * A station with a cached authorisation may skip Authorize entirely and
     * go straight to StartTransaction. If this is your only check, a card you
     * blocked five minutes ago still charges. Never assume Authorize
     * preceded this.
     */
    const decision = await authorizeToken(payload.idTag, {
      stationIdentity: ctx.identity,
      evseId: payload.connectorId,
      source: 'csms',
    });

    if (decision.status !== 'Accepted') {
      log.warn({ idTag: payload.idTag, status: decision.status }, 'start refused');
      /**
       * Note what we return: transactionId 0 and a rejecting status. The
       * specification requires a transactionId field even on refusal, and 0
       * is the conventional "no transaction". The station will stop and send
       * StopTransaction with reason DeAuthorized.
       */
      return { transactionId: 0, idTagInfo: { status: decision.status } };
    }

    const result = await transaction(async (client) => {
      const session = await client.query<{ id: string }>(
        `INSERT INTO sessions
           (protocol, status, station_id, evse_id, connector_id,
            token_id, token_value, user_id, started_at, meter_start_wh, tariff_id, currency)
         SELECT 'ocpp1.6', 'active', s.id, $2, 1,
                t.id, $3, t.user_id, $4, $5, s.tariff_id, 'EUR'
           FROM stations s
           LEFT JOIN tokens t ON t.value = $3
          WHERE s.identity = $1
        RETURNING id`,
        [ctx.identity, payload.connectorId, payload.idTag.toUpperCase(), payload.timestamp, payload.meterStart],
      );

      const sessionId = session.rows[0]?.id;
      if (!sessionId) throw new Error(`Unknown station ${ctx.identity}`);

      /**
       * The transaction id.
       *
       * In OCPP 1.6 the CSMS allocates it and it must be an integer, unique
       * across the whole CSMS. Some firmware stores it in 32 bits, so do NOT
       * use a millisecond timestamp — a database sequence is the right answer.
       * And never reuse one, even years later.
       */
      const seq = await client.query<{ nextval: string }>(`SELECT nextval('transaction_id_seq')`);
      const transactionId = Number(seq.rows[0]!.nextval);

      await client.query(`UPDATE sessions SET transaction_id = $2 WHERE id = $1`, [
        sessionId,
        String(transactionId),
      ]);

      return { sessionId, transactionId };
    });

    log.info(
      { transactionId: result.transactionId, connectorId: payload.connectorId, meterStart: payload.meterStart },
      'transaction started',
    );

    return {
      transactionId: result.transactionId,
      idTagInfo: { status: 'Accepted' },
    };
  },
});
```

Add the sequence to your migration:

```sql
CREATE SEQUENCE transaction_id_seq START 1 MAXVALUE 2147483647;
```

### 4. MeterValues

```ts
// src/ocpp/handlers/meter-values.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { query } from '../../db/index.js';

const SampledValue = z.object({
  // A STRING, by specification, even though it is a number. Some firmware
  // sends "1234.00", some "1,234", some "" for no reading.
  value: z.string(),
  context: z.string().optional(),
  format: z.string().optional(),
  measurand: z.string().optional(),
  phase: z.string().optional(),
  location: z.string().optional(),
  unit: z.string().optional(),
});

registerHandler('MeterValues', {
  schema: z.object({
    connectorId: z.number().int().min(0),
    // ABSENT for clock-aligned samples taken while idle. Do not assume every
    // MeterValues belongs to a transaction.
    transactionId: z.number().int().optional(),
    meterValue: z.array(
      z.object({ timestamp: z.string(), sampledValue: z.array(SampledValue) }),
    ),
  }),

  async handle(payload, ctx) {
    if (payload.transactionId === undefined) return {};   // idle sample; ignore for now

    const session = await query<{ id: string }>(
      `SELECT s.id FROM sessions s
         JOIN stations st ON st.id = s.station_id
        WHERE st.identity = $1 AND s.transaction_id = $2`,
      [ctx.identity, String(payload.transactionId)],
    );
    const sessionId = session[0]?.id;
    if (!sessionId) return {};   // a transaction we do not know: log, do not crash

    for (const sample of payload.meterValue) {
      const flat = pivot(sample.sampledValue);
      await query(
        `INSERT INTO meter_values
           (session_id, measured_at, energy_wh, power_kw, current_a, voltage_v, soc, temperature_c)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sessionId, sample.timestamp, flat.energyWh, flat.powerKw, flat.currentA,
         flat.voltageV, flat.soc, flat.temperatureC],
      );

      if (flat.energyWh !== null) {
        // Keep the running total on the session so the dashboard does not
        // aggregate a million rows to show one number.
        await query(
          `UPDATE sessions
              SET energy_wh = GREATEST(0, $2 - meter_start_wh), updated_at = now()
            WHERE id = $1 AND meter_start_wh IS NOT NULL`,
          [sessionId, flat.energyWh],
        );
      }
    }

    return {};
  },
});

/**
 * Flatten the three-level nesting into one row.
 *
 * A MeterValues carries a list of timestamps, each with a list of sampled
 * values, each with its own measurand, unit and phase. Storing that shape
 * makes every chart query painful, so we pivot: one row per timestamp with
 * the measurands we care about as columns.
 *
 * A real trade-off — we lose generality and gain a table a chart can read
 * directly. Worth being able to defend.
 */
function pivot(values: Array<z.infer<typeof SampledValue>>) {
  const out = {
    energyWh: null as number | null,
    powerKw: null as number | null,
    currentA: null as number | null,
    voltageV: null as number | null,
    soc: null as number | null,
    temperatureC: null as number | null,
  };

  for (const v of values) {
    // A phase-specific reading (L1, L2, L3) is not the total. Skip them;
    // the reading with no phase is the aggregate.
    if (v.phase && !['L1-N', 'L1'].includes(v.phase)) continue;

    const n = Number.parseFloat(v.value.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;

    const measurand = v.measurand ?? 'Energy.Active.Import.Register';   // the spec default
    const unit = (v.unit ?? '').toLowerCase();

    switch (measurand) {
      case 'Energy.Active.Import.Register':
        // Wh and kWh are BOTH legal here. Normalise, or your totals are out
        // by 1000 for one vendor only — which is worse than for all of them.
        out.energyWh = unit === 'kwh' ? Math.round(n * 1000) : Math.round(n);
        break;
      case 'Power.Active.Import':
        out.powerKw = unit === 'w' ? n / 1000 : n;
        break;
      case 'Current.Import': out.currentA = n; break;
      case 'Voltage':        out.voltageV = n; break;
      case 'SoC':            out.soc = Math.round(n); break;
      case 'Temperature':    out.temperatureC = n; break;
    }
  }

  return out;
}
```

### 5. StopTransaction — the one that matters

```ts
// src/ocpp/handlers/stop-transaction.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { transaction } from '../../db/index.js';
import { stationLogger } from '../../logger.js';

registerHandler('StopTransaction', {
  schema: z.object({
    transactionId: z.number().int(),
    meterStop: z.number().int().min(0),
    timestamp: z.string(),
    idTag: z.string().max(20).optional(),
    reason: z.string().optional(),
    // An offline station dumps its whole buffered session here — sometimes
    // thousands of samples in one message.
    transactionData: z.array(z.unknown()).optional(),
  }),

  async handle(payload, ctx) {
    const log = stationLogger(ctx.identity);

    await transaction(async (client) => {
      const found = await client.query<{
        id: string; meter_start_wh: string | null; status: string;
      }>(
        `SELECT s.id, s.meter_start_wh, s.status
           FROM sessions s
           JOIN stations st ON st.id = s.station_id
          WHERE st.identity = $1 AND s.transaction_id = $2
          FOR UPDATE`,
        [ctx.identity, String(payload.transactionId)],
      );

      const session = found.rows[0];

      if (!session) {
        // Not an error worth failing on. A station replaying buffered
        // messages after an outage may stop a transaction we never saw start.
        log.warn({ transactionId: payload.transactionId }, 'stop for unknown transaction');
        return;
      }

      /**
       * Idempotency.
       *
       * The same StopTransaction CAN arrive twice — a station that did not
       * see our CALLRESULT will resend. Closing an already-closed session
       * would double-bill. Check and return.
       */
      if (session.status === 'completed') {
        log.info({ transactionId: payload.transactionId }, 'duplicate stop ignored');
        return;
      }

      const meterStart = Number(session.meter_start_wh ?? 0);

      /**
       * THE formula. Energy delivered is the DIFFERENCE.
       *
       * `meterStop` is the meter's lifetime register — typically several
       * million Wh. Store it as the session total and you invoice people for
       * four thousand kWh. This is the most common first bug in a CPMS.
       */
      const energyWh = Math.max(0, payload.meterStop - meterStart);

      await client.query(
        `UPDATE sessions
            SET status = 'completed',
                ended_at = $2,
                meter_stop_wh = $3,
                energy_wh = $4,
                stop_reason = $5,
                updated_at = now()
          WHERE id = $1`,
        [session.id, payload.timestamp, payload.meterStop, energyWh, mapReason(payload.reason)],
      );

      log.info(
        { transactionId: payload.transactionId, energyWh, reason: payload.reason ?? 'Local' },
        'transaction stopped',
      );

      // Milestone 11 prices it and issues the CDR here, inside the same
      // transaction — so a session is never closed without its bill.
    });

    return {};
  },
});

/** OCPP 1.6 says an ABSENT reason means `Local`. Defaulting to "other" would
 *  silently mislabel every ordinary unplug. */
function mapReason(reason?: string) {
  const map: Record<string, string> = {
    EmergencyStop: 'emergency_stop', EVDisconnected: 'ev_disconnected',
    HardReset: 'hard_reset', Local: 'local', Other: 'other', PowerLoss: 'power_loss',
    Reboot: 'reboot', Remote: 'remote', SoftReset: 'soft_reset',
    UnlockCommand: 'unlock_command', DeAuthorized: 'de_authorized',
  };
  return reason ? (map[reason] ?? 'other') : 'local';
}
```

---

## Prove it works

Run the simulator's **"A complete charge, start to finish"** scenario. Or do it
by hand on `SIM-AMS-001`:

1. **Connect** → BootNotification accepted.
2. **Plug in cable** → StatusNotification `Preparing`.
3. **Swipe card & start** → Authorize → StartTransaction → you allocate `48213`.
4. Wait; MeterValues arrive every 10 seconds.
5. **Stop charging** → StopTransaction.

Then:

```sql
SELECT transaction_id, status, energy_wh, meter_start_wh, meter_stop_wh, stop_reason
  FROM sessions ORDER BY started_at DESC LIMIT 1;
```

```
 transaction_id | status    | energy_wh | meter_start_wh | meter_stop_wh | stop_reason
----------------+-----------+-----------+----------------+---------------+-------------
 48213          | completed |      8420 |        4823110 |       4831530 | ev_disconnected
```

**`energy_wh` is 8420, not 4831530.** That is the whole milestone in one row.

```sql
SELECT count(*), min(measured_at), max(measured_at) FROM meter_values;
SELECT result, count(*) FROM authorizations GROUP BY result;
```

### Then break it

- **Swipe an unknown card** → `Invalid`, no session created.
- **Block a token** (`UPDATE tokens SET status='blocked'`) then start → `Blocked`.
- **Send StopTransaction twice** — use the simulator's raw send. The second is
  ignored, and the session is not double-closed.

---

## What you can now explain

- `energy = meterStop − meterStart`, and why getting it wrong is so expensive.
- Why `connectorId: 0` is the station, not a connector.
- Why you must re-authorise in `StartTransaction` even though `Authorize` exists.
- Why sampled values are strings, and why you must normalise Wh/kWh.
- Why `StopTransaction` must be idempotent, and what replays it.

> **You have now built a CSMS.** It accepts stations, authorises cards, runs
> transactions and records energy. Everything after this makes it good.

---

Next: **[Milestone 6 — remote commands →](milestone-06-remote-commands.md)**
