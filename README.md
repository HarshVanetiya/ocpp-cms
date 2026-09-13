# OCPP CPMS — learn it by building it

A complete, professional-grade **frontend** for an EV charging platform, plus a
hand-held guide to building the **backend** yourself.

You get three working web apps and a precise API contract. You write the server
that answers it. By the end you will have built a Charge Point Management System
that speaks **OCPP 1.6J and OCPP 2.0.1 at the same time**, a charge point
simulator, a driver app with prepaid charging, and **OCPI 2.2.1** roaming — and
you will be able to explain every part of it.

> **The point of this project.** Not to give you a repository to point at, but
> to make you the person who can answer follow-up questions about it. Every
> milestone tells you *why*, not just *what*, and the docs are written assuming
> you have never touched TypeScript.

---

## What is already built for you

| | |
|---|---|
| **CPMS dashboard** | Fleet overview, stations, live map, sessions, users, RFID tokens, tariffs, billing, OCPI partners — and a live OCPP frame inspector |
| **Station simulator** | Virtual charge points that open real WebSockets to your CSMS, with fault injection and scripted conformance scenarios |
| **Driver app** | Mobile-first: find a charger, enter an amount, watch it charge, get a receipt |
| **The contract** | 90 endpoints defined once as Zod schemas → TypeScript types → OpenAPI 3.1 |
| **A mock backend** | So every screen works on day one, before you have written a line of server code |

## What you build

A backend, in TypeScript, in fourteen milestones. Each one makes more of the UI
come alive, and the dashboard has a **Build progress** page that shows you
exactly which endpoints your server answers and which are still on mocks.

---

## Start in two minutes

```bash
git clone https://github.com/HarshVanetiya/ocpp-cms
cd ocpp-cms
npm install
npm run dev:learn
```

Open **http://localhost:5173** and everything works — live data, live charts, a
scrolling OCPP log. None of it is real yet; it is a mock backend running inside
your browser. That is the starting line.

| Command | What it does |
|---|---|
| `npm run dev:learn` | All three apps **with** the mock backend. Start here. |
| `npm run dev` | All three apps **without** mocks. Use this once you are building. |
| `npm run dev:dashboard` | CPMS console only → http://localhost:5173 |
| `npm run dev:simulator` | Simulator only → http://localhost:5174 |
| `npm run dev:driver` | Driver app only → http://localhost:5175 |
| `npm run contracts:openapi` | Regenerate `packages/contracts/openapi.json` |
| `npm run typecheck` | Typecheck every package and app |

### The bit that makes this work

In learn mode, every request goes to **your** backend first. Only if your
server is not running, or answers `404`/`501` for that route, does the mock
answer instead — and it stamps the response so the UI can show a small
`mocked` badge on the screen.

So the loop is:

1. Run `npm run dev:learn`. Everything works, everything says `mocked`.
2. Implement `GET /api/v1/stations` in your backend.
3. Refresh. The stations table is now **live**; everything else still works.
4. Repeat 89 more times.

You are never staring at a broken page, and you always know exactly how far
along you are.

---

## Read the docs in this order

| | |
|---|---|
| **[00 · Start here](docs/00-start-here.md)** | What you are building and how the pieces fit |
| **[01 · OCPP primer](docs/01-ocpp-primer/README.md)** | The protocol, explained from zero |
| **[02 · TypeScript crash course](docs/02-typescript-crash-course.md)** | Only the TypeScript this project needs |
| **[03 · Build the backend](docs/03-build-the-backend/README.md)** | The fourteen milestones |
| **[04 · Architecture](docs/04-architecture/README.md)** | The target shape and why |
| **[05 · Deployment](docs/05-deployment/README.md)** | Docker, Kubernetes, and what breaks in production |
| **[06 · Scaling](docs/06-scaling/README.md)** | From one box to a national network |
| **[07 · Interview prep](docs/07-interview-prep.md)** | The questions you will be asked, and good answers |
| **[08 · Build the simulator](docs/08-build-the-simulator/README.md)** | The other side of the wire — start it after Milestone 3 |

---

## Repository layout

```
ocpp-cms/
├── apps/
│   ├── dashboard/     CPMS operator console      (port 5173)
│   ├── simulator/     Charge point simulator     (port 5174)
│   └── driver/        Driver charging web app    (port 5175)
├── packages/
│   ├── contracts/     THE API CONTRACT — read this first
│   ├── ocpp/          OCPP 1.6J + 2.0.1 message catalogue
│   ├── ui/            Design system
│   ├── api-client/    Typed client + realtime
│   └── mocks/         Learn-mode mock backend
├── docs/              Everything above
└── design/canvas/     Design source for the visual language
```

Your backend does **not** live in this repository. Create it alongside:

```
~/code/
├── ocpp-cms/          this repo, the frontend
└── ocpp-cms-server/   what you are about to write
```

Keeping them separate is deliberate: it proves the two really are talking over
the contract and nothing else.

---

## Requirements

- **Node.js 20.19+** (`node --version`)
- **Docker** for Postgres and Redis, from Milestone 4 onward
- A browser

That is all. No accounts, no API keys, no cloud anything.

---

## Licence

MIT. Use it, fork it, put it on your CV.
