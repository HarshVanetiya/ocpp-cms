# Milestone 11 — Tariffs, payments and the driver app

**Goal:** a driver opens an app, types "€20", plugs in, charges, and gets a
receipt for what they actually used.

**Time:** 6–8 hours.

**Endpoints:** 24 — the pricing engine, the payment lifecycle, and the whole
driver-facing API.

---

## Why this exists

Everything so far served an operator. This milestone serves the person with the
car, and it is where the system stops being a monitoring tool and becomes a
business.

It also contains the two things most likely to be probed in an interview,
because they are where money meets an unreliable physical device:

1. **Why you cannot charge the card at the end.** The car has driven away. The
   card may decline. You have already given away the electricity.
2. **Why you cannot charge it at the start.** You do not know the amount yet.

The answer is **authorize then capture**, and it forces the rest of the design.

```
 driver types €20
        │
        ▼
  AUTHORIZE €20          money ring-fenced, not taken
        │
        ▼
  cap the station        ← the part people forget
        │
        ▼
  car charges, we meter and price live
        │
        ▼
  CAPTURE €13.40         actual cost taken, €6.60 released
        │
        ▼
  CDR + receipt
```

> **The step people forget is the cap.** Authorizing €20 does nothing to stop
> the car drawing €40 of electricity. The only thing that stops it is telling
> the *station*: an energy limit on the remote start, plus Milestone 10's
> charging profile, plus your own watchdog that stops the session when the
> budget is spent. Belt, braces, and a third thing — because each one fails in
> a different way.

> **There is no payment gateway here, deliberately.** Integrating Stripe
> teaches you Stripe. The flow above is what is specific to charging, and a
> 60-line fake provider exercises every path including the ones a real PSP
> makes it hard to test.

---

## Build it

### 1. The pricing engine

Read `packages/contracts/src/tariff.ts` first — the data model is OCPI 2.2.1's,
copied deliberately so your tariffs are already roaming-compatible.

The rule that matters: **elements are ordered, and the first one whose
restrictions match wins.** Not "all matching elements", not "the cheapest". The
first. That is why the UI lets operators reorder them.

```ts
// src/domain/pricing.ts
import { DateTime } from 'luxon';
import type { Tariff, TariffElement } from '@ocpp/contracts';

export interface PriceableSession {
  energyWh: number;
  durationSeconds: number;
  parkingSeconds: number;
  startedAt: Date;
  /** The site's IANA zone. Tariff windows are in LOCAL time. */
  timeZone: string;
  maxPowerKw?: number;
}

/**
 * Price a session.
 *
 * Returns the total, an itemised breakdown, and a TRACE saying which elements
 * matched and which did not and why. The trace is not decoration: a driver
 * disputing a bill, or an operator asking "why is the night rate not
 * applying?", is answered by the trace and not by reading the code.
 */
export function priceSession(tariff: Tariff, session: PriceableSession) {
  const trace: Array<{ elementIndex: number; matched: boolean; reason: string }> = [];
  let matched: { element: TariffElement; index: number } | null = null;

  for (const [index, element] of tariff.elements.entries()) {
    const verdict = matches(element, session);
    trace.push({ elementIndex: index, matched: verdict.ok, reason: verdict.reason });
    if (verdict.ok && !matched) {
      matched = { element, index };
      // Keep walking so the trace explains ALL elements, not just up to the
      // winner. The extra work is microseconds and it saves support tickets.
    }
  }

  if (!matched) {
    return { totalMinor: 0, breakdown: [], trace, currency: tariff.currency };
  }

  const breakdown = matched.element.priceComponents.map((component) => {
    switch (component.kind) {
      case 'energy': {
        /**
         * Round the TOTAL, once, at the end.
         *
         * Rounding each meter sample up to the step and summing overcharges
         * systematically — 2,000 samples rounded up by an average of half a
         * step each is a real, provable overcharge, and it is the kind of bug
         * that gets a company fined. Round once.
         */
        const billableWh = ceilTo(session.energyWh, component.stepSize);
        const kwh = billableWh / 1000;
        return line('Energy', 'energy', kwh, 'kWh', component.priceMinor,
                    Math.round(kwh * component.priceMinor));
      }
      case 'time': {
        const seconds = ceilTo(session.durationSeconds, component.stepSize);
        const hours = seconds / 3600;
        return line('Charging time', 'time', hours, 'hour', component.priceMinor,
                    Math.round(hours * component.priceMinor));
      }
      case 'parking_time': {
        const seconds = ceilTo(session.parkingSeconds, component.stepSize);
        const hours = seconds / 3600;
        return line('Parking', 'parking_time', hours, 'hour', component.priceMinor,
                    Math.round(hours * component.priceMinor));
      }
      case 'flat':
        return line('Session fee', 'flat', 1, 'session', component.priceMinor,
                    component.priceMinor);
    }
  });

  let totalMinor = breakdown.reduce((sum, l) => sum + l.amountMinor, 0);

  // Floors and ceilings come from the tariff and roaming partners rely on
  // them, so apply them AFTER the components and say so in the breakdown.
  if (tariff.minPriceMinor != null && totalMinor < tariff.minPriceMinor) {
    breakdown.push(line('Minimum charge adjustment', 'flat', 1, 'session',
                        tariff.minPriceMinor - totalMinor, tariff.minPriceMinor - totalMinor));
    totalMinor = tariff.minPriceMinor;
  }
  if (tariff.maxPriceMinor != null && totalMinor > tariff.maxPriceMinor) {
    breakdown.push(line('Maximum price cap', 'flat', 1, 'session',
                        tariff.maxPriceMinor - totalMinor, tariff.maxPriceMinor - totalMinor));
    totalMinor = tariff.maxPriceMinor;
  }

  return { totalMinor, breakdown, trace, currency: tariff.currency };
}

/** Always UP. Never round money or billable quantities down. */
const ceilTo = (value: number, step: number) => Math.ceil(value / step) * step;

function matches(element: TariffElement, s: PriceableSession) {
  const r = element.restrictions;
  if (!r) return { ok: true, reason: 'no restrictions' };

  /**
   * LOCAL time, from the site's zone — not the server's, and not UTC.
   *
   * A cheap-rate window of 22:00–06:00 is defined where the charger is. Get
   * this wrong and every tariff in a different timezone is silently off by
   * hours, which is exactly the class of bug nobody notices until a customer
   * does.
   */
  const local = DateTime.fromJSDate(s.startedAt, { zone: s.timeZone });

  if (r.dayOfWeek?.length) {
    const day = local.toFormat('cccc').toLowerCase();
    if (!r.dayOfWeek.includes(day as never)) {
      return { ok: false, reason: `day ${day} not in ${r.dayOfWeek.join(', ')}` };
    }
  }

  if (r.startTime && r.endTime) {
    const minutes = local.hour * 60 + local.minute;
    const from = toMinutes(r.startTime);
    const to = toMinutes(r.endTime);
    /**
     * A window that wraps midnight is legal and common (22:00–06:00).
     * `from > to` is the signal, and the test flips from AND to OR.
     * Forgetting this makes every night tariff match nothing.
     */
    const inside = from <= to
      ? minutes >= from && minutes < to
      : minutes >= from || minutes < to;
    if (!inside) return { ok: false, reason: `${local.toFormat('HH:mm')} outside ${r.startTime}-${r.endTime}` };
  }

  const kwh = s.energyWh / 1000;
  if (r.minKwh != null && kwh < r.minKwh) return { ok: false, reason: `${kwh} kWh below minimum` };
  if (r.maxKwh != null && kwh > r.maxKwh) return { ok: false, reason: `${kwh} kWh above maximum` };

  if (r.minPowerKw != null && (s.maxPowerKw ?? 0) < r.minPowerKw)
    return { ok: false, reason: 'power below minimum' };
  if (r.maxPowerKw != null && (s.maxPowerKw ?? 0) > r.maxPowerKw)
    return { ok: false, reason: 'power above maximum' };

  if (r.minDurationSeconds != null && s.durationSeconds < r.minDurationSeconds)
    return { ok: false, reason: 'too short' };
  if (r.maxDurationSeconds != null && s.durationSeconds > r.maxDurationSeconds)
    return { ok: false, reason: 'too long' };

  return { ok: true, reason: 'all restrictions satisfied' };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
```

> **Why `maxKwh` restrictions are a trap for live pricing.** An element that
> only applies above 20 kWh cannot be evaluated until the session ends. Price
> live with what you have, and reprice authoritatively at `StopTransaction`.
> The live number is an estimate shown to the driver; the CDR is the bill.
> Say that out loud in the UI ("estimated") and you have described the real
> behaviour honestly.

### 2. Which tariff applies

```ts
// src/domain/pricing.ts (continued)

/**
 * Resolution order, most specific first:
 *
 *   1. the user's group tariff  (corporate accounts, negotiated rates)
 *   2. the station's tariff
 *   3. the location's default
 *   4. the system default
 *
 * And if none exists, charging is FREE — not an error. A station with no
 * tariff configured that refuses to charge cars is a worse failure than one
 * that gives away electricity, because the first is visible to every driver
 * and the second is visible to you in a report.
 */
export async function tariffForSession(sessionId: string) {
  const { rows } = await query(`
    SELECT COALESCE(gt.id, st.id, lt.id, dt.id) AS tariff_id
      FROM sessions s
      LEFT JOIN users u        ON u.id = s.user_id
      LEFT JOIN user_groups g  ON g.id = u.group_id
      LEFT JOIN tariffs gt     ON gt.id = g.tariff_id     AND gt.active
      JOIN stations stn        ON stn.id = s.station_id
      LEFT JOIN tariffs st     ON st.id = stn.tariff_id   AND st.active
      LEFT JOIN locations loc  ON loc.id = stn.location_id
      LEFT JOIN tariffs lt     ON lt.id = loc.tariff_id   AND lt.active
      LEFT JOIN tariffs dt     ON dt.is_default           AND dt.active
     WHERE s.id = $1`, [sessionId]);
  return rows[0]?.tariff_id ?? null;
}
```

### 3. The fake payment provider

```ts
// src/domain/payments.ts
import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * A payment provider that takes no money and teaches the whole flow.
 *
 * The only thing that makes it fake is that `callProvider` returns a result
 * instead of calling Adyen. Every state transition, every failure mode and
 * every idempotency concern is real — and `PAYMENT_DECLINE_RATE` lets you
 * test the unhappy path on demand, which a real PSP sandbox makes annoying.
 */

export async function authorizePayment(input: {
  amountMinor: number;
  currency: string;
  userId?: string;
  sessionId?: string;
  idempotencyKey?: string;
}) {
  /**
   * Idempotency, and why it is not optional.
   *
   * A driver on a train taps "Pay €20". The request goes out, the tunnel
   * eats the response, the app retries. Without an idempotency key you have
   * just authorized €40 of their money. With one, the second request returns
   * the first payment, unchanged.
   *
   * Note this is a READ of a UNIQUE column, not a "check then insert" — the
   * unique index is what actually makes it safe under concurrency. Two
   * simultaneous retries race, one inserts, the other gets 23505 and we
   * return the winner's row.
   */
  if (input.idempotencyKey) {
    const existing = await query(
      `SELECT * FROM payments WHERE idempotency_key = $1`, [input.idempotencyKey],
    ).then((r) => r.rows[0]);
    if (existing) return existing;
  }

  const result = await callProvider(input.amountMinor);

  try {
    const { rows } = await query(
      `INSERT INTO payments
         (reference, status, provider, user_id, session_id, currency,
          authorized_amount_minor, failure_code, failure_message,
          idempotency_key, authorized_at, expires_at)
       VALUES ($1,$2,'dummy',$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $2='authorized' THEN now() END,
               now() + interval '2 hours')
       RETURNING *`,
      [
        `PAY-${Date.now().toString(36).toUpperCase()}`,
        result.ok ? 'authorized' : 'failed',
        input.userId ?? null, input.sessionId ?? null, input.currency,
        input.amountMinor,
        result.ok ? null : result.code,
        result.ok ? null : result.message,
        input.idempotencyKey ?? null,
      ],
    );
    if (!result.ok) {
      throw new AppError('PAYMENT_DECLINED', result.message, 402);
    }
    return rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && input.idempotencyKey) {
      // Lost the race. The winner's row is the answer.
      return query(`SELECT * FROM payments WHERE idempotency_key=$1`, [input.idempotencyKey])
        .then((r) => r.rows[0]);
    }
    throw err;
  }
}

export async function capturePayment(paymentId: string, amountMinor: number) {
  const payment = await query(`SELECT * FROM payments WHERE id=$1`, [paymentId])
    .then((r) => r.rows[0]);
  if (!payment) throw AppError.notFound('Payment');

  // Already captured: return it rather than erroring. A retried capture must
  // be safe — this is the same idempotency argument as above, from the other
  // direction.
  if (payment.status === 'captured') return payment;
  if (payment.status !== 'authorized') {
    throw AppError.conflict(`Cannot capture a payment that is ${payment.status}`);
  }

  /**
   * You may capture LESS than you authorized. You may never capture more.
   *
   * If the session genuinely cost more than the hold — the cap failed, the
   * station overran — you cannot silently take the difference. Capture the
   * hold, record the shortfall, and let a human decide. Overcapturing is
   * fraud in some jurisdictions and a chargeback in all of them.
   */
  if (amountMinor > payment.authorized_amount_minor) {
    logger.error(
      { paymentId, amountMinor, authorized: payment.authorized_amount_minor },
      'session cost exceeded the authorization — capturing the hold only',
    );
    amountMinor = payment.authorized_amount_minor;
  }

  const { rows } = await query(
    `UPDATE payments
        SET status='captured', captured_amount_minor=$2, captured_at=now(), expires_at=NULL
      WHERE id=$1 AND status='authorized'
      RETURNING *`,
    [paymentId, amountMinor],
  );
  // The WHERE clause carries the guard, so a concurrent capture cannot
  // double-apply. If it returns nothing, someone else won — re-read.
  return rows[0] ?? payment;
}

async function callProvider(amountMinor: number) {
  await sleep(120 + Math.random() * 200);              // a network exists
  if (amountMinor > 50_000) {
    return { ok: false as const, code: 'AMOUNT_TOO_LARGE', message: 'Amount exceeds the limit' };
  }
  if (Math.random() < config.PAYMENT_DECLINE_RATE) {
    return { ok: false as const, code: 'CARD_DECLINED', message: 'The card was declined' };
  }
  return { ok: true as const };
}
```

```sql
-- migrations/007_money.sql

CREATE TABLE tariffs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  description    TEXT,
  currency       CHAR(3) NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'simple',
  -- The elements array, stored as JSONB. It is read whole and written whole,
  -- never queried into, so normalising it into three tables would buy
  -- nothing and cost every read a join.
  elements       JSONB NOT NULL DEFAULT '[]',
  min_price_minor BIGINT,
  max_price_minor BIGINT,
  active         BOOLEAN NOT NULL DEFAULT true,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  valid_from     TIMESTAMPTZ,
  valid_until    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one default, enforced by the database rather than by hoping.
CREATE UNIQUE INDEX idx_one_default_tariff ON tariffs((is_default)) WHERE is_default;

CREATE TABLE payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL
                          CHECK (status IN ('pending','authorized','captured',
                                            'refunded','failed','expired','cancelled')),
  provider                TEXT NOT NULL DEFAULT 'dummy',
  user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id              UUID REFERENCES sessions(id) ON DELETE SET NULL,
  currency                CHAR(3) NOT NULL,
  authorized_amount_minor BIGINT NOT NULL,
  captured_amount_minor   BIGINT,
  refunded_amount_minor   BIGINT,
  failure_code            TEXT,
  failure_message         TEXT,
  -- The unique index IS the idempotency mechanism. Not the SELECT before it.
  idempotency_key         TEXT UNIQUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_at           TIMESTAMPTZ,
  captured_at             TIMESTAMPTZ,
  refunded_at             TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ
);

CREATE INDEX idx_payments_user    ON payments(user_id, created_at DESC);
CREATE INDEX idx_payments_expiry  ON payments(expires_at) WHERE status = 'authorized';

-- ══════════════════════════════════════════════════════════════════
--  CDRs — the immutable bill
--
--  A session row keeps changing while the car charges. A CDR is written
--  ONCE, when the session ends, and never updated. That separation is the
--  whole point: an auditor asks "what did you bill?" and the answer must not
--  depend on code that has been deployed since.
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE cdrs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  reference       TEXT NOT NULL UNIQUE,
  -- Denormalised ON PURPOSE. The station may be renamed or deleted; the CDR
  -- must still read correctly in five years.
  station_identity TEXT NOT NULL,
  station_name    TEXT NOT NULL,
  location_name   TEXT NOT NULL,
  location_address TEXT NOT NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name       TEXT,
  token_value     TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  duration_seconds INT NOT NULL,
  energy_wh       BIGINT NOT NULL,
  currency        CHAR(3) NOT NULL,
  total_minor     BIGINT NOT NULL,
  -- A snapshot of the tariff AS IT WAS, plus the priced lines. Editing a
  -- tariff must never change an old bill.
  tariff_id       UUID,
  tariff_snapshot JSONB NOT NULL,
  lines           JSONB NOT NULL,
  payment_id      UUID REFERENCES payments(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cdrs_user ON cdrs(user_id, started_at DESC);
```

### 4. The driver start flow

This is the endpoint the whole driver app exists for.

```ts
// src/api/routes/driver.ts
app.post('/driver/charge/start', async (request) => {
  const body = StartChargeSchema.parse(request.body);
  const driver = request.user!;

  const connector = await findConnector(body.connectorId);
  if (!connector) throw AppError.notFound('Connector');
  if (connector.status !== 'available') {
    throw AppError.conflict('That connector is not available right now');
  }
  if (!registry.isOnline(connector.station_identity)) {
    // Fail BEFORE taking the money. Obvious, and easy to get wrong when the
    // payment call is the first thing in the handler.
    throw AppError.stationOffline(connector.station_identity);
  }

  const token = await driverToken(driver.id, body.tokenId);

  /**
   * Order matters, and this is the order:
   *
   *   1. authorize the money      (fails → nothing else happened)
   *   2. create the session row   (so the command has something to reference)
   *   3. send the remote start    (fails → refund, below)
   *
   * Doing 3 before 1 means free electricity when the card declines. Doing 1
   * before checking the station is online means holding someone's money for
   * a charger that cannot charge.
   */
  const payment = await authorizePayment({
    amountMinor: body.amountMinor,
    currency: body.currency,
    userId: driver.id,
    idempotencyKey: body.idempotencyKey,
  });

  const tariff = await tariffForConnector(connector.id);
  const estimatedKwh = tariff ? estimateKwh(tariff, body.amountMinor) : null;

  const session = await createPendingSession({
    stationId: connector.station_id,
    evseId: connector.evse_id,
    connectorId: connector.connector_id,
    userId: driver.id,
    tokenId: token.id,
    tokenValue: token.value,
    paymentId: payment.id,
    authorizedAmountMinor: body.amountMinor,
    currency: body.currency,
    tariffId: tariff?.id ?? null,
  });

  try {
    await issueCommand({
      stationId: connector.station_id,
      command: 'remote_start',
      payload: {
        evseId: connector.evse_id,
        connectorId: connector.connector_id,
        idToken: token.value,
        // The cap, sent to the station. See the note at the top of this file:
        // the authorization alone does not limit anything physical.
        chargingProfile: estimatedKwh
          ? energyCapProfile(estimatedKwh, session.id)
          : undefined,
      },
      requestedBy: driver.id,
    });
  } catch (err) {
    // The station refused or is unreachable. Give the money back NOW —
    // do not leave a hold on a charge that will never happen.
    await voidPayment(payment.id, 'Station did not accept the start request');
    await cancelSession(session.id);
    throw err;
  }

  return {
    sessionId: session.id,
    paymentId: payment.id,
    status: 'pending',
    /**
     * The deadline is a promise to the driver: plug in within this window or
     * we release your money. Without it, a driver who authorizes and walks
     * away has funds held for days.
     */
    plugInDeadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    estimatedKwh,
    message: estimatedKwh
      ? `Plug in within 5 minutes. Your ${formatMoney(body.amountMinor)} buys about ${estimatedKwh.toFixed(1)} kWh.`
      : 'Plug in within 5 minutes.',
  };
});
```

### 5. The budget watchdog

```ts
// src/domain/budget.ts

/**
 * Stop a session that has spent its authorization.
 *
 * Called from the meter-values handler, which is the only place that learns
 * new energy. Three lines of logic and it is the difference between a prepaid
 * system and a hopeful one.
 *
 * Note the 95% threshold, not 100%: a remote stop takes a few seconds to
 * reach the station and the car keeps drawing during them. Stopping exactly
 * at the limit reliably overshoots it.
 */
export async function enforceBudget(sessionId: string) {
  const session = await query(
    `SELECT id, station_id, transaction_id, cost_minor, authorized_amount_minor, status
       FROM sessions WHERE id = $1`, [sessionId],
  ).then((r) => r.rows[0]);

  if (!session?.authorized_amount_minor) return;
  if (!['active', 'suspended'].includes(session.status)) return;
  if (session.cost_minor < session.authorized_amount_minor * 0.95) return;

  logger.info({ sessionId, cost: session.cost_minor }, 'budget reached, stopping session');

  await issueCommand({
    stationId: session.station_id,
    command: 'remote_stop',
    payload: { sessionId: session.id, transactionId: session.transaction_id },
  });
}
```

### 6. Closing the loop: CDR and capture

In the `StopTransaction` / `TransactionEvent(Ended)` handler, after the session
is closed:

```ts
// src/domain/sessions.ts — finaliseSession()

/**
 * One transaction, on purpose.
 *
 * Pricing, the CDR and the capture must all land or none of them must. A
 * crash between "wrote the CDR" and "captured the payment" leaves a bill
 * nobody paid; between "captured" and "wrote the CDR" leaves money taken with
 * no record of why. Neither is recoverable by a retry unless they are atomic.
 */
export async function finaliseSession(sessionId: string) {
  const priced = await tx(async (client) => {
    const session = await loadForPricing(client, sessionId);
    const tariff = session.tariff_id ? await loadTariff(client, session.tariff_id) : null;

    const result = tariff
      ? priceSession(tariff, {
          energyWh: session.energy_wh,
          durationSeconds: session.duration_seconds,
          parkingSeconds: session.parking_seconds,
          startedAt: session.started_at,
          timeZone: session.time_zone,
          maxPowerKw: session.max_power_kw,
        })
      : { totalMinor: 0, breakdown: [], trace: [], currency: session.currency };

    await client.query(
      `UPDATE sessions SET cost_minor=$2, cost_breakdown=$3 WHERE id=$1`,
      [sessionId, result.totalMinor, JSON.stringify(result.breakdown)],
    );

    await client.query(
      `INSERT INTO cdrs (session_id, reference, station_identity, station_name,
                         location_name, location_address, user_id, user_name,
                         token_value, started_at, ended_at, duration_seconds,
                         energy_wh, currency, total_minor, tariff_id,
                         tariff_snapshot, lines, payment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       -- A replayed StopTransaction must not produce a second bill. The
       -- UNIQUE constraint on session_id plus this clause makes the whole
       -- finalisation idempotent.
       ON CONFLICT (session_id) DO NOTHING`,
      [/* … */ JSON.stringify(tariff), JSON.stringify(result.breakdown), session.payment_id],
    );

    return { result, session };
  });

  // OUTSIDE the transaction: the provider call can be slow and must not hold
  // a database transaction open. If this fails, a sweeper retries it — the
  // CDR exists and says what is owed, so the retry is safe and obvious.
  if (priced.session.payment_id) {
    await capturePayment(priced.session.payment_id, priced.result.totalMinor);
  }
}
```

### 7. The rest of the driver API

| Endpoint | Note |
|---|---|
| `GET /driver/profile` | balance, lifetime stats — cheap denormalised counters |
| `GET /driver/locations/nearby` | see the distance query below |
| `GET /driver/locations/:id` | connectors with live status and this driver's price |
| `POST /driver/connectors/resolve` | QR payload or typed code → connector |
| `GET /driver/sessions/active` | polled every few seconds; keep it small |
| `GET /driver/sessions/:id` | the live charging screen |
| `POST /driver/sessions/:id/stop` | must verify the session belongs to this driver |
| `GET /driver/sessions` | history |
| `GET /driver/sessions/:id/receipt` | reads the **CDR**, never reprices |

Nearby search, without PostGIS:

```sql
-- Haversine in SQL. Good to a few metres, which is far better than the GPS
-- fix that produced the input coordinates.
SELECT l.*,
       6371 * 2 * asin(sqrt(
         power(sin(radians($2 - l.latitude) / 2), 2) +
         cos(radians(l.latitude)) * cos(radians($2)) *
         power(sin(radians($3 - l.longitude) / 2), 2)
       )) AS distance_km
  FROM locations l
 WHERE l.latitude IS NOT NULL
   -- A cheap bounding box FIRST, so the index does the work and the
   -- trigonometry only runs on candidates. 1 degree of latitude is ~111 km.
   AND l.latitude  BETWEEN $2 - ($4/111.0) AND $2 + ($4/111.0)
   AND l.longitude BETWEEN $3 - ($4/(111.0 * cos(radians($2))))
                       AND $3 + ($4/(111.0 * cos(radians($2))))
HAVING distance_km <= $4
 ORDER BY distance_km
 LIMIT $5;
```

> **Receipts read the CDR.** Never re-run the pricing engine to render a
> receipt. If you fix a pricing bug next month, last month's receipts must
> still show what was actually billed — otherwise your receipts and your
> accounts disagree, and the receipts are the ones the customer has.

---

## Prove it works

### 1. The tariff editor

Open `/tariffs` and build a time-of-use tariff:

| Element | Restriction | Price |
|---|---|---|
| 1 | 22:00–06:00 | €0.22/kWh |
| 2 | (none) | €0.45/kWh |

The preview panel is your test harness. Enter 30 kWh starting at 23:00 → €6.60.
Change the start to 14:00 → €13.50. The **trace** should say element 1 did not
match and why.

Then reorder the elements so the unrestricted one is first. Every session now
prices at €0.45 — because first match wins, and element 2 always matches. That
is not a bug, and being able to explain it is the point of the exercise.

### 2. The full money path

Open the driver app (http://localhost:5175), sign in, pick a connector, type
**€20**, and start.

| Step | Check |
|---|---|
| Authorize | `payments` row, `status='authorized'`, `authorized_amount_minor=2000` |
| Remote start | frame log shows `RemoteStartTransaction` with a charging profile |
| Charging | driver screen's ring fills as cost approaches €20 |
| Stop | `cdrs` row written once |
| Capture | `payments.status='captured'`, captured < 2000 |
| Receipt | itemised lines that add up to the captured amount |

### 3. Run the budget to its limit

Authorize **€2** and let it run. The session must stop on its own at about
€1.90, without you touching anything. Check the command history: a
`remote_stop` you did not issue.

### 4. Break it deliberately

| Do this | Expect |
|---|---|
| `PAYMENT_DECLINE_RATE=1` and start | `402 PAYMENT_DECLINED`, no session, no command |
| Double-tap start with the same idempotency key | One payment. Check `select count(*) from payments` |
| Start against an offline station | `409`, and **no** payment row in `authorized` |
| Kill the server between CDR insert and capture | Restart; the sweeper captures. No double bill |
| Replay `StopTransaction` | `ON CONFLICT DO NOTHING`. One CDR |
| Edit a tariff, then reopen an old receipt | Old numbers, unchanged |

That last one is the argument for `tariff_snapshot` in one click.

### 5. Check the rounding

```sql
SELECT energy_wh, total_minor, lines FROM cdrs ORDER BY created_at DESC LIMIT 1;
```

Compute it by hand. 8,420 Wh at €0.45/kWh with `stepSize: 1` is 8.42 × 45 =
378.9 → 379 minor units. If you get 380, you rounded the Wh up per sample
somewhere; if you get 378, you rounded money down. Both are bugs and only one
of them is in your favour.

---

## What you can now explain

- Why charging uses authorize-then-capture, and what breaks with either half
  alone.
- Why the payment authorization does not limit the car, and the three things
  that do.
- Why idempotency keys need a unique index, not a SELECT.
- Why you may capture less than you authorized and never more.
- Why the tariff's first matching element wins, and why order is a feature.
- Why a CDR is immutable and carries a snapshot of the tariff.
- Why billable quantities round up once, at the end.
- Why tariff time windows are evaluated in the site's local timezone.

---

Next: **[Milestone 12 — OCPI roaming →](milestone-12-ocpi.md)**
