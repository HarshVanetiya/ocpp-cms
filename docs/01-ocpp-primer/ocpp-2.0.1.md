# OCPP 2.0.1 message reference

<!-- GENERATED FILE — edit packages/ocpp/src, then run `npm run docs:reference`. -->

OCPP 2.0.1 is not "1.6 with more messages". Four structural changes explain
almost everything that looks unfamiliar:

1. **Transactions became one message.** `StartTransaction`,
   `StopTransaction` and `MeterValues` collapsed into `TransactionEvent`,
   and the **station** now allocates the transaction id instead of you.
2. **The device model replaced configuration keys.** A flat bag of strings
   became a tree of components and typed variables you can query.
3. **Security moved into the core specification** — certificates, security
   profiles and a security event log, rather than an optional whitepaper.
4. **ISO 15118 support** — Plug & Charge, where the car identifies itself
   over the cable and no card or app is needed.

The RPC framing is unchanged, which is why one gateway can serve both
versions: only the payloads and action names differ.

See also [the side-by-side comparison](comparing-versions.md).

## Every message at a glance

| Message | Direction | Group | Core | What it is for |
|---|---|---|---|---|
| [`BootNotification`](#bootnotification) | Station → CSMS | Provisioning | ● | Station introduces itself and asks for permission to operate |
| [`Heartbeat`](#heartbeat) | Station → CSMS | Availability | ● | Keep-alive and clock sync |
| [`StatusNotification`](#statusnotification) | Station → CSMS | Availability | ● | A connector changed state |
| [`Authorize`](#authorize) | Station → CSMS | Authorization | ● | May this identifier start a charge? |
| [`TransactionEvent`](#transactionevent) | Station → CSMS | Transactions | ● | Everything about a charging transaction, in one message |
| [`MeterValues`](#metervalues) | Station → CSMS | Meter values | ○ | Measurements outside a transaction |
| [`RequestStartTransaction`](#requeststarttransaction) | CSMS → Station | Transactions | ● | Ask a station to start charging |
| [`RequestStopTransaction`](#requeststoptransaction) | CSMS → Station | Transactions | ● | Ask a station to stop a charge |
| [`GetTransactionStatus`](#gettransactionstatus) | CSMS → Station | Transactions | ○ | Is this transaction still running, and are messages still queued? |
| [`GetVariables`](#getvariables) | CSMS → Station | Device management | ● | Read device-model variables |
| [`SetVariables`](#setvariables) | CSMS → Station | Device management | ● | Write device-model variables |
| [`GetBaseReport`](#getbasereport) | CSMS → Station | Device management | ● | Ask the station to describe everything it can do |
| [`NotifyReport`](#notifyreport) | Station → CSMS | Device management | ● | One page of a device-model report |
| [`NotifyEvent`](#notifyevent) | Station → CSMS | Diagnostics | ● | Something notable happened — including faults |
| [`Reset`](#reset) | CSMS → Station | Provisioning | ● | Reboot the station or one EVSE |
| [`ChangeAvailability`](#changeavailability) | CSMS → Station | Availability | ● | Take an EVSE or the station out of service |
| [`UnlockConnector`](#unlockconnector) | CSMS → Station | Availability | ○ | Release a stuck cable |
| [`TriggerMessage`](#triggermessage) | CSMS → Station | Remote trigger | ○ | Ask the station to send a message now |
| [`ClearCache`](#clearcache) | CSMS → Station | Authorization | ● | Forget cached authorizations |
| [`SetDisplayMessage`](#setdisplaymessage) | CSMS → Station | Display messages | ○ | Put text on the station screen |
| [`CostUpdated`](#costupdated) | CSMS → Station | Tariff and cost | ○ | Push the running cost to the station display |
| [`SecurityEventNotification`](#securityeventnotification) | Station → CSMS | Security | ● | A security-relevant event occurred at the station |
| [`SignCertificate`](#signcertificate) | Station → CSMS | Security | ○ | Station asks you to sign its certificate request |
| [`CertificateSigned`](#certificatesigned) | CSMS → Station | Security | ○ | Return the signed certificate to the station |
| [`SetChargingProfile`](#setchargingprofile) | CSMS → Station | Smart charging | ○ | Limit how much power an EVSE or transaction may draw |
| [`NotifyEVChargingNeeds`](#notifyevchargingneeds) | Station → CSMS | ISO 15118 / Plug & Charge | ○ | The car says what it wants |
| [`SendLocalList`](#sendlocallist) | CSMS → Station | Local authorisation list | ○ | Push the offline authorization list |
| [`GetLocalListVersion`](#getlocallistversion) | CSMS → Station | Local authorisation list | ○ | Which list version does the station hold? |
| [`UpdateFirmware`](#updatefirmware) | CSMS → Station | Firmware management | ○ | Install new firmware, now with signature verification |
| [`GetLog`](#getlog) | CSMS → Station | Diagnostics | ○ | Ask for a log bundle |
| [`DataTransfer`](#datatransfer) | Either direction | Data transfer | ○ | Vendor-specific escape hatch |
| [`ReserveNow`](#reservenow) | CSMS → Station | Reservation | ○ | Hold an EVSE for one driver |
| [`ReservationStatusUpdate`](#reservationstatusupdate) | Station → CSMS | Reservation | ○ | A reservation expired or was removed |

---

## Provisioning

### BootNotification

**Station → CSMS** · Provisioning · required for a conformant implementation · introduced in Milestone 7

Same role as in 1.6, but restructured: the vendor and model fields moved into a nested `chargingStation` object, and a `reason` field was added so you know WHY it booted.

**When it fires.** Power-up, reset, reconnection, and whenever the station is told to re-boot-notify. The `reason` field tells you which — very useful for spotting stations that are crash-looping rather than merely reconnecting.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `chargingStation.model` | string(20) | yes | Model name. |
| `chargingStation.vendorName` | string(50) | yes | Manufacturer. |
| `chargingStation.serialNumber` | string(25) | no | Serial number. |
| `chargingStation.firmwareVersion` | string(50) | no | Installed firmware. |
| `chargingStation.modem.iccid` | string(20) | no | SIM ICCID, now nested under modem. |
| `chargingStation.modem.imsi` | string(20) | no | SIM IMSI. |
| `reason` | enum | yes | Why the station is booting. New in 2.0.1 and genuinely useful.<br>*One of:* `ApplicationReset`, `FirmwareUpdate`, `LocalReset`, `PowerUp`, `RemoteReset`, `ScheduledReset`, `Triggered`, `Unknown`, `Watchdog` |

> **Watch out — `reason`.** Repeated `Watchdog` reasons mean the station firmware is hanging and resetting itself. Alert on it — in 1.6 this was invisible and sites would quietly reboot all night.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `currentTime` | dateTime | yes | UTC time for the station to sync to. |
| `interval` | integer | yes | Heartbeat interval when Accepted, retry interval otherwise. |
| `status` | enum | yes | Permission to operate.<br>*One of:* `Accepted`, `Pending`, `Rejected` |
| `statusInfo` | StatusInfo | no | Structured reason with reasonCode and additionalInfo. New in 2.0.1 — use it, because a bare Rejected with no explanation is an unpleasant thing to debug from a van. |

**Equivalent in the other version:** `BootNotification`

---

### Reset

**CSMS → Station** · Provisioning · required for a conformant implementation · introduced in Milestone 7

Two improvements over 1.6: the type names say what they mean, and you can reset a single EVSE rather than the whole station.

**When it fires.** Operator reset.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | enum | yes | Immediate reboots now; OnIdle waits for transactions to finish.<br>*One of:* `Immediate`, `OnIdle` |
| `evseId` | integer | no | Reset just this EVSE. Omit for the whole station. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `Scheduled` |

**Equivalent in the other version:** `Reset`

---

## Availability

### Heartbeat

**Station → CSMS** · Availability · required for a conformant implementation · introduced in Milestone 7

Identical in purpose and shape to 1.6.

**When it fires.** Every heartbeat interval of silence.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `currentTime` | dateTime | yes | Current UTC time. |

**Equivalent in the other version:** `Heartbeat`

---

### StatusNotification

**Station → CSMS** · Availability · required for a conformant implementation · introduced in Milestone 7

Much simpler than 1.6: five states instead of nine, and no error code. Faults are now reported separately through NotifyEvent, and the detail of what a charging connector is doing lives in TransactionEvent.chargingState.

**When it fires.** On connector state change and after boot.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `timestamp` | dateTime | yes | Now required, unlike 1.6. |
| `connectorStatus` | enum | yes | The state.<br>*One of:* `Available`, `Occupied`, `Reserved`, `Unavailable`, `Faulted` |
| `evseId` | integer | yes | Which EVSE. |
| `connectorId` | integer | yes | Which connector in it. |

> **Watch out — `connectorStatus`.** There is no Charging state. `Occupied` covers plugged-in, charging, suspended and finishing. To fill a dashboard you must combine this with the live transaction's chargingState. This is the single biggest surprise when moving from 1.6.

**Response.** Empty.

**Equivalent in the other version:** `StatusNotification`

---

### ChangeAvailability

**CSMS → Station** · Availability · required for a conformant implementation · introduced in Milestone 7

Same idea as 1.6, addressed by EVSE rather than connector number.

**When it fires.** Maintenance.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `operationalStatus` | enum | yes | Target state.<br>*One of:* `Inoperative`, `Operative` |
| `evse` | EVSE | no | Omit for the whole station — no more magic connector 0. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `Scheduled` |

**Equivalent in the other version:** `ChangeAvailability`

---

### UnlockConnector

**CSMS → Station** · Availability · introduced in Milestone 7

Now addressed by EVSE and connector rather than a single connector number.

**When it fires.** Support request.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `evseId` | integer | yes | Which EVSE. |
| `connectorId` | integer | yes | Which connector. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Unlocked`, `UnlockFailed`, `OngoingAuthorizedTransaction`, `UnknownConnector` |

> **Watch out — `status`.** OngoingAuthorizedTransaction is a new and useful refusal: it will not unlock while someone is legitimately charging. 1.6 would simply fail with no reason.

**Equivalent in the other version:** `UnlockConnector`

---

## Authorization

### Authorize

**Station → CSMS** · Authorization · required for a conformant implementation · introduced in Milestone 7

Same question as 1.6, richer identifier. `idToken` is now an object with a type, and the response can carry ISO 15118 certificate validation results for Plug & Charge.

**When it fires.** Card presented, app start, or a car authenticating over the cable.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idToken.idToken` | string(36) | yes | The identifier. 36 chars now, up from 20. |
| `idToken.type` | enum | yes | What kind of identifier this is.<br>*One of:* `Central`, `eMAID`, `ISO14443`, `ISO15693`, `KeyCode`, `Local`, `MacAddress`, `NoAuthorization` |
| `certificate` | string(5500) | no | PEM certificate chain for Plug & Charge. |
| `iso15118CertificateHashData` | array | no | Hashes for OCSP validation, so the full chain need not be sent. |

> **Watch out — `idToken.type`.** The type is now explicit, which means you can tell an RFID card from a Plug & Charge contract id. In 1.6 both arrived as a bare string and you had to guess.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idTokenInfo.status` | enum | yes | The decision.<br>*One of:* `Accepted`, `Blocked`, `ConcurrentTx`, `Expired`, `Invalid`, `NoCredit`, `NotAllowedTypeEVSE`, `NotAtThisLocation`, `NotAtThisTime`, `Unknown` |
| `idTokenInfo.cacheExpiryDateTime` | dateTime | no | How long the station may cache this decision. |
| `idTokenInfo.groupIdToken` | IdToken | no | The 2.0.1 equivalent of parentIdTag. |
| `idTokenInfo.personalMessage` | MessageContent | no | Text to show on the station display. "Welcome back, Alex." |

> **Watch out — `idTokenInfo.status`.** Far richer than 1.6's five values. `NoCredit`, `NotAtThisTime` and `NotAtThisLocation` let the station show the driver a useful message instead of a generic refusal.

**Equivalent in the other version:** `Authorize`

---

### ClearCache

**CSMS → Station** · Authorization · required for a conformant implementation · introduced in Milestone 7

Unchanged from 1.6.

**When it fires.** After blocking a token.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

**Equivalent in the other version:** `ClearCache`

---

## Transactions

### TransactionEvent

**Station → CSMS** · Transactions · required for a conformant implementation · introduced in Milestone 7

The headline change of 2.0.1. StartTransaction, StopTransaction and MeterValues are now a single action distinguished by `eventType`. The station allocates `transactionId` itself, so it can open a transaction while offline and tell you later — the thing 1.6 handled badly.

The `triggerReason` field says WHY this event fired, which turns your log from a list of numbers into a readable story: Authorized, CablePluggedIn, ChargingStateChanged, MeterValuePeriodic, StopAuthorized, EVCommunicationLost, and so on.

**When it fires.** Started once at the beginning, Updated repeatedly during charging, Ended once at the end. A station that was offline sends the whole sequence when it reconnects, with the original timestamps and increasing seqNo values.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `eventType` | enum | yes | Which part of the transaction lifecycle this is.<br>*One of:* `Started`, `Updated`, `Ended` |
| `timestamp` | dateTime | yes | When the event happened at the station, not when it reached you. |
| `triggerReason` | enum | yes | What caused this event.<br>*One of:* `Authorized`, `CablePluggedIn`, `ChargingRateChanged`, `ChargingStateChanged`, `Deauthorized`, `EnergyLimitReached`, `EVCommunicationLost`, `EVConnectTimeout`, `MeterValueClock`, `MeterValuePeriodic`, `TimeLimitReached`, `Trigger`, `UnlockCommand`, `StopAuthorized`, `EVDeparted`, `EVDetected`, `RemoteStop`, `RemoteStart`, `AbnormalCondition`, `SignedDataReceived`, `ResetCommand` |
| `seqNo` | integer | yes | Sequence number within this transaction, starting at 0. |
| `transactionInfo.transactionId` | string(36) | yes | Allocated by the STATION, not by you. String, not integer. |
| `transactionInfo.chargingState` | enum | no | What the transaction is doing right now. Replaces 1.6 connector statuses.<br>*One of:* `Charging`, `EVConnected`, `SuspendedEV`, `SuspendedEVSE`, `Idle` |
| `transactionInfo.stoppedReason` | enum | no | Only on eventType Ended.<br>*One of:* `DeAuthorized`, `EmergencyStop`, `EnergyLimitReached`, `EVDisconnected`, `GroundFault`, `ImmediateReset`, `Local`, `LocalOutOfCredit`, `MasterPass`, `Other`, `OvercurrentFault`, `PowerLoss`, `PowerQuality`, `Reboot`, `Remote`, `SOCLimitReached`, `StoppedByEV`, `TimeLimitReached`, `Timeout` |
| `idToken` | IdToken | no | Who is charging. Usually only on the Started event. |
| `evse.id` | integer | no | Which EVSE. |
| `evse.connectorId` | integer | no | Which connector. |
| `meterValue` | MeterValue[] | no | Samples, same nested structure as 1.6 MeterValues. |
| `offline` | boolean | no | True when this event was buffered while the station had no connection. |
| `cableMaxCurrent` | integer | no | Amp rating the cable reports. Explains why a car charges slower than expected. |
| `reservationId` | integer | no | Reservation this transaction consumed. |

> **Watch out — `seqNo`.** This is how you detect gaps and reordering after an offline period. Store it and check for holes — a missing seqNo means a lost event, and a lost Ended event means a session that never closes and never bills.

> **Watch out — `transactionInfo.transactionId`.** The reversal from 1.6. Your database must accept an id you did not create, and it may collide across stations from different vendors — always scope uniqueness by station.

> **Watch out — `offline`.** Treat offline events as historical: do not fire "charging started" push notifications for a transaction that began two hours ago and has already ended.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `totalCost` | decimal | no | Running cost. The station can display it to the driver live. |
| `chargingPriority` | integer | no | Priority for load management, -9 to 9. |
| `idTokenInfo` | IdTokenInfo | no | Updated authorization status, e.g. to stop a session that ran out of credit. |
| `updatedPersonalMessage` | MessageContent | no | New text for the station display. |

> **Watch out — `totalCost`.** This is the 2.0.1 feature that makes prepaid charging pleasant — you compute cost and the station shows it on its own screen. 1.6 had no equivalent.

**Equivalent in the other version:** `StartTransaction / StopTransaction / MeterValues`

---

### RequestStartTransaction

**CSMS → Station** · Transactions · required for a conformant implementation · introduced in Milestone 7

Renamed from RemoteStartTransaction, and the rename is meaningful: you REQUEST, the station decides. It can also return the transactionId immediately if it already knows it.

**When it fires.** Driver app start; dashboard start; an OCPI partner command.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idToken` | IdToken | yes | Who to bill, as a typed object. |
| `remoteStartId` | integer | yes | Your correlation id, echoed back in the resulting TransactionEvent. |
| `evseId` | integer | no | Which EVSE. Omit to let the station choose. |
| `chargingProfile` | ChargingProfile | no | Limits for this transaction. Purpose must be TxProfile. |
| `groupIdToken` | IdToken | no | Group token, for shared authorization. |

> **Watch out — `remoteStartId`.** This solves a genuine 1.6 pain: matching "the start I requested" to "the transaction that appeared". In 1.6 you had to guess by connector and time. Always send it and always store it.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station will attempt it.<br>*One of:* `Accepted`, `Rejected` |
| `transactionId` | string(36) | no | Returned when the station can allocate the id right away. |
| `statusInfo` | StatusInfo | no | Structured reason. |

**Equivalent in the other version:** `RemoteStartTransaction`

---

### RequestStopTransaction

**CSMS → Station** · Transactions · required for a conformant implementation · introduced in Milestone 7

Stops by transactionId, which is now a string.

**When it fires.** Driver stop; operator stop; credit exhausted.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transactionId` | string(36) | yes | The station-allocated id. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station will attempt it.<br>*One of:* `Accepted`, `Rejected` |
| `statusInfo` | StatusInfo | no | Structured reason. |

**Equivalent in the other version:** `RemoteStopTransaction`

---

### GetTransactionStatus

**CSMS → Station** · Transactions · introduced in Milestone 7

New in 2.0.1. Lets you reconcile after a network outage: the station tells you whether it still considers a transaction open and whether it has unsent messages for it.

**When it fires.** After a reconnect, or when your records and the station disagree.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transactionId` | string(36) | no | Omit to ask about queued messages in general. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `ongoingIndicator` | boolean | no | Is the transaction still active at the station? |
| `messagesInQueue` | boolean | yes | Does the station still have buffered messages to deliver? |

---

## Meter values

### MeterValues

**Station → CSMS** · Meter values · introduced in Milestone 7

Still exists, but only for samples NOT tied to a transaction — clock-aligned readings while a connector is idle. Anything during a charge goes inside TransactionEvent.

**When it fires.** Clock-aligned sampling on an idle connector.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `evseId` | integer | yes | Which EVSE. 0 for the station. |
| `meterValue` | MeterValue[] | yes | Sample batches. |

**Response.** Empty.

**Equivalent in the other version:** `MeterValues`

---

## Device management

### GetVariables

**CSMS → Station** · Device management · required for a conformant implementation · introduced in Milestone 7

The replacement for GetConfiguration. You address a variable by the Component it belongs to, the Variable name, and which attribute you want (Actual, Target, MinSet, MaxSet). Far more precise than 1.6's flat string bag, and considerably more verbose.

**When it fires.** Operator opens the configuration tab; capability discovery after boot.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `getVariableData[].component.name` | string(50) | yes | Component, e.g. OCPPCommCtrlr, SampledDataCtrlr, AuthCtrlr. |
| `getVariableData[].component.evse` | EVSE | no | Scope the component to one EVSE or connector. |
| `getVariableData[].variable.name` | string(50) | yes | Variable, e.g. HeartbeatInterval. |
| `getVariableData[].attributeType` | enum | no | Which attribute to read. Defaults to Actual.<br>*One of:* `Actual`, `Target`, `MinSet`, `MaxSet` |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `getVariableResult[].attributeStatus` | enum | yes | Per-variable result.<br>*One of:* `Accepted`, `Rejected`, `UnknownComponent`, `UnknownVariable`, `NotSupportedAttributeType` |
| `getVariableResult[].attributeValue` | string(2500) | no | The value, still as a string. |

> **Watch out — `getVariableResult[].attributeStatus`.** The result is PER VARIABLE, not per message. A request for ten variables can return six Accepted and four UnknownVariable. Handle partial success or your UI will show blank rows with no explanation.

**Equivalent in the other version:** `GetConfiguration`

---

### SetVariables

**CSMS → Station** · Device management · required for a conformant implementation · introduced in Milestone 7

The replacement for ChangeConfiguration. Writes several variables in one call.

**When it fires.** Operator edits configuration; automated fleet configuration.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `setVariableData[].component.name` | string(50) | yes | Target component. |
| `setVariableData[].variable.name` | string(50) | yes | Target variable. |
| `setVariableData[].attributeValue` | string(1000) | yes | New value as a string. |
| `setVariableData[].attributeType` | enum | no | Defaults to Actual. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `setVariableResult[].attributeStatus` | enum | yes | Per-variable result.<br>*One of:* `Accepted`, `Rejected`, `RebootRequired`, `UnknownComponent`, `UnknownVariable`, `NotSupportedAttributeType` |

**Equivalent in the other version:** `ChangeConfiguration`

---

### GetBaseReport

**CSMS → Station** · Device management · required for a conformant implementation · introduced in Milestone 7

The capability-discovery message that 1.6 completely lacked. The station replies with NotifyReport messages listing every component, variable and characteristic it has. Run this once at boot and you never have to guess what a station supports.

**When it fires.** After the first successful boot of a newly registered station.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestId` | integer | yes | Correlates the NotifyReport messages that follow. |
| `reportBase` | enum | yes | How much detail to return.<br>*One of:* `ConfigurationInventory`, `FullInventory`, `SummaryInventory` |

> **Watch out — `reportBase`.** FullInventory on a large station can produce dozens of NotifyReport messages over several minutes. Do not block a UI on it.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station will produce the report.<br>*One of:* `Accepted`, `Rejected`, `NotSupported`, `EmptyResultSet` |

---

### NotifyReport

**Station → CSMS** · Device management · required for a conformant implementation · introduced in Milestone 7

The station streams its inventory back in chunks. `tbc` (to be continued) tells you whether more pages are coming.

**When it fires.** After GetBaseReport or GetReport.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestId` | integer | yes | Which request this answers. |
| `generatedAt` | dateTime | yes | When the report was made. |
| `seqNo` | integer | yes | Page number, from 0. |
| `tbc` | boolean | no | True when more pages follow. Defaults to false. |
| `reportData` | ReportData[] | no | Components with their variables, attributes and characteristics. |

> **Watch out — `tbc`.** Do not treat the report as complete until you receive a page with tbc false or absent. Acting on a partial inventory produces confusing "unsupported feature" errors later.

**Response.** Empty.

---

## Diagnostics

### NotifyEvent

**Station → CSMS** · Diagnostics · required for a conformant implementation · introduced in Milestone 7

Where 1.6 faults went. In 1.6, errorCode rode along on StatusNotification; in 2.0.1 a fault is its own event with a severity, a component, and a technical code. This is also how variable monitors report threshold breaches.

**When it fires.** Hardware faults, threshold crossings, and monitored variable changes.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `generatedAt` | dateTime | yes | When it happened. |
| `seqNo` | integer | yes | Page number for long batches. |
| `eventData[].trigger` | enum | yes | What kind of monitor fired.<br>*One of:* `Alerting`, `Delta`, `Periodic` |
| `eventData[].actualValue` | string(2500) | yes | The value that triggered it. |
| `eventData[].eventNotificationType` | enum | yes | Whether this monitor was set by you or is built into the firmware.<br>*One of:* `HardWiredNotification`, `HardWiredMonitor`, `PreconfiguredMonitor`, `CustomMonitor` |
| `eventData[].component` | Component | yes | Which part of the station. |
| `eventData[].variable` | Variable | yes | Which variable. |
| `eventData[].cleared` | boolean | no | True when this event CLEARS a previous alert. |

> **Watch out — `eventData[].cleared`.** Faults now have an explicit clear event, which 1.6 never had — there you inferred recovery from a NoError status. Track open faults by component and close them on cleared, or your fault list will only ever grow.

**Response.** Empty.

**Equivalent in the other version:** `StatusNotification (errorCode field)`

---

### GetLog

**CSMS → Station** · Diagnostics · introduced in Milestone 7

Replaces GetDiagnostics, and adds a log TYPE so you can request the security log specifically rather than everything.

**When it fires.** Fault investigation; security audit.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestId` | integer | yes | Correlates status reports. |
| `logType` | enum | yes | Which log to collect.<br>*One of:* `DiagnosticsLog`, `SecurityLog` |
| `log.remoteLocation` | string(512) | yes | Upload URL. |
| `log.oldestTimestamp` | dateTime | no | Range start. |
| `log.latestTimestamp` | dateTime | no | Range end. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `AcceptedCanceled` |
| `filename` | string(255) | no | Name of the upload. |

**Equivalent in the other version:** `GetDiagnostics`

---

## Remote trigger

### TriggerMessage

**CSMS → Station** · Remote trigger · introduced in Milestone 7

Same as 1.6 with a longer list of requestable messages.

**When it fires.** Refresh; post-reconnect reconciliation.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestedMessage` | enum | yes | Which message to ask for.<br>*One of:* `BootNotification`, `LogStatusNotification`, `FirmwareStatusNotification`, `Heartbeat`, `MeterValues`, `SignChargingStationCertificate`, `SignV2GCertificate`, `StatusNotification`, `TransactionEvent`, `SignCombinedCertificate`, `PublishFirmwareStatusNotification` |
| `evse` | EVSE | no | Scope to one EVSE. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `NotImplemented` |

**Equivalent in the other version:** `TriggerMessage`

---

## Display messages

### SetDisplayMessage

**CSMS → Station** · Display messages · introduced in Milestone 7

Entirely new in 2.0.1. Schedule a message, target one transaction or the idle screen, set priority. This is how you show tariffs, promotions or "out of order" notices.

**When it fires.** Marketing messages; maintenance notices; per-driver greetings.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `message.id` | integer | yes | Your id for the message. |
| `message.priority` | enum | yes | Where it appears.<br>*One of:* `AlwaysFront`, `InFront`, `NormalCycle` |
| `message.state` | enum | no | Only show in this station state.<br>*One of:* `Charging`, `Faulted`, `Idle`, `Unavailable` |
| `message.message.content` | string(512) | yes | The text. |
| `message.message.format` | enum | yes | Text rendering format.<br>*One of:* `ASCII`, `HTML`, `URI`, `UTF8` |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `NotSupported`, `Rejected`, `UnknownTransaction` |

---

## Tariff and cost

### CostUpdated

**CSMS → Station** · Tariff and cost · introduced in Milestone 11

New in 2.0.1. You compute cost as meter values arrive and push it so the driver sees a live price on the charger itself. Prepaid charging without this feels broken.

**When it fires.** Every meter value, or on a timer, during a transaction.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `totalCost` | decimal | yes | Running cost so far. |
| `transactionId` | string(36) | yes | Which transaction. |

**Response.** Empty.

---

## Security

### SecurityEventNotification

**Station → CSMS** · Security · required for a conformant implementation · introduced in Milestone 13

Firmware updates, failed authentications, tampered enclosures, certificate expiry. In 1.6 this existed only in the optional security whitepaper; in 2.0.1 it is core.

**When it fires.** Enclosure opened, reset, firmware changed, invalid credentials, certificate about to expire.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | string(50) | yes | Event type from the specification list.<br>*One of:* `FirmwareUpdated`, `FailedToAuthenticateAtCsms`, `CsmsFailedToAuthenticate`, `SettingSystemTime`, `StartupOfTheDevice`, `ResetOrReboot`, `SecurityLogWasCleared`, `ReconfigurationOfSecurityParameters`, `MemoryExhaustion`, `InvalidMessages`, `AttemptedReplayAttacks`, `TamperDetectionActivated`, `InvalidFirmwareSignature`, `InvalidCsmsCertificate` |
| `timestamp` | dateTime | yes | When it happened. |
| `techInfo` | string(255) | no | Extra detail. |

> **Watch out — `type`.** TamperDetectionActivated means someone physically opened the charger. Page a human. This is the message that turns your CPMS into something a security team cares about.

**Response.** Empty.

---

### SignCertificate

**Station → CSMS** · Security · introduced in Milestone 13

The station generates a key pair and sends you a CSR; you (or your CA) sign it and return the certificate via CertificateSigned. This is how security profile 3 (mutual TLS) is bootstrapped and rotated without a site visit.

**When it fires.** Initial provisioning and certificate renewal.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `csr` | string(5500) | yes | PEM-encoded CSR. |
| `certificateType` | enum | no | What the certificate is for.<br>*One of:* `ChargingStationCertificate`, `V2GCertificate` |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

---

### CertificateSigned

**CSMS → Station** · Security · introduced in Milestone 13

The answer to SignCertificate, sent as a separate CALL.

**When it fires.** After your CA signs the CSR.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `certificateChain` | string(10000) | yes | PEM chain, leaf first. |
| `certificateType` | enum | no | Matching type. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

---

## Smart charging

### SetChargingProfile

**CSMS → Station** · Smart charging · introduced in Milestone 10

Same concept as 1.6 with more purposes and better ISO 15118 integration. Profiles are now addressed by evseId, and a new PriorityCharging purpose supports "charge this one fast".

**When it fires.** Load management; prepaid caps; grid demand response.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `evseId` | integer | yes | 0 for a station-wide limit. |
| `chargingProfile.chargingProfilePurpose` | enum | yes | Role of this profile.<br>*One of:* `ChargingStationExternalConstraints`, `ChargingStationMaxProfile`, `TxDefaultProfile`, `TxProfile`, `PriorityCharging` |
| `chargingProfile.chargingSchedule[]` | ChargingSchedule[] | yes | Now an ARRAY — several schedules in different units may be offered. |
| `chargingProfile.transactionId` | string(36) | no | Required when purpose is TxProfile. |

> **Watch out — `chargingProfile.chargingSchedule[]`.** It is a list in 2.0.1 where 1.6 had a single object. Sending an object instead of an array is a very common porting bug and produces an unhelpful schema error.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

**Equivalent in the other version:** `SetChargingProfile`

---

## ISO 15118 / Plug & Charge

### NotifyEVChargingNeeds

**Station → CSMS** · ISO 15118 / Plug & Charge · introduced in Milestone 10

With ISO 15118 the vehicle negotiates: it reports target state of charge, departure time and energy needed. This has no 1.6 equivalent at all — it is the foundation of genuinely smart charging, because you can now optimise against a deadline instead of guessing.

**When it fires.** When an ISO 15118 vehicle connects and completes its handshake.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `evseId` | integer | yes | Which EVSE. |
| `chargingNeeds.requestedEnergyTransfer` | enum | yes | AC or DC, single or three phase, bidirectional.<br>*One of:* `AC_single_phase`, `AC_two_phase`, `AC_three_phase`, `DC` |
| `chargingNeeds.departureTime` | dateTime | no | When the driver wants to leave. The input smart charging was missing. |
| `chargingNeeds.acChargingParameters` | object | no | Energy amount, max voltage, max current, min current. |
| `chargingNeeds.dcChargingParameters` | object | no | Includes stateOfCharge and energyAmount — the battery telling you its state. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

---

## Local authorisation list

### SendLocalList

**CSMS → Station** · Local authorisation list · introduced in Milestone 7

Same mechanism as 1.6, using typed IdToken objects.

**When it fires.** Token changes; scheduled sync.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `versionNumber` | integer | yes | Resulting version. |
| `updateType` | enum | yes | Full or incremental.<br>*One of:* `Differential`, `Full` |
| `localAuthorizationList` | AuthorizationData[] | no | Entries; omit idTokenInfo to delete one. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Failed`, `VersionMismatch` |

**Equivalent in the other version:** `SendLocalList`

---

### GetLocalListVersion

**CSMS → Station** · Local authorisation list · introduced in Milestone 7

Unchanged from 1.6.

**When it fires.** Before syncing.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `versionNumber` | integer | yes | Current version. |

**Equivalent in the other version:** `GetLocalListVersion`

---

## Firmware management

### UpdateFirmware

**CSMS → Station** · Firmware management · introduced in Milestone 7

The important addition over 1.6 is `signature` and `signingCertificate`: the station can verify the image is genuine before installing it. Unsigned firmware updates were a real attack path in 1.6 deployments.

**When it fires.** Fleet rollout.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestId` | integer | yes | Correlates status reports. |
| `firmware.location` | string(512) | yes | Download URL. |
| `firmware.retrieveDateTime` | dateTime | yes | When to download. |
| `firmware.signingCertificate` | string(5500) | no | Certificate that signed the image. |
| `firmware.signature` | string(800) | no | Signature over the image. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `AcceptedCanceled`, `InvalidCertificate`, `RevokedCertificate` |

**Equivalent in the other version:** `UpdateFirmware`

---

## Data transfer

### DataTransfer

**Either direction** · Data transfer · introduced in Milestone 7

Unchanged in purpose from 1.6.

**When it fires.** Vendor extensions.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vendorId` | string(255) | yes | Vendor namespace. |
| `messageId` | string(50) | no | Vendor message type. |
| `data` | any | no | Now any JSON, not just a string. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `UnknownMessageId`, `UnknownVendorId` |

**Equivalent in the other version:** `DataTransfer`

---

## Reservation

### ReserveNow

**CSMS → Station** · Reservation · introduced in Milestone 7

Now optionally constrained to a connector type, so a CCS reservation stays CCS.

**When it fires.** Driver reserves in the app.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | integer | yes | Reservation id. |
| `expiryDateTime` | dateTime | yes | When it lapses. |
| `idToken` | IdToken | yes | Who it is for. |
| `evseId` | integer | no | Which EVSE. |
| `connectorType` | enum | no | Reserve a specific connector type. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Faulted`, `Occupied`, `Rejected`, `Unavailable` |

**Equivalent in the other version:** `ReserveNow`

---

### ReservationStatusUpdate

**Station → CSMS** · Reservation · introduced in Milestone 7

New in 2.0.1. In 1.6 you had to guess when a reservation lapsed by watching the clock; now the station tells you, so you can release the hold and refund promptly.

**When it fires.** Reservation expiry or cancellation at the station.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `reservationId` | integer | yes | Which reservation. |
| `reservationUpdateStatus` | enum | yes | What happened.<br>*One of:* `Expired`, `Removed` |

**Response.** Empty.

---
