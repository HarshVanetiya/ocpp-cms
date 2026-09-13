# Milestone 0 — Setup and health

**Goal:** a server that answers one endpoint, and a dashboard that notices.

**Time:** 20 minutes.

---

## Why this exists

`GET /api/v1/health` is the endpoint the frontend probes on boot to decide
whether your backend is alive. Implement it and the sidebar indicator flips
from "Running on mocks" to "Backend connected".

It is also the smallest possible end-to-end slice: Node running, TypeScript
compiling, HTTP served, CORS right, the contract satisfied. Getting those five
things working together before you write any OCPP is worth the twenty minutes.

---

## Build it

### 1. Create the project

```bash
mkdir ocpp-cms-server && cd ocpp-cms-server
npm init -y
npm pkg set type=module
npm install fastify @fastify/cors zod
npm install -D typescript tsx @types/node
```

`npm pkg set type=module` makes Node treat `.js` as ES modules, which is what
you want in 2026 and what the rest of this guide assumes.

### 2. `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### 3. `src/index.ts`

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({
  logger: {
    // Pretty logs in development; JSON in production, where a log shipper
    // has to parse them.
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
});

const startedAt = Date.now();

/**
 * CORS.
 *
 * The dashboard runs on :5173, the simulator on :5174, the driver app on
 * :5175 — all different origins from this server on :3000. Without this the
 * browser blocks every request and you get a confusing "Failed to fetch" with
 * no other clue.
 *
 * The permissive list is fine for local development. Milestone 13 narrows it.
 */
await app.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
  credentials: true,
});

app.get('/api/v1/health', async () => ({
  status: 'ok' as const,
  version: '0.1.0',
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  // Advertise nothing you cannot actually serve. This grows as you build.
  protocols: [],
  dependencies: [],
}));

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`CSMS listening on http://localhost:${port}`);
```

```bash
npm install -D pino-pretty
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.typecheck="tsc --noEmit"
npm run dev
```

---

## Prove it works

**1. From the terminal:**

```bash
curl -s http://localhost:3000/api/v1/health | jq
```

```json
{ "status": "ok", "version": "0.1.0", "uptimeSeconds": 12, "protocols": [], "dependencies": [] }
```

**2. From the dashboard.** With `npm run dev:learn` running in this repo, open
http://localhost:5173 and look at the bottom of the sidebar:

```
 ● Backend connected
   localhost:3000
   realtime closed
```

The dot is green. That is your server.

**3. Open the Build progress page** (`/progress`). `GET /api/v1/health` is now
**live**; the other 89 are untouched or mocked. That page is your checklist for
the rest of the project.

---

## Things that go wrong here

**The dashboard still says "Running on mocks".** Hard-refresh — the probe runs
once at boot. If it persists, open the browser console: a CORS error is the
usual cause and it names the origin it wanted.

**`Cannot find module 'fastify'`.** You are running `node src/index.ts` instead
of `tsx src/index.ts`.

**`ERR_MODULE_NOT_FOUND` for your own file.** Under `NodeNext` you must write
the extension of the file that exists *at runtime*: `./config.js`, even though
the file on disk is `config.ts`. It looks wrong. It is correct.

---

## What you can now explain

- Why a browser app on :5173 cannot call a server on :3000 without CORS, and
  what the preflight request is for.
- Why a health endpoint advertises its capabilities (`protocols`) rather than
  just returning `200` — a load balancer and a monitoring system both want to
  know *what* is healthy.

---

Next: **[Milestone 1 — project skeleton →](milestone-01-skeleton.md)**
