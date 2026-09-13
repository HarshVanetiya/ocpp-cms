# Milestone 13 — Security and audit

**Goal:** something you would be willing to put on the internet.

**Time:** 4–5 hours.

**Endpoints:** 1 — `auditLog`. The rest is hardening.

---

## Why this exists

Up to now, any device that knows a URL can claim to be any station. That is
fine on your laptop and unacceptable anywhere else: an attacker who can open a
WebSocket as `STATION-042` can start free charges, report fake energy, and
generate CDRs against someone else's account.

OCPP takes this seriously enough to define **security profiles**, and knowing
what they are is one of the cheapest ways to sound like you have operated a
CPMS rather than only written one.

| Profile | Auth | Transport | In practice |
|---|---|---|---|
| **0** | none | `ws://` | Lab only. Never deploy this. |
| **1** | HTTP Basic | `ws://` | Password over plaintext. Only inside a private APN. |
| **2** | HTTP Basic | `wss://` | **The common one.** TLS server cert + per-station password. |
| **3** | client certificate | `wss://` | Mutual TLS. Best, and hardest to operate. |

> **Profile 2 is the realistic target** and the one this milestone builds.
> Profile 3 is better but needs a certificate lifecycle — issuance, rotation,
> revocation, and a way to recover a station whose cert expired in a car park.
> Knowing *why* operators stop at 2 is more useful than implementing 3.

---

## Build it

### 1. Authenticate the station

```ts
// src/ocpp/gateway.ts — in the upgrade handler, before accepting the socket
import argon2 from 'argon2';

/**
 * HTTP Basic on the WebSocket handshake.
 *
 * This works because a WebSocket upgrade IS an HTTP request — it has headers,
 * and a charge point configured with security profile 1 or 2 sends
 * `Authorization: Basic base64(identity:password)`.
 *
 * Two rules the OCPP security whitepaper is explicit about, and both matter:
 *
 *   - The username MUST equal the station identity in the URL. Otherwise a
 *     station with valid credentials can impersonate any other station, which
 *     defeats the point entirely.
 *   - Reject BEFORE completing the upgrade. Accepting the socket and then
 *     closing it looks like a network fault to the station, and it will
 *     reconnect immediately, forever.
 */
async function authenticateStation(request: IncomingMessage, identity: string) {
  const station = await query(
    `SELECT id, identity, security_profile, auth_password_hash
       FROM stations WHERE identity = $1`, [identity],
  ).then((r) => r.rows[0]);

  if (!station) {
    if (!config.ALLOW_UNKNOWN_STATIONS) return { ok: false, code: 404 };
    return { ok: true, station: null };            // learning mode only
  }

  if (station.security_profile === 0) {
    if (config.NODE_ENV === 'production') {
      // Refuse to serve profile 0 in production even if a row says so. A
      // config mistake must not silently downgrade your whole fleet.
      logger.error({ identity }, 'security profile 0 rejected in production');
      return { ok: false, code: 401 };
    }
    return { ok: true, station };
  }

  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return { ok: false, code: 401 };

  const [username, password] = Buffer.from(header.slice(6), 'base64').toString().split(':');

  // Constant-time on the identity too. It is not secret, but a length-based
  // early exit here leaks which identities exist.
  if (!timingSafeEqualString(username, identity)) return { ok: false, code: 401 };

  const valid = await argon2.verify(station.auth_password_hash ?? DUMMY_HASH, password ?? '')
    .catch(() => false);
  if (!valid) {
    logger.warn({ identity, ip: request.socket.remoteAddress }, 'station auth failed');
    await recordAuthFailure(identity, request.socket.remoteAddress);
    return { ok: false, code: 401 };
  }

  return { ok: true, station };
}

server.on('upgrade', async (request, socket, head) => {
  const identity = extractIdentity(request.url);
  const result = await authenticateStation(request, identity);

  if (!result.ok) {
    // A real 401 with the challenge header, so the station knows to send
    // credentials rather than assuming the network ate the request.
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'WWW-Authenticate: Basic realm="OCPP"\r\n' +
      'Connection: close\r\n\r\n',
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => onStationConnected(ws, identity, result.station));
});
```

### 2. Rotating a station's password

OCPP 1.6 security extensions and 2.0.1 both let the CSMS set a new password
over the existing connection — `SetVariables` on
`SecurityCtrlr.BasicAuthPassword` for 2.0.1, `ChangeConfiguration` on
`AuthorizationKey` for 1.6.

```ts
/**
 * Rotate a station's credential. The ordering here is the whole lesson.
 *
 *   1. Generate the new password.
 *   2. Store it ALONGSIDE the old one — both are valid during the swap.
 *   3. Send it to the station.
 *   4. The station disconnects and reconnects with the new one.
 *   5. Only THEN retire the old one.
 *
 * Store-then-send, never send-then-store. If you store the new password
 * first and the message never arrives, the station reconnects with the old
 * one and you have locked out a device that may be a hundred kilometres away
 * behind a locked enclosure. Accepting both for a window makes the operation
 * safe to fail.
 */
export async function rotateStationPassword(stationId: string) {
  const password = randomBytes(24).toString('base64url');

  await query(
    `UPDATE stations
        SET auth_password_hash_next = $2, password_rotation_started_at = now()
      WHERE id = $1`,
    [stationId, await argon2.hash(password)],
  );

  await issueCommand({
    stationId,
    command: 'set_configuration',
    payload: {
      key: 'AuthorizationKey',
      component: 'SecurityCtrlr',
      variable: 'BasicAuthPassword',
      value: password,
    },
  });
  // Step 5 happens in the connection handler: when a station authenticates
  // with `auth_password_hash_next`, promote it and clear the old one.
}
```

### 3. Rate limiting, in the two places that matter

```ts
// src/api/rate-limit.ts
import rateLimit from '@fastify/rate-limit';

/**
 * Two different limits, because the threats are different.
 *
 * On /auth/login the threat is credential stuffing, so the limit is per IP
 * AND per email, tight, and it counts FAILURES only — a legitimate user with
 * the right password should never be locked out by someone else guessing.
 *
 * On the rest of the API the threat is an accidental loop in someone's
 * script. That limit is loose and generous.
 */
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.user?.id ?? request.ip,
});

app.post('/auth/login', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes',
      keyGenerator: (request) => `${request.ip}:${(request.body as any)?.email ?? ''}`,
    },
  },
}, loginHandler);
```

And on the WebSocket, which `@fastify/rate-limit` does not cover:

```ts
/**
 * Connection throttling per IP.
 *
 * A station in a reboot loop reconnecting 50 times a second is not an attack,
 * it is a Tuesday — and it will exhaust your file descriptors just as
 * effectively as one. Cap concurrent connections per IP and add a rejection
 * delay, so a badly-behaved device backs off instead of spinning.
 *
 * Set the cap well above your real density: a site with 20 chargers behind one
 * NAT is a completely normal deployment and must not trip this.
 */
const CONNECTIONS_PER_IP = 100;
```

### 4. The audit trail

Separate from system logs, and the difference is the point: a system log is for
you, an audit trail is for someone asking who did this.

```sql
-- migrations/008_audit.sql
CREATE TABLE audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Denormalised: the actor may be deleted, and "deleted user" is a worse
  -- audit answer than the name they had at the time.
  actor_name   TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  target_label TEXT,
  -- { field: { from, to } } — the diff, not the whole object.
  changes      JSONB,
  ip_address   INET,
  user_agent   TEXT
);

CREATE INDEX idx_audit_time  ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, occurred_at DESC);

-- Append-only, enforced by the database rather than by convention.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
```

```ts
// src/domain/audit.ts

/**
 * Record a change, with a DIFF rather than a snapshot.
 *
 * `{ status: { from: 'active', to: 'blocked' } }` answers the question. A
 * full before-and-after object makes the reader diff two blobs by eye, and it
 * stores every unchanged field forever.
 *
 * Redaction is not optional: never write a password hash, a token value, or a
 * partner credential into a table whose whole purpose is to be read later by
 * people who are not you.
 */
const REDACTED = new Set(['password', 'passwordHash', 'tokenForUs', 'tokenForThem', 'value']);

export async function audit(entry: {
  actor: { id: string; name: string } | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip?: string;
}) {
  const changes = entry.before && entry.after ? diff(entry.before, entry.after) : null;

  await query(
    `INSERT INTO audit_log
       (actor_id, actor_name, action, target_type, target_id, target_label, changes, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.actor?.id ?? null,
      entry.actor?.name ?? 'system',
      entry.action, entry.targetType,
      entry.targetId ?? null, entry.targetLabel ?? null,
      changes ? JSON.stringify(changes) : null,
      entry.ip ?? null,
    ],
  );
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = REDACTED.has(key)
      ? { from: '***', to: '***' }
      : { from: before[key], to: after[key] };
  }
  return out;
}
```

Audit these, and not much else:

| Action | Why |
|---|---|
| `station.command` | "who reset this at 03:00" |
| `station.create/update/delete` | fleet changes |
| `tariff.*` | it changes what people are charged |
| `user.*`, `token.*` | access changes |
| `payment.refund` | money leaving |
| `ocpi.party.*` | a new partner can read your fleet |
| `auth.login.failed` | the signal before a breach |

> **Do not audit reads.** It is tempting and it drowns the table. The one
> exception worth making is bulk export of personal data, because that is the
> read a regulator asks about.

### 5. Input hardening you may not have done yet

```ts
/**
 * OCPP payload size limits.
 *
 * A charge point can send you a 500 MB MeterValues array. Nothing in the
 * protocol stops it, `ws` will happily buffer it, and your process dies. Cap
 * the frame size at the socket, before JSON.parse ever sees it.
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

/** Same for HTTP. */
const app = fastify({ bodyLimit: 1024 * 1024 });
```

```ts
/**
 * Station identities come from a URL and end up in SQL, log lines and file
 * paths. Constrain them at the door.
 *
 * OCPP 1.6 allows up to 20 characters; 2.0.1 allows 48. Anything with a
 * slash, a null byte or a newline is either a bug or an attack, and there is
 * no legitimate station whose identity contains a newline.
 */
const IDENTITY = /^[A-Za-z0-9_.:-]{1,48}$/;
```

```ts
// src/api/security-headers.ts
import helmet from '@fastify/helmet';

await app.register(helmet, {
  // The API serves JSON, not HTML, so a strict CSP costs nothing.
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
});

await app.register(cors, {
  /**
   * An explicit allow-list. `origin: true` reflects whatever Origin arrives,
   * which — combined with `credentials: true` — means any website can call
   * your API as a logged-in user. That combination is the classic CORS
   * mistake and it is worth being able to explain.
   */
  origin: config.CORS_ORIGINS.split(','),
  credentials: true,
});
```

### 6. Secrets and the things that leak

```ts
// src/logger.ts — extend the pino config
export const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.accessToken',
      '*.refreshToken',
      '*.tokenA', '*.tokenForUs', '*.tokenForThem',
      // OCPP: idTag IS personal data. It identifies a person's movements.
      '*.idTag',
      '*.idToken.idToken',
    ],
    censor: '***',
  },
});
```

> **`idTag` is personal data.** An RFID number plus a station location plus a
> timestamp is a record of where a specific person was at a specific time.
> Under GDPR that is personal data with all that follows: a retention period, a
> deletion path, and a good reason to keep it. The frame log makes this
> concrete — it stores raw payloads containing idTags, so it needs a retention
> policy, and your partitioned tables make that a `DROP TABLE`.

### 7. The audit endpoint

```ts
// src/api/routes/logs.ts
app.get('/logs/audit', { preHandler: requireRole('admin') }, async (request) => {
  const q = AuditQuerySchema.parse(request.query);
  // Cursor pagination, same as the OCPP log and for the same reason.
  // …
});
```

Admin only. An audit trail that every operator can read is a list of which
admin to social-engineer.

---

## Prove it works

### 1. Authentication actually blocks

```bash
# No credentials
npx wscat -c "ws://localhost:3000/ocpp/STATION-001" -s ocpp1.6
# → 401

# Wrong password
npx wscat -c "ws://user:wrong@localhost:3000/ocpp/STATION-001" -s ocpp1.6
# → 401

# Right password, wrong identity in the URL
npx wscat -c "ws://STATION-001:correct@localhost:3000/ocpp/STATION-002" -s ocpp1.6
# → 401   ← the impersonation test. This is the one that matters.

# Correct
npx wscat -c "ws://STATION-001:correct@localhost:3000/ocpp/STATION-001" -s ocpp1.6
# → connected
```

### 2. TLS, locally

```bash
mkcert -install
mkcert localhost 127.0.0.1
```

Point the simulator at `wss://localhost:3443/ocpp/...` and confirm it connects.
Then look at the certificate the station presents — there is none, and that is
the difference between profile 2 and profile 3 in one observation.

### 3. Rate limits

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " localhost:3000/api/v1/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"admin@example.com","password":"wrong"}'
done
# 401 401 401 401 401 429 429 429 429 429
```

Then log in with the **correct** password from a different IP and confirm it
still works. A rate limit that locks out the real user is a denial of service
you built yourself.

### 4. The audit trail tells a story

Reset a station, change a tariff, block a token. Open `/settings` → **Audit**.

Each row should say who, what, when, and — for the tariff — exactly which
fields changed and from what. Then:

```sql
UPDATE audit_log SET actor_name = 'someone else' WHERE id = (SELECT id FROM audit_log LIMIT 1);
-- ERROR: permission denied for table audit_log
```

An audit trail you can edit is not an audit trail.

### 5. Nothing leaks

```bash
# Every log line from a full charge cycle
npm run dev 2>&1 | tee /tmp/run.log
# then
grep -iE 'password|bearer |authorization|idTag' /tmp/run.log
```

Only `***`. Then check the API the same way:

```bash
curl -s localhost:3000/api/v1/users -H "authorization: Bearer $ACCESS" \
  | grep -ciE 'password|hash'
# 0
```

### 6. Break it deliberately

| Do this | Expect |
|---|---|
| Send a 10 MB OCPP frame | Socket closed, process alive |
| Connect as `../../etc/passwd` | Rejected by the identity pattern |
| Start with `NODE_ENV=production` and profile 0 | Refused, with a loud log line |
| Call the API from an origin not on the list | CORS blocks it in the browser |
| Rotate a password and kill the server before the station gets it | Station reconnects on the OLD password and still works |

That last one is the design justifying itself.

---

## What you can now explain

- The four OCPP security profiles, and why most fleets run profile 2.
- Why the Basic auth username must match the station identity in the URL.
- Why you reject before completing the WebSocket upgrade.
- Why password rotation stores before it sends, and what breaks otherwise.
- Why login rate limiting is keyed differently from the rest of the API.
- Why an audit trail is append-only and stores diffs rather than snapshots.
- Why `idTag` is personal data, and what that means for your retention policy.

> **You are done with the curriculum.** What you have is a CPMS that speaks two
> OCPP versions, roams over OCPI, prices and bills real sessions, manages site
> load, and authenticates its fleet. Next comes what it takes to run it.

---

Next: **[The architecture →](../04-architecture/README.md)**
