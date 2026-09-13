# Start here

You want to be able to say, truthfully, in an interview:

> "I built a CPMS that runs OCPP 1.6 and 2.0.1 side by side, a charge point
> simulator to test it against, OCPI roaming, and a driver app with prepaid
> charging."

This project is the shortest honest path to that sentence. Not a tutorial you
copy, and not a repository you clone and claim — a contract, a working
frontend, and a guide that walks you through building the server behind it.

---

## 1. What is actually going on in EV charging

Four things talk to each other. Everything else is detail.

```
      ┌──────────────┐                        ┌──────────────┐
      │   The car    │◄── the cable ─────────►│ Charge point │
      └──────────────┘   (ISO 15118, or       │  (hardware)  │
                          just electrons)     └───────┬──────┘
                                                      │
                                                      │  OCPP
                                                      │  one WebSocket,
                                                      │  open for years
                                                      ▼
  ┌──────────────┐                            ┌──────────────────┐
  │  Other CPOs  │◄──────── OCPI ────────────►│   YOUR  CPMS     │
  │  and eMSPs   │   (HTTP between companies) │  (what you build)│
  └──────────────┘                            └────────┬─────────┘
                                                       │ your own REST + WebSocket
                                                       ▼
                                            ┌────────────────────┐
                                            │ Dashboard · Driver │
                                            │  (already built)   │
                                            └────────────────────┘
```

- **OCPP** connects your server to **chargers**. It is a WebSocket, open
  permanently, carrying JSON-RPC messages in both directions.
- **OCPI** connects your server to **other companies**, so a driver with
  someone else's card can use your chargers. It is ordinary HTTP.
- Your own API connects your server to **your apps**. That part is normal web
  development, and this repo has already written the client half of it.

If you understand those three boundaries, you understand the industry's
architecture. Everything in the docs from here is detail hanging off this
picture.

---

## 2. The vocabulary, in one table

You will meet these constantly. Learn them now and the specifications stop
being intimidating.

| Term | What it means |
|---|---|
| **CP / Charge Point / Charging Station** | The physical box on the wall. |
| **EVSE** | One "parking bay" — a place exactly one car can charge. A station has one or more. |
| **Connector** | One socket or cable on an EVSE. A DC charger with CCS + CHAdeMO that serves one car at a time is **one EVSE, two connectors**. |
| **CSMS** | Charging Station Management System — the server. In OCPP 1.6 it was called the "Central System". |
| **CPMS** | Charge Point Management System — the whole product: CSMS plus dashboards, billing, users. What you are building. |
| **CPO** | Charge Point Operator. Owns the hardware. You. |
| **eMSP** | e-Mobility Service Provider. Owns the customer and issues the card or app. |
| **Transaction / Session** | One charge, start to finish. OCPP says transaction; everyone else says session. |
| **idTag / idToken** | The thing that identifies a driver: an RFID card number, an app identity. |
| **CDR** | Charge Detail Record. The immutable bill produced when a session ends. |
| **Meter values** | Periodic measurements during a charge: energy, power, voltage, state of charge. |
| **Tariff** | The rules that turn a session into a number of euros. |
| **Smart charging** | Telling a station how much power it may draw, and when. |

There is a fuller [glossary](01-ocpp-primer/glossary.md) with the acronyms you
will meet in the specifications.

---

## 3. How this repository is put together

```
packages/contracts   ← the single source of truth. Everything else follows it.
       │
       ├── packages/api-client   generated typed client
       ├── packages/mocks        fake server that implements the same contract
       └── apps/*                the three frontends
```

**`packages/contracts` is the most important directory in the repo.** Ninety
endpoints, each defined once as a Zod schema. From that one definition comes:

- the TypeScript types the apps use,
- the runtime validation that checks your backend's responses,
- `openapi.json`, which you can load into Postman or Swagger UI,
- and the build-progress checklist in the dashboard.

Open [`packages/contracts/src/enums.ts`](../packages/contracts/src/enums.ts)
first. It is the canonical model — the single vocabulary that both OCPP
versions map onto — and it is the idea the whole project is built around.

---

## 4. The learn-mode trick, and why it matters

Run `npm run dev:learn` and the dashboard is full of data. None of it is real.
A service worker in your browser is intercepting every request and answering
from fixtures.

But it does something cleverer than that. For every request it:

1. forwards it to your backend at `http://localhost:3000`;
2. if your backend answers **anything** — a success, a validation error, a
   500 — returns that answer untouched;
3. only if your backend is down, or answers `404`/`501` for that exact route,
   serves the mock instead.

So you never choose between "mocks" and "real". You get whatever is real, and
mocks for the rest, updating endpoint by endpoint as you build.

The dashboard's **Build progress** page lists all 90 endpoints grouped by
milestone, with a green tick against the ones your server has answered.

> Turn the mocks off entirely with `npm run dev`. Unimplemented routes then
> show a real error state, which is what you want once you are past the first
> few milestones.

---

## 5. Your route through the docs

**If you have never seen OCPP:** read the
[OCPP primer](01-ocpp-primer/README.md) end to end first. It is about forty
minutes and it will save you days.

**If you have never written TypeScript:** read the
[crash course](02-typescript-crash-course.md). It covers only what this project
uses — about two hours, and you will not need anything else.

**Then start [Milestone 0](03-build-the-backend/README.md).** Each milestone is
self-contained: what you are building, why it exists, the code, and a
"prove it works" section that tells you exactly what to look at in the UI.

Milestones 0–8 are the core. When you finish Milestone 8 you have a working
CPMS with a live dashboard, and you have already earned the sentence at the top
of this page. Milestones 9–13 are what turn it from a project into something
that would survive contact with a real fleet.

---

## 6. How long this takes

Honest numbers, assuming you are comfortable programming but new to OCPP:

| Milestones | What you get | Time |
|---|---|---|
| 0–3 | A station connects and talks to you | an evening |
| 4–5 | Real charging sessions in a database | a weekend |
| 6–8 | Remote control and a live dashboard | a weekend |
| 9–11 | Logs, tariffs, payments, the driver flow | a weekend |
| 12–13 | OCPI roaming and security | a weekend |

Add roughly a day for **[the simulator service](08-build-the-simulator/README.md)**,
which you start once Milestone 3 is done. It is the other side of the protocol
and it is what every "prove it works" section from Milestone 5 onward relies on.

You do not have to do all of it. Stop wherever you like — but read the
[interview prep](07-interview-prep.md) either way, because it tells you which
parts of what you built are the ones worth talking about.

---

Next: **[The OCPP primer →](01-ocpp-primer/README.md)**
