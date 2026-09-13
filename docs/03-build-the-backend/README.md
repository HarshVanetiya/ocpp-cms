# Build the backend

Fourteen milestones. Each one is self-contained: what you are building, why it
exists, the code, and how to prove it works by looking at the UI.

You are writing a **separate project** from this repository:

```
~/code/
├── ocpp-cms/          this repo — the frontend, already built
└── ocpp-cms-server/   what you are about to write
```

Keeping them apart is deliberate. It proves the two really are talking over the
contract and nothing else — which is also what makes the story credible when
you describe it to someone.

---

## The map

| | Milestone | You get | Endpoints |
|---|---|---|---|
| **0** | [Setup and health](milestone-00-setup.md) | A server the dashboard can see | 1 |
| **1** | [Project skeleton](milestone-01-skeleton.md) | Config, logging, errors, structure | — |
| **2** | [The WebSocket](milestone-02-websocket.md) | A station connects and boots | — |
| **3** | [The OCPP RPC layer](milestone-03-rpc.md) | Framing, routing, validation, timeouts | — |
| **4** | [Data model](milestone-04-data-model.md) | Postgres, migrations, the schema | — |
| **5** | [OCPP 1.6 core profile](milestone-05-core-profile.md) | Real charging sessions, stored | — |
| **6** | [Remote commands](milestone-06-remote-commands.md) | Start, stop, reset, configure | 6 |
| **7** | [OCPP 2.0.1](milestone-07-ocpp-201.md) | **Both versions, one codebase** | — |
| **8** | [The REST API](milestone-08-rest-api.md) | **The dashboard goes live** | 35 |
| **9** | [Realtime and logs](milestone-09-realtime.md) | The frame inspector, live | 2 |
| **10** | [Smart charging](milestone-10-smart-charging.md) | Power limits, load management | — |
| **11** | [Tariffs, payments, driver](milestone-11-tariffs-payments.md) | The whole money path | 24 |
| **12** | [OCPI roaming](milestone-12-ocpi.md) | Other networks' customers | 8 |
| **13** | [Security and audit](milestone-13-security.md) | Something you could deploy | 1 |

<a id="milestone-0"></a><a id="milestone-1"></a><a id="milestone-2"></a>
<a id="milestone-3"></a><a id="milestone-4"></a><a id="milestone-5"></a>
<a id="milestone-6"></a><a id="milestone-7"></a><a id="milestone-8"></a>
<a id="milestone-9"></a><a id="milestone-10"></a><a id="milestone-11"></a>
<a id="milestone-12"></a><a id="milestone-13"></a>

### The other side of the wire

From Milestone 3 onward you need something to talk to, and `wscat` runs out of
road quickly. **[Chapter 08 builds the simulator service](../08-build-the-simulator/README.md)**
— the program that pretends to be a charge point. Five short milestones,
numbered S0–S4 so they do not collide with these, and the first three are worth
doing as soon as your CSMS can answer a CALL.

Writing the sending side of the protocol is also the fastest way to learn it:
handling a message teaches you its shape, producing one teaches you why the
field is there.

### Where to stop

**Milestone 8 is the finish line for most people.** At that point you have a
CPMS that speaks both OCPP versions, stores real sessions, accepts remote
commands, and drives a professional dashboard. That is a complete, defensible
project.

9–13 are what separate "I built a CPMS" from "I have thought about running
one". Do them if you have the time; they are where the interesting interview
questions live.

---

## The stack, and why

| | Choice | Why |
|---|---|---|
| Runtime | **Node 20+** | The OCPP ecosystem is JavaScript-heavy, and you get one language across the whole stack |
| Language | **TypeScript** | See [the crash course](../02-typescript-crash-course.md) |
| HTTP | **Fastify** | Fast, first-class TypeScript, schema validation built in |
| WebSocket | **`ws`** | The standard library. Not Socket.IO — OCPP is plain WebSocket and Socket.IO adds a framing layer the chargers do not speak |
| Database | **Postgres** | Relational data with strict integrity, and it does time-series well enough via partitioning |
| Query layer | **`pg` + plain SQL** | You will read more SQL than you write; an ORM would hide the part worth learning |
| Cache / bus | **Redis** | From Milestone 9 onward: pub/sub and the connection registry |
| Validation | **Zod** | Already written for you in `packages/contracts` |

> **Why not Socket.IO.** It is a different protocol that happens to use
> WebSocket as a transport. A charge point speaks RFC 6455 WebSocket with an
> `ocpp1.6` subprotocol and nothing else. Use `ws`.

---

## How to work through a milestone

Each one has the same four parts:

1. **Why this exists** — the problem, before the code.
2. **Build it** — real code you can paste and run.
3. **Prove it works** — exactly what to click and what you should see.
4. **What you can now explain** — the interview angle.

Have three things open while you work:

- your editor,
- `npm run dev:learn` in this repo, on http://localhost:5173,
- the **simulator** on http://localhost:5174.

The simulator is your test harness from Milestone 2 onward. Point it at
`ws://localhost:3000/ocpp`, press buttons, and watch what your server does.

---

## A note on copying

The code in these milestones is real and it runs. You are meant to type it,
read it, and change it — not paste it and move on.

The parts that matter are the comments explaining **why**. If you only take the
code you will have a working server and no answers, which defeats the purpose.

---

Start: **[Milestone 0 — setup and health →](milestone-00-setup.md)**
