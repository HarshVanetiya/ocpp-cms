# Glossary

Every acronym you will meet in the specifications, in the industry, and in an
interview.

## The essentials

| Term | Meaning |
|---|---|
| **OCPP** | Open Charge Point Protocol. Server ↔ charger. |
| **OCPI** | Open Charge Point Interface. Company ↔ company (roaming). |
| **CSMS** | Charging Station Management System — the server. Called the "Central System" in OCPP 1.6. |
| **CPMS** | Charge Point Management System — the whole product: CSMS + dashboards + billing. |
| **CP** | Charge Point. The physical unit. 2.0.1 calls it a Charging Station. |
| **EVSE** | Electric Vehicle Supply Equipment. One place exactly one car can charge. |
| **Connector** | One socket or cable. An EVSE may have several, usable one at a time. |
| **CPO** | Charge Point Operator. Owns and runs the hardware. |
| **eMSP** | e-Mobility Service Provider. Owns the customer, issues the card. |
| **EMP** | Another name for eMSP. |
| **MSP** | Another name for eMSP. The industry is not consistent. |

## Charging and sessions

| Term | Meaning |
|---|---|
| **Transaction** | OCPP's word for one charge, start to finish. |
| **Session** | Everyone else's word for the same thing. OCPI uses it too. |
| **CDR** | Charge Detail Record. The immutable billing document a session produces. |
| **idTag** | OCPP 1.6: the identifier read from an RFID card. Max 20 characters. |
| **idToken** | OCPP 2.0.1: the same idea, as a typed object. Max 36 characters. |
| **eMAID** | e-Mobility Account Identifier. The pan-European contract id that identifies a driver **across** networks. Sometimes written EMAID or EMA-ID. |
| **Measurand** | What a meter reading measures: energy, power, voltage, state of charge. |
| **SoC** | State of Charge. How full the battery is, as a percentage. |
| **Meter value** | One sampled reading during a session. |
| **Wh / kWh / MWh** | Watt-hours. Store Wh as integers; convert only when rendering. |

## Connector types

| Term | Meaning |
|---|---|
| **Type 2** (IEC 62196-2) | The standard European AC connector. Up to 22 kW. |
| **Type 1** (J1772) | The older North American / Japanese AC connector. |
| **CCS** | Combined Charging System. Type 2 (or 1) plus two DC pins. CCS2 in Europe, CCS1 in North America. The dominant DC standard. |
| **CHAdeMO** | The Japanese DC standard. Declining outside Japan. |
| **GB/T** | The Chinese standard, AC and DC variants. |
| **Schuko** | An ordinary domestic socket. Slow, common on cheap home units. |
| **Tethered** | The cable is attached to the charger. Cannot be unlocked or removed. |
| **Untethered** | You bring your own cable. |

## Protocol mechanics

| Term | Meaning |
|---|---|
| **CALL / CALLRESULT / CALLERROR** | The three OCPP-J frame types: 2, 3 and 4. |
| **Message id** | The correlation id at index 1 of every frame. |
| **Feature profile** | OCPP 1.6's grouping of optional messages: Core, FirmwareManagement, LocalAuthListManagement, Reservation, SmartCharging, RemoteTrigger. |
| **Functional block** | OCPP 2.0.1's replacement for feature profiles. |
| **Configuration key** | OCPP 1.6: a named string setting on a station. |
| **Device model** | OCPP 2.0.1: the typed component/variable tree that replaced configuration keys. |
| **Component / Variable** | The two levels of the 2.0.1 device model. |
| **Local authorisation list** | A list of valid cards stored **on the station**, so it can authorise while offline. |
| **Auth cache** | The station's memory of recent authorisation answers. Clear it when you block a card. |
| **Security profile** | 0 = none, 1 = Basic auth, 2 = TLS + Basic, 3 = mutual TLS. |

## Smart charging

| Term | Meaning |
|---|---|
| **Charging profile** | A schedule of power limits sent to a station. |
| **ChargePointMaxProfile** | A limit for the whole station. |
| **TxDefaultProfile** | A limit applied to any transaction. |
| **TxProfile** | A limit for one specific transaction. Wins over the others. |
| **Stack level** | Which profile wins when several overlap. Higher wins. |
| **Composite schedule** | The flattened result of all stacked profiles — what the station will actually do. |
| **Load management** | Keeping a site's total draw under its grid connection limit. |
| **V2G** | Vehicle to Grid. The car discharges back into the network. |
| **DSO / DNO** | Distribution System / Network Operator. The company that owns the local grid and sets your connection limit. |

## ISO 15118 and Plug & Charge

| Term | Meaning |
|---|---|
| **ISO 15118** | The standard for communication between the **car** and the **charger**, over the cable. |
| **Plug & Charge** | Plug in and it just works — the car identifies itself by certificate. No card, no app. |
| **PnC** | Abbreviation of the above. |
| **V2G Root / MO Root** | Certificate authorities in the Plug & Charge trust chain. |
| **Contract certificate** | What the car presents to prove who pays. |

## Roaming

| Term | Meaning |
|---|---|
| **Hub** | A party that speaks OCPI to everyone, so you integrate once instead of N times. Hubject is the largest. |
| **Party id** | Three characters identifying a company within a country. |
| **Country code** | ISO-3166 alpha-2. Together with party id it uniquely names a party: `NL-MEM`. |
| **Token** | In OCPI, a customer's card or app identity — not an auth credential. Confusing but standard. |
| **Whitelist** | Whether a token may be used offline: `ALWAYS`, `ALLOWED`, `ALLOWED_OFFLINE`, `NEVER`. |
| **OCHP / eMIP / OICP** | Other roaming protocols. OCPI is the open, modern one. |

## Operations

| Term | Meaning |
|---|---|
| **Uptime** | Share of time a station was reachable. The number an SLA is written against. |
| **Utilisation** | Share of time a connector was occupied. The number a business cares about. |
| **Availability** | Whether a connector is currently usable. |
| **Ghost charging** | A session that appears to be running but is not. Usually a lost `StopTransaction`. |
| **Idle fee / parking fee** | Charged after the car is full but still plugged in. |
| **Ad-hoc charging** | Charging without an account — pay by card or QR code at the charger. |
| **AFIR** | EU regulation requiring ad-hoc payment and price transparency at public chargers. |

---

Back to **[the primer](README.md)**.
