# Interview prep

**The point of this whole project.** You built a CPMS and a simulator so you
could say so and then defend it. This chapter is the defence.

It is organised the way interviews actually go: a two-minute story, then
increasingly specific questions, then the ones designed to find out whether you
really did it.

---

## 1. The story, in two minutes

Practise this out loud until it is boring. It is the answer to "tell me about a
project you are proud of", and everything else hangs off it.

> I built a charge point management system that runs OCPP 1.6J and 2.0.1
> simultaneously on one backend, plus a charge point simulator to test it
> against.
>
> The interesting problem was the two protocol versions. 2.0.1 is not a
> superset of 1.6 — it collapses four messages into `TransactionEvent`, moves
> the transaction id from the CSMS to the station, and reduces connector status
> from nine values to five with the detail moved elsewhere. So I translate both
> into a canonical internal model at the gateway edge, and nothing below that
> layer knows which version a station speaks. Adding a third version would be
> one new handler directory and one new mapping table.
>
> On top of that: remote commands with proper async lifecycle tracking, a
> pricing engine, authorize-then-capture payments, OCPI 2.2.1 roaming, and site
> load management that shares a grid connection between cars.
>
> The frontend is three separate apps — an operator dashboard, the simulator
> UI, and a driver app — all driven by a shared typed contract, so the API and
> the UI cannot drift.

Three things that makes that answer work:

- **It names a specific hard problem** rather than listing features.
- **It shows a design decision** — canonical model at the edge — with the
  consequence stated.
- **It invites the follow-up you want.** They will ask about the two versions,
  which is the part you know best.

---

## 2. The questions you will be asked

### "What is OCPP?"

The warm-up. Do not recite a definition.

> The protocol between a charge point and the management system that runs it.
> JSON over WebSocket, with the charger dialling out — which matters, because
> chargers sit behind NAT on mobile connections and could not accept inbound
> connections. The charger is the WebSocket client even though it is the thing
> being controlled, and once the socket is open either side can send commands.

### "What is the difference between 1.6 and 2.0.1?"

The question this project exists for. Five things, with an example each:

1. **Structure.** 1.6 has a charge point with connectors. 2.0.1 adds EVSEs in
   between — an EVSE is "a place exactly one car can charge", so a DC cabinet
   with a CCS and a CHAdeMO cable serving one car is one EVSE with two
   connectors.
2. **`TransactionEvent`** replaces StartTransaction, MeterValues and
   StopTransaction, with a `triggerReason` saying *why* each one fired.
3. **The station allocates the transaction id**, as a string, instead of the
   CSMS allocating an integer. Better for offline operation: a station that
   charges while disconnected already has an id.
4. **`Occupied` is ambiguous.** 2.0.1's StatusNotification has five values
   instead of nine; whether a car is charging or paused lives in
   `TransactionEvent.chargingState`. You need both to know anything.
5. **Faults moved** out of StatusNotification into `NotifyEvent`, a general
   monitoring message.

Then land it: *"Point 4 is the one that bit me. `Occupied` on its own tells you
nothing, so I cache the last `chargingState` per EVSE and resolve the two
together."*

### "How do you run both versions on one system?"

> A canonical model, translated at the gateway edge. There is one internal
> vocabulary for connector status, stop reasons and commands, and the protocol
> layer maps to and from it. The rule I enforced is that `domain/` may not
> import `ocpp/` — so the business logic literally cannot branch on version.
>
> Concretely: 1.6's `Charging` and 2.0.1's `Occupied` + `chargingState:
> Charging` both become `charging`. Outbound, my `reset` command takes
> `immediate` or `on_idle`, and the mapper turns that into Hard/Soft for 1.6
> and Immediate/OnIdle for 2.0.1. The word "Hard" appears in exactly one file.

### "Walk me through a charging session."

Pick 1.6 — it has more messages, so it shows more.

```
StatusNotification  Preparing          cable plugged in
Authorize           idTag              may this card charge?
   → Accepted
StartTransaction    connectorId, idTag, meterStart
   → transactionId  ← the CSMS allocates it
StatusNotification  Charging
MeterValues         every 30-60s, cumulative register
StopTransaction     transactionId, meterStop, reason
StatusNotification  Finishing → Available
```

Then add the detail that shows you built it:

> Two things I got wrong first time. Energy is `meterStop − meterStart`, not
> `meterStop` — the meter is a lifetime odometer, so billing the raw reading
> bills the driver for every kWh the charger has ever delivered. And
> `StopTransaction` must be idempotent, because a station that was offline
> replays its buffer on reconnect and will happily send the same stop twice.

### "What happens when a charger goes offline mid-session?"

> The station keeps charging — it does not need me to deliver electricity — and
> buffers its messages. On reconnect it replays them with the original
> timestamps, and 2.0.1 marks them `offline: true`.
>
> So every timestamp I store comes from the payload, never from `now()`. If you
> use arrival time, a two-hour outage produces two hours of meter values all
> stamped at the reconnect second, and the session chart is a vertical line.
>
> Authorization is the harder half. If the station cannot reach me, it decides
> locally from its cached list — which is what `LocalAuthorizeOffline` and the
> local list are for. That is a commercial decision about who carries the risk
> of a bad card, not a technical one.

### "How do you send a command to a specific charger?"

The question that tests whether you understand the architecture.

> With one process, a Map from station identity to the socket. With more than
> one, the connection is a file descriptor in one process and no other process
> can reach it — so Redis holds `station:<identity> → instance id`, with a TTL
> refreshed on heartbeat so a dead instance's entries expire instead of lying
> forever.
>
> The API looks up the instance and forwards over HTTP to that pod — a
> StatefulSet, so pods have stable addresses. The race is that the station
> reconnects to a different pod between the lookup and the forward; the
> receiving pod checks its local map, answers "not mine", and the caller
> retries the lookup once. Once, not in a loop — if it misses twice the station
> is flapping and `STATION_OFFLINE` is the honest answer.

### "A remote start returns Accepted. Is the car charging?"

The trap question. The answer is no.

> No. `Accepted` means the station understood the instruction and will try. The
> car may not be plugged in, and often is not — the driver is still walking to
> it.
>
> The real outcome arrives seconds later as a separate inbound message: a
> StatusNotification going to Preparing then Charging, and a StartTransaction.
> So I model a command as a state machine — queued, sent, accepted, then
> succeeded only when the effect is observed, with a timeout sweeper for
> commands that are accepted and never happen.
>
> In 1.6 you correlate the effect by station, connector and idTag within a time
> window, because the inbound message carries no reference to the command.
> 2.0.1 fixed that: `remoteStartId` is echoed back on every TransactionEvent,
> so it is an exact match.

### "How do payments work when you don't know the amount up front?"

> Authorize then capture. You cannot charge at the end — the car has driven
> away and the card may decline — and you cannot charge at the start, because
> you do not know the amount. So you ring-fence a maximum before charging
> starts, meter and price live, and capture the actual cost at the end,
> releasing the rest.
>
> The part people miss is that authorizing €20 does nothing physical. The car
> will happily draw €40 of electricity. You have to tell the *station*: an
> energy cap on the remote start, a charging profile, and a server-side
> watchdog that stops the session at about 95% of budget — 95 because a remote
> stop takes a few seconds to land and the car keeps drawing.
>
> And idempotency keys with a unique index, not a SELECT-then-INSERT. A driver
> on a train taps pay, the response is lost, the app retries — without the key
> you have taken €40.

### "What is OCPI and how is it different?"

> OCPP connects you to chargers. OCPI connects you to other companies. If a
> Shell customer charges at an Ionity station, OCPI is how Ionity tells Shell
> what to bill and how Shell's app knew the station was free.
>
> The fiddly part is the credentials handshake — three tokens. A partner gives
> you TOKEN_A out of band; you use it to discover their endpoints and POST them
> TOKEN_B, which is what *they* will use to call *you*; they reply with
> TOKEN_C, which is what *you* use to call *them*. TOKEN_A is then dead. Two
> tokens stored per partner, pointing in opposite directions.
>
> Two gotchas: the scheme is `Authorization: Token`, not `Bearer`. And an OCPI
> error is usually HTTP 200 with a non-1000 `status_code` in the body —
> returning a bare 404 makes partners' clients throw instead of handling it.

### "How would you scale this?"

Lead with the number, not the architecture. This is the question where most
candidates over-answer.

> First: a charge point is very quiet. Heartbeat every 300 seconds, meter
> values every 30 while charging. Ten thousand stations at 10% utilisation is
> about 60 messages a second. Throughput is not the problem.
>
> Connections are. Ten thousand months-long TLS connections is roughly half a
> gigabyte of RAM before my code allocates anything, and they cannot be
> rebalanced without disconnecting someone.
>
> So the split is by scaling axis and state, not by domain nouns: a **stateful**
> OCPP gateway that scales on connection count, a **stateless** API that scales
> on request rate, and a realtime service for browsers. Splitting stations,
> sessions and tariffs into separate services would give me distributed
> transactions across things that change together and buy nothing — they all
> scale identically.
>
> Below a few hundred stations it is one process and that is the correct
> answer. The value of the design is that going to multiple processes is a
> week, because the connection registry and the event bus were always behind
> interfaces.

### "What is the hardest bug you hit?"

Have a real one ready. Two good ones from this project:

> **Timestamps on offline replay.** A station reconnected after an outage and
> replayed forty minutes of meter values. I was stamping them with arrival
> time, so the session chart showed zero power for forty minutes and then a
> vertical spike. The fix is one line, but the lesson is general: in a protocol
> with store-and-forward, the payload's timestamp is the truth and the arrival
> time is an artefact of the network.

> **Pairing OCPP frames.** A CALLRESULT contains only a message id — no action
> name — so to show "BootNotification → Accepted, 43 ms" you join back to the
> request. My first version paired by id alone and occasionally matched my own
> outbound question to another outbound question, because message ids are only
> unique *per connection per direction*. Both sides can be using id "1" at the
> same time.

### "What would you do differently?"

Never "nothing". Pick something real and specific.

> I would put the frame log somewhere other than Postgres from the start. It is
> append-only, high volume, and queried by time range — which is a time-series
> workload, and I partitioned to cope rather than choosing the right store. It
> works, and TimescaleDB or ClickHouse would have been less work in the end.
>
> I would also have written the canonical model before either protocol handler.
> I wrote 1.6 first and extracted the canonical layer when adding 2.0.1, and
> that extraction leaked 1.6 assumptions — my first stop-reason enum was just
> 1.6's list renamed.

---

## 3. The questions that check whether you really built it

Interviewers who know the domain ask small, specific things. These are cheap to
answer if you did the work and impossible to bluff.

| Question | The tell |
|---|---|
| "What is `connectorId: 0`?" | The station itself, not a connector. A StatusNotification on 0 is about the whole unit. |
| "Why are sampled values strings in 1.6?" | Because the schema says so. You must parse and normalise units — Wh vs kWh — yourself. |
| "What does `Pending` mean in a BootNotification response?" | "I know you, but configure first." The station may only send BootNotification, Heartbeat and StatusNotification until accepted. |
| "Why must a CALL have a timeout?" | The pending map is keyed by message id. No timeout means one leaked entry per unanswered call, forever. |
| "What is `stackLevel` in a charging profile?" | A tie-break within a purpose. Higher wins — but it never lets you exceed a more restrictive profile of another purpose. |
| "Amps or watts?" | Amps are per phase. 32 A is 7.4 kW single-phase and 22 kW three-phase. Guess the phase count wrong and you are out by 3×. |
| "Why is a CDR immutable?" | It is the bill. It carries a snapshot of the tariff, so fixing a pricing bug next month cannot change what a customer was charged. |
| "Why cursor pagination on the log?" | The table grows while you read it. With offsets, new rows push everything down and page 2 repeats page 1. |
| "Why `Authorization: Token` in OCPI?" | Because the spec says so, base64-encoded since 2.2. It is a real interop failure people hit. |

---

## 4. What to show, and how

### The five-minute live demo

Order matters. This sequence builds tension and resolves it.

1. **Dashboard overview** — "this is a fleet." Ten seconds.
2. **Two stations, different protocols** — "same fleet, 1.6 and 2.0.1, and the
   only difference in the UI is a badge."
3. **The frame inspector, live** — start a charge in the simulator and let them
   watch the messages arrive. This is the moment people lean in.
4. **The `Occupied` demo** — plug in on the 2.0.1 station, show the wire saying
   `Occupied`, show the UI saying Preparing, then start the transaction and
   show it becoming Charging with no new StatusNotification. *"The status did
   not change; my interpretation of it did."*
5. **Remote start with the cable unplugged** — the command sits at
   `accepted`, nothing charges. Then plug in and watch it flip to
   `succeeded`. *"The Accepted reply is not the answer."*
6. **The driver app** — type €5, charge, watch it stop itself at budget, show
   the itemised receipt.

Six minutes, and every step demonstrates a concept rather than a screen.

### What to put in the README

Someone will skim for thirty seconds. Give them:

- The one-line description, with **both versions** in it.
- One screenshot of the frame inspector. It is the most distinctive screen.
- The architecture diagram from chapter 4.
- "What I learned", three bullets, specific.

---

## 5. Honesty

You will be asked something you did not build. The correct answer is short and
then curious:

> I did not implement ISO 15118 Plug & Charge. I know where it fits — the
> certificate exchange rides on 2.0.1's Authorize and TransactionEvent, and my
> handlers have the fields — but I have not done the certificate chain, and I
> would not want to claim it.

That answer is *better* than a vague yes. Interviewers are calibrating how much
they can trust your other answers, and a crisp "no, but here is where it would
go" raises that estimate.

Things it is fine to say you skipped: ISO 15118, OCPP 2.1, certificate-based
security profile 3, real payment gateways, multi-tenancy, the hardware side.

---

## 6. The five sentences

If you remember nothing else:

1. **"I run both OCPP versions on one backend by translating each into a
   canonical model at the gateway edge."**
2. **"A remote command has two results — the station accepting it, and the
   effect actually happening — and only the second one means anything."**
3. **"A CPMS is connection-bound, not throughput-bound: ten thousand chargers
   is sixty messages a second and ten thousand months-long sockets."**
4. **"Energy is meterStop minus meterStart, and every timestamp comes from the
   payload, never from arrival time."**
5. **"Payments are authorize-then-capture, and the authorization does not limit
   the car — the station does."**

Each one is specific, each is true of what you built, and each invites a
follow-up you can answer.

---

## 7. Before the interview

- [ ] Run the whole system once, end to end, the morning of.
- [ ] Have the simulator seeded with two stations, one per protocol.
- [ ] Have the frame inspector open on a second screen.
- [ ] Re-read your own `enums.ts` — the canonical model is the thing you will
      be asked to defend.
- [ ] Know one number: how many stations your design handles before it needs
      changing, and why.
- [ ] Have your "what would you do differently" ready. It gets asked, and a
      prepared answer is the difference between thoughtful and defensive.

---

You built a CPMS and a simulator. You can explain the protocol, the design, and
the failure modes. That is not a tutorial project — go and say so.
