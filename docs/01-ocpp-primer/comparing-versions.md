# OCPP 1.6 vs 2.0.1, side by side

<!-- GENERATED FILE — edit packages/ocpp/src, then run `npm run docs:reference`. -->

The table people actually want. Every row is one concept and what it is
called in each version.

This is also the table to have in your head walking into an interview: being
able to say *"RemoteStartTransaction became RequestStartTransaction, because
the station decides whether to honour it"* demonstrates that you have read
the specifications rather than a blog post about them.

| Concept | OCPP 1.6J | OCPP 2.0.1 | Why it changed |
|---|---|---|---|
| Station announces itself | `BootNotification` | `BootNotification` | 2.0.1 nests the hardware fields and adds a boot `reason`. |
| Keep-alive | `Heartbeat` | `Heartbeat` | Identical. |
| Connector state | `StatusNotification (9 states + errorCode)` | `StatusNotification (5 states)` | 2.0.1 moved charging detail to chargingState and faults to NotifyEvent. |
| Charge begins | `StartTransaction` | `TransactionEvent (Started)` | The transaction id moved from the CSMS to the station. |
| Measurements | `MeterValues` | `TransactionEvent (Updated)` | 2.0.1 keeps MeterValues only for samples outside a transaction. |
| Charge ends | `StopTransaction` | `TransactionEvent (Ended)` | One message type replaces three. |
| Ask to start remotely | `RemoteStartTransaction` | `RequestStartTransaction` | Renamed to make clear the station decides. Adds remoteStartId for correlation. |
| Ask to stop remotely | `RemoteStopTransaction` | `RequestStopTransaction` | transactionId became a string. |
| Read settings | `GetConfiguration` | `GetVariables` | Flat key/value bag became a typed component/variable tree. |
| Write settings | `ChangeConfiguration` | `SetVariables` | 2.0.1 writes many variables in one call, with per-variable results. |
| Discover capabilities | — | `GetBaseReport → NotifyReport` | No 1.6 equivalent. You had to consult the vendor datasheet. |
| Report a fault | `StatusNotification.errorCode` | `NotifyEvent` | 2.0.1 faults are first-class events with severity and explicit clearing. |
| Show text on the screen | — | `SetDisplayMessage` | New. 1.6 vendors used DataTransfer for this, incompatibly. |
| Show live cost | — | `CostUpdated` | New, and what makes prepaid charging feel finished. |
| Security events | `Security whitepaper (optional)` | `SecurityEventNotification` | Moved into the core specification. |
| Certificate management | `Security whitepaper (optional)` | `SignCertificate / CertificateSigned / InstallCertificate` | Enables certificate rotation without a site visit. |
| Plug & Charge (ISO 15118) | — | `NotifyEVChargingNeeds, Get15118EVCertificate` | The main commercial reason operators move to 2.0.1. |
| Reconcile after an outage | — | `GetTransactionStatus` | In 1.6 you guessed. In 2.0.1 you can ask. |
| Diagnostics upload | `GetDiagnostics` | `GetLog` | 2.0.1 can request the security log specifically. |
| Reservation expiry | — | `ReservationStatusUpdate` | The station now tells you instead of you watching a clock. |

---

## How this project supports both at once

One canonical model, translated at the edge. The WebSocket gateway is the
only place in the whole system that knows the words `StartTransaction` or
`TransactionEvent`; everything above it — the database, the REST API, the
dashboard — speaks one vocabulary.

The translation lives in two files worth reading:

- [`packages/contracts/src/enums.ts`](../../packages/contracts/src/enums.ts)
  — the canonical vocabulary, with the mapping rules written out.
- [`packages/ocpp/src/mapping.ts`](../../packages/ocpp/src/mapping.ts)
  — the pure functions that do the translating.

The hardest single mapping is connector status, because 2.0.1 deliberately
shrank the list from nine values to five and moved the detail into the
transaction:

```
  1.6  StatusNotification.status = "Charging"        → charging

2.0.1  StatusNotification.connectorStatus = "Occupied"
       + TransactionEvent.chargingState  = "Charging" → charging
                                         = "SuspendedEV" → suspended_ev
                                         = "EVConnected"  → preparing
```

You need **both** messages to know what a 2.0.1 connector is doing. That
asymmetry is the clearest example of 2.0.1 separating "what is the socket
doing" from "what is the transaction doing", and it is a very good thing to
be able to explain out loud.