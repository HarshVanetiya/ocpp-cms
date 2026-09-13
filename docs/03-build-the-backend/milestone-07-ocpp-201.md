# Milestone 7 — OCPP 2.0.1

**Goal:** the same server, the same database, the same dashboard — now
speaking both protocol versions at once.

**Time:** 4–5 hours. The most valuable milestone in the project.

---

## Why this exists

This is the one that makes the project worth talking about.

Almost every "I built a CPMS" side project speaks one version. Running both
simultaneously is what real operators actually have to do — a field of 2019
hardware that will never be upgraded, next to 2024 hardware that ships 2.0.1 —
and it is the difference between a tutorial and a system.

It is also the milestone where a bad design becomes obvious. If you build it by
branching on protocol version everywhere, you will write `if (protocol ===
'ocpp1.6')` a hundred times and every future feature will need it twice. The
whole point of the last three milestones — canonical statuses, canonical stop
reasons, canonical commands — was to earn the right to write it **once**.

### The rule

> **Protocol knowledge stops at `src/ocpp/`. Nothing below it knows what
> version a station speaks.**

`src/domain/` must never import from `src/ocpp/`. If you find yourself wanting
to, something belongs on the other side of the line. The dependency arrow points
one way:

```
   handlers (per protocol)          routes
        │                             │
        ▼                             ▼
   ┌─────────────────────────────────────┐
   │              domain/                │   ← protocol-blind
   │   sessions, tariffs, authorization  │
   └─────────────────────────────────────┘
                    │
                    ▼
                   db/
```

### What actually changed between the versions

Not "everything". Five things, and the rest is renaming.

**1. Three levels instead of two.**
1.6 has a charge point with connectors. 2.0.1 has a charge point with **EVSEs**,
each with connectors. An EVSE is "a place exactly one car can charge". A DC
cabinet with a CCS cable and a CHAdeMO cable serving one car at a time is *one*
EVSE with *two* connectors.

You already handled this in Milestone 4 by giving every 1.6 connector its own
EVSE with the same number. That projection is the whole fix.

**2. `TransactionEvent` replaced four messages.**

| OCPP 1.6 | OCPP 2.0.1 |
|---|---|
| `StartTransaction` | `TransactionEvent` `eventType: "Started"` |
| `MeterValues` | `TransactionEvent` `eventType: "Updated"` |
| `StopTransaction` | `TransactionEvent` `eventType: "Ended"` |
| `StatusNotification` (during a tx) | `TransactionEvent` + `chargingState` |

One action, three event types, plus a `triggerReason` saying *why* it fired
(`Authorized`, `CablePluggedIn`, `MeterValuePeriodic`, `RemoteStop`, …). Your
frame log stops being "a message arrived" and becomes "a message arrived
because the driver plugged in", which is a genuine operational upgrade.

**3. The station allocates the transaction id.**

1.6: the CSMS invents an integer and sends it back in `StartTransaction.conf`.
2.0.1: the station invents a string (up to 36 chars) and tells you.

This is strictly better. In 1.6, a station that starts charging while offline
has no id to attach the energy to and must replay everything on reconnect,
hoping you do the right thing. In 2.0.1 it already has an id and simply sends
the queued events with `offline: true`.

**4. `Occupied` says nothing.**

1.6's `StatusNotification` has nine values that tell you exactly what is
happening: `Charging`, `SuspendedEV`, `Finishing`. 2.0.1's `StatusNotification`
has **five** — `Available`, `Occupied`, `Reserved`, `Unavailable`, `Faulted` —
and everything interesting moved into `TransactionEvent.transactionInfo.chargingState`.

So in 2.0.1, connector status alone cannot tell you whether a car is charging.
You need both, and you need to remember the last `chargingState` per EVSE.

**This is the single biggest surprise when moving from 1.6**, and being able to
explain it is a reliable way to demonstrate you have actually done this.

**5. Faults left `StatusNotification`.**

1.6 packs an `errorCode` into every `StatusNotification` (`GroundFailure`,
`OverCurrentFailure`, …). 2.0.1 removed it entirely: faults arrive as
`NotifyEvent`, a general-purpose monitoring message, and `Faulted` is just a
status. That is why `connectors.error_code` is `NULL` for 2.0.1 stations in
your schema — a null there is information, not a gap.

### What did NOT change

The framing. `[2, messageId, action, payload]` is identical. Milestone 3 works
unchanged for both, and that is why you built it before either handler.

---

## Build it

### 1. Route by subprotocol

You already negotiate the subprotocol in Milestone 2. Now use it.

```ts
// src/ocpp/router.ts — extend the registry from Milestone 3
import type { Protocol } from './registry.js';

type Handler = {
  schema: z.ZodTypeAny;
  handle: (ctx: HandlerContext, payload: any) => Promise<unknown>;
};

// One table per protocol. A station only ever reaches one of them.
const handlers: Record<Protocol, Map<string, Handler>> = {
  'ocpp1.6': new Map(),
  'ocpp2.0.1': new Map(),
};

/**
 * Register a handler for one or both protocols.
 *
 * A few actions are genuinely identical on the wire — Heartbeat, DataTransfer
 * — and registering them once for both is honest. Everything else gets its own
 * implementation, because pretending two different messages are the same
 * message is how you end up with a function full of `if (v16)`.
 */
export function registerHandler(
  action: string,
  handler: Handler,
  protocols: Protocol[] = ['ocpp1.6'],
) {
  for (const p of protocols) handlers[p].set(action, handler);
}

export async function dispatch(connection: Connection, action: string, payload: unknown) {
  const handler = handlers[connection.protocol].get(action);
  if (!handler) {
    // NotImplemented is the correct OCPP error, and it is not a crash. A 2.0.1
    // station sending something you have not built yet should get a clean
    // CALLERROR, and your server should stay up.
    throw new OcppError('NotImplemented', `${action} is not supported on ${connection.protocol}`);
  }
  const parsed = handler.schema.safeParse(payload);
  if (!parsed.success) {
    throw new OcppError('FormationViolation', formatIssues(parsed.error), {
      issues: parsed.error.issues,
    });
  }
  return handler.handle(contextFor(connection), parsed.data);
}
```

Then update your existing Milestone 5 handlers to declare their protocol
explicitly:

```ts
registerHandler('StartTransaction', { /* … */ }, ['ocpp1.6']);
registerHandler('Heartbeat',        { /* … */ }, ['ocpp1.6', 'ocpp2.0.1']);
```

### 2. BootNotification, 2.0.1 flavour

```ts
// src/ocpp/handlers201/boot-notification.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { upsertStationFromBoot } from '../../domain/stations.js';
import { config } from '../../config.js';

registerHandler(
  'BootNotification',
  {
    schema: z.object({
      // 1.6 sent flat fields with `chargePoint` prefixes; 2.0.1 nests them
      // in an object and adds a required `reason`.
      reason: z.enum([
        'ApplicationReset', 'FirmwareUpdate', 'LocalReset', 'PowerUp',
        'RemoteReset', 'ScheduledReset', 'Triggered', 'Unknown', 'Watchdog',
      ]),
      chargingStation: z.object({
        model: z.string().max(20),
        vendorName: z.string().max(50),
        serialNumber: z.string().max(25).optional(),
        firmwareVersion: z.string().max(50).optional(),
        modem: z.object({
          iccid: z.string().max(20).optional(),
          imsi: z.string().max(20).optional(),
        }).optional(),
      }),
    }),

    async handle(ctx, payload) {
      // The SAME domain function the 1.6 handler calls. Flatten here, in the
      // protocol layer, and the domain never learns that 2.0.1 nests things.
      const station = await upsertStationFromBoot({
        identity: ctx.identity,
        protocol: 'ocpp2.0.1',
        vendor: payload.chargingStation.vendorName,
        model: payload.chargingStation.model,
        serialNumber: payload.chargingStation.serialNumber ?? null,
        firmwareVersion: payload.chargingStation.firmwareVersion ?? null,
        iccid: payload.chargingStation.modem?.iccid ?? null,
        imsi: payload.chargingStation.modem?.imsi ?? null,
        bootReason: payload.reason,
      });

      ctx.connection.booted = station.status === 'online';

      return {
        currentTime: new Date().toISOString(),
        interval: station.heartbeat_interval_seconds,
        // Same three values as 1.6, same meaning. `Pending` means "I know you
        // but I want to configure you before you do anything" — the station
        // must then only send BootNotification, Heartbeat and
        // StatusNotification until you accept it.
        status: station.status === 'online' ? 'Accepted'
              : station.status === 'rejected' ? 'Rejected' : 'Pending',
      };
    },
  },
  ['ocpp2.0.1'],
);
```

### 3. StatusNotification, 2.0.1 flavour

```ts
// src/ocpp/handlers201/status-notification.ts
registerHandler(
  'StatusNotification',
  {
    schema: z.object({
      timestamp: z.string(),          // required in 2.0.1, optional in 1.6
      connectorStatus: z.enum(['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted']),
      evseId: z.number().int().min(1),
      connectorId: z.number().int().min(1),
      // Note what is NOT here: errorCode. Faults come via NotifyEvent now.
    }),

    async handle(ctx, payload) {
      /**
       * `Occupied` is ambiguous by design, so we resolve it with the last
       * chargingState we saw for this EVSE.
       *
       * Where does that come from? `TransactionEvent`. Which means status and
       * transaction state are now two halves of one picture, and you must
       * keep the halves together. We cache chargingState on the session row
       * and read it here.
       */
      const chargingState = await currentChargingState(ctx.stationId, payload.evseId);

      await setConnectorStatus({
        stationId: ctx.stationId,
        evseId: payload.evseId,
        connectorId: payload.connectorId,
        status: toConnectorStatus('ocpp2.0.1', payload.connectorStatus, chargingState),
        // Explicitly null, not absent. The column means "1.6 error code" and
        // a 2.0.1 station will never have one.
        errorCode: null,
        at: payload.timestamp,
      });

      return {};   // StatusNotificationResponse is empty in 2.0.1
    },
  },
  ['ocpp2.0.1'],
);

async function currentChargingState(stationId: string, evseId: number) {
  const { rows } = await query(
    `SELECT charging_state FROM sessions
      WHERE station_id=$1 AND evse_id=$2 AND status IN ('pending','active','suspended')
      ORDER BY created_at DESC LIMIT 1`,
    [stationId, evseId],
  );
  return rows[0]?.charging_state ?? null;
}
```

```sql
-- migrations/004_ocpp201.sql

-- 2.0.1 needs two extra facts per session.
ALTER TABLE sessions ADD COLUMN charging_state TEXT;
-- Gap detection: every TransactionEvent carries an increasing seqNo, and a
-- hole means an event was lost. See the handler below.
ALTER TABLE sessions ADD COLUMN last_seq_no INT;
-- Our own id, echoed back by the station on every event of a remote start.
ALTER TABLE sessions ADD COLUMN remote_start_id INT;
```

### 4. TransactionEvent — the big one

```ts
// src/ocpp/handlers201/transaction-event.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { authorizeToken } from '../../domain/authorization.js';
import {
  openSession, updateSession, closeSession, recordMeterValues, findLiveSession,
} from '../../domain/sessions.js';
import { markEffect } from '../../domain/commands.js';
import { toStopReason, normaliseSample } from '@ocpp/ocpp';
import { logger } from '../../logger.js';

const MeterValue = z.object({
  timestamp: z.string(),
  sampledValue: z.array(z.object({
    value: z.number(),                 // a NUMBER in 2.0.1. It was a string in 1.6.
    context: z.string().optional(),
    measurand: z.string().optional(),
    phase: z.string().optional(),
    location: z.string().optional(),
    unitOfMeasure: z.object({
      unit: z.string().optional(),
      multiplier: z.number().int().optional(),
    }).optional(),
  })),
});

registerHandler(
  'TransactionEvent',
  {
    schema: z.object({
      eventType: z.enum(['Started', 'Updated', 'Ended']),
      timestamp: z.string(),
      triggerReason: z.string(),
      seqNo: z.number().int().min(0),
      offline: z.boolean().optional(),
      numberOfPhasesUsed: z.number().int().optional(),
      cableMaxCurrent: z.number().optional(),
      reservationId: z.number().int().optional(),
      transactionInfo: z.object({
        transactionId: z.string().max(36),
        chargingState: z
          .enum(['Charging', 'EVConnected', 'SuspendedEV', 'SuspendedEVSE', 'Idle'])
          .optional(),
        timeSpentCharging: z.number().int().optional(),
        stoppedReason: z.string().optional(),
        remoteStartId: z.number().int().optional(),
      }),
      evse: z.object({
        id: z.number().int(),
        connectorId: z.number().int().optional(),
      }).optional(),
      idToken: z.object({
        idToken: z.string().max(36),
        type: z.string(),
      }).optional(),
      meterValue: z.array(MeterValue).optional(),
    }),

    async handle(ctx, p) {
      const txId = p.transactionInfo.transactionId;

      /**
       * Two things every branch needs.
       *
       * `offline: true` means the station buffered this while disconnected
       * and is replaying it now. The timestamp inside is the truth; `now()`
       * is a lie. Always trust `p.timestamp`, never the arrival time — this
       * is the same lesson as 1.6's StopTransaction replay, and it is why
       * every timestamp column in your schema is fed from the payload.
       */
      const occurredAt = new Date(p.timestamp);
      const evseId = p.evse?.id ?? 1;

      switch (p.eventType) {
        /* ---------------------------------------------------------- */
        case 'Started': {
          /**
           * Authorization, and a real difference from 1.6.
           *
           * In 1.6 the station asks `Authorize` and then sends
           * `StartTransaction`, and you check twice. In 2.0.1 the idToken
           * rides along on the Started event and your RESPONSE carries the
           * decision. One round trip instead of two.
           *
           * If you reject here, the station must stop. There is no separate
           * "sorry, actually no" message.
           */
          const decision = p.idToken
            ? await authorizeToken({
                tokenValue: p.idToken.idToken,
                stationId: ctx.stationId,
                evseId,
              })
            : { result: 'invalid' as const, tokenId: null, userId: null };

          if (decision.result !== 'accepted') {
            return {
              idTokenInfo: { status: toIdTokenStatus(decision.result) },
            };
          }

          await openSession({
            protocol: 'ocpp2.0.1',
            stationId: ctx.stationId,
            evseId,
            connectorId: p.evse?.connectorId ?? 1,
            // The station's id, used verbatim. Do not parse it as a number
            // even when it looks like one — "007" and 7 are different keys.
            transactionId: txId,
            tokenValue: p.idToken?.idToken ?? '',
            tokenId: decision.tokenId,
            userId: decision.userId,
            startedAt: occurredAt,
            meterStartWh: energyFrom(p.meterValue) ?? 0,
            chargingState: p.transactionInfo.chargingState ?? null,
            seqNo: p.seqNo,
            remoteStartId: p.transactionInfo.remoteStartId ?? null,
          });

          /**
           * Exact correlation — the thing 1.6 cannot do.
           *
           * We put `remoteStartId` on the RequestStartTransaction in
           * Milestone 6; the station hands it back here. No time windows, no
           * guessing by idToken. This is a concrete, specific example of
           * 2.0.1 being better, and it is a good one to have ready.
           */
          if (p.transactionInfo.remoteStartId != null) {
            await markEffect(ctx.stationId, 'remote_start', {
              correlation: String(p.transactionInfo.remoteStartId),
            });
          }

          return {
            idTokenInfo: { status: 'Accepted' },
            // Optional but nice: the driver's display shows this.
            // updatedPersonalMessage: { format: 'ASCII', content: 'Charging started' },
          };
        }

        /* ---------------------------------------------------------- */
        case 'Updated': {
          const session = await findLiveSession(ctx.stationId, txId);
          if (!session) {
            // An Updated for a transaction we never saw Started. Happens
            // after a CSMS restart, or if the Started event was lost. Do not
            // throw — the station cannot fix it and will just retry forever.
            logger.warn({ txId, station: ctx.identity }, 'meter values for unknown transaction');
            return {};
          }

          checkSeqNo(session, p.seqNo, ctx.identity);

          await updateSession(session.id, {
            chargingState: p.transactionInfo.chargingState ?? session.charging_state,
            seqNo: p.seqNo,
            energyWh: energyFrom(p.meterValue) ?? undefined,
          });

          if (p.meterValue?.length) {
            await recordMeterValues(
              session.id,
              p.meterValue.flatMap((mv) =>
                mv.sampledValue.map((sv) =>
                  normaliseSample({
                    // 2.0.1 sends a number, 1.6 a string. normaliseSample
                    // takes either and gives you back Wh, W and the rest in
                    // one shape — which is what lets Milestone 8's chart
                    // endpoint be protocol-blind.
                    value: sv.value,
                    measurand: sv.measurand ?? 'Energy.Active.Import.Register',
                    unit: sv.unitOfMeasure?.unit ?? null,
                    multiplier: sv.unitOfMeasure?.multiplier ?? 0,
                    phase: sv.phase ?? null,
                    context: sv.context ?? null,
                    at: mv.timestamp,
                  }),
                ),
              ),
            );
          }
          return {};
        }

        /* ---------------------------------------------------------- */
        case 'Ended': {
          const session = await findLiveSession(ctx.stationId, txId);
          if (!session) {
            logger.warn({ txId }, 'Ended for unknown transaction');
            return {};
          }

          const meterStop = energyFrom(p.meterValue);

          await closeSession(session.id, {
            endedAt: occurredAt,
            meterStopWh: meterStop ?? session.meter_start_wh,
            // Same canonical vocabulary as 1.6. `toStopReason` knows both
            // spellings; the domain only ever sees `ev_disconnected`.
            stopReason: toStopReason('ocpp2.0.1', p.transactionInfo.stoppedReason ?? 'Other'),
            chargingState: 'Idle',
          });

          await markEffect(ctx.stationId, 'remote_stop');

          // 2.0.1 lets you tell the station the final cost so it can show it
          // on the display. We fill this in properly in Milestone 11.
          return { totalCost: undefined };
        }
      }
    },
  },
  ['ocpp2.0.1'],
);

/**
 * Pull the energy register out of a meter value batch.
 *
 * `Energy.Active.Import.Register` is the cumulative meter reading — the same
 * number 1.6 sends as meterStart/meterStop. Everything else in the batch
 * (power, current, SoC) is instantaneous and must not be used for billing.
 */
function energyFrom(batches?: Array<z.infer<typeof MeterValue>>): number | null {
  if (!batches?.length) return null;
  for (const batch of [...batches].reverse()) {
    for (const sv of batch.sampledValue) {
      const measurand = sv.measurand ?? 'Energy.Active.Import.Register';
      if (measurand !== 'Energy.Active.Import.Register') continue;
      const unit = sv.unitOfMeasure?.unit ?? 'Wh';
      const multiplier = sv.unitOfMeasure?.multiplier ?? 0;
      // multiplier is a power of ten, and it is easy to forget: a value of
      // 4.8 with multiplier 3 and unit kWh is 4800 kWh, not 4.8.
      const scaled = sv.value * 10 ** multiplier;
      return Math.round(unit === 'kWh' ? scaled * 1000 : scaled);
    }
  }
  return null;
}

/**
 * Gap detection.
 *
 * seqNo increases by one per event within a transaction. A hole means an
 * event was lost — and a lost `Ended` event means a session that never closes
 * and a bill you never send. You cannot recover the missing event, but you
 * can know, and knowing is what lets you build the "sessions that look wrong"
 * report that every operator eventually needs.
 */
function checkSeqNo(session: { last_seq_no: number | null }, seqNo: number, identity: string) {
  const previous = session.last_seq_no;
  if (previous != null && seqNo !== previous + 1) {
    logger.warn(
      { identity, expected: previous + 1, received: seqNo },
      'transaction event sequence gap',
    );
  }
}

function toIdTokenStatus(result: string) {
  switch (result) {
    case 'blocked':  return 'Blocked';
    case 'expired':  return 'Expired';
    case 'no_credit': return 'NoCredit';
    default:         return 'Invalid';
  }
}
```

### 5. The other 2.0.1 messages worth having

```ts
// src/ocpp/handlers201/index.ts

// Authorize — still exists, for the "swipe before plugging in" flow. Same
// domain call as 1.6, different envelope.
registerHandler('Authorize', {
  schema: z.object({
    idToken: z.object({ idToken: z.string(), type: z.string() }),
    certificate: z.string().optional(),                    // ISO 15118 plug & charge
    iso15118CertificateHashData: z.array(z.unknown()).optional(),
  }),
  async handle(ctx, p) {
    const decision = await authorizeToken({
      tokenValue: p.idToken.idToken,
      stationId: ctx.stationId,
    });
    return { idTokenInfo: { status: toIdTokenStatus(decision.result) } };
  },
}, ['ocpp2.0.1']);

/**
 * NotifyEvent — where faults went.
 *
 * 1.6 put errorCode on StatusNotification. 2.0.1 has a general monitoring
 * system: the station reports any variable crossing a threshold, and a
 * hardware fault is just one kind of event. Store them; the dashboard's
 * station detail page shows the recent ones.
 */
registerHandler('NotifyEvent', {
  schema: z.object({
    generatedAt: z.string(),
    seqNo: z.number().int(),
    tbc: z.boolean().optional(),     // "to be continued" — more pages coming
    eventData: z.array(z.object({
      eventId: z.number().int(),
      timestamp: z.string(),
      trigger: z.enum(['Alerting', 'Delta', 'Periodic']),
      actualValue: z.string(),
      eventNotificationType: z.string(),
      component: z.object({ name: z.string(), evse: z.object({ id: z.number() }).optional() }),
      variable: z.object({ name: z.string() }),
      cause: z.number().int().optional(),
      techCode: z.string().optional(),
      techInfo: z.string().optional(),
      cleared: z.boolean().optional(),   // the fault went away
      severity: z.number().int().optional(),
    })),
  }),
  async handle(ctx, p) {
    for (const event of p.eventData) {
      await recordStationEvent({
        stationId: ctx.stationId,
        evseId: event.component.evse?.id ?? null,
        component: event.component.name,
        variable: event.variable.name,
        value: event.actualValue,
        severity: event.severity ?? null,
        cleared: event.cleared ?? false,
        techCode: event.techCode ?? null,
        occurredAt: new Date(event.timestamp),
      });
    }
    return {};
  },
}, ['ocpp2.0.1']);

// Heartbeat and DataTransfer are byte-identical across versions.
registerHandler('Heartbeat', heartbeatHandler, ['ocpp1.6', 'ocpp2.0.1']);
```

```sql
-- migrations/004_ocpp201.sql (continued)
CREATE TABLE station_events (
  id          BIGSERIAL PRIMARY KEY,
  station_id  UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  evse_id     INT,
  component   TEXT NOT NULL,
  variable    TEXT NOT NULL,
  value       TEXT,
  severity    INT,
  cleared     BOOLEAN NOT NULL DEFAULT false,
  tech_code   TEXT,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_station_events ON station_events(station_id, occurred_at DESC);
```

### 6. The `sessions` domain stays protocol-blind

Check your own work. Open `src/domain/sessions.ts` and search for the string
`ocpp`. The only acceptable occurrence is the `protocol` column being written
through from the caller.

```ts
// src/domain/sessions.ts — this is the shape both protocols call into
export interface OpenSessionInput {
  protocol: 'ocpp1.6' | 'ocpp2.0.1';   // stored, never branched on
  stationId: string;
  evseId: number;
  connectorId: number;
  transactionId: string;               // TEXT for both, always
  tokenValue: string;
  tokenId: string | null;
  userId: string | null;
  startedAt: Date;
  meterStartWh: number;
  chargingState?: string | null;       // 2.0.1 only; null for 1.6
  seqNo?: number | null;               // 2.0.1 only
  remoteStartId?: number | null;       // 2.0.1 only
}
```

Three nullable columns is the entire cost of supporting both versions in the
domain layer. That is the payoff for the mapping work.

---

## Prove it works

### 1. Two protocols, one fleet

In the simulator, create two stations:

| Identity | Protocol |
|---|---|
| `SIM-16-001` | OCPP 1.6J |
| `SIM-201-001` | OCPP 2.0.1 |

Connect both. In the dashboard's station list you should see two rows with
different protocol badges — and **every other column identical in meaning**.
Status, connector states, last seen: all canonical.

Now run a full charge on each. Open **Sessions** and confirm you cannot tell
from the session list which protocol produced which row, except for the
protocol badge. That is the test. If a 2.0.1 session displays differently, you
leaked protocol detail upward.

### 2. The `Occupied` demo

On the 2.0.1 station, plug in but do not authorize.

```
← StatusNotification {"connectorStatus":"Occupied", evseId:1, connectorId:1}
```

The dashboard should show **Preparing**, not "Occupied". Then start a
transaction:

```
← TransactionEvent {"eventType":"Started", transactionInfo:{chargingState:"Charging"}}
```

Now it shows **Charging** — with no new `StatusNotification` at all. The status
did not change on the wire; your interpretation of it did.

Run this and you will never forget why 2.0.1 needs both fields.

### 3. Exact correlation

Send a remote start to the 2.0.1 station from the dashboard. In the frame log:

```
→ RequestStartTransaction {"evseId":1,"idToken":{...},"remoteStartId":734512}
← TransactionEvent {"eventType":"Started", transactionInfo":{"remoteStartId":734512,...}}
```

The command flips to `succeeded` on an exact id match — no time window. Do the
same on the 1.6 station and watch it correlate by `(station, idTag, 5 minutes)`
instead. Same outcome, different confidence.

### 4. The offline replay

Use the simulator's **Go offline** control on the 2.0.1 station mid-charge, let
it run for a minute, then bring it back. It replays the buffered
`TransactionEvent`s with `offline: true`.

```sql
SELECT measured_at FROM meter_values
  WHERE session_id = '<the session>' ORDER BY measured_at;
```

The timestamps must be spread across the offline minute, **not** bunched at the
reconnect moment. If they are bunched, you used `now()` somewhere you should
have used `p.timestamp`.

### 5. Sequence gaps

Use raw send in the simulator to deliver an `Updated` event with a `seqNo` that
skips one. Your log should say `transaction event sequence gap`. The session
keeps working — detection is not rejection.

### 6. Unsupported actions

Send `GetDiagnostics` (a 1.6-only message) to the 2.0.1 station:

```
← CALLERROR [4,"<id>","NotImplemented","GetDiagnostics is not supported on ocpp2.0.1",{}]
```

Clean error, server still running, station still connected.

---

## What you can now explain

- The five real differences between 1.6 and 2.0.1, with an example of each.
- Why `TransactionEvent` replacing four messages is a simplification and not
  just churn.
- Why 2.0.1's `Occupied` cannot be interpreted without `chargingState`.
- Why the station allocating the transaction id is better for offline
  operation.
- Where faults went, and why a null `error_code` on a 2.0.1 connector is
  correct rather than missing.
- How one codebase serves both without `if (protocol)` scattered through the
  business logic — and where exactly the line is drawn.
- What `seqNo` gap detection buys you, and what it cannot fix.

> **This is your strongest interview material.** "I ran 1.6 and 2.0.1 on one
> CPMS by translating both into a canonical model at the gateway edge" is a
> sentence very few candidates can say and then defend with specifics.

---

Next: **[Milestone 8 — the REST API →](milestone-08-rest-api.md)**
