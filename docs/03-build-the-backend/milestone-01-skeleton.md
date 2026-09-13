# Milestone 1 — Project skeleton

**Goal:** config, logging, errors and a folder layout you will not regret.

**Time:** 45 minutes.

---

## Why this exists

Every one of these is something people add *after* it hurts. Adding them now
costs an hour; adding them at Milestone 9 costs a day of rewriting.

The folder layout matters more than it looks. The structure below is chosen so
that **splitting this into services later is a move, not a rewrite** — see [the architecture guide](../04-architecture/README.md).
Each top-level directory is a seam you can cut along later.

---

## Build it

```
src/
├── index.ts           entry point — wires everything, owns nothing
├── config.ts          environment → a typed, validated object
├── logger.ts          one logger, used everywhere
├── errors.ts          the error shape the contract promises
├── db/                Postgres (Milestone 4)
├── ocpp/              ← the seam. Everything protocol-specific lives here.
│   ├── gateway.ts       WebSocket server, connection registry
│   ├── framing.ts       CALL / CALLRESULT / CALLERROR
│   ├── router.ts        action → handler
│   └── handlers/        one file per message
├── domain/            ← business logic. Knows nothing about OCPP or HTTP.
│   ├── stations.ts
│   ├── sessions.ts
│   └── tariffs.ts
├── api/               ← HTTP routes. Thin. Calls domain, shapes responses.
│   └── routes/
└── realtime/          SSE / WebSocket fan-out to the dashboards (Milestone 9)
```

> **The rule that makes this work:** `domain/` must never import from `ocpp/`
> or `api/`. Protocol details translate into domain language at the edge, and
> business rules stay testable without a socket or a request. If you find
> yourself importing `ocpp/framing` into `domain/sessions`, something has
> leaked.

### 1. Config

```ts
// src/config.ts
import { z } from 'zod';

/**
 * Validate the environment ONCE, at boot.
 *
 * The alternative — `process.env.DATABASE_URL!` scattered through the code —
 * fails at 3am on the one code path nobody exercised in staging. This fails
 * immediately, with the name of the variable you forgot.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().default('postgres://ocpp:ocpp@localhost:5432/ocpp'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** Seconds we tell stations to wait between heartbeats. */
  HEARTBEAT_INTERVAL: z.coerce.number().default(300),

  /**
   * How long to wait for a station to answer a CALL before giving up.
   * 30s is the specification's suggestion. Shorter and slow 4G links fail;
   * longer and your operator stares at a spinner.
   */
  CALL_TIMEOUT_MS: z.coerce.number().default(30_000),

  /**
   * Accept BootNotification from stations you have never registered.
   * Convenient in development, a security hole in production — anyone who
   * can reach your port becomes a charger in your fleet.
   */
  ALLOW_UNKNOWN_STATIONS: z.coerce.boolean().default(true),

  JWT_SECRET: z.string().default('dev-only-change-me'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:5174,http://localhost:5175')
    .transform((s) => s.split(',').map((x) => x.trim())),
});

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
```

### 2. Logger

```ts
// src/logger.ts
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  transport:
    config.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  /**
   * Never log these, ever. A production log is read by more people than you
   * expect and kept for longer than you expect.
   */
  redact: ['req.headers.authorization', 'password', '*.password', 'token', '*.token'],
});

/**
 * A child logger tagged with the station.
 *
 * Every OCPP log line should carry the station identity — when 500 chargers
 * are talking at once, an untagged line is noise. This is also the hook that
 * later becomes a correlation id across services.
 */
export function stationLogger(identity: string) {
  return logger.child({ station: identity });
}
```

```bash
npm install pino
npm install -D pino-pretty
```

### 3. Errors

```ts
// src/errors.ts

/**
 * The one error class.
 *
 * `code` is a stable, machine-readable string the frontend switches on —
 * `packages/contracts/src/common.ts` lists the ones it special-cases. Once you
 * have shipped a code, never change it.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(what: string) {
    return new AppError('NOT_FOUND', `${what} not found`, 404);
  }
  static conflict(message: string) {
    return new AppError('CONFLICT', message, 409);
  }
  static validation(details: Array<{ field: string; message: string }>) {
    return new AppError('VALIDATION_FAILED', 'Some fields need fixing', 400, details);
  }
  static stationOffline(identity: string) {
    return new AppError(
      'STATION_OFFLINE',
      `${identity} is not connected, so the command cannot be delivered`,
      409,
    );
  }
  static unauthorized() {
    return new AppError('UNAUTHORIZED', 'Sign in to continue', 401);
  }
}
```

```ts
// src/api/error-handler.ts
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    // A Zod failure is a validation error, whoever threw it.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields need fixing',
          details: error.issues.map((i) => ({
            field: i.path.join('.') || '(root)',
            message: i.message,
          })),
          requestId: request.id,
        },
      });
    }

    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }

    /**
     * Anything else is a bug. Log the real error with the stack; send the
     * client a generic message.
     *
     * Leaking a stack trace to a browser tells an attacker your file layout,
     * your dependency versions and sometimes your SQL.
     */
    logger.error({ err: error, url: request.url, requestId: request.id }, 'unhandled error');

    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side',
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url}`,
        requestId: request.id,
      },
    }),
  );
}
```

> **Why the 404 shape matters here.** Learn mode falls back to a mock when your
> server answers `404` — so an unimplemented route must return a *clean* 404,
> not a crash. Getting this right is what makes the endpoint-by-endpoint
> workflow function.

### 4. Graceful shutdown

```ts
// src/index.ts — add near the bottom
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  // Order matters: stop taking new work, then drain, then close resources.
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

> Worth doing now because of what is coming. When this server holds 500 open
> WebSockets, a hard kill drops all of them at once and they all reconnect at
> the same millisecond. [Deployment](../05-deployment/README.md) turns this into a proper drain.

---

## Prove it works

```bash
PORT=notanumber npm run dev
```

```
Invalid configuration:
  PORT: Expected number, received nan
```

It refused to start, and told you which variable. That is the whole point.

```bash
curl -s http://localhost:3000/api/v1/nonsense | jq
```

```json
{ "error": { "code": "NOT_FOUND", "message": "No route for GET /api/v1/nonsense", "requestId": "req-1" } }
```

---

## What you can now explain

- Why configuration is validated at boot rather than read where it is used.
- Why 5xx responses do not carry the real error message.
- What a `requestId` is for, and why every error carries one.
- Why the folder layout has `domain/` that cannot import `ocpp/` — and how
  that one rule is what makes the later service split cheap.

---

Next: **[Milestone 2 — the WebSocket →](milestone-02-websocket.md)**
