# OCPP 1.6J message reference

<!-- GENERATED FILE — edit packages/ocpp/src, then run `npm run docs:reference`. -->

Every message this project handles, what it means, and the specific thing
in each one that will cost you an afternoon.

A **core** message (●) is one a minimally conformant CSMS must implement.
The rest are optional profiles that real hardware may or may not support —
and which a station advertises through the `SupportedFeatureProfiles`
configuration key.

New to the protocol? Read [the primer](README.md) first.

## Every message at a glance

| Message | Direction | Group | Core | What it is for |
|---|---|---|---|---|
| [`BootNotification`](#bootnotification) | Station → CSMS | Core | ● | Station introduces itself and asks for permission to operate |
| [`Heartbeat`](#heartbeat) | Station → CSMS | Core | ● | Keep-alive and clock sync |
| [`StatusNotification`](#statusnotification) | Station → CSMS | Core | ● | A connector changed state, or reported a fault |
| [`Authorize`](#authorize) | Station → CSMS | Core | ● | May this card start a charge? |
| [`StartTransaction`](#starttransaction) | Station → CSMS | Core | ● | A charge has begun |
| [`StopTransaction`](#stoptransaction) | Station → CSMS | Core | ● | The charge has ended |
| [`MeterValues`](#metervalues) | Station → CSMS | Core | ● | Periodic measurements during a charge |
| [`DataTransfer`](#datatransfer) | Either direction | Data transfer | ○ | Vendor-specific escape hatch |
| [`RemoteStartTransaction`](#remotestarttransaction) | CSMS → Station | Core | ● | Ask a station to start charging |
| [`RemoteStopTransaction`](#remotestoptransaction) | CSMS → Station | Core | ● | Ask a station to stop a charge |
| [`UnlockConnector`](#unlockconnector) | CSMS → Station | Core | ○ | Release a stuck cable |
| [`Reset`](#reset) | CSMS → Station | Core | ● | Reboot the station |
| [`ChangeAvailability`](#changeavailability) | CSMS → Station | Core | ● | Take a connector or the whole station out of service |
| [`GetConfiguration`](#getconfiguration) | CSMS → Station | Core | ● | Read the station settings |
| [`ChangeConfiguration`](#changeconfiguration) | CSMS → Station | Core | ● | Write one station setting |
| [`ClearCache`](#clearcache) | CSMS → Station | Core | ● | Forget cached authorizations |
| [`TriggerMessage`](#triggermessage) | CSMS → Station | Remote trigger | ○ | Ask the station to send a message now |
| [`ReserveNow`](#reservenow) | CSMS → Station | Reservation | ○ | Hold a connector for one driver |
| [`CancelReservation`](#cancelreservation) | CSMS → Station | Reservation | ○ | Release a held connector |
| [`GetLocalListVersion`](#getlocallistversion) | CSMS → Station | Local authorisation list | ○ | Which version of the offline card list does the station hold? |
| [`SendLocalList`](#sendlocallist) | CSMS → Station | Local authorisation list | ○ | Push the offline card list |
| [`SetChargingProfile`](#setchargingprofile) | CSMS → Station | Smart charging | ○ | Limit how much power a station or transaction may draw |
| [`ClearChargingProfile`](#clearchargingprofile) | CSMS → Station | Smart charging | ○ | Remove charging limits |
| [`GetCompositeSchedule`](#getcompositeschedule) | CSMS → Station | Smart charging | ○ | Ask the station what limit it will actually apply |
| [`UpdateFirmware`](#updatefirmware) | CSMS → Station | Firmware management | ○ | Tell the station to fetch and install firmware |
| [`FirmwareStatusNotification`](#firmwarestatusnotification) | Station → CSMS | Firmware management | ○ | Firmware update progress |
| [`GetDiagnostics`](#getdiagnostics) | CSMS → Station | Firmware management | ○ | Ask the station to upload its logs |
| [`DiagnosticsStatusNotification`](#diagnosticsstatusnotification) | Station → CSMS | Firmware management | ○ | Diagnostics upload progress |

---

## Core

### BootNotification

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 2

The first message after the WebSocket opens. The station tells you what it is; you tell it whether it may work, how often to send heartbeats, and what time it is. Your answer of `Accepted`, `Pending` or `Rejected` is the gate for the whole session: until you say Accepted, the station may only send BootNotification and Heartbeat.

**When it fires.** On power-up, after a reset, and after the station reconnects following a network drop. A station stuck in a boot loop will send this repeatedly — that pattern in your log usually means you answered Rejected or the station cannot parse your response.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `chargePointVendor` | string(20) | yes | Manufacturer name, free text. |
| `chargePointModel` | string(20) | yes | Model name, free text. |
| `chargePointSerialNumber` | string(25) | no | Serial number of the charge point. |
| `chargeBoxSerialNumber` | string(25) | no | Deprecated in 1.6 but still widely sent. Treat as an alias of the above. |
| `firmwareVersion` | string(50) | no | Currently installed firmware. Store it — you will want it for fleet reports. |
| `iccid` | string(20) | no | SIM card ICCID. |
| `imsi` | string(20) | no | SIM card IMSI. |
| `meterType` | string(25) | no | Type of the built-in energy meter. |
| `meterSerialNumber` | string(25) | no | Serial number of the energy meter. Matters for legal metrology. |

> **Watch out — `chargePointModel`.** Only 20 characters. Real vendors truncate awkwardly; do not try to parse meaning out of it.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station may operate.<br>*One of:* `Accepted`, `Pending`, `Rejected` |
| `currentTime` | dateTime | yes | The station sets its clock from this. Send real UTC with a Z suffix. A wrong clock here corrupts every timestamp in every transaction the station ever reports. |
| `interval` | integer | yes | Heartbeat interval in seconds when Accepted; retry interval when Pending or Rejected. |

> **Watch out — `status`.** Pending means "wait, I am configuring you" — the station stays connected and keeps sending BootNotification at `interval`. Rejected means "go away and retry later". Using Rejected for an unknown station is correct; using it for a temporary database error is not, because some firmware backs off very aggressively.

> **Watch out — `interval`.** The same field means two different things depending on status. 300 is a sane heartbeat; 10 as a retry interval on Rejected will hammer you.

**Equivalent in the other version:** `BootNotification`

---

### Heartbeat

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 2

An empty message whose only job is to prove the station is still there, and to let it re-sync its clock from your response. A station only sends it when nothing else has been sent for `interval` seconds — a busy station may never send one at all.

**When it fires.** Every `interval` seconds of silence. If you have not heard ANY message for about 2.5 intervals, mark the station offline. Do not mark it offline after one missed beat; mobile networks lose single packets constantly.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `currentTime` | dateTime | yes | Current UTC time, used by the station to correct its clock drift. |

**Equivalent in the other version:** `Heartbeat`

---

### StatusNotification

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 5

The station reports the state of one connector. This is how the dashboard knows a plug is free, occupied or broken. It is also the only way 1.6 reports hardware faults.

**When it fires.** On every state change, and usually once per connector right after boot. Also on demand via TriggerMessage.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | Which connector. 0 means the charge point as a whole, not a socket. |
| `errorCode` | enum | yes | Fault code. `NoError` when everything is fine — it is required either way.<br>*One of:* `ConnectorLockFailure`, `EVCommunicationError`, `GroundFailure`, `HighTemperature`, `InternalError`, `LocalListConflict`, `NoError`, `OtherError`, `OverCurrentFailure`, `OverVoltage`, `PowerMeterFailure`, `PowerSwitchFailure`, `ReaderFailure`, `ResetFailure`, `UnderVoltage`, `WeakSignal` |
| `status` | enum | yes | The connector state.<br>*One of:* `Available`, `Preparing`, `Charging`, `SuspendedEV`, `SuspendedEVSE`, `Finishing`, `Reserved`, `Unavailable`, `Faulted` |
| `timestamp` | dateTime | no | When the change happened at the station. |
| `info` | string(50) | no | Free-text detail. |
| `vendorId` | string(255) | no | Namespace for vendorErrorCode. |
| `vendorErrorCode` | string(50) | no | Manufacturer-specific error code. The one the field engineer actually needs. |

> **Watch out — `connectorId`.** connectorId 0 is the single most common source of bugs in a first CPMS. A Faulted on connector 0 means the WHOLE STATION is broken, not connector zero — there is no connector zero. Handle it as a station-level status or you will show phantom connectors.

> **Watch out — `status`.** SuspendedEV means the CAR stopped drawing (usually it is full). SuspendedEVSE means the CHARGER stopped supplying (load management, or a fault). Drivers phone about the first and engineers get paged about the second, so never collapse them into one state.

> **Watch out — `timestamp`.** Optional, and often absent or wrong. Store both the station timestamp and your own received-at time, and show your own in the UI. Station clocks drift and reset.

**Response.** Empty.

**Equivalent in the other version:** `StatusNotification`

---

### Authorize

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 5

Sent when someone presents an RFID card. You look the tag up and answer. This is a pure question — it does not start anything.

**When it fires.** On card presentation, before StartTransaction. A station with a cached authorization may skip it entirely and go straight to StartTransaction, so never assume Authorize always precedes a transaction.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idTag` | string(20) | yes | The identifier read from the card. |

> **Watch out — `idTag`.** Maximum 20 characters in 1.6. Readers differ on byte order and case for the same physical card — normalise to uppercase before comparing, and store the normalised form.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idTagInfo.status` | enum | yes | The decision.<br>*One of:* `Accepted`, `Blocked`, `Expired`, `Invalid`, `ConcurrentTx` |
| `idTagInfo.expiryDate` | dateTime | no | When this authorization stops being valid. The station caches until then. |
| `idTagInfo.parentIdTag` | string(20) | no | Groups cards together. Any card sharing a parentIdTag may stop a transaction started by another — this is how a household or a fleet shares one charger. |

**Equivalent in the other version:** `Authorize`

---

### StartTransaction

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 5

The station tells you energy is about to flow. You answer with a transactionId that the station will quote in every MeterValues and in StopTransaction. YOU allocate that id in 1.6 — this is reversed in 2.0.1.

**When it fires.** After the cable is connected and authorization has succeeded.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | Which connector. Must be > 0 here. |
| `idTag` | string(20) | yes | Who is charging. |
| `meterStart` | integer | yes | Meter reading in Wh at the moment charging began. |
| `reservationId` | integer | no | Set when this charge consumes an existing reservation. |
| `timestamp` | dateTime | yes | When charging started, per the station clock. |

> **Watch out — `meterStart`.** This is the LIFETIME register of the meter, not zero. Energy delivered is meterStop − meterStart. Storing meterStart as the session total is a classic bug that produces sessions of 4,000,000 kWh.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transactionId` | integer | yes | The id you assign. Must be unique across your entire CSMS. |
| `idTagInfo.status` | enum | yes | You may still reject here. If you do, the station must stop and will send StopTransaction with reason DeAuthorized.<br>*One of:* `Accepted`, `Blocked`, `Expired`, `Invalid`, `ConcurrentTx` |

> **Watch out — `transactionId`.** Integer, and the station may store it in 32 bits. Do not use a timestamp in milliseconds. A per-CSMS sequence is correct. Never reuse an id, even years later.

**Equivalent in the other version:** `TransactionEvent (eventType=Started)`

---

### StopTransaction

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 5

Final meter reading and the reason it stopped. This is the message that produces a bill, so treat it as the most important one in the protocol.

**When it fires.** When the cable is unplugged, a card is presented again, you send RemoteStopTransaction, or the station faults. Also sent for transactions that were queued offline, sometimes hours later.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transactionId` | integer | yes | The id you handed out in StartTransaction. |
| `meterStop` | integer | yes | Final meter reading in Wh. |
| `timestamp` | dateTime | yes | When charging stopped. |
| `idTag` | string(20) | no | Who stopped it. Absent when the car simply unplugged. |
| `reason` | enum | no | Why it stopped. Absent means "Local" by specification.<br>*One of:* `EmergencyStop`, `EVDisconnected`, `HardReset`, `Local`, `Other`, `PowerLoss`, `Reboot`, `Remote`, `SoftReset`, `UnlockCommand`, `DeAuthorized` |
| `transactionData` | MeterValue[] | no | A final batch of meter samples, often the whole session at once. |

> **Watch out — `transactionData`.** Stations that were offline dump their entire buffered session here. Be ready for a single message containing thousands of samples — and be ready for it to arrive for a transaction you already closed.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idTagInfo` | IdTagInfo | no | Optional updated status for the card that stopped the charge. |

**Equivalent in the other version:** `TransactionEvent (eventType=Ended)`

---

### MeterValues

**Station → CSMS** · Core · required for a conformant implementation · introduced in Milestone 5

A batch of samples. The nesting is three deep: a list of timestamps, each holding a list of sampled values, each with its own measurand, unit, phase and context. Flatten it on the way in — see the note on pivoting in the contracts package.

**When it fires.** Every `MeterValueSampleInterval` seconds during a transaction, and at the clock-aligned interval outside one. Both intervals are configuration keys you control.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | Which connector. |
| `transactionId` | integer | no | Present when these samples belong to a transaction. |
| `meterValue[].timestamp` | dateTime | yes | When this sample set was taken. |
| `meterValue[].sampledValue[].value` | string | yes | The reading — as a STRING, even though it is a number. |
| `meterValue[].sampledValue[].measurand` | enum | no | What was measured. Defaults to Energy.Active.Import.Register when absent.<br>*One of:* `Energy.Active.Import.Register`, `Power.Active.Import`, `Current.Import`, `Voltage`, `SoC`, `Temperature`, `Current.Offered`, `Power.Offered`, `Energy.Active.Export.Register`, `Frequency` |
| `meterValue[].sampledValue[].unit` | enum | no | Wh, kWh, W, kW, A, V, Celsius, Percent... |
| `meterValue[].sampledValue[].phase` | enum | no | L1, L2, L3, N or a combination. Absent means the total across all phases. |
| `meterValue[].sampledValue[].context` | enum | no | Why the sample was taken: Sample.Periodic, Transaction.Begin, Trigger... |

> **Watch out — `transactionId`.** Absent for clock-aligned samples taken while idle. Do not assume every MeterValues has a transaction to attach to.

> **Watch out — `meterValue[].sampledValue[].value`.** It really is a string in the schema. Parse it defensively; some firmware sends "1234.00", some sends "1,234", and some sends an empty string for "no reading".

> **Watch out — `meterValue[].sampledValue[].unit`.** Wh and kWh are both legal for the same measurand. Normalise to Wh at ingest or your energy totals will be out by a factor of 1000 for some vendors only.

**Response.** Empty.

**Equivalent in the other version:** `TransactionEvent (with meterValue) / MeterValues`

---

### RemoteStartTransaction

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

What the driver app and the dashboard "start" buttons turn into. The station answers Accepted or Rejected immediately — but Accepted only means it will try.

**When it fires.** Driver taps start in the app; operator clicks start in the dashboard.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `idTag` | string(20) | yes | The identifier to bill. Must be one you will later authorize. |
| `connectorId` | integer | no | Which connector. Omit to let the station choose. |
| `chargingProfile` | ChargingProfile | no | Optional limits for this transaction. This is how you cap the energy a prepaid driver can draw — nothing else enforces the amount they paid. |

> **Watch out — `connectorId`.** Omitting it on a multi-connector station means the station picks, and it may pick the one the driver is not standing at. Always send it when you know it.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station will attempt it.<br>*One of:* `Accepted`, `Rejected` |

> **Watch out — `status`.** Accepted does NOT mean charging started. The transaction only exists once StartTransaction arrives, which may be much later or never, because the driver still has to plug in. Design your UI around that gap.

**Equivalent in the other version:** `RequestStartTransaction`

---

### RemoteStopTransaction

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Stops one transaction by id. As with remote start, the real confirmation is the StopTransaction that follows.

**When it fires.** Driver taps stop; operator stops a session; prepaid limit reached.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `transactionId` | integer | yes | Which transaction to stop. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station will attempt it.<br>*One of:* `Accepted`, `Rejected` |

> **Watch out — `status`.** Rejected usually means the transactionId is unknown to the station — which means your database and the station disagree about what is running. Worth alerting on.

**Equivalent in the other version:** `RequestStopTransaction`

---

### UnlockConnector

**CSMS → Station** · Core · introduced in Milestone 6

Physically unlocks the connector latch. A real support workflow: the driver cannot get their cable out and phones you.

**When it fires.** Support agent clicks unlock.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | Which connector. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result of the attempt.<br>*One of:* `Unlocked`, `UnlockFailed`, `NotSupported` |

> **Watch out — `status`.** Many DC chargers have tethered cables that cannot unlock, and answer NotSupported. Hide the button for those, or your support team will keep clicking it.

**Equivalent in the other version:** `UnlockConnector`

---

### Reset

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Hard is a power-cycle: it drops everything immediately. Soft asks the software to restart gracefully, finishing what it can first.

**When it fires.** Operator clicks reset, usually after a fault the station will not clear.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `type` | enum | yes | Hard = immediate power cycle. Soft = graceful software restart.<br>*One of:* `Hard`, `Soft` |

> **Watch out — `type`.** A Hard reset during a transaction loses the session — you will get a StopTransaction with reason HardReset if you are lucky, and nothing at all if you are not. Warn the operator when a session is running.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether the station accepted the reset.<br>*One of:* `Accepted`, `Rejected` |

**Equivalent in the other version:** `Reset`

---

### ChangeAvailability

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Marks hardware Operative or Inoperative. Used for maintenance windows and for disabling a connector that keeps faulting.

**When it fires.** Operator schedules maintenance, or disables a broken plug.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | 0 for the whole station, or a specific connector. |
| `type` | enum | yes | The target availability.<br>*One of:* `Inoperative`, `Operative` |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `Scheduled` |

> **Watch out — `status`.** Scheduled means "there is a transaction running, I will do it when that finishes". Your UI must show a pending state, not success — the connector is still live.

**Equivalent in the other version:** `ChangeAvailability`

---

### GetConfiguration

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Returns key/value pairs. Send no keys to get everything the station is willing to share.

**When it fires.** Operator opens the configuration tab.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `key` | string[] | no | Specific keys to read. Omit for all of them. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `configurationKey` | KeyValue[] | no | Each with key, readonly and value. |
| `unknownKey` | string[] | no | Keys you asked for that the station does not have. |

> **Watch out — `unknownKey`.** Surface these in the UI. An unknown key usually means the station does not support the feature you were about to configure, which is useful to know early.

**Equivalent in the other version:** `GetVariables`

---

### ChangeConfiguration

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Sets a single key. Values are always strings, even numeric ones.

**When it fires.** Operator edits a configuration value.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `key` | string(50) | yes | Key name, case-sensitive. |
| `value` | string(500) | yes | New value, as a string. "300", not 300. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `RebootRequired`, `NotSupported` |

> **Watch out — `status`.** RebootRequired means the value is stored but not active. Your UI must say so, otherwise the operator will think the change did nothing and change it again.

**Equivalent in the other version:** `SetVariables`

---

### ClearCache

**CSMS → Station** · Core · required for a conformant implementation · introduced in Milestone 6

Stations cache Authorize results so they can work offline. When you block a card, the cache is what still lets it charge — clear it.

**When it fires.** Immediately after blocking or deleting a token.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

**Equivalent in the other version:** `ClearCache`

---

## Data transfer

### DataTransfer

**Either direction** · Data transfer · introduced in Milestone 7

The officially sanctioned way to send something the specification does not cover. Both sides may send it. In practice it carries everything from display messages to payment terminal data, and every vendor uses it differently.

**When it fires.** Whenever a vendor needs a feature OCPP does not have.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `vendorId` | string(255) | yes | Reverse-DNS vendor namespace, e.g. com.example. |
| `messageId` | string(50) | no | Vendor message type. |
| `data` | string | no | Free-form payload, often JSON-in-a-string. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Whether you understood it.<br>*One of:* `Accepted`, `Rejected`, `UnknownMessageId`, `UnknownVendorId` |
| `data` | string | no | Vendor response payload. |

**Equivalent in the other version:** `DataTransfer`

---

## Remote trigger

### TriggerMessage

**CSMS → Station** · Remote trigger · introduced in Milestone 6

Rather than waiting for the next heartbeat or status change, ask for one on demand. The refresh button on a station page is exactly this.

**When it fires.** Operator clicks refresh; you want current state after a reconnect.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `requestedMessage` | enum | yes | Which message to ask for.<br>*One of:* `BootNotification`, `DiagnosticsStatusNotification`, `FirmwareStatusNotification`, `Heartbeat`, `MeterValues`, `StatusNotification` |
| `connectorId` | integer | no | For per-connector messages. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `NotImplemented` |

**Equivalent in the other version:** `TriggerMessage`

---

## Reservation

### ReserveNow

**CSMS → Station** · Reservation · introduced in Milestone 7

The connector reports Reserved and refuses other cards until the reservation expires.

**When it fires.** Driver reserves a charger in the app.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | 0 lets the station choose. |
| `expiryDate` | dateTime | yes | When the hold lapses. |
| `idTag` | string(20) | yes | Who the hold is for. |
| `parentIdTag` | string(20) | no | Allows any card in the group to claim it. |
| `reservationId` | integer | yes | Your id for this reservation, quoted back in StartTransaction. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Faulted`, `Occupied`, `Rejected`, `Unavailable` |

**Equivalent in the other version:** `ReserveNow`

---

### CancelReservation

**CSMS → Station** · Reservation · introduced in Milestone 7

Cancels by reservation id.

**When it fires.** Driver cancels, or the hold is cleaned up by a scheduled job.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `reservationId` | integer | yes | Which reservation. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |

**Equivalent in the other version:** `CancelReservation`

---

## Local authorisation list

### GetLocalListVersion

**CSMS → Station** · Local authorisation list · introduced in Milestone 7

The local list lets a station authorize cards with no network. Versioning it means you can send differences instead of the whole list every time.

**When it fires.** Before syncing the list, and as a periodic consistency check.

**Request.** Empty.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `listVersion` | integer | yes | Current version. 0 means empty, -1 means not supported. |

**Equivalent in the other version:** `GetLocalListVersion`

---

### SendLocalList

**CSMS → Station** · Local authorisation list · introduced in Milestone 7

Full replaces everything; Differential applies changes. Differential is what you want in production — a full list of 10,000 cards over a mobile link is painful.

**When it fires.** After token changes, on a schedule, or when versions disagree.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `listVersion` | integer | yes | The version this update produces. Must increase. |
| `updateType` | enum | yes | Full replacement or incremental change.<br>*One of:* `Differential`, `Full` |
| `localAuthorizationList` | AuthorizationData[] | no | Entries. An entry with no idTagInfo means DELETE this card. |

> **Watch out — `localAuthorizationList`.** Omitting idTagInfo is how you delete — it is not a malformed entry. Easy to get backwards, and getting it backwards leaves blocked cards working offline.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Failed`, `NotSupported`, `VersionMismatch` |

**Equivalent in the other version:** `SendLocalList`

---

## Smart charging

### SetChargingProfile

**CSMS → Station** · Smart charging · introduced in Milestone 10

The heart of load management. A profile is a schedule of limits over time. Three purposes stack: ChargePointMaxProfile caps the whole station, TxDefaultProfile applies to any transaction, TxProfile applies to one specific transaction and wins over the others.

**When it fires.** Site load management, prepaid energy caps, and demand response from the grid operator.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | 0 for a station-wide limit. |
| `csChargingProfiles.chargingProfileId` | integer | yes | Your id for this profile. |
| `csChargingProfiles.stackLevel` | integer | yes | Higher wins when profiles overlap. |
| `csChargingProfiles.chargingProfilePurpose` | enum | yes | Which of the three roles this profile plays.<br>*One of:* `ChargePointMaxProfile`, `TxDefaultProfile`, `TxProfile` |
| `csChargingProfiles.chargingProfileKind` | enum | yes | Absolute times, recurring daily/weekly, or relative to transaction start.<br>*One of:* `Absolute`, `Recurring`, `Relative` |
| `csChargingProfiles.chargingSchedule.chargingRateUnit` | enum | yes | W or A. |
| `csChargingProfiles.chargingSchedule.chargingSchedulePeriod[]` | array | yes | Each period has startPeriod (seconds from schedule start) and limit. |

> **Watch out — `csChargingProfiles.chargingSchedule.chargingRateUnit`.** Amps or watts is a per-station capability, not a choice. Sending A to a station that only accepts W gets you a rejection with no useful detail. Read the supported unit from the configuration key `ChargingScheduleAllowedChargingRateUnit` first.

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected`, `NotSupported` |

**Equivalent in the other version:** `SetChargingProfile`

---

### ClearChargingProfile

**CSMS → Station** · Smart charging · introduced in Milestone 10

Clears by id, or by any combination of connector, purpose and stack level.

**When it fires.** Load management releases a constraint; a prepaid session ends.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | integer | no | A specific profile id. |
| `connectorId` | integer | no | Filter by connector. |
| `chargingProfilePurpose` | enum | no | Filter by purpose. |
| `stackLevel` | integer | no | Filter by stack level. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Unknown` |

**Equivalent in the other version:** `ClearChargingProfile`

---

### GetCompositeSchedule

**CSMS → Station** · Smart charging · introduced in Milestone 10

With several stacked profiles, the effective limit is not obvious. This asks the station to flatten them and tell you the answer. Invaluable when load management misbehaves.

**When it fires.** Debugging smart charging; verifying a profile took effect.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `connectorId` | integer | yes | Which connector. |
| `duration` | integer | yes | How many seconds ahead. |
| `chargingRateUnit` | enum | no | W or A. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Result.<br>*One of:* `Accepted`, `Rejected` |
| `chargingSchedule` | ChargingSchedule | no | The flattened schedule the station will follow. |

**Equivalent in the other version:** `GetCompositeSchedule`

---

## Firmware management

### UpdateFirmware

**CSMS → Station** · Firmware management · introduced in Milestone 7

You give a URL; the station downloads and installs it itself. You do not push bytes over OCPP. Progress arrives as FirmwareStatusNotification.

**When it fires.** Fleet firmware rollout.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `location` | string | yes | URL to download from. Often FTP on older hardware. |
| `retrieveDate` | dateTime | yes | When to start downloading. Stagger these across a fleet. |
| `retries` | integer | no | Download retry count. |
| `retryInterval` | integer | no | Seconds between retries. |

> **Watch out — `location`.** The station fetches this itself, so the URL must be reachable from the STATION's network, not yours. Localhost URLs are a classic wasted afternoon.

**Response.** Empty.

**Equivalent in the other version:** `UpdateFirmware`

---

### FirmwareStatusNotification

**Station → CSMS** · Firmware management · introduced in Milestone 7

Progress reports during an update.

**When it fires.** After UpdateFirmware, at each stage.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Where the update has got to.<br>*One of:* `Downloaded`, `DownloadFailed`, `Downloading`, `Idle`, `InstallationFailed`, `Installing`, `Installed` |

**Response.** Empty.

**Equivalent in the other version:** `FirmwareStatusNotification`

---

### GetDiagnostics

**CSMS → Station** · Firmware management · introduced in Milestone 7

You supply an upload URL; the station posts a log bundle to it.

**When it fires.** Investigating a fault you cannot reproduce.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `location` | string | yes | Upload target URL. |
| `startTime` | dateTime | no | Oldest log to include. |
| `stopTime` | dateTime | no | Newest log to include. |
| `retries` | integer | no | Upload retry count. |

**Response fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `fileName` | string(255) | no | What the station will call the file. |

**Equivalent in the other version:** `GetLog`

---

### DiagnosticsStatusNotification

**Station → CSMS** · Firmware management · introduced in Milestone 7

Progress of a diagnostics upload.

**When it fires.** After GetDiagnostics.

**Request fields**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `status` | enum | yes | Upload state.<br>*One of:* `Idle`, `Uploaded`, `UploadFailed`, `Uploading` |

**Response.** Empty.

**Equivalent in the other version:** `LogStatusNotification`

---
