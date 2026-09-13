# Build the simulator

**Goal:** a program that pretends to be a charge point, well enough that your
CPMS cannot tell the difference.

**Time:** 6–8 hours across four milestones.

**Endpoints:** 13 — the `sim` service, base path `/sim/v1`, port **3100**.

---

## Why you build this too

Two reasons, and the second is the real one.

**You need a test rig.** You cannot plug a 22 kW charger into your desk. Every
"prove it works" section in the CPMS curriculum needs something on the other end
of the WebSocket, and `wscat` stops being enough at about Milestone 3 — you
cannot hand-type a `StopTransaction` with the right transaction id forty times.

**Writing the other side is how you actually learn the protocol.** Handling a
message teaches you its shape. *Producing* one teaches you why the field is
there. You will not forget that `meterStart` exists after you have had to decide
what number to put in it, and the first time your own CSMS rejects your own
station's payload, you will have learned more about OCPP than any specification
reading session delivers.

This is also why the simulator is a **separate service with its own UI**, and
why keeping it separate matters:

> The simulator knows nothing about your CPMS's database. It talks to it only
> over OCPP, exactly as hardware does.

If you build it as a feature inside the CPMS you will take a shortcut — reading
session state from the database instead of from the messages — and then you have
tested nothing. Keep them apart and the simulator becomes a genuine conformance
tool.

```
┌────────────────────┐                        ┌────────────────────┐
│  simulator UI      │  HTTP /sim/v1          │  dashboard         │
│  localhost:5174    │ ───────────┐           │  localhost:5173    │
└────────────────────┘            │           └─────────┬──────────┘
                                  ▼                     │ HTTP /api/v1
                       ┌────────────────────┐           ▼
                       │  SIMULATOR service │  ┌────────────────────┐
                       │  localhost:3100    │  │  YOUR CPMS         │
                       │                    │  │  localhost:3000    │
                       │  N virtual         │  │                    │
                       │  stations, each    │──┼─► WebSocket        │
                       │  with its own      │  │   /ocpp/:identity  │
                       │  WebSocket client  │  │                    │
                       └────────────────────┘  └────────────────────┘
                                     OCPP — the only thing between them
```

---

## When to build it

| You are at | Do this |
|---|---|
| Milestones 0–2 | `wscat` is fine. Come back later. |
| **After Milestone 3** | **Build S0–S2 now.** Your CSMS can answer a CALL, so a real station client becomes useful immediately. |
| Milestone 5 | You need S3 (the charging model) to run a full session. |
| Milestone 6 | S2's remote-command handling is what makes commands testable. |
| Milestone 10 | S3's charging-profile clamping. Without it you cannot test load management. |
| Any time after | S4, the scenario runner. It turns all of the above into a regression suite. |

The milestones below are numbered **S0–S4** so they never get confused with the
CPMS ones.

| | Milestone | You get | Endpoints |
|---|---|---|---|
| **S0** | [Service skeleton](#s0) | The service the UI talks to | 1 |
| **S1** | [A station that connects](#s1) | Boot, heartbeat, the frame log | 7 |
| **S2** | [Physical actions](#s2) | Plug in, swipe, charge — and answering commands | 2 |
| **S3** | [The charging model](#s3) | Meter values, taper, profile clamping | — |
| **S4** | [Scenarios](#s4) | A regression suite | 5 |

> **The same stack as the CPMS.** Node, Fastify, `ws`, Zod from
> `@ocpp/contracts`. No database — the simulator's state is in memory and
> *should* be: a virtual charge point that survives a restart is not simulating
> anything real.

---

<a id="s0"></a>

## S0 — The service skeleton

**Endpoint:** `simHealth`.

```ts
// src/index.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SimHealthSchema } from '@ocpp/contracts';

const app = Fastify({ logger: true });

/**
 * CORS matters here in a way it does not for the CPMS.
 *
 * The simulator UI runs on :5174 and calls :3100 — a cross-origin request from
 * the first line of code. Forget this and every call fails in the browser with
 * an error that says nothing about CORS, while curl works perfectly.
 */
await app.register(cors, { origin: ['http://localhost:5174'], credentials: true });

app.get('/sim/v1/health', async () => ({
  status: 'ok',
  version: '0.1.0',
  stationCount: stations.size,
  connectedCount: [...stations.values()].filter((s) => s.connectionState === 'connected').length,
  // The UI pre-fills new stations with this, so you set the CSMS address once.
  defaultCsmsUrl: process.env.DEFAULT_CSMS_URL ?? 'ws://localhost:3000/ocpp',
}));

await app.listen({ port: 3100, host: '0.0.0.0' });
```

**Prove it:** start the simulator UI (`npm run dev:simulator`, port 5174). The
backend badge in its header turns green and stops saying "mock".

---

<a id="s1"></a>

## S1 — A station that connects

**Endpoints:** `listSimStations`, `getSimStation`, `createSimStation`,
`updateSimStation`, `deleteSimStation`, `simFrames`, plus the realtime channel.

### The station object

```ts
// src/station.ts
import WebSocket from 'ws';

/**
 * One virtual charge point.
 *
 * Note what this class owns: a socket, a state machine, and a pending-call
 * map. It is the mirror image of the CPMS's `Connection` from Milestone 2 —
 * the same problem seen from the other end of the wire, which is why building
 * it teaches you so much.
 */
export class VirtualStation {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  /** Calls WE sent, waiting for the CSMS's answer. Same map, other direction. */
  private pending = new Map<string, PendingCall>();

  connect() {
    /**
     * The identity goes in the PATH, and it must be URL-encoded.
     *
     * Real stations have identities like `CP/001` and `Acme Charger #2`. A
     * naive template string produces a path that either 404s or, worse,
     * silently connects as a different station. This is a real
     * interoperability bug, not a theoretical one.
     */
    const url = `${this.csmsUrl.replace(/\/$/, '')}/${encodeURIComponent(this.identity)}`;

    this.socket = new WebSocket(url, [this.protocol], {
      /**
       * Security profile 1/2 is HTTP Basic on the handshake, and this is the
       * one place a WebSocket client CAN set a header — the upgrade is an
       * ordinary HTTP request. (Browsers cannot; `ws` on Node can, which is
       * one reason a real station is not a browser.)
       *
       * `password` is internal state, not part of the sim contract — add it
       * when you reach CPMS Milestone 13 and your gateway starts demanding
       * credentials. Until then it is undefined and this header is omitted.
       */
      headers: this.password
        ? { authorization: 'Basic ' + Buffer.from(`${this.identity}:${this.password}`).toString('base64') }
        : undefined,
      handshakeTimeout: 10_000,
    });

    this.socket.on('open', () => {
      /**
       * VERIFY THE NEGOTIATED SUBPROTOCOL. Do not assume.
       *
       * If the CSMS echoes nothing, `ws` leaves `protocol` empty and you are
       * talking to a server that did not agree to speak OCPP. Real firmware
       * disconnects here. Simulating that is the point — it is exactly the bug
       * Milestone 2 warns about, seen from the side that suffers it.
       */
      if (this.socket!.protocol !== this.protocol) {
        this.fail(`CSMS did not accept ${this.protocol}`);
        return;
      }
      this.reconnectAttempt = 0;
      this.setState('connected');
      void this.sendBootNotification();
    });

    this.socket.on('message', (raw) => this.onMessage(raw.toString()));
    this.socket.on('close', (code, reason) => this.onClose(code, reason.toString()));
    this.socket.on('error', (err) => this.fail(err.message));
  }

  /**
   * Reconnect with exponential backoff AND jitter.
   *
   * The jitter is not decoration. Create fifty virtual stations, restart your
   * CPMS, and without jitter all fifty reconnect on the same millisecond —
   * you will have built yourself the thundering herd the deployment chapter
   * warns about, and it is a genuinely useful thing to be able to reproduce
   * on demand.
   */
  private scheduleReconnect() {
    const base = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt++);
    const delay = base * (0.5 + Math.random() * 0.5);   // full jitter
    this.setState('reconnecting');
    setTimeout(() => this.connect(), delay);
  }
}
```

### Framing, from the other side

You already wrote this once, in CPMS Milestone 3. Write it again facing the
other way — it is thirty lines and the symmetry is the lesson.

```ts
// src/framing.ts

/**
 * The one asymmetry worth noticing.
 *
 * The CPMS answers CALLs and occasionally sends them. A station sends CALLs
 * constantly and answers a handful. So the station's hot path is the PENDING
 * MAP, where the CPMS's hot path is the handler table.
 *
 * Everything else — the four message types, the id correlation, the timeout —
 * is identical, because OCPP is symmetric once the socket is open.
 */
private async onMessage(text: string) {
  this.logFrame({ direction: 'inbound', raw: text });

  const frame = JSON.parse(text);
  switch (frame[0]) {
    case 2: return this.handleCall(frame[1], frame[2], frame[3]);
    case 3: return this.settle(frame[1], { ok: true, payload: frame[2] });
    case 4: return this.settle(frame[1], { ok: false, code: frame[2], description: frame[3] });
  }
}
```

### The frame log

```ts
/**
 * `outbound` means "from this station to the CSMS".
 *
 * THE OPPOSITE of the CPMS's frame log, where `inbound` means "into the
 * CSMS". Both are correct from their own point of view, and the contract says
 * so in both files. Get it backwards here and the simulator's wire log reads
 * as a mirror of the dashboard's, which is confusing in a way that takes a
 * surprisingly long time to notice.
 */
private logFrame(input: { direction: 'inbound' | 'outbound'; raw: string }) {
  const parsed = safeParse(input.raw);
  const frame: SimFrame = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    stationId: this.id,
    stationIdentity: this.identity,
    protocol: this.protocol,
    direction: input.direction,
    messageTypeId: parsed?.[0] ?? 2,
    messageId: parsed?.[1] ?? '',
    action: typeof parsed?.[2] === 'string' ? parsed[2] : null,
    payload: parsed?.[3] ?? parsed?.[2] ?? null,
    raw: input.raw,
    errorCode: parsed?.[0] === 4 ? String(parsed[2]) : null,
    errorDescription: parsed?.[0] === 4 ? String(parsed[3]) : null,
    durationMs: this.durationFor(parsed?.[1]),
  };

  // A ring buffer, not an array you push to forever. A station left running
  // overnight at one frame a second is 86,400 objects; ten stations is a leak
  // that ends in an OOM at 3am for no reason anyone will enjoy diagnosing.
  frames.push(frame);
  if (frames.length > 5000) frames.splice(0, frames.length - 5000);

  bus.publish({ type: 'sim.frame', at: frame.timestamp, data: frame });
}
```

### BootNotification, both versions

```ts
// src/messages/boot.ts

/**
 * Same event, two shapes. Writing the SENDING side of both is the fastest way
 * to internalise the difference you spent CPMS Milestone 7 handling.
 */
private bootPayload() {
  if (this.protocol === 'ocpp1.6') {
    return {
      chargePointVendor: this.vendor,          // flat, prefixed field names
      chargePointModel: this.model,
      chargePointSerialNumber: this.serialNumber,
      firmwareVersion: this.firmwareVersion,
    };
  }
  return {
    reason: this.bootReason,                   // REQUIRED in 2.0.1, absent from 1.6
    chargingStation: {                         // nested, unprefixed
      vendorName: this.vendor,
      model: this.model,
      serialNumber: this.serialNumber,
      firmwareVersion: this.firmwareVersion,
    },
  };
}

private async sendBootNotification() {
  const response = await this.call('BootNotification', this.bootPayload());

  /**
   * Obey the interval the CSMS gives you. Do not keep your own.
   *
   * This is the field almost every homemade simulator ignores, and ignoring it
   * means you never test the one lever a CPMS has over its fleet's message
   * rate. If your CSMS answers `interval: 60`, heartbeat every 60 seconds.
   */
  this.heartbeatIntervalSeconds = response.interval ?? this.heartbeatIntervalSeconds;

  switch (response.status) {
    case 'Accepted':
      this.booted = true;
      this.startHeartbeat();
      // Real firmware reports every connector's state right after boot, so
      // the CSMS knows what it is looking at. Simulate it.
      for (const connector of this.connectors) await this.sendStatusNotification(connector);
      break;

    case 'Pending':
      /**
       * `Pending` means "I know you, but I am not ready". The station may then
       * send ONLY BootNotification, Heartbeat and StatusNotification until it
       * is accepted — and must retry the boot after `interval` seconds.
       *
       * Simulating this properly is what lets you test your CPMS's
       * provisioning flow, which is otherwise very hard to exercise.
       */
      this.booted = false;
      setTimeout(() => void this.sendBootNotification(), this.heartbeatIntervalSeconds * 1000);
      break;

    case 'Rejected':
      // Rejected means go away and retry no sooner than `interval`. It does
      // NOT mean close the socket — a rejected station stays connected.
      this.booted = false;
      setTimeout(() => void this.sendBootNotification(), Math.max(60, response.interval) * 1000);
      break;
  }
}
```

**Prove it:** create a station in the UI, press **Connect**, and watch your
CPMS log a BootNotification. Then stop your CPMS and watch the reconnect delays
grow in the simulator's log — 1s, 2s, 4s, each with jitter. Start it again and
the station comes back on its own.

---

<a id="s2"></a>

## S2 — Physical actions and remote commands

**Endpoints:** `simAction`, and the command handling that makes CPMS Milestone 6
testable.

### Model physical events, not messages

This is the design decision that makes the simulator worth using.

```ts
// src/actions.ts

/**
 * The action list is PHYSICAL where a physical event exists.
 *
 * `plug_in` is a thing that happens in the world; the StatusNotification is a
 * consequence of it. Exposing "send StatusNotification" as the primary control
 * would let you put the station into states that cannot physically occur —
 * Charging with no cable attached — and then you are testing a fantasy.
 *
 * The raw senders exist too, under a separate group in the UI, for when you
 * deliberately want to poke one message at your CSMS. Both are useful; only
 * one is the default.
 */
export async function performAction(station: VirtualStation, request: SimActionRequest) {
  switch (request.action) {
    case 'plug_in': {
      const connector = station.connector(request.connectorId ?? 1);
      connector.cablePluggedIn = true;
      // The causal chain, in order. This is what real hardware does.
      await station.setConnectorStatus(connector, 'preparing');
      // 1.6 reports Preparing; 2.0.1 reports Occupied + EVConnected. The
      // station object handles that split — same call, two wires.
      break;
    }

    case 'swipe_card': {
      const idToken = request.idToken ?? station.defaultIdToken;
      const decision = await station.sendAuthorize(idToken);

      /**
       * ACT ON THE ANSWER. A simulator that swipes and then starts charging
       * regardless is not testing your authorization logic at all — and
       * authorization is the thing most likely to be wrong.
       */
      if (decision !== 'Accepted') {
        station.log('warn', `Card ${idToken} rejected: ${decision}`);
        return { accepted: false, message: `Card rejected: ${decision}` };
      }
      if (station.connector(request.connectorId ?? 1).cablePluggedIn) {
        await station.startTransaction(request.connectorId ?? 1, idToken);
      }
      break;
    }

    case 'plug_out': {
      const connector = station.connector(request.connectorId ?? 1);
      /**
       * Unplugging during a transaction STOPS it, with reason
       * `EVDisconnected`. Getting this right is what makes your CPMS's
       * stop-reason handling testable, and it is the single most common way a
       * real session ends.
       */
      if (connector.transactionId) {
        await station.stopTransaction(connector, 'EVDisconnected');
      }
      connector.cablePluggedIn = false;
      await station.setConnectorStatus(connector, 'available');
      break;
    }

    case 'disconnect':
      /**
       * Close the socket WITHOUT stopping the transaction.
       *
       * This is the offline case, and the whole point is that the car keeps
       * charging while the link is down. The station buffers its messages and
       * replays them on reconnect — see the buffer below. If `disconnect`
       * also ended the session you could never test the replay path, which is
       * the most valuable thing this simulator does.
       */
      station.goOffline();
      break;

    case 'reboot':
      // Close, wait, reconnect, and send BootNotification with reason
      // `LocalReset` (2.0.1). This is the effect your CPMS correlates a
      // `reset` command against in Milestone 6.
      await station.reboot('LocalReset');
      break;

    case 'send_raw':
      // Straight onto the wire, unvalidated, exactly as given. This is how you
      // test your CSMS's error handling — malformed frames, unknown actions,
      // duplicate message ids, a CALLRESULT for a call nobody made.
      station.sendRaw(JSON.stringify(request.raw));
      break;
  }
}
```

### The offline buffer

```ts
/**
 * What a real charge point does when it cannot reach the CSMS.
 *
 * It keeps charging — the electricity does not depend on the network — and
 * queues its messages with their ORIGINAL timestamps. On reconnect it replays
 * them in order.
 *
 * This is the single most valuable behaviour to simulate, because it is the
 * one your CPMS is most likely to get wrong, and the bug (stamping messages
 * with arrival time) is invisible until you test exactly this.
 */
private queue: Array<{ action: string; payload: unknown; queuedAt: Date }> = [];

private send(action: string, payload: unknown) {
  if (this.socket?.readyState !== WebSocket.OPEN) {
    // The timestamp is captured NOW, not at replay time.
    this.queue.push({ action, payload, queuedAt: new Date() });
    // Bounded, like real firmware: a station offline for a week does not have
    // infinite flash. Dropping the oldest is what most vendors do.
    if (this.queue.length > 1000) this.queue.shift();
    return;
  }
  this.socket.send(encodeCall(randomUUID(), action, payload));
}

private async replayQueue() {
  const queued = this.queue.splice(0);
  this.log('info', `replaying ${queued.length} buffered messages`);
  for (const item of queued) {
    // 2.0.1 has a flag for this. 1.6 has nothing, which is why 1.6 CSMSs must
    // infer it from the timestamps — and why they so often do not.
    const payload = this.protocol === 'ocpp2.0.1'
      ? { ...(item.payload as object), offline: true }
      : item.payload;
    await this.call(item.action, payload);
  }
}
```

### Answering the CPMS's commands

```ts
/**
 * The station side of CPMS Milestone 6. Two rules:
 *
 *  1. Answer the CALL immediately with Accepted/Rejected. That answer means
 *     "I will try", nothing more.
 *  2. Produce the EFFECT afterwards, on a delay. A station that starts
 *     charging in the same tick as its Accepted teaches your CPMS that the
 *     two are simultaneous — and then your CPMS is wrong about real hardware.
 */
private async handleCall(messageId: string, action: string, payload: any) {
  if (this.faults.ignoreRemoteCommands) return;          // test the CALL timeout
  if (this.faults.respondWithErrors) {
    return this.sendError(messageId, 'InternalError', 'Injected fault');
  }
  if (this.faults.responseDelayMs) await sleep(this.faults.responseDelayMs);

  switch (action) {
    case 'RemoteStartTransaction':
    case 'RequestStartTransaction': {
      const connectorId = payload.connectorId ?? payload.evseId ?? 1;
      const connector = this.connector(connectorId);

      // Reject what real firmware rejects: a busy connector.
      if (connector.transactionId) {
        return this.sendResult(messageId, { status: 'Rejected' });
      }

      this.sendResult(messageId, { status: 'Accepted' });

      /**
       * THEN, seconds later, the effect — and only if the cable is in.
       *
       * If it is not, nothing happens at all, which is exactly right: the
       * driver was asked to plug in and did not. That produces the `accepted`
       * command that never reaches `succeeded`, and it is the behaviour
       * Milestone 6 asks you to demonstrate.
       */
      setTimeout(() => {
        if (!connector.cablePluggedIn) {
          this.log('info', 'remote start accepted but no cable — nothing to do');
          return;
        }
        const idToken = payload.idTag ?? payload.idToken?.idToken;
        void this.startTransaction(connectorId, idToken, {
          remoteStartId: payload.remoteStartId,   // 2.0.1: echoed on every event
        });
      }, 2000 + Math.random() * 2000);
      return;
    }

    case 'Reset': {
      this.sendResult(messageId, { status: 'Accepted' });
      const immediate = payload.type === 'Hard' || payload.type === 'Immediate';
      setTimeout(() => {
        // "On idle" waits for the transaction to finish. Implementing the
        // difference is what makes your CPMS's reset semantics testable.
        if (!immediate && this.hasActiveTransaction()) {
          this.pendingReset = true;
          return;
        }
        void this.reboot(immediate ? 'RemoteReset' : 'ScheduledReset');
      }, 1000);
      return;
    }

    case 'UnlockConnector': {
      const connector = this.connector(payload.connectorId ?? 1);
      // Real stations refuse to unlock a cable with current flowing. So does
      // this one — and the status value is `UnlockFailed`, NOT `Rejected`.
      return this.sendResult(messageId, {
        status: connector.transactionId ? 'UnlockFailed' : 'Unlocked',
      });
    }

    case 'GetConfiguration':
      return this.sendResult(messageId, {
        configurationKey: this.configurationKeys(payload.key),
        // 1.6 returns keys it did not recognise separately. Populating this
        // is how your CPMS's configuration screen learns to show them.
        unknownKey: (payload.key ?? []).filter((k: string) => !this.hasKey(k)),
      });

    case 'ChangeConfiguration': {
      if (this.readonlyKeys.has(payload.key)) {
        return this.sendResult(messageId, { status: 'Rejected' });
      }
      this.configuration.set(payload.key, payload.value);
      // Some keys only take effect after a restart, and the protocol has a
      // status saying exactly that. Model at least one — HeartbeatInterval is
      // a good choice because its effect is observable.
      return this.sendResult(messageId, {
        status: this.rebootRequiredKeys.has(payload.key) ? 'RebootRequired' : 'Accepted',
      });
    }

    default:
      // Unknown action → NotImplemented. Same rule as the CPMS, same reason.
      return this.sendError(messageId, 'NotImplemented', `${action} not supported`);
  }
}
```

**Prove it:** send a remote start from the **dashboard** with the cable
unplugged. The simulator answers `Accepted`; nothing charges; the dashboard
command stays amber. Press **Plug in cable** and it goes green. You have just
tested the most commonly misunderstood behaviour in OCPP, with both halves of
it code you wrote.

---

<a id="s3"></a>

## S3 — The charging model

No new endpoints. This is what makes meter values, smart charging and prepaid
budgets testable.

```ts
// src/charging.ts

/**
 * Advance one connector's meter by one tick.
 *
 * Three behaviours, each of which exists to make a CPMS feature testable:
 *
 *  1. The meter is CUMULATIVE and never resets. It is an odometer. This is
 *     what makes `energy = meterStop − meterStart` a real test rather than a
 *     tautology — start a second session on the same connector and a CPMS
 *     that bills the raw reading will bill the first session again.
 *
 *  2. Power TAPERS as the battery fills, like a real car. Constant power is
 *     both unrealistic and useless for testing load management, which is
 *     supposed to allocate against actual draw.
 *
 *  3. The charging profile CLAMPS it. Without this your CPMS's
 *     SetChargingProfile is accepted and has no observable effect, and you
 *     cannot tell a working load manager from a broken one.
 */
export function advanceMeter(connector: SimConnector, station: VirtualStation, seconds: number) {
  if (connector.status !== 'charging') {
    connector.powerKw = 0;
    return;
  }

  // 1. What the car is willing to take right now.
  const soc = connector.soc ?? 20;
  const taper = taperFactor(soc);
  const carDemandKw = station.chargingPowerKw * taper;

  // 2. What the hardware can deliver.
  const hardwareLimitKw = connector.maxPowerKw;

  // 3. What the CSMS has allowed. The lowest applicable profile wins — which
  //    is the rule CPMS Milestone 10 explains, implemented on the side that
  //    has to obey it.
  const profileLimitKw = station.activeLimitKw(connector) ?? Infinity;

  const actualKw = Math.min(carDemandKw, hardwareLimitKw, profileLimitKw);

  connector.powerKw = round(actualKw, 2);
  connector.meterWh += (actualKw * 1000 * seconds) / 3600;

  // A 60 kWh battery, so the SoC moves at a believable rate.
  if (connector.soc != null) {
    connector.soc = Math.min(100, connector.soc + (actualKw * seconds) / 3600 / 60 * 100);
  }

  /**
   * A full battery stops the session, reason `EVDisconnected` — which is what
   * most cars actually report. Without this, sessions run forever and you
   * never exercise your CPMS's natural-end path.
   */
  if ((connector.soc ?? 0) >= 100) {
    void station.stopTransaction(connector, 'EVDisconnected');
  }
}

/**
 * The taper curve. Roughly what a real EV does: flat to 80%, then falls off a
 * cliff to protect the cells.
 *
 * Deliberately crude. It does not need to be accurate — it needs to be
 * NON-CONSTANT, so that "allocate against actual draw" and "allocate against
 * connector rating" produce visibly different answers in your load manager.
 */
function taperFactor(soc: number): number {
  if (soc < 80) return 1;
  if (soc < 90) return 0.5;
  return 0.2;                 // ~5 kW on a station set to 22 kW
}
```

```ts
/**
 * Which profile actually applies.
 *
 * The rule is: the MOST RESTRICTIVE of all applicable profiles, with
 * stackLevel breaking ties within a purpose — never across purposes. Ten lines
 * here, and implementing them is how you find out whether you understood
 * Milestone 10 or only read it.
 */
activeLimitKw(connector: SimConnector): number | null {
  const applicable = this.profiles.filter((p) =>
    (p.evseId === 0 || p.evseId === connector.evseId) &&
    (!p.validFrom || new Date(p.validFrom) <= new Date()) &&
    (!p.validTo || new Date(p.validTo) > new Date()) &&
    (p.purpose !== 'TxProfile' || p.transactionId === connector.transactionId));

  if (applicable.length === 0) return null;

  // Winner per purpose: highest stackLevel.
  const byPurpose = new Map<string, ChargingProfile>();
  for (const p of applicable) {
    const current = byPurpose.get(p.purpose);
    if (!current || p.stackLevel > current.stackLevel) byPurpose.set(p.purpose, p);
  }

  // Then the most restrictive across purposes. A TxProfile does NOT let you
  // exceed a ChargePointMaxProfile, which is the part people get wrong.
  return Math.min(...[...byPurpose.values()].map((p) => currentPeriodLimitKw(p)));
}
```

And the tick loop:

```ts
/**
 * One interval for everything, not one per connector.
 *
 * Fifty stations × four connectors is 200 timers if you do it the other way,
 * and Node's timer heap becomes measurable. One tick, iterate, done — and it
 * also means every station's meter advances against the same clock, which
 * makes the numbers in your CPMS reproducible.
 */
setInterval(() => {
  for (const station of stations.values()) {
    for (const connector of station.connectors) {
      advanceMeter(connector, station, 1);
    }
    station.maybeSendMeterValues();     // respects meterValueIntervalSeconds
  }
}, 1000);
```

**Prove it:** run a full session and check the dashboard's session chart. Power
should be flat, then step down twice as the SoC climbs. Then set a 7 kW
charging profile from the dashboard and watch it clamp within one meter-value
interval.

---

<a id="s4"></a>

## S4 — Scenarios

**Endpoints:** `listScenarios`, `runScenario`, `getRun`, `listRuns`, `abortRun`.

A scenario is a scripted sequence of actions with assertions on what your CSMS
replied. This is what turns the simulator from a toy into a regression suite:
after every backend change, run all eight and see what broke.

The eight built into the UI's fixtures, which are the ones to implement:

| Scenario | Tests |
|---|---|
| Boot and heartbeat | Milestone 3 |
| A complete charge, start to finish | Milestone 5 |
| Remote start from the app | Milestone 6 |
| Prepaid charge, card declined | Milestone 11 |
| Station goes offline mid-charge | offline replay |
| Connector faults and recovers | error handling |
| Prepaid energy cap | Milestone 11's budget watchdog |
| Station sends rubbish | your validation |

```ts
// src/runner.ts

/**
 * Run a scenario step by step, asserting as it goes.
 *
 * The assertion reads a dot path out of the CSMS's RESPONSE — for example
 * `idTagInfo.status` equals `Accepted`. That is deliberately narrow: a
 * scenario asserts on what came back over the wire, never on your CPMS's
 * database. The moment a test reaches into the system under test's storage it
 * stops being a conformance test.
 */
export async function runScenario(scenario: SimScenario, station: VirtualStation, speed: number) {
  const run: SimRun = { /* … */ status: 'running', steps: scenario.steps.map(toPending) };
  runs.set(run.id, run);

  for (const [index, step] of scenario.steps.entries()) {
    const result = run.steps[index];

    if (run.status === 'aborted') {
      // Everything after an abort is `skipped`, not `failed`. A run the
      // operator stopped is not a failing run, and conflating the two makes
      // the results useless.
      result.status = 'skipped';
      continue;
    }

    if (step.delayMsBefore) await sleep(step.delayMsBefore / speed);

    result.status = 'running';
    result.startedAt = new Date().toISOString();
    publish(run);

    try {
      const outcome = await performAction(station, step);
      result.request = outcome.request;
      result.response = outcome.response;
      result.messageId = outcome.messageId;

      if (step.expect) {
        const actual = dotPath(outcome.response, step.expect.field);
        const passed = step.expect.exists
          ? actual !== undefined
          : String(actual) === String(step.expect.equals);

        result.assertion = {
          passed,
          expected: String(step.expect.equals ?? 'exists'),
          // Record the ACTUAL value even when it passes. A run you can only
          // read when it fails is half a diagnostic.
          actual: String(actual),
        };
        result.status = passed ? 'passed' : 'failed';
      } else {
        result.status = 'passed';
      }
    } catch (err) {
      result.status = 'failed';
      result.error = String(err);
    }

    result.finishedAt = new Date().toISOString();
    publish(run);

    /**
     * Keep going after a failure. Do not stop the run.
     *
     * One broken assertion in the middle should not hide the six steps after
     * it — you want the whole picture in one pass, because re-running takes a
     * minute and attention is the scarce resource when you are debugging.
     */
  }

  run.status = run.steps.some((s) => s.status === 'failed') ? 'failed' : 'passed';
  run.finishedAt = new Date().toISOString();
  publish(run);
  return run;
}
```

**Prove it:** open the simulator's **Scenarios** page and run "A complete charge,
start to finish" against a 1.6 station, then the same scenario against a 2.0.1
station. Both should pass green, against the same CPMS, with completely
different messages on the wire.

**That screenshot is the single best artefact this project produces.** One
scenario, two protocols, one backend, all green.

---

## What you can now explain

- Why a simulator must be a separate process that talks only OCPP.
- Why the actions are physical events rather than messages, and what you lose
  by modelling it the other way.
- What a station does when it cannot reach the CSMS, and why the timestamps in
  the replay are the ones that matter.
- Why `Accepted` and the effect must be separated by a delay in the simulator
  too — and what a CPMS learns wrongly if they are not.
- How a station decides which charging profile limit applies.
- Why a conformance test asserts on the wire and never on the database.

---

You now have both sides of the protocol, written by you, disagreeing with each
other until they do not. That is what "I know OCPP" actually means.

---

Back to: **[The milestone index →](../03-build-the-backend/README.md)** ·
**[Interview prep →](../07-interview-prep.md)**
