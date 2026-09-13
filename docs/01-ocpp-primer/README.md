# The OCPP primer

Forty minutes that will save you days. Read it once now, come back to it when a
milestone confuses you.

- [1. What OCPP actually is](#1-what-ocpp-actually-is)
- [2. The connection](#2-the-connection)
- [3. The message framing](#3-the-message-framing)
- [4. The conversation](#4-the-conversation)
- [5. The five things that trip everyone up](#5-the-five-things-that-trip-everyone-up)
- [6. Where to go next](#6-where-to-go-next)

---

## 1. What OCPP actually is

**Open Charge Point Protocol.** A published, royalty-free standard from the
Open Charge Alliance that lets any charger talk to any management system.

Before it, every manufacturer had its own protocol, so buying chargers meant
buying their software too. OCPP is why you can put an ABB charger and an Alfen
charger on the same site and manage both from one screen.

Two versions matter:

| | OCPP 1.6J | OCPP 2.0.1 |
|---|---|---|
| Published | 2015 | 2020 |
| In the field | The large majority of chargers | Growing, mandated in new EU tenders |
| Transport | WebSocket + JSON | WebSocket + JSON |
| Messages | 29 | 64 |
| Killer feature | It is everywhere | Plug & Charge, a real device model, security in the core |

**You must support both.** 1.6 hardware will be in service for another decade;
2.0.1 is what new procurement asks for. Supporting one is a toy; supporting
both, from one codebase, is the actual engineering problem — and it is the
thing worth talking about in an interview.

> The "J" in 1.6J means JSON-over-WebSocket. There is also 1.6S (SOAP), which
> you will meet on very old hardware and should politely decline to support.

---

## 2. The connection

### The station dials you, not the other way round

This is the first thing to internalise, and it explains most of the
architecture that follows.

A charger sits behind a 4G modem or an office firewall. It has no public
address and nothing can dial in to it. So **the charger opens the connection**,
to you, and holds it open — for months. Every message in both directions rides
that one socket.

```
Charger                                                    Your CSMS
   │                                                            │
   │  GET /ocpp/CP-AMS-0001  HTTP/1.1                           │
   │  Upgrade: websocket                                        │
   │  Sec-WebSocket-Protocol: ocpp1.6                           │
   ├───────────────────────────────────────────────────────────►│
   │                                                            │
   │  HTTP/1.1 101 Switching Protocols                          │
   │  Sec-WebSocket-Protocol: ocpp1.6                           │
   │◄───────────────────────────────────────────────────────────┤
   │                                                            │
   │  ══════════ one socket, open for months ══════════════════ │
```

Three things happen in that handshake, and all three matter:

**The URL carries the identity.** The last path segment — `CP-AMS-0001` — is
how the station says who it is, before a single message is exchanged. There is
no login step. Your server reads it out of the URL.

**The subprotocol header selects the version.** The client offers
`Sec-WebSocket-Protocol: ocpp1.6` or `ocpp2.0.1`, and your server must **echo
back the one it accepts**. If you do not echo it, well-behaved clients close
the connection immediately. This one line is the most common reason a first
CSMS never sees a message.

**Nothing has been authenticated yet.** That is what security profiles are for
(Milestone 13). At profile 0 — lab only — anyone who knows the URL can connect.

### Consequences you have to design around

Because the station dials you and stays connected:

- **Your gateway is stateful.** The socket for `CP-AMS-0001` lives in one
  process's memory. To send that station a command, the request must reach
  *that* process. This is the single biggest constraint on scaling a CPMS, and
  [the scaling guide](../06-scaling/README.md) is mostly about it.
- **Connections outlive deploys.** Restart your server and 500 chargers
  reconnect at once. Without jittered backoff on their side and rate limiting
  on yours, you get a thundering herd.
- **Silence is ambiguous.** A socket that has said nothing for ten minutes
  might be idle, or the station might have vanished without a close frame.
  Heartbeats exist to disambiguate, and TCP will happily keep a dead socket
  "open" for a long time.

---

## 3. The message framing

OCPP-J is JSON-RPC with a specific array shape. The whole framing protocol is
four message types, distinguished by the number at index 0.

### CALL — a request (type 2)

```json
[2, "19223201", "BootNotification", {"chargePointVendor":"Alfen","chargePointModel":"Eve Single Pro"}]
 │       │              │                               │
 │       │              │                               └── payload
 │       │              └────────────────────────────────── action name
 │       └───────────────────────────────────────────────── unique message id
 └───────────────────────────────────────────────────────── 2 = CALL
```

### CALLRESULT — a successful reply (type 3)

```json
[3, "19223201", {"status":"Accepted","currentTime":"2026-09-13T14:22:03Z","interval":300}]
 │       │                                    │
 │       │                                    └── payload
 │       └─────────────────────────────────────── the SAME message id
 └─────────────────────────────────────────────── 3 = CALLRESULT
```

> **Notice what is missing: the action name.** A CALLRESULT does not say what
> it is a result *of*. The only way to know is to remember which action you
> sent with that message id.
>
> This is why your gateway needs a **pending-call map** — message id → the
> request that is waiting — and why every entry needs a **timeout**. Forget the
> timeout and the map grows forever; that is a real memory leak that only shows
> up after a fortnight in production.

### CALLERROR — a failed reply (type 4)

```json
[4, "19223201", "FormationViolation", "connectorId must be an integer", {}]
```

The error codes are a fixed list: `NotImplemented`, `NotSupported`,
`InternalError`, `ProtocolError`, `SecurityError`, `FormationViolation`,
`PropertyConstraintViolation`, `OccurrenceConstraintViolation`,
`TypeConstraintViolation`, `GenericError`. Return the right one — a field
engineer reading the station's own log has nothing else to go on.

### Both sides can start a conversation

The station sends you `BootNotification`; you send it `RemoteStartTransaction`.
Same framing, same socket, opposite direction. Your gateway is simultaneously a
server (handling their calls) and a client (making yours). That symmetry is
worth building deliberately rather than bolting the outbound half on later.

---

## 4. The conversation

Here is a complete charge, in OCPP 1.6. Read it once; this single diagram is
most of what you need.

```
Charger                                                         CSMS
   │                                                              │
   │  ① BootNotification {vendor, model, firmwareVersion}         │
   ├─────────────────────────────────────────────────────────────►│
   │◄─────────────────────────────────────────────────────────────┤
   │     {status: "Accepted", currentTime, interval: 300}          │
   │     "You may operate. Here is the time. Beat every 300s."     │
   │                                                              │
   │  ② StatusNotification {connectorId: 1, status: "Available"}  │
   ├─────────────────────────────────────────────────────────────►│
   │                                                              │
   │  ══ idle, heartbeats every 300s ═══════════════════════════  │
   │                                                              │
   │              🚗  a driver arrives and plugs in                │
   │                                                              │
   │  ③ StatusNotification {connectorId: 1, status: "Preparing"}  │
   ├─────────────────────────────────────────────────────────────►│
   │                                                              │
   │              💳  the driver presents a card                   │
   │                                                              │
   │  ④ Authorize {idTag: "04A1B2C3"}                             │
   ├─────────────────────────────────────────────────────────────►│
   │◄─────────────────────────────────────────────────────────────┤
   │     {idTagInfo: {status: "Accepted"}}                         │
   │                                                              │
   │  ⑤ StartTransaction {connectorId, idTag, meterStart, ts}     │
   ├─────────────────────────────────────────────────────────────►│
   │◄─────────────────────────────────────────────────────────────┤
   │     {transactionId: 48213, idTagInfo: {status: "Accepted"}}   │
   │     ↑ YOU allocate this number, in 1.6                        │
   │                                                              │
   │  ⑥ StatusNotification {connectorId: 1, status: "Charging"}   │
   ├─────────────────────────────────────────────────────────────►│
   │                                                              │
   │  ⑦ MeterValues {transactionId: 48213, ...}   every 60s       │
   ├─────────────────────────────────────────────────────────────►│
   │  ⑦ MeterValues ...                                           │
   ├─────────────────────────────────────────────────────────────►│
   │                                                              │
   │              🔌  the driver unplugs                           │
   │                                                              │
   │  ⑧ StopTransaction {transactionId, meterStop, ts, reason}    │
   ├─────────────────────────────────────────────────────────────►│
   │◄─────────────────────────────────────────────────────────────┤
   │     {}                    ← now you can bill                  │
   │                                                              │
   │  ⑨ StatusNotification {connectorId: 1, status: "Available"}  │
   ├─────────────────────────────────────────────────────────────►│
```

Nine messages. That is the whole happy path, and Milestones 2–5 build exactly
this.

**In OCPP 2.0.1** steps ⑤, ⑦ and ⑧ collapse into one message type,
`TransactionEvent`, with `eventType` of `Started`, `Updated` and `Ended` — and
the **station** allocates the transaction id instead of you. Everything else is
recognisably the same conversation.

---

## 5. The five things that trip everyone up

Every one of these has cost somebody a weekend. They are all visible in the
frame inspector in the dashboard, and the simulator can reproduce all five.

### ① `meterStart` is a lifetime register, not zero

`StartTransaction` sends `meterStart: 4823110`. That is the meter's **total
since it was manufactured**, in Wh — not the session starting at zero.

```
energy delivered = meterStop − meterStart
```

Store `meterStart` as the session total and you produce invoices for four
thousand kWh. This is the single most common first bug.

### ② `connectorId: 0` means the station, not a connector

In OCPP 1.6, connectors are numbered from 1. **Zero means the charge point as a
whole.** A `StatusNotification` with `connectorId: 0, status: "Faulted"` means
the entire station is broken, not that "connector zero" is.

Handle it explicitly, or your UI will invent phantom connectors.

### ③ Sampled values are strings

```json
{"value": "4823110", "measurand": "Energy.Active.Import.Register", "unit": "Wh"}
```

`value` is a **string**, by specification. Some firmware sends `"1234.00"`, some
`"1,234"`, some an empty string for "no reading". Parse defensively.

And watch `unit`: `Wh` and `kWh` are both legal for the same measurand. Normalise
at ingest or your totals will be wrong by a factor of 1000 — for one vendor
only, which is worse than being wrong for all of them.

### ④ "Accepted" does not mean "done"

You send `RemoteStartTransaction`. The station replies `Accepted`. Nothing has
happened yet.

`Accepted` means "I will try". The actual charge only exists when
`StartTransaction` arrives — which may be a minute later, when the driver plugs
in, or never, if they walk away.

A UI that shows "charging" on `Accepted` is lying to its user. The driver app in
this repo has a dedicated waiting state for exactly this gap.

### ⑤ Offline stations buffer, then replay

Lose the network mid-charge and the station keeps charging, buffering its
messages. When it reconnects it replays them **with their original
timestamps** — possibly hours old, possibly for a transaction you have already
timed out.

Which means:
- your handlers must be **idempotent** — the same `StartTransaction` may arrive
  twice;
- you must use the **message timestamp**, not arrival time, for billing;
- and you must not fire "charging started" notifications for events that are
  two hours old and already finished.

OCPP 2.0.1 helps here: `TransactionEvent` carries an `offline` flag and a
`seqNo`, so you can detect gaps. In 1.6 you are on your own.

---

## 6. Where to go next

| | |
|---|---|
| [OCPP 1.6J in detail](ocpp-1.6.md) | Every message, when it fires, what bites |
| [OCPP 2.0.1 in detail](ocpp-2.0.1.md) | What changed, and why they changed it |
| [OCPI 2.2.1](ocpi.md) | How networks talk to each other |
| [Glossary](glossary.md) | Every acronym you will meet |

The specifications themselves are free from the
[Open Charge Alliance](https://openchargealliance.org/) — you have to register,
but you do not have to pay. Download the 1.6 PDF and keep it open; the message
tables in section 6 are the reference you will use most.

**Then start building: [Milestone 0 →](../03-build-the-backend/README.md)**
