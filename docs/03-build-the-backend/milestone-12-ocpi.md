# Milestone 12 — OCPI roaming

**Goal:** another company's customer charges at your station, and both sides
agree on the bill.

**Time:** 5–6 hours.

**Endpoints:** 8 for the dashboard, plus the OCPI surface you host for partners.

---

## Why this exists

OCPP connects your CPMS to **chargers**. OCPI connects it to **other
companies**.

A driver with a Shell card pulls into an Ionity site. Ionity's CPMS has never
heard of that card. OCPI is how Ionity asks Shell "is this card good for
€40?", and how, forty minutes later, Ionity tells Shell "your customer took
43 kWh, here is the CDR". Without roaming, every driver needs an account with
every network — which is the world EV charging is slowly leaving behind.

You are the **CPO**: you own the hardware. Your partner is an **eMSP**: they own
the customer. That one sentence resolves almost every "which direction does this
go?" question.

| Module | As a CPO you… | Meaning |
|---|---|---|
| `locations` | **host** | partners read your sites to show them in their app |
| `tariffs` | **host** | partners read your prices |
| `sessions` | **host** | partners poll live sessions of their customers |
| `cdrs` | **push** | you tell partners what to bill |
| `tokens` | **receive** | partners push you the cards you should accept |
| `commands` | **receive** | a partner asks you to start a charge |

That last row is the good news: an OCPI `START_SESSION` becomes the
`remote_start` command you already built in Milestone 6. **OCPI is a thin shell
over machinery that already exists.** That is why it comes after OCPP and not
before.

### The handshake, which is the part everyone gets wrong

Two tokens, pointing in opposite directions, and a third that dies immediately.

```
  1. out of band          partner emails you TOKEN_A
  2. GET  their /versions           Authorization: Token <TOKEN_A>
  3. GET  their /2.2.1              Authorization: Token <TOKEN_A>
        → their endpoint list
  4. POST their /credentials        Authorization: Token <TOKEN_A>
        body: { token: TOKEN_B, url: <YOUR versions url>, roles: [...] }
        TOKEN_B is one YOU generate. It is what THEY will use to call YOU.
  5. their response body: { token: TOKEN_C, url: ..., roles: [...] }
        TOKEN_C is what YOU use to call THEM from now on.
  6. TOKEN_A is dead.
```

So you store **two** tokens per partner:

- `token_for_us` — TOKEN_B. Incoming requests must present this.
- `token_for_them` — TOKEN_C. Outgoing requests must carry this.

Put them in one column and you will spend an afternoon on 401s. The contract
names them so you cannot mix them up.

> **`Authorization: Token <base64>`.** Not `Bearer`. The scheme is the literal
> word "Token", and the value is base64-encoded in OCPI 2.2+. A surprising
> number of integrations fail on that one line.

---

## Build it

### 1. The envelope

Every OCPI response — every single one, including errors — is wrapped:

```json
{
  "data": { },
  "status_code": 1000,
  "status_message": "Success",
  "timestamp": "2026-09-13T10:15:30Z"
}
```

```ts
// src/ocpi/envelope.ts

/**
 * OCPI status codes are NOT HTTP status codes, and both are present.
 *
 * A request can be `HTTP 200` with `status_code: 2001` — "the message was
 * received and understood, and the answer is no". Partners check the body,
 * not the HTTP status. Returning a bare HTTP 400 with no envelope is the most
 * common thing to get wrong, because it works with curl and fails with every
 * real implementation.
 *
 *   1000  success
 *   2000  generic client error     2001  invalid parameters
 *   2002  not enough information   2003  unknown location
 *   3000  generic server error     3001  unable to use the client's API
 *   3002  unsupported version      3003  no matching endpoints
 */
export const ok = <T>(data: T) => ({
  data,
  status_code: 1000,
  status_message: 'Success',
  timestamp: new Date().toISOString(),
});

export const fail = (code: number, message: string) => ({
  status_code: code,
  status_message: message,
  timestamp: new Date().toISOString(),
});
```

### 2. What you host

```ts
// src/ocpi/routes/index.ts

/**
 * Two separate HTTP surfaces, and keeping them separate matters.
 *
 *   /api/v1/*   your dashboard's API. JWT auth. Your own shapes.
 *   /ocpi/*     the standard. Token auth. OCPI's shapes, exactly.
 *
 * Do not try to serve both from one set of handlers. OCPI's object shapes are
 * fixed by the spec and differ from yours in small, unavoidable ways —
 * latitude is a STRING, energy is in kWh as a decimal, ids are max 36 chars.
 * Translate at this boundary and keep your internal model clean.
 */
export async function registerOcpi(app: FastifyInstance) {
  await app.register(async (ocpi) => {
    ocpi.addHook('onRequest', ocpiAuth);

    // Version discovery. Unauthenticated partners find you here.
    ocpi.get('/versions', async () => ok([
      { version: '2.2.1', url: `${config.PUBLIC_URL}/ocpi/2.2.1` },
    ]));

    ocpi.get('/2.2.1', async (request) => ok({
      version: '2.2.1',
      endpoints: [
        { identifier: 'credentials', role: 'RECEIVER', url: `${base}/credentials` },
        { identifier: 'locations',   role: 'SENDER',   url: `${base}/locations` },
        { identifier: 'tariffs',     role: 'SENDER',   url: `${base}/tariffs` },
        { identifier: 'sessions',    role: 'SENDER',   url: `${base}/sessions` },
        { identifier: 'cdrs',        role: 'SENDER',   url: `${base}/cdrs` },
        { identifier: 'tokens',      role: 'RECEIVER', url: `${base}/tokens` },
        { identifier: 'commands',    role: 'RECEIVER', url: `${base}/commands` },
      ],
    }));

    await ocpi.register(credentialsRoutes);
    await ocpi.register(locationRoutes);
    await ocpi.register(tokenRoutes);
    await ocpi.register(commandRoutes);
  }, { prefix: '/ocpi' });
}

/**
 * SENDER hosts the data; RECEIVER consumes it. As a CPO you are the SENDER of
 * locations (you own the sites) and the RECEIVER of tokens (partners push
 * their customers' cards at you). Getting a role backwards in this list means
 * partners call endpoints you do not serve, and the error they get is a 404
 * with no explanation.
 */
```

```ts
// src/ocpi/auth.ts
export async function ocpiAuth(request: FastifyRequest) {
  // /versions is how a partner discovers you before the handshake, so it
  // cannot require a token that the handshake has not issued yet.
  if (request.url.endsWith('/ocpi/versions')) return;

  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Token ')) {
    return reply.code(401).send(fail(2000, 'Missing or malformed Authorization header'));
  }

  // OCPI 2.2+ base64-encodes the token. 2.1.1 did not. Accept both: you will
  // meet partners still on 2.1.1 and rejecting them is not worth the purity.
  const raw = header.slice(6).trim();
  const candidates = [raw, safeBase64Decode(raw)].filter(Boolean);

  const party = await findPartyByToken(candidates);
  if (!party) return reply.code(401).send(fail(2000, 'Unknown token'));

  request.ocpiParty = party;
}
```

### 3. The handshake, as a client

```ts
// src/ocpi/handshake.ts

/**
 * Register with a partner. Returns a step-by-step result, because when this
 * fails — and the first time, it will — "it failed" is useless and "step 3
 * returned 401 with body {…}" is the answer.
 */
export async function registerParty(input: RegisterOcpiParty) {
  const steps: HandshakeStep[] = [];
  const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const value = await fn();
      steps.push({ step: name, status: 'ok', detail: 'ok', durationMs: Date.now() - started });
      return value;
    } catch (err) {
      steps.push({
        step: name, status: 'failed',
        detail: (err as Error).message,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  };

  const tokenA = input.tokenA;

  const versions = await step('fetch_versions', () =>
    ocpiGet<Array<{ version: string; url: string }>>(input.versionsUrl, tokenA));

  const chosen = await step('select_version', async () => {
    const match = versions.find((v) => v.version === '2.2.1')
               ?? versions.find((v) => v.version.startsWith('2.2'));
    if (!match) throw new Error(`No supported version. They offer: ${versions.map(v => v.version).join(', ')}`);
    return match;
  });

  const details = await step('fetch_endpoints', () =>
    ocpiGet<{ endpoints: OcpiEndpoint[] }>(chosen.url, tokenA));

  const credentialsUrl = details.endpoints.find((e) => e.identifier === 'credentials')?.url;
  if (!credentialsUrl) throw new Error('Partner exposes no credentials endpoint');

  // TOKEN_B — what they will use to call us. Generate it now and store it
  // BEFORE posting: they are allowed to call us the instant they receive it,
  // and a partner whose first request 401s will usually give up.
  const tokenB = randomBytes(32).toString('base64url');
  await storeIncomingToken(input, tokenB);

  const response = await step('post_credentials', () =>
    ocpiPost<CredentialsBody>(credentialsUrl, tokenA, {
      token: tokenB,
      url: `${config.PUBLIC_URL}/ocpi/versions`,
      roles: [{
        role: 'CPO',
        party_id: config.OCPI_PARTY_ID,
        country_code: config.OCPI_COUNTRY_CODE,
        business_details: { name: config.OCPI_BUSINESS_NAME },
      }],
    }));

  // TOKEN_C — what we use to call them. TOKEN_A is now dead; overwrite it so
  // nobody can accidentally keep using it.
  await step('store_tokens', () => saveParty({
    ...input,
    tokenForThem: response.token,
    theirVersionsUrl: response.url,
    endpoints: details.endpoints,
    status: 'connected',
  }));

  return { success: true, steps, error: null };
}
```

### 4. Hosting locations

```ts
// src/ocpi/mappers/location.ts

/**
 * Your Location → an OCPI Location.
 *
 * The differences look petty and every one of them will reject your payload
 * if you get it wrong:
 *
 *   - `coordinates` are STRINGS with 5–7 decimal places. Not numbers.
 *   - `id` is max 36 characters. A UUID fits exactly; a composite key may not.
 *   - `last_updated` is required on every object AND every nested object,
 *     because partners use it to decide what to re-fetch.
 *   - `evses[].uid` must be stable forever — a partner's deep link to a
 *     specific EVSE breaks if it changes.
 *   - status is a different enum from OCPP's, with fewer values.
 */
export function toOcpiLocation(location: LocationRow, stations: StationRow[]) {
  return {
    country_code: config.OCPI_COUNTRY_CODE,
    party_id: config.OCPI_PARTY_ID,
    id: location.id,
    publish: true,
    name: location.name,
    address: location.street,
    city: location.city,
    postal_code: location.postal_code,
    country: toIso3(location.country),          // OCPI wants ISO-3166 alpha-3
    coordinates: {
      latitude: Number(location.latitude).toFixed(6),
      longitude: Number(location.longitude).toFixed(6),
    },
    evses: stations.flatMap((station) =>
      station.evses.map((evse) => ({
        uid: `${station.identity}-${evse.evse_id}`,
        evse_id: `${config.OCPI_COUNTRY_CODE}*${config.OCPI_PARTY_ID}*E${station.identity}${evse.evse_id}`,
        status: toOcpiStatus(evse.status),
        connectors: evse.connectors.map((c) => ({
          id: String(c.connector_id),
          standard: toOcpiStandard(c.type),     // 'IEC_62196_T2_COMBO'
          format: c.type.includes('type2') ? 'SOCKET' : 'CABLE',
          power_type: toOcpiPowerType(c.power_type),
          max_voltage: c.power_type === 'dc' ? 400 : 230,
          max_amperage: Math.round((c.max_power_kw * 1000) / (c.power_type === 'dc' ? 400 : 230)),
          max_electric_power: Math.round(c.max_power_kw * 1000),
          tariff_ids: c.tariff_id ? [c.tariff_id] : [],
          last_updated: c.updated_at,
        })),
        last_updated: evse.status_updated_at ?? station.updated_at,
      })),
    ),
    time_zone: location.time_zone,
    opening_times: location.opening_hours,
    last_updated: location.updated_at,
  };
}

/**
 * OCPP has nine connector statuses, OCPI has seven, and they are not the same
 * seven. `Preparing` and `Finishing` both collapse to OCCUPIED — a partner
 * app only needs to know "can my customer use this right now".
 */
const OCPI_STATUS: Record<ConnectorStatus, string> = {
  available: 'AVAILABLE',
  preparing: 'OCCUPIED',
  charging: 'CHARGING',
  suspended_ev: 'CHARGING',      // still occupied, still not free
  suspended_evse: 'CHARGING',
  finishing: 'OCCUPIED',
  reserved: 'RESERVED',
  unavailable: 'INOPERATIVE',
  faulted: 'OUTOFORDER',
};
```

### 5. Receiving tokens and authorizing roaming cards

A partner pushes you their customers' tokens. When one of those cards is
presented at your station, you authorize it **locally** from that cached list —
or, if you have not cached it, by asking the partner in real time.

```ts
// src/ocpi/routes/tokens.ts

// PUT /ocpi/2.2.1/tokens/:country_code/:party_id/:token_uid
ocpi.put('/tokens/:countryCode/:partyId/:tokenUid', async (request) => {
  const body = OcpiTokenSchema.parse(request.body);

  await query(
    `INSERT INTO ocpi_tokens
       (party_id, country_code, token_uid, token_type, contract_id, issuer,
        valid, whitelist, "group_id", language, last_updated, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (party_id, token_uid) DO UPDATE SET
       valid = EXCLUDED.valid,
       whitelist = EXCLUDED.whitelist,
       last_updated = EXCLUDED.last_updated,
       raw = EXCLUDED.raw`,
    [/* … */],
  );

  return ok({});
});
```

```ts
// src/domain/authorization.ts — extend the function from Milestone 5

/**
 * `whitelist` decides whether you may authorize locally, and it is the field
 * that actually matters:
 *
 *   ALWAYS          accept from the cache. Never call the partner.
 *   ALLOWED         prefer the cache; call them only if you have no entry.
 *   ALLOWED_OFFLINE call them, but fall back to the cache if they are down.
 *   NEVER           always call them in real time. No exceptions.
 *
 * NEVER exists because some eMSPs need to check a prepaid balance per
 * session. Caching those is a way to give away electricity.
 */
export async function authorizeToken(input: AuthorizeInput) {
  const local = await findLocalToken(input.tokenValue);
  if (local) return decideLocal(local);

  const roaming = await findOcpiToken(input.tokenValue);
  if (!roaming) return { result: 'invalid', reason: 'Unknown token' };

  if (roaming.whitelist === 'ALWAYS') {
    return roaming.valid
      ? { result: 'accepted', roamingPartyId: roaming.party_id }
      : { result: 'blocked', reason: 'Partner marked the token invalid' };
  }

  try {
    // POST /tokens/{uid}/authorize on the partner's side.
    const decision = await realtimeAuthorize(roaming, input);
    return decision.allowed
      ? { result: 'accepted', roamingPartyId: roaming.party_id }
      : { result: 'invalid', reason: decision.info ?? 'Partner declined' };
  } catch (err) {
    /**
     * The partner is unreachable, and a driver is standing at the charger.
     *
     * ALLOWED_OFFLINE says: trust the cache. Anything else says: refuse.
     * There is no universally right answer — it is a commercial decision
     * about who carries the risk — which is exactly why OCPI made it a field
     * instead of a rule. Saying that in an interview is better than picking.
     */
    if (roaming.whitelist === 'ALLOWED_OFFLINE' && roaming.valid) {
      logger.warn({ party: roaming.party_id }, 'partner unreachable, authorizing from cache');
      return { result: 'accepted', roamingPartyId: roaming.party_id, degraded: true };
    }
    return { result: 'invalid', reason: 'Could not reach the issuing partner' };
  }
}
```

### 6. Pushing CDRs — with a retry queue

```ts
// src/ocpi/push.ts

/**
 * Push a CDR to the partner who issued the token.
 *
 * A CDR is money. If the push fails you cannot drop it, and you cannot retry
 * forever in a loop either — the partner may be down for hours. It goes in a
 * queue with exponential backoff, and it stays there until it succeeds or a
 * human intervenes.
 *
 * This is the most operationally important thing in the whole OCPI surface:
 * undelivered CDRs are unbilled revenue, and "how do you know you have not
 * lost any?" is a question a real operator will ask you.
 */
export async function queueCdrPush(cdrId: string, partyId: string) {
  await query(
    `INSERT INTO ocpi_push_queue (kind, object_id, party_id, next_attempt_at)
     VALUES ('cdr', $1, $2, now())
     ON CONFLICT (kind, object_id, party_id) DO NOTHING`,
    [cdrId, partyId],
  );
}

export async function drainPushQueue() {
  const { rows } = await query(
    `SELECT * FROM ocpi_push_queue
      WHERE next_attempt_at <= now() AND status = 'pending'
      ORDER BY next_attempt_at
      LIMIT 20
      -- Two workers must not push the same CDR twice. SKIP LOCKED is the
      -- one-line answer and it is worth knowing: the second worker walks
      -- past the locked rows instead of blocking on them.
      FOR UPDATE SKIP LOCKED`,
  );

  for (const job of rows) {
    try {
      await pushOne(job);
      await query(`UPDATE ocpi_push_queue SET status='done', completed_at=now() WHERE id=$1`,
                  [job.id]);
    } catch (err) {
      const attempts = job.attempts + 1;
      // 1m, 2m, 4m, … capped at an hour. After 10 attempts it needs a human,
      // and it must be VISIBLE — the dashboard's OCPI page shows the failed
      // queue for exactly this reason.
      const delayMinutes = Math.min(60, 2 ** attempts);
      await query(
        `UPDATE ocpi_push_queue
            SET attempts=$2, last_error=$3, status=$4,
                next_attempt_at = now() + ($5 || ' minutes')::interval
          WHERE id=$1`,
        [job.id, attempts, String(err), attempts >= 10 ? 'failed' : 'pending', delayMinutes],
      );
    }
  }
}
```

### 7. Log every OCPI request, both directions

Same reasoning as the OCPP frame log, and if anything more important: roaming
bugs are almost always "we sent them something they rejected", and you cannot
debug that from a status code.

```sql
CREATE TABLE ocpi_logs (
  id           BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  party_id     UUID REFERENCES ocpi_parties(id) ON DELETE SET NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  method       TEXT NOT NULL,
  url          TEXT NOT NULL,
  module       TEXT,
  request_body  JSONB,
  response_body JSONB,
  http_status   INT,
  ocpi_status   INT,
  duration_ms   INT,
  error         TEXT
);
CREATE INDEX idx_ocpi_logs ON ocpi_logs(occurred_at DESC);
```

> **Redact the Authorization header before you store it.** It is a live
> credential for a business partner. Storing partner tokens in a log table you
> later hand to a support engineer is a real incident, not a hypothetical one.

---

## Prove it works

### 1. Talk to yourself

The most practical test: run a second instance of your own server on port 3001
and register the two with each other. One plays CPO, the other eMSP. You
control both sides, so every failure is inspectable.

```bash
PORT=3001 OCPI_PARTY_ID=EMS OCPI_ROLE=EMSP npm run dev
```

Then, in the dashboard's OCPI page, **Add partner** with
`http://localhost:3001/ocpi/versions` and a TOKEN_A you invent.

The handshake timeline should show all five steps green. If step 4 fails, read
the body — it is almost always the `Token` scheme or a missing `roles` array.

### 2. Check the tokens landed in the right columns

```sql
SELECT name, status,
       left(token_for_us, 6)   AS incoming,
       left(token_for_them, 6) AS outgoing
  FROM ocpi_parties;
```

Both populated, and **different**. If they match, you stored the same token
twice and one direction will 401.

### 3. Fetch your own locations as a partner

```bash
curl -s http://localhost:3000/ocpi/2.2.1/locations \
  -H "Authorization: Token $(echo -n "$TOKEN_B" | base64)" | jq '.status_code, .data[0].evses[0]'
```

`1000`, and an EVSE with string coordinates, an `evse_id` in
`XX*YYY*E...` form, and a `last_updated` on every level.

### 4. A roaming charge, end to end

1. On the eMSP instance, push a token to the CPO instance.
2. Swipe that token in the simulator against the CPO's station.
3. Watch the CPO authorize it — from the cache if `whitelist: ALWAYS`, with a
   real-time call if `NEVER`. Check the OCPI log for the outbound
   `POST /tokens/.../authorize`.
4. Complete the charge.
5. Watch the CDR push land on the eMSP side.

```sql
SELECT kind, status, attempts, last_error FROM ocpi_push_queue ORDER BY id DESC LIMIT 5;
```

### 5. Break it deliberately

| Do this | Expect |
|---|---|
| Stop the partner mid-CDR-push | Job stays `pending`, `next_attempt_at` in the future, retries when it returns |
| Send `Authorization: Bearer <token>` | `401` with envelope `status_code: 2000` |
| Request an unknown location | HTTP 200, `status_code: 2003` |
| Authorize a `NEVER` token with the partner down | Refused. Not "accepted, we'll sort it out later" |
| Handshake against a partner offering only 2.1.1 | Clean failure at `select_version` with their version list in the detail |

That third row is the one people fail. **An OCPI error is an HTTP 200 with a
non-1000 status code in the body.** Returning HTTP 404 with no envelope makes
partners' clients throw instead of handling it.

---

## What you can now explain

- The difference between OCPP and OCPI in one sentence, and who plays which
  role.
- The credentials handshake, all three tokens, and which direction each points.
- Why an OCPI error is usually HTTP 200.
- What `whitelist` controls and why the offline case is a commercial decision
  rather than a technical one.
- Why CDR delivery needs a durable queue, and how you know nothing is lost.
- Why OCPI object shapes get their own mappers instead of reusing your API
  models.

---

Next: **[Milestone 13 — security and audit →](milestone-13-security.md)**
