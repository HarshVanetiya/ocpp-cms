# Milestone 6 — Remote commands

**Goal:** the dashboard can tell a station to do something, and find out whether it worked.

**Time:** 2–3 hours.

**Endpoints:** 6 — `sendCommand`, `listCommands`, `getCommand`,
`getStationConfiguration`, `updateStationConfiguration`, `stopSession`.

---

## Why this exists

Until now every message arrived *from* the station. This milestone reverses the
arrow. The station is the server-ish party in the conversation — it dialled us —
but OCPP is symmetric: once the socket is open, either side can send a CALL.

And here is the thing that trips up almost every first CPMS:

> **A remote command has two results, and the first one is not the answer.**

Take a remote start. You send `RemoteStartTransaction`. The station replies
`{"status":"Accepted"}` about 80 ms later. That reply means:

- ✅ "I understood the message, and I will attempt it."

It does **not** mean:

- ❌ the cable is plugged in,
- ❌ the contactor closed,
- ❌ a car is charging,
- ❌ a transaction exists.

The real outcome arrives *seconds later*, as a **separate inbound message** —
a `StatusNotification` going to `Preparing` then `Charging`, and a
`StartTransaction`. If the driver never plugs in, the accepted command simply
never produces anything, and after a minute or so the station gives up silently.

So a command is a small state machine with a lifetime, not a function call.
That is why it gets a database table.

```
queued ──► sent ──► accepted ──► succeeded
                 └─► rejected        │
                                     └─ (or nothing ever arrives → timeout)
```

| Status | What happened | Set by |
|---|---|---|
| `queued` | Row written, not yet on the wire | the HTTP handler |
| `sent` | CALL written to the socket | the gateway |
| `accepted` | Station answered `Accepted` | the CALLRESULT |
| `rejected` | Station answered `Rejected` | the CALLRESULT |
| `succeeded` | The **effect** was observed | a later inbound message |
| `failed` | CALLERROR, or the effect failed | either |
| `timeout` | No CALLRESULT in time, or no effect in time | a timer |

If your UI marks a command "done" on `accepted`, it lies to the operator. The
dashboard in this repo deliberately shows `accepted` in amber and only turns it
green on `succeeded` — go look at the station detail page after you build this.

### The second reason this exists: two protocols, one verb

The dashboard sends `{"command":"reset","payload":{"type":"immediate"}}`. It has
no idea whether the station speaks 1.6 or 2.0.1, and it must not need to.

| Canonical | OCPP 1.6 | OCPP 2.0.1 |
|---|---|---|
| `remote_start` | `RemoteStartTransaction` | `RequestStartTransaction` |
| `remote_stop` | `RemoteStopTransaction` | `RequestStopTransaction` |
| `reset` `immediate` | `Reset {type:"Hard"}` | `Reset {type:"Immediate"}` |
| `reset` `on_idle` | `Reset {type:"Soft"}` | `Reset {type:"OnIdle"}` |
| `unlock_connector` | `UnlockConnector {connectorId}` | `UnlockConnector {evseId, connectorId}` |
| `change_availability` | `ChangeAvailability {type:"Operative"}` | `ChangeAvailability {operationalStatus:"Operative"}` |
| `get_configuration` | `GetConfiguration` | `GetVariables` |
| `set_configuration` | `ChangeConfiguration` | `SetVariables` |
| `clear_cache` | `ClearCache` | `ClearCache` |
| `trigger_message` | `TriggerMessage` | `TriggerMessage` |

Notice `reset`: the canonical vocabulary is **`immediate` / `on_idle`**, not
Hard/Soft. "Hard" and "Soft" describe the 1.6 wire; "immediate" and "on idle"
describe what the operator wants. Name things after the intent and the mapping
table is the only place protocol knowledge lives.

This is the same move you made in Milestone 5 for statuses, applied outbound.
By the end of Milestone 7 you will have done it in both directions, and that
symmetry is the single most defensible design decision in the whole project.

---

## Build it

### 1. The commands table

```sql
-- migrations/002_commands.sql

CREATE TABLE commands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id   UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,

  -- Canonical name, never the wire name. `reset`, not `Reset`.
  command      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','accepted','rejected',
                                 'succeeded','failed','timeout')),

  payload      JSONB NOT NULL DEFAULT '{}',
  -- The station's answer to the CALL, verbatim. Store what it actually said,
  -- not your interpretation of it — one day a station will send something
  -- your parser did not expect and you will want the original.
  response     JSONB,

  -- The OCPP message id we used. This is the join key between this table and
  -- the frame log, and it is what makes the dashboard's "show me this
  -- command on the wire" link work.
  ocpp_message_id TEXT,

  error_code    TEXT,
  error_message TEXT,

  -- Who pressed the button. "Who reset this station at 03:00?" is a real
  -- question that gets asked in real incident reviews.
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Set when the command is waiting on an effect, so a sweeper can time it
  -- out without scanning the whole table.
  expires_at    TIMESTAMPTZ,
  -- Correlates the eventual effect back to this row (a session id, usually).
  correlation   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  responded_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

CREATE INDEX idx_commands_station ON commands(station_id, created_at DESC);
CREATE INDEX idx_commands_msgid   ON commands(ocpp_message_id);

-- The sweeper's index: only rows still waiting, so it stays tiny forever.
CREATE INDEX idx_commands_pending ON commands(expires_at)
  WHERE status IN ('queued','sent','accepted');
```

> **`correlation` in one sentence:** when a `StartTransaction` arrives, you
> need to know which remote-start caused it. 1.6 gives you no request id on the
> inbound message, so you correlate on `(station, connector, idTag)` within a
> time window. More on that below.

### 2. The mapping layer

This is the file to get right. Everything protocol-specific about outbound
commands lives here and nowhere else.

```ts
// src/ocpp/commands/map.ts
import type { Protocol } from '../registry.js';
import { AppError } from '../../errors.js';

/** What a mapper produces: the wire action and its payload. */
export interface WireCall {
  action: string;
  payload: Record<string, unknown>;
}

/**
 * How to read the station's answer.
 *
 * Every OCPP response is shaped differently — 1.6's RemoteStartTransaction
 * answers `{status:"Accepted"}`, 2.0.1's GetVariables answers an array of
 * results with no top-level status at all. So each command says how to turn
 * its own response into our three-valued verdict.
 */
export type Verdict = 'accepted' | 'rejected' | 'unknown';

export interface CommandMapper {
  /** Build the wire call, or throw AppError if this protocol cannot do it. */
  toWire(payload: Record<string, unknown>, protocol: Protocol): WireCall;
  /** Read the CALLRESULT. */
  readVerdict(response: Record<string, unknown>, protocol: Protocol): Verdict;
  /**
   * Does the real outcome arrive later, as a separate message?
   * If false, `accepted` is the final answer and we mark it `succeeded`.
   */
  awaitsEffect?: boolean;
  /** How long to wait for that effect before giving up. */
  effectTimeoutMs?: number;
}

/**
 * The generic 1.6-style reader: `{ status: "Accepted" | "Rejected" }`.
 *
 * 2.0.1 kept the same shape for most commands but moved a few into
 * `{ status, statusInfo: { reasonCode, additionalInfo } }`. Reading only
 * `status` works for both; `statusInfo` is the human-readable *why*, which we
 * keep in the raw response for the UI to show.
 */
const statusVerdict = (r: Record<string, unknown>): Verdict => {
  const s = String(r?.status ?? '');
  if (s === 'Accepted' || s === 'Scheduled') return 'accepted';
  if (s === 'Rejected' || s === 'NotSupported' || s === 'Unknown') return 'rejected';
  return 'unknown';
};

export const COMMAND_MAPPERS: Record<string, CommandMapper> = {
  /* ------------------------------------------------------------------ */
  remote_start: {
    awaitsEffect: true,
    // Generous on purpose: this waits for a human to walk to the car and
    // plug in. Too short and you will mark real starts as failures.
    effectTimeoutMs: 120_000,
    toWire(p, protocol) {
      if (protocol === 'ocpp1.6') {
        return {
          action: 'RemoteStartTransaction',
          payload: {
            // 1.6 has no EVSE concept. We projected each 1.6 connector onto
            // its own EVSE in Milestone 4, so evseId and connectorId are the
            // same number here — send whichever the caller gave us.
            connectorId: p.connectorId ?? p.evseId,
            idTag: p.idToken,
            ...(p.chargingProfile ? { chargingProfile: p.chargingProfile } : {}),
          },
        };
      }
      return {
        action: 'RequestStartTransaction',
        payload: {
          evseId: p.evseId ?? p.connectorId,
          // 2.0.1 wrapped the bare string in a typed object. `type` is not
          // optional — a station is entitled to reject the whole message if
          // you omit it.
          idToken: { idToken: p.idToken, type: 'ISO14443' },
          // The one genuinely new field: WE allocate this, and the station
          // echoes it back on every TransactionEvent. It is the correlation
          // id that 1.6 never had. Milestone 7 uses it.
          remoteStartId: Number(p.remoteStartId ?? Date.now() % 2_147_483_647),
        },
      };
    },
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  remote_stop: {
    awaitsEffect: true,
    effectTimeoutMs: 60_000,
    toWire(p, protocol) {
      // The caller gave us OUR session id; the station only knows its own
      // transaction id. The domain layer resolves that before we get here.
      const txId = p.transactionId;
      if (txId === undefined || txId === null) {
        throw new AppError('CONFLICT', 'That session has no transaction id yet', 409);
      }
      if (protocol === 'ocpp1.6') {
        // 1.6 transaction ids are INTEGERS on the wire even though we store
        // them as text. Send a number or a strict station will reject it.
        return { action: 'RemoteStopTransaction', payload: { transactionId: Number(txId) } };
      }
      // 2.0.1 transaction ids are strings, up to 36 chars. Do not coerce.
      return { action: 'RequestStopTransaction', payload: { transactionId: String(txId) } };
    },
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  reset: {
    // A reset's effect is the station disconnecting and booting again. We do
    // treat that as the effect — see markEffect() below.
    awaitsEffect: true,
    effectTimeoutMs: 180_000,
    toWire(p, protocol) {
      const immediate = p.type === 'immediate';
      if (protocol === 'ocpp1.6') {
        return { action: 'Reset', payload: { type: immediate ? 'Hard' : 'Soft' } };
      }
      return {
        action: 'Reset',
        payload: {
          type: immediate ? 'Immediate' : 'OnIdle',
          // 2.0.1 can reset a single EVSE and leave the rest charging.
          // Omitting evseId means the whole station.
          ...(p.evseId ? { evseId: Number(p.evseId) } : {}),
        },
      };
    },
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  unlock_connector: {
    toWire(p, protocol) {
      if (protocol === 'ocpp1.6') {
        return { action: 'UnlockConnector', payload: { connectorId: Number(p.connectorId) } };
      }
      return {
        action: 'UnlockConnector',
        payload: { evseId: Number(p.evseId), connectorId: Number(p.connectorId) },
      };
    },
    // 1.6 answers Unlocked/UnlockFailed/NotSupported, not Accepted/Rejected.
    readVerdict(r) {
      const s = String(r?.status ?? '');
      if (s === 'Unlocked') return 'accepted';
      if (s === 'UnlockFailed' || s === 'NotSupported' || s === 'OngoingAuthorizedTransaction')
        return 'rejected';
      return 'unknown';
    },
  },

  /* ------------------------------------------------------------------ */
  change_availability: {
    awaitsEffect: true,
    // "Scheduled" means: I will do it when the current transaction ends.
    // That could be hours. This timeout is for the *status* to change; a
    // scheduled availability change that never lands is genuinely a problem.
    effectTimeoutMs: 300_000,
    toWire(p, protocol) {
      const operative = p.operational === 'operative';
      if (protocol === 'ocpp1.6') {
        return {
          action: 'ChangeAvailability',
          payload: {
            // 0 means the whole charge point in 1.6. This is one of the very
            // few places 1.6 lets you address the station itself.
            connectorId: Number(p.connectorId ?? p.evseId ?? 0),
            type: operative ? 'Operative' : 'Inoperative',
          },
        };
      }
      return {
        action: 'ChangeAvailability',
        payload: {
          // 2.0.1 renamed the field and made the target an object. Omitting
          // `evse` entirely means the whole station — you cannot send
          // evseId 0.
          operationalStatus: operative ? 'Operative' : 'Inoperative',
          ...(p.evseId
            ? {
                evse: {
                  id: Number(p.evseId),
                  ...(p.connectorId ? { connectorId: Number(p.connectorId) } : {}),
                },
              }
            : {}),
        },
      };
    },
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  trigger_message: {
    toWire(p, protocol) {
      if (protocol === 'ocpp1.6') {
        return {
          action: 'TriggerMessage',
          payload: {
            requestedMessage: String(p.requestedMessage),
            ...(p.connectorId ? { connectorId: Number(p.connectorId) } : {}),
          },
        };
      }
      return {
        action: 'TriggerMessage',
        payload: {
          // Renamed enum values, too: 1.6's "MeterValues" is 2.0.1's
          // "MeterValues", but 1.6's "StatusNotification" is 2.0.1's
          // "StatusNotification" and 1.6's "DiagnosticsStatusNotification"
          // has no equivalent at all. Pass through and let the station
          // reject what it does not know.
          requestedMessage: String(p.requestedMessage),
          ...(p.evseId ? { evse: { id: Number(p.evseId) } } : {}),
        },
      };
    },
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  clear_cache: {
    toWire: () => ({ action: 'ClearCache', payload: {} }),
    readVerdict: statusVerdict,
  },

  /* ------------------------------------------------------------------ */
  get_configuration: {
    toWire(p, protocol) {
      const keys = Array.isArray(p.keys) ? (p.keys as string[]) : undefined;
      if (protocol === 'ocpp1.6') {
        // Omitting `key` means "send me everything". Some stations return
        // sixty keys; some return two hundred.
        return { action: 'GetConfiguration', payload: keys?.length ? { key: keys } : {} };
      }
      // 2.0.1 has no "give me everything" — GetVariables REQUIRES a list.
      // You must either know what to ask for or read the full device model
      // from the report the station sends at boot. This asymmetry is real
      // and it is why the UI shows a "Refresh from station" button rather
      // than fetching silently.
      if (!keys?.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          'OCPP 2.0.1 requires an explicit list of variables to read',
          400,
        );
      }
      return {
        action: 'GetVariables',
        payload: {
          getVariableData: keys.map((k) => {
            const [component, variable] = splitKey(k);
            return { component: { name: component }, variable: { name: variable } };
          }),
        },
      };
    },
    // Neither version answers with a status; both answer with data.
    readVerdict: () => 'accepted',
  },

  /* ------------------------------------------------------------------ */
  set_configuration: {
    toWire(p, protocol) {
      if (protocol === 'ocpp1.6') {
        // Everything is a string in 1.6. `true` is "true", 300 is "300".
        return {
          action: 'ChangeConfiguration',
          payload: { key: String(p.key), value: String(p.value) },
        };
      }
      const component = String(p.component ?? splitKey(String(p.key))[0]);
      const variable = String(p.variable ?? splitKey(String(p.key))[1]);
      return {
        action: 'SetVariables',
        payload: {
          setVariableData: [
            {
              // attributeType defaults to "Actual" if omitted. Being explicit
              // costs nothing and saves you a confusing hour when a station
              // defaults it to "Target" instead.
              attributeType: 'Actual',
              attributeValue: String(p.value),
              component: { name: component },
              variable: { name: variable },
            },
          ],
        },
      };
    },
    readVerdict(r, protocol) {
      if (protocol === 'ocpp1.6') {
        const s = String(r?.status ?? '');
        // 1.6 has a THIRD answer here that is neither yes nor no:
        // "RebootRequired" means accepted, but not in effect until restart.
        if (s === 'Accepted' || s === 'RebootRequired') return 'accepted';
        return s === 'Rejected' || s === 'NotSupported' ? 'rejected' : 'unknown';
      }
      const results = (r?.setVariableResult ?? []) as Array<{ attributeStatus?: string }>;
      const first = results[0]?.attributeStatus ?? '';
      if (first === 'Accepted' || first === 'RebootRequired') return 'accepted';
      return first ? 'rejected' : 'unknown';
    },
  },
};

/** "OCPPCommCtrlr.HeartbeatInterval" → ["OCPPCommCtrlr", "HeartbeatInterval"] */
function splitKey(key: string): [string, string] {
  const dot = key.indexOf('.');
  // A key with no dot is a bare 1.6-style name. Put it in the catch-all
  // component so 2.0.1 stations at least receive something well-formed.
  if (dot === -1) return ['OCPPCommCtrlr', key];
  return [key.slice(0, dot), key.slice(dot + 1)];
}

export function mapperFor(command: string): CommandMapper {
  const m = COMMAND_MAPPERS[command];
  if (!m) throw new AppError('VALIDATION_FAILED', `Unknown command: ${command}`, 400);
  return m;
}
```

> **Read the `unlock_connector` verdict reader again.** 1.6 answers
> `Unlocked` / `UnlockFailed`, not `Accepted` / `Rejected`. If you assume every
> OCPP response has `status: "Accepted"` you will show a successful unlock as
> "unknown" forever. There is no shortcut here; each command's response has to
> be read on its own terms. That is exactly why `readVerdict` is per-command
> rather than one shared function.

### 3. Issuing a command

```ts
// src/domain/commands.ts
import { query, tx } from '../db/index.js';
import { callStation } from '../ocpp/call.js';
import { registry } from '../ocpp/registry.js';
import { mapperFor } from '../ocpp/commands/map.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

export interface IssueInput {
  stationId: string;
  command: string;
  payload: Record<string, unknown>;
  requestedBy?: string | null;
}

/**
 * Send a command and return as soon as we know whether the station took it.
 *
 * Note what this does NOT do: wait for the effect. The HTTP request returns in
 * well under a second with status `accepted`, and the dashboard subscribes or
 * polls for the rest. An HTTP handler that blocks for two minutes waiting for
 * a driver to plug a cable in is a handler that will be killed by a load
 * balancer.
 */
export async function issueCommand(input: IssueInput) {
  const station = await query(
    `SELECT id, identity, protocol FROM stations WHERE id = $1`,
    [input.stationId],
  ).then((r) => r.rows[0]);
  if (!station) throw AppError.notFound('Station');

  const mapper = mapperFor(input.command);

  // Build the wire call BEFORE writing the row. If the payload is wrong we
  // want a 400 and no database noise, not a `failed` command in the history.
  const wire = mapper.toWire(input.payload, station.protocol);

  const { rows } = await query(
    `INSERT INTO commands (station_id, command, payload, requested_by, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING *`,
    [station.id, input.command, JSON.stringify(input.payload), input.requestedBy ?? null],
  );
  const command = rows[0];

  if (!registry.isOnline(station.identity)) {
    // Deliberate choice: FAIL rather than queue.
    //
    // A queued command that fires when the station reconnects two hours later
    // is almost always wrong — the operator has moved on, the driver has
    // gone home, and a car starts charging with nobody there. Real CPMSs do
    // queue a few specific things (firmware updates, local list sync). An
    // unlock is not one of them.
    await finish(command.id, 'failed', {
      errorCode: 'STATION_OFFLINE',
      errorMessage: `${station.identity} is not connected`,
    });
    throw AppError.stationOffline(station.identity);
  }

  // Mark sent before awaiting: if this process dies mid-call, the row says
  // `sent`, which is the truth. Marking it after would lose the fact that we
  // put bytes on the wire.
  await query(`UPDATE commands SET status='sent', sent_at=now() WHERE id=$1`, [command.id]);

  try {
    const response = (await callStation<Record<string, unknown>>(
      station.identity,
      wire.action,
      wire.payload,
    )) ?? {};

    const verdict = mapper.readVerdict(response, station.protocol);

    if (verdict === 'rejected') {
      return finish(command.id, 'rejected', { response });
    }

    // Accepted. Is this the end of the story, or do we wait for an effect?
    if (!mapper.awaitsEffect) {
      return finish(command.id, 'succeeded', { response });
    }

    const expires = new Date(Date.now() + (mapper.effectTimeoutMs ?? 60_000));
    const { rows: updated } = await query(
      `UPDATE commands
          SET status='accepted', response=$2, responded_at=now(), expires_at=$3
        WHERE id=$1 RETURNING *`,
      [command.id, JSON.stringify(response), expires],
    );
    return updated[0];
  } catch (err) {
    const e = err as AppError;
    const status = e.code === 'COMMAND_TIMEOUT' ? 'timeout' : 'failed';
    logger.warn({ err, command: input.command, station: station.identity }, 'command failed');
    await finish(command.id, status, { errorCode: e.code ?? 'INTERNAL', errorMessage: e.message });
    throw err;
  }
}

async function finish(
  id: string,
  status: string,
  extra: { response?: unknown; errorCode?: string; errorMessage?: string } = {},
) {
  const { rows } = await query(
    `UPDATE commands
        SET status = $2,
            response = COALESCE($3, response),
            error_code = COALESCE($4, error_code),
            error_message = COALESCE($5, error_message),
            responded_at = COALESCE(responded_at, now()),
            completed_at = now(),
            expires_at = NULL
      WHERE id = $1
      RETURNING *`,
    [
      id,
      status,
      extra.response === undefined ? null : JSON.stringify(extra.response),
      extra.errorCode ?? null,
      extra.errorMessage ?? null,
    ],
  );
  return rows[0];
}
```

### 4. Closing the loop — observing the effect

This is the part that makes the status column honest. When a `StartTransaction`
arrives, look for an `accepted` remote start that could have caused it.

```ts
// src/domain/commands.ts (continued)

/**
 * Mark the newest waiting command of a kind as succeeded.
 *
 * Correlation in 1.6 is inference, not identity: the inbound StartTransaction
 * carries no reference at all to the RemoteStartTransaction that caused it.
 * All you have is "same station, same connector, same idTag, and it happened
 * shortly after". That is genuinely all the protocol gives you, and it is one
 * of the concrete things 2.0.1 fixed — `remoteStartId` is echoed back on every
 * TransactionEvent, so in 2.0.1 this becomes an exact lookup. Milestone 7
 * wires that up.
 *
 * Being wrong here is cheap (a command shows `timeout` instead of `succeeded`)
 * so prefer a narrow window over a clever guess.
 */
export async function markEffect(
  stationId: string,
  command: string,
  match: { connectorId?: number; idToken?: string; correlation?: string } = {},
) {
  const { rows } = await query(
    `UPDATE commands SET status='succeeded', completed_at=now(), expires_at=NULL
      WHERE id = (
        SELECT id FROM commands
         WHERE station_id = $1
           AND command    = $2
           AND status     = 'accepted'
           AND created_at > now() - interval '5 minutes'
           AND ($3::text IS NULL OR payload->>'idToken' = $3)
         ORDER BY created_at DESC
         LIMIT 1
      )
      RETURNING *`,
    [stationId, command, match.idToken ?? null],
  );
  return rows[0] ?? null;
}

/**
 * The sweeper. Anything that was accepted but never produced its effect.
 *
 * Run it on an interval. Without it, `accepted` rows live forever and the
 * dashboard shows an amber command from last Tuesday.
 */
export async function sweepExpiredCommands() {
  const { rowCount } = await query(
    `UPDATE commands
        SET status='timeout', completed_at=now(), expires_at=NULL,
            error_message='The station accepted the command but the effect never arrived'
      WHERE status IN ('queued','sent','accepted')
        AND expires_at IS NOT NULL
        AND expires_at < now()`,
  );
  if (rowCount) logger.info({ rowCount }, 'commands timed out');
  return rowCount;
}
```

Call `markEffect` from the handlers you already wrote in Milestone 5:

```ts
// src/ocpp/handlers/start-transaction.ts — after the session row is created
await markEffect(station.id, 'remote_start', { idToken: payload.idTag });
```

```ts
// src/ocpp/handlers/stop-transaction.ts — after the session is closed
await markEffect(station.id, 'remote_stop');
```

```ts
// src/ocpp/handlers/boot-notification.ts — a boot is the effect of a reset
await markEffect(station.id, 'reset');
```

```ts
// src/ocpp/handlers/status-notification.ts — availability changes land here
if (canonical === 'unavailable' || canonical === 'available') {
  await markEffect(station.id, 'change_availability', { connectorId: payload.connectorId });
}
```

And start the sweeper in `src/index.ts`:

```ts
// src/index.ts
import { sweepExpiredCommands } from './domain/commands.js';

const sweeper = setInterval(() => {
  void sweepExpiredCommands().catch((err) =>
    logger.error({ err }, 'command sweeper failed'),
  );
}, 15_000);
// Unref so a stray interval never keeps the process alive during shutdown.
sweeper.unref();
```

### 5. Configuration

1.6 and 2.0.1 disagree so completely here that it is worth stating plainly:

|  | OCPP 1.6 | OCPP 2.0.1 |
|---|---|---|
| Shape | flat list of `key` → `value` strings | a tree: Component → Variable → Attribute |
| Read all | `GetConfiguration` with no key | **not possible** — you must name them |
| Discovery | there is none; you guess key names | `GetBaseReport` sends the whole device model |
| Unknown keys | returned in `unknownKey[]` | per-variable `UnknownComponent` / `UnknownVariable` |
| Types | everything is a string | typed: integer, decimal, boolean, dateTime, … |

We flatten both into one row shape — `key`, `value`, `readonly`, plus optional
`component` / `variable` / `dataType` — so the dashboard has one table
component. The contract for it is `StationConfigurationSchema` in
`packages/contracts/src/station.ts`.

```ts
// src/domain/configuration.ts
import { query } from '../db/index.js';
import { callStation } from '../ocpp/call.js';
import { AppError } from '../errors.js';
import { issueCommand } from './commands.js';

/**
 * Keys worth asking a 2.0.1 station about when we have nothing cached.
 *
 * 1.6 can just say "everything". For 2.0.1 you need a starting list, because
 * GetVariables has no wildcard. In production you would populate this from
 * the station's own device-model report; this list gets you a useful screen
 * on day one.
 */
const DEFAULT_201_VARIABLES = [
  'OCPPCommCtrlr.HeartbeatInterval',
  'OCPPCommCtrlr.MessageTimeout',
  'OCPPCommCtrlr.NetworkConfigurationPriority',
  'OCPPCommCtrlr.WebSocketPingInterval',
  'AlignedDataCtrlr.Interval',
  'AlignedDataCtrlr.Measurands',
  'SampledDataCtrlr.TxUpdatedInterval',
  'SampledDataCtrlr.TxUpdatedMeasurands',
  'AuthCtrlr.AuthorizeRemoteStart',
  'AuthCtrlr.LocalAuthorizeOffline',
  'TxCtrlr.EVConnectionTimeOut',
  'TxCtrlr.StopTxOnEVSideDisconnect',
];

export async function readConfiguration(stationId: string, keys?: string[]) {
  const station = await query(
    `SELECT id, identity, protocol FROM stations WHERE id=$1`,
    [stationId],
  ).then((r) => r.rows[0]);
  if (!station) throw AppError.notFound('Station');

  const isV16 = station.protocol === 'ocpp1.6';
  const wanted = keys?.length ? keys : isV16 ? undefined : DEFAULT_201_VARIABLES;

  const response = isV16
    ? await callStation<Ocpp16Config>(station.identity, 'GetConfiguration',
        wanted ? { key: wanted } : {})
    : await callStation<Ocpp201Vars>(station.identity, 'GetVariables', {
        getVariableData: (wanted ?? []).map((k) => {
          const [component, variable] = k.split(/\.(.+)/);
          return { component: { name: component }, variable: { name: variable } };
        }),
      });

  const flat = isV16
    ? flatten16(response as Ocpp16Config)
    : flatten201(response as Ocpp201Vars, wanted ?? []);

  // Cache it. The station may go offline, and an empty configuration screen
  // is worse than a stale one — as long as you show when it was read.
  await query(
    `INSERT INTO station_configuration (station_id, keys, unknown_keys, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (station_id) DO UPDATE
       SET keys = EXCLUDED.keys,
           unknown_keys = EXCLUDED.unknown_keys,
           fetched_at = EXCLUDED.fetched_at`,
    [station.id, JSON.stringify(flat.keys), flat.unknownKeys],
  );

  return {
    stationId: station.id,
    protocol: station.protocol,
    keys: flat.keys,
    unknownKeys: flat.unknownKeys,
    fetchedAt: new Date().toISOString(),
  };
}

interface Ocpp16Config {
  configurationKey?: Array<{ key: string; value?: string; readonly: boolean }>;
  unknownKey?: string[];
}

function flatten16(r: Ocpp16Config) {
  return {
    keys: (r.configurationKey ?? []).map((k) => ({
      key: k.key,
      // A key can exist and have no value. `null` and `""` mean different
      // things — "not set" versus "set to empty" — so preserve the
      // difference instead of defaulting to ''.
      value: k.value ?? null,
      readonly: k.readonly,
      component: null,
      variable: null,
      dataType: null,
    })),
    unknownKeys: r.unknownKey ?? [],
  };
}

interface Ocpp201Vars {
  getVariableResult: Array<{
    attributeStatus: string;
    attributeValue?: string;
    attributeType?: string;
    component: { name: string };
    variable: { name: string };
  }>;
}

function flatten201(r: Ocpp201Vars, asked: string[]) {
  const keys: Array<Record<string, unknown>> = [];
  const unknownKeys: string[] = [];

  for (const result of r.getVariableResult ?? []) {
    const key = `${result.component.name}.${result.variable.name}`;
    if (result.attributeStatus !== 'Accepted') {
      // UnknownComponent, UnknownVariable, NotSupportedAttributeType,
      // Rejected — all mean "you are not getting a value for this".
      unknownKeys.push(key);
      continue;
    }
    keys.push({
      key,
      value: result.attributeValue ?? null,
      // 2.0.1 tells you mutability in the variable's characteristics, which
      // GetVariables does not return. Reading it properly needs
      // GetBaseReport; until then, assume writable and let the station say no.
      readonly: false,
      component: result.component.name,
      variable: result.variable.name,
      dataType: null,
    });
  }

  // Anything we asked for and heard nothing about at all.
  for (const k of asked) {
    if (!keys.some((x) => x.key === k) && !unknownKeys.includes(k)) unknownKeys.push(k);
  }
  return { keys, unknownKeys };
}

/** Writing goes through the command pipeline, so it lands in the audit trail. */
export async function writeConfiguration(
  stationId: string,
  input: { key: string; value: string; component?: string; variable?: string },
  requestedBy?: string | null,
) {
  return issueCommand({
    stationId,
    command: 'set_configuration',
    payload: { ...input },
    requestedBy,
  });
}
```

```sql
-- migrations/003_station_configuration.sql
CREATE TABLE station_configuration (
  station_id   UUID PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  keys         JSONB NOT NULL DEFAULT '[]',
  unknown_keys TEXT[] NOT NULL DEFAULT '{}',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6. The routes

```ts
// src/api/routes/commands.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateCommandSchema, UpdateConfigurationSchema, PageQuerySchema }
  from '@ocpp/contracts';
import { issueCommand } from '../../domain/commands.js';
import { readConfiguration, writeConfiguration } from '../../domain/configuration.js';
import { query } from '../../db/index.js';
import { AppError } from '../../errors.js';

const Params = z.object({ id: z.string().uuid() });

export async function commandRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/stations/:id/commands
   *
   * The schemas are imported from the contracts package — the SAME objects the
   * frontend validates against. Not a copy, not a translation. If you change
   * one, both sides change together, which is the entire point of having a
   * contracts package rather than an API document nobody updates.
   */
  app.post('/stations/:id/commands', async (request) => {
    const { id } = Params.parse(request.params);
    const body = CreateCommandSchema.parse(request.body);
    return issueCommand({
      stationId: id,
      command: body.command,
      payload: body.payload,
      requestedBy: request.user?.id ?? null,   // request.user arrives in Milestone 8
    });
  });

  app.get('/stations/:id/commands', async (request) => {
    const { id } = Params.parse(request.params);
    const { page = 1, pageSize = 25 } = PageQuerySchema.parse(request.query);

    const [items, total] = await Promise.all([
      query(
        `SELECT c.*, s.identity AS station_identity, u.name AS requested_by_name
           FROM commands c
           JOIN stations s ON s.id = c.station_id
      LEFT JOIN users u    ON u.id = c.requested_by
          WHERE c.station_id = $1
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3`,
        [id, pageSize, (page - 1) * pageSize],
      ).then((r) => r.rows),
      query(`SELECT count(*)::int AS n FROM commands WHERE station_id=$1`, [id])
        .then((r) => r.rows[0].n),
    ]);

    return { items, page, pageSize, total, hasMore: page * pageSize < total };
  });

  app.get('/commands/:id', async (request) => {
    const { id } = Params.parse(request.params);
    const row = await query(
      `SELECT c.*, s.identity AS station_identity, u.name AS requested_by_name
         FROM commands c
         JOIN stations s ON s.id = c.station_id
    LEFT JOIN users u    ON u.id = c.requested_by
        WHERE c.id = $1`,
      [id],
    ).then((r) => r.rows[0]);
    if (!row) throw AppError.notFound('Command');
    return row;
  });

  app.get('/stations/:id/configuration', async (request) => {
    const { id } = Params.parse(request.params);
    const q = z.object({ refresh: z.coerce.boolean().default(false) }).parse(request.query);

    if (!q.refresh) {
      const cached = await query(
        `SELECT station_id, keys, unknown_keys, fetched_at FROM station_configuration
          WHERE station_id=$1`,
        [id],
      ).then((r) => r.rows[0]);
      if (cached) {
        const station = await query(`SELECT protocol FROM stations WHERE id=$1`, [id])
          .then((r) => r.rows[0]);
        return {
          stationId: cached.station_id,
          protocol: station.protocol,
          keys: cached.keys,
          unknownKeys: cached.unknown_keys,
          fetchedAt: cached.fetched_at,
        };
      }
    }
    return readConfiguration(id);
  });

  app.put('/stations/:id/configuration', async (request) => {
    const { id } = Params.parse(request.params);
    const body = UpdateConfigurationSchema.parse(request.body);
    return writeConfiguration(id, body, request.user?.id ?? null);
  });
}
```

### 7. Stopping a session from the dashboard

```ts
// src/api/routes/sessions.ts
app.post('/sessions/:id/stop', async (request) => {
  const { id } = Params.parse(request.params);

  const session = await query(
    `SELECT s.id, s.transaction_id, s.status, s.station_id
       FROM sessions s WHERE s.id = $1`,
    [id],
  ).then((r) => r.rows[0]);

  if (!session) throw AppError.notFound('Session');

  // Not an error the operator needs to care about, but not a silent success
  // either — if they pressed stop and it was already stopped, say so.
  if (!['pending', 'active', 'suspended'].includes(session.status)) {
    throw AppError.conflict('That session has already finished');
  }

  return issueCommand({
    stationId: session.station_id,
    command: 'remote_stop',
    // Resolve OUR id into the STATION's id here, at the boundary. The mapper
    // deals with wire formats; it should not be running SQL.
    payload: { sessionId: session.id, transactionId: session.transaction_id },
    requestedBy: request.user?.id ?? null,
  });
});
```

---

## Prove it works

Start everything: your server, the frontend (`npm run dev:learn`), and the
simulator (`npm run dev:sim`). Connect a virtual 1.6 station.

### 1. Reset

Open the station's detail page in the dashboard → **Commands** → **Reset** →
*Immediate*.

Watch three places at once:

| Where | What you should see |
|---|---|
| Dashboard command row | `sent` → `accepted` (amber) → `succeeded` (green) |
| Simulator wire log | `CALL Reset {"type":"Hard"}` inbound, `CALLRESULT {"status":"Accepted"}` back |
| Your server log | the station disconnecting, then a fresh BootNotification |

The jump from amber to green happens when the station boots again — that is
`markEffect` firing from your `BootNotification` handler. If it stays amber for
three minutes and then goes to `timeout`, your sweeper works and your effect
correlation does not. Check that the boot handler calls `markEffect`.

### 2. Remote start, the honest way

Set the simulator station's **auto-plug** behaviour to off, then send a remote
start from the dashboard.

- The command goes `accepted` and **stays there**.
- Nothing charges. No session appears.

That is correct. The station said yes; the driver never plugged in. Now press
**Plug in** in the simulator, and watch the command flip to `succeeded` as the
`StartTransaction` lands.

**This is the demo to remember for an interview.** Being able to say "the CALL
result only means the station accepted the instruction; I model the effect
separately and time it out" is worth more than any amount of protocol trivia.

### 3. Configuration

Station detail → **Configuration** → **Refresh from station**. You should get
the simulator's key list. Change `HeartbeatInterval` to `60`, save, and watch:

```
→ CALL  ChangeConfiguration {"key":"HeartbeatInterval","value":"60"}
← CALLRESULT {"status":"Accepted"}
```

Then confirm the station actually heartbeats every 60 seconds instead of 300.

### 4. Break it deliberately

| Do this | Expect |
|---|---|
| Send any command to an offline station | `409 STATION_OFFLINE`, row recorded as `failed` |
| Use the simulator's "never answer" fault injection | `timeout` after `CALL_TIMEOUT_MS`, no leaked map entry |
| Send `{"command":"reset","payload":{}}` | `400 VALIDATION_FAILED` — and **no** command row is written |
| Unlock a connector mid-charge | `rejected`, because the station refuses to unlock a live cable |

That third row is the one to verify in the database:

```sql
SELECT count(*) FROM commands WHERE command='reset' AND payload = '{}';
-- 0
```

Validate before you insert, and your command history stays a record of real
attempts instead of a record of your own typos.

---

## What you can now explain

- Why a remote command has **two** results, and what each one does and does not
  prove.
- Why `accepted` is not `succeeded`, and how you detect the difference.
- How you correlate an inbound `StartTransaction` back to the remote start that
  caused it — and why 1.6 forces you to infer it while 2.0.1's `remoteStartId`
  makes it exact.
- Why you refuse commands to offline stations instead of queueing them.
- The concrete differences between 1.6 configuration keys and the 2.0.1 device
  model — including the fact that 2.0.1 has no "read everything".
- Why the mapping table is the only file that knows what "Hard" means.

---

Next: **[Milestone 7 — OCPP 2.0.1 →](milestone-07-ocpp-201.md)**
