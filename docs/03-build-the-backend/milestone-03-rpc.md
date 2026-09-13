# Milestone 3 — The OCPP RPC layer

**Goal:** parse frames, route them to handlers, validate payloads, send your
own calls, and time out the ones that never answer.

**Time:** 2–3 hours. This is the most important code in the whole project.

---

## Why this exists

Everything above this layer — every handler, every command, every log line —
depends on getting four things right:

1. **Framing.** Four array shapes, and a malformed one must produce a
   `CALLERROR`, never a crash.
2. **Correlation.** A `CALLRESULT` carries no action name. The only way to know
   what it answers is to remember what you sent with that message id.
3. **Timeouts.** A station can accept a call and never reply. Without a
   timeout, the entry in your pending map lives forever — a real memory leak
   that shows up two weeks later.
4. **Validation.** A `connectorId` of `"two"` must be rejected with the right
   error code, not propagated into your database.

Get this layer right and the rest of OCPP is filling in handlers.

---

## Build it

### 1. Framing

```ts
// src/ocpp/framing.ts
import { z } from 'zod';

export const MessageType = {
  CALL: 2,
  CALLRESULT: 3,
  CALLERROR: 4,
} as const;

/**
 * The error codes OCPP defines for CALLERROR. Returning the right one is not
 * pedantry: the station's own log is the only thing a field engineer has.
 */
export type OcppErrorCode =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurrenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError';

export class OcppError extends Error {
  constructor(
    readonly code: OcppErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OcppError';
  }
}

export type IncomingFrame =
  | { type: 'call'; messageId: string; action: string; payload: unknown }
  | { type: 'callresult'; messageId: string; payload: unknown }
  | { type: 'callerror'; messageId: string; code: string; description: string; details: unknown };

/**
 * Parse one frame off the wire.
 *
 * Throws `OcppError` for anything malformed. The caller turns that into a
 * CALLERROR — which is the specified behaviour, and considerably better than
 * dropping the connection because someone sent bad JSON.
 */
export function parseFrame(raw: string): IncomingFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OcppError('ProtocolError', 'Payload is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new OcppError('ProtocolError', 'Frame must be an array of at least 3 elements');
  }

  const [typeId, messageId] = parsed;

  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 36) {
    throw new OcppError('ProtocolError', 'Message id must be a string of 1–36 characters');
  }

  switch (typeId) {
    case MessageType.CALL: {
      const [, , action, payload] = parsed;
      if (typeof action !== 'string') {
        throw new OcppError('ProtocolError', 'Action must be a string');
      }
      // An absent payload is legal for messages like Heartbeat; treat it as {}.
      return { type: 'call', messageId, action, payload: payload ?? {} };
    }

    case MessageType.CALLRESULT: {
      const [, , payload] = parsed;
      return { type: 'callresult', messageId, payload: payload ?? {} };
    }

    case MessageType.CALLERROR: {
      const [, , code, description, details] = parsed;
      return {
        type: 'callerror',
        messageId,
        code: String(code ?? 'GenericError'),
        description: String(description ?? ''),
        details: details ?? {},
      };
    }

    default:
      throw new OcppError('ProtocolError', `Unknown message type id: ${String(typeId)}`);
  }
}

export function encodeCall(messageId: string, action: string, payload: unknown) {
  return JSON.stringify([MessageType.CALL, messageId, action, payload ?? {}]);
}

export function encodeResult(messageId: string, payload: unknown) {
  return JSON.stringify([MessageType.CALLRESULT, messageId, payload ?? {}]);
}

export function encodeError(messageId: string, error: OcppError) {
  return JSON.stringify([
    MessageType.CALLERROR,
    messageId,
    error.code,
    error.message,
    error.details,
  ]);
}
```

### 2. Handler registry

```ts
// src/ocpp/router.ts
import { z } from 'zod';
import type { Connection } from './registry.js';
import { OcppError } from './framing.js';

export interface HandlerContext {
  connection: Connection;
  identity: string;
  protocol: 'ocpp1.6' | 'ocpp2.0.1';
}

export interface Handler<TIn, TOut> {
  /** Validates the inbound payload. Failing it produces the right CALLERROR. */
  schema: z.ZodType<TIn>;
  handle: (payload: TIn, ctx: HandlerContext) => Promise<TOut> | TOut;
  /**
   * May the station send this before BootNotification has been accepted?
   *
   * The specification is strict: until you answer Accepted, a station may send
   * only BootNotification and Heartbeat. Enforcing it is how you stop an
   * unregistered charger opening transactions.
   */
  allowedBeforeBoot?: boolean;
}

type AnyHandler = Handler<never, unknown>;

const handlers = new Map<string, AnyHandler>();

export function registerHandler<TIn, TOut>(
  action: string,
  handler: Handler<TIn, TOut>,
) {
  handlers.set(action, handler as unknown as AnyHandler);
}

export function getHandler(action: string) {
  return handlers.get(action) ?? null;
}

/**
 * Run an inbound CALL.
 *
 * Every failure mode maps to the error code the specification asks for:
 *   unknown action        → NotImplemented
 *   payload fails schema  → TypeConstraintViolation (or FormationViolation)
 *   handler throws        → InternalError
 */
export async function dispatch(
  action: string,
  payload: unknown,
  ctx: HandlerContext,
): Promise<unknown> {
  const handler = getHandler(action);

  if (!handler) {
    throw new OcppError('NotImplemented', `${action} is not supported by this CSMS`);
  }

  if (!ctx.connection.booted && !handler.allowedBeforeBoot) {
    throw new OcppError(
      'SecurityError',
      `${action} is not allowed before BootNotification has been accepted`,
    );
  }

  const result = handler.schema.safeParse(payload);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new OcppError(
      'TypeConstraintViolation',
      `${first?.path.join('.') || 'payload'}: ${first?.message ?? 'invalid'}`,
      { issues: result.error.issues.slice(0, 5) },
    );
  }

  try {
    return await handler.handle(result.data as never, ctx);
  } catch (error) {
    if (error instanceof OcppError) throw error;
    // A bug in your handler is an InternalError to the station, and a full
    // stack trace in your own log.
    throw new OcppError(
      'InternalError',
      error instanceof Error ? error.message : 'Handler failed',
    );
  }
}
```

### 3. Outbound calls, with correlation and timeouts

```ts
// src/ocpp/call.ts
import { randomUUID } from 'node:crypto';
import { encodeCall, OcppError } from './framing.js';
import { registry, type Connection } from './registry.js';
import { config } from '../config.js';
import { stationLogger } from '../logger.js';
import { AppError } from '../errors.js';

/**
 * Send a CALL to a station and wait for its answer.
 *
 * The three things this does that a naive version does not:
 *
 *  1. Stores the pending promise keyed by message id, because a CALLRESULT
 *     carries no action name and cannot otherwise be matched.
 *  2. Sets a timeout that REJECTS and DELETES the entry. Without it, a station
 *     that accepts and never answers leaks one map entry per call, forever.
 *  3. Refuses immediately when the station is not connected, with a specific
 *     error the UI can explain, rather than waiting 30 seconds to say nothing.
 */
export function callStation<T = unknown>(
  identity: string,
  action: string,
  payload: unknown,
  timeoutMs = config.CALL_TIMEOUT_MS,
): Promise<T> {
  const connection = registry.get(identity);
  if (!connection) {
    return Promise.reject(AppError.stationOffline(identity));
  }

  const messageId = randomUUID();
  const log = stationLogger(identity);

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(messageId);
      log.warn({ action, messageId, timeoutMs }, 'call timed out');
      reject(new AppError('COMMAND_TIMEOUT', `${action} was not answered in time`, 504));
    }, timeoutMs);

    connection.pending.set(messageId, {
      action,
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    });

    const frame = encodeCall(messageId, action, payload);
    log.debug({ action, messageId }, 'call out');
    connection.socket.send(frame, (err) => {
      if (!err) return;
      // The send itself failed — clean up now rather than waiting for the
      // timeout to notice.
      clearTimeout(timer);
      connection.pending.delete(messageId);
      reject(new AppError('STATION_OFFLINE', `Could not send ${action}: ${err.message}`, 409));
    });
  });
}

/** Settle a pending call when its answer arrives. */
export function resolvePending(
  connection: Connection,
  messageId: string,
  outcome: { ok: true; payload: unknown } | { ok: false; error: OcppError },
) {
  const pending = connection.pending.get(messageId);
  if (!pending) {
    // A reply to a call we already timed out, or a message id we never sent.
    // Log it — a station replying to phantom ids is a real firmware bug.
    stationLogger(connection.identity).warn({ messageId }, 'reply for unknown message id');
    return;
  }
  clearTimeout(pending.timer);
  connection.pending.delete(messageId);
  if (outcome.ok) pending.resolve(outcome.payload);
  else pending.reject(outcome.error);
}
```

### 4. Wire the message loop

Replace the placeholder `socket.on('message')` from Milestone 2:

```ts
// src/ocpp/gateway.ts
import { encodeError, encodeResult, OcppError, parseFrame } from './framing.js';
import { dispatch } from './router.js';
import { resolvePending } from './call.js';

socket.on('message', async (raw) => {
  connection.lastSeenAt = new Date();
  const text = raw.toString();

  let frame;
  try {
    frame = parseFrame(text);
  } catch (error) {
    /**
     * We could not even read the message id, so we cannot correlate a
     * CALLERROR to it. The specification's guidance is to use an empty id.
     * Critically: do NOT close the connection. A malformed frame is a bug in
     * their firmware, not a reason to take a charger offline.
     */
    const err = error instanceof OcppError ? error : new OcppError('ProtocolError', 'Bad frame');
    log.warn({ err: err.message, raw: text.slice(0, 300) }, 'malformed frame');
    socket.send(encodeError('', err));
    return;
  }

  switch (frame.type) {
    case 'call': {
      log.debug({ action: frame.action, messageId: frame.messageId }, 'call in');
      try {
        const result = await dispatch(frame.action, frame.payload, {
          connection,
          identity,
          protocol,
        });
        socket.send(encodeResult(frame.messageId, result));
      } catch (error) {
        const err =
          error instanceof OcppError ? error : new OcppError('InternalError', 'Handler failed');
        log.warn({ action: frame.action, code: err.code, message: err.message }, 'call failed');
        socket.send(encodeError(frame.messageId, err));
      }
      break;
    }

    case 'callresult':
      resolvePending(connection, frame.messageId, { ok: true, payload: frame.payload });
      break;

    case 'callerror':
      resolvePending(connection, frame.messageId, {
        ok: false,
        error: new OcppError(frame.code as never, frame.description, frame.details as never),
      });
      break;
  }
});
```

### 5. Your first handler

```ts
// src/ocpp/handlers/boot-notification.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';
import { config } from '../../config.js';
import { stationLogger } from '../../logger.js';

const Request16 = z.object({
  chargePointVendor: z.string().max(20),
  chargePointModel: z.string().max(20),
  chargePointSerialNumber: z.string().max(25).optional(),
  chargeBoxSerialNumber: z.string().max(25).optional(),
  firmwareVersion: z.string().max(50).optional(),
  iccid: z.string().max(20).optional(),
  imsi: z.string().max(20).optional(),
  meterType: z.string().max(25).optional(),
  meterSerialNumber: z.string().max(25).optional(),
});

registerHandler('BootNotification', {
  schema: Request16,
  // The one message that is, by definition, allowed before boot.
  allowedBeforeBoot: true,

  async handle(payload, ctx) {
    const log = stationLogger(ctx.identity);
    log.info(
      { vendor: payload.chargePointVendor, model: payload.chargePointModel },
      'boot notification',
    );

    /**
     * The decision.
     *
     *   Accepted — may operate.
     *   Pending  — stay connected, keep asking; we are still configuring you.
     *   Rejected — go away and retry after `interval`.
     *
     * Rejecting a station you do not recognise is the correct default in
     * production: a CSMS that accepts anyone means anyone who reaches your
     * port joins your fleet. In development you want the opposite, which is
     * what ALLOW_UNKNOWN_STATIONS is for. (Milestone 4 adds the real lookup.)
     */
    const known = config.ALLOW_UNKNOWN_STATIONS;   // replaced in Milestone 4
    const status = known ? 'Accepted' : 'Rejected';

    if (status === 'Accepted') ctx.connection.booted = true;

    return {
      status,
      /**
       * Send real UTC with a Z suffix. The station sets its clock from this,
       * and every timestamp it ever reports depends on it. A wrong clock here
       * corrupts every transaction that station will produce.
       */
      currentTime: new Date().toISOString(),
      /**
       * Seconds. Note this field means two different things:
       * when Accepted it is the heartbeat interval; when Rejected it is how
       * long to wait before trying again.
       */
      interval: config.HEARTBEAT_INTERVAL,
    };
  },
});
```

```ts
// src/ocpp/handlers/heartbeat.ts
import { z } from 'zod';
import { registerHandler } from '../router.js';

registerHandler('Heartbeat', {
  schema: z.object({}).passthrough(),
  allowedBeforeBoot: true,
  handle: () => ({ currentTime: new Date().toISOString() }),
});
```

Import them for their side effects, once, at boot:

```ts
// src/ocpp/handlers/index.ts
import './boot-notification.js';
import './heartbeat.js';
```

```ts
// src/index.ts
import './ocpp/handlers/index.js';
```

---

## Prove it works

**1. The happy path.** Connect `SIM-AMS-001` in the simulator.

```
INFO: station connected      station=SIM-AMS-001 protocol=ocpp1.6
DEBUG: call in               action=BootNotification messageId=a41f-8c02
INFO: boot notification      station=SIM-AMS-001 vendor=SimuVolt model=SV-22AC
```

In the simulator's **Wire log** pane you will see the CALL go out and the
CALLRESULT come back, with a round-trip time. That round trip is the first
proof the whole layer works.

**2. Unknown action.** In the simulator, press **DataTransfer**. You have no
handler for it:

```json
[4, "...", "NotImplemented", "DataTransfer is not supported by this CSMS", {}]
```

The connection stays up. That is the important part.

**3. Malformed payload.** Turn on **Invalid payloads** in the simulator's fault
injection panel and press **StatusNotification**:

```json
[4, "...", "TypeConstraintViolation", "connectorId: Expected number, received string", {}]
```

**4. The timeout.** Turn on **Ignore commands**, then send anything from your
own code with `callStation(...)`. After 30 seconds:

```
WARN: call timed out  station=SIM-AMS-001 action=TriggerMessage timeoutMs=30000
```

Check `connection.pending.size` afterwards — it is back to 0. If it is not,
your cleanup is wrong, and that is the leak.

---

## What you can now explain

- Why a `CALLRESULT` needs a pending-call map — it carries no action name.
- Why every pending entry needs a timeout, and what happens over a fortnight
  if it does not.
- Why a malformed frame produces a `CALLERROR` rather than closing the socket.
- What each OCPP error code means and when to use which.
- Why `BootNotification` is allowed before boot and nothing else is.

> **A good interview answer.** "A CALLRESULT has no action field, so you cannot
> know what it answers without remembering what you sent. I keep a Map from
> message id to the pending promise, with a 30-second timeout that rejects and
> deletes the entry — otherwise a station that accepts and never replies leaks
> an entry per call, and you find out two weeks later when the process is out
> of memory."

---

Next: **[Milestone 4 — data model →](milestone-04-data-model.md)**
