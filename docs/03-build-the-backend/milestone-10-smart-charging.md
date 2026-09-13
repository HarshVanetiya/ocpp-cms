# Milestone 10 — Smart charging

**Goal:** limit how fast cars charge, and stop a site from tripping its main
breaker.

**Time:** 4–5 hours. The hardest concepts in OCPP live here.

**Endpoints:** none new — this rides on Milestone 6's command pipeline.

---

## Why this exists

A site has a grid connection. Say 100 kW. It has six 50 kW chargers, because
six cars rarely turn up at once — and when they do, something has to give.

Without smart charging that "something" is the main breaker, and the whole site
goes dark. With it, six cars share 100 kW and everyone charges a bit slower.

This is not a nice-to-have. Grid capacity is the binding constraint on EV
infrastructure almost everywhere, and **load management is the feature
operators actually pay for.** It is also the part of OCPP most people skip,
which makes it disproportionately valuable to be able to discuss.

### The concepts, in the order they confused everyone

**A ChargingProfile is not a limit.** It is a *schedule* of limits, with a
purpose, a stack level, and a validity window. Several can apply at once.

**Three purposes, and they compose:**

| Purpose | Meaning | Set by |
|---|---|---|
| `ChargePointMaxProfile` | The station's ceiling, whatever else says | the operator, long-lived |
| `TxDefaultProfile` | The default for any transaction here | the operator, per connector |
| `TxProfile` | This transaction only | the CSMS, during a session |

The station applies **the most restrictive of all applicable profiles**. You do
not "override" a lower limit by sending a higher one — that is the single most
common misunderstanding, and the reason people report "the station ignores my
profile" when it is doing exactly what it was told.

**`stackLevel` breaks ties within a purpose.** Higher wins. Two `TxProfile`s at
stack level 0 and 1: the level 1 one applies. It does *not* let you exceed a
`ChargePointMaxProfile`.

**Units: A or W, and you must say which.** `chargingRateUnit: "A"` means amps
*per phase*. A 32 A limit on a 3-phase 230 V supply is 32 × 230 × 3 ≈ 22 kW; on
single phase it is 7.4 kW. Send amps to a station whose phase count you assumed
wrongly and you will be off by a factor of three. Prefer `W` when the station
supports it — `SupportedFeatureProfiles` / the device model tells you.

**Schedules are relative to a start.** A `chargingSchedulePeriod` has
`startPeriod` in **seconds from the schedule start**, not a clock time. `[{
startPeriod: 0, limit: 32 }, { startPeriod: 3600, limit: 16 }]` means "32 A for
an hour, then 16 A". The limit holds until the next period — the last one runs
forever.

---

## Build it

### 1. The profile model

```sql
-- migrations/006_smart_charging.sql

CREATE TABLE charging_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id    UUID NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  -- 0 means the whole station; 1..n a specific EVSE.
  evse_id       INT  NOT NULL DEFAULT 0,

  -- The id the STATION knows this profile by. It is an integer in both
  -- protocol versions and it must be unique per station, because that is how
  -- ClearChargingProfile addresses it. Our UUID is for us; this is for them.
  profile_id    INT  NOT NULL,

  purpose       TEXT NOT NULL CHECK (purpose IN
                  ('charge_point_max_profile','tx_default_profile','tx_profile')),
  stack_level   INT  NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'absolute'
                CHECK (kind IN ('absolute','recurring','relative')),
  recurrency    TEXT CHECK (recurrency IN ('daily','weekly')),

  rate_unit     TEXT NOT NULL DEFAULT 'W' CHECK (rate_unit IN ('A','W')),
  -- [{ startPeriod: 0, limit: 22000, numberPhases: 3 }, ...]
  periods       JSONB NOT NULL,

  valid_from    TIMESTAMPTZ,
  valid_to      TIMESTAMPTZ,
  session_id    UUID REFERENCES sessions(id) ON DELETE CASCADE,

  -- Did the station accept it? A profile we think is applied and the station
  -- rejected is the worst possible state, so record the truth.
  applied       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (station_id, profile_id)
);

CREATE INDEX idx_profiles_station ON charging_profiles(station_id, evse_id);
CREATE INDEX idx_profiles_session ON charging_profiles(session_id)
  WHERE session_id IS NOT NULL;
```

### 2. Building the wire payload

```ts
// src/ocpp/commands/charging-profile.ts

export interface SimpleProfile {
  profileId: number;
  purpose: 'charge_point_max_profile' | 'tx_default_profile' | 'tx_profile';
  stackLevel: number;
  rateUnit: 'A' | 'W';
  periods: Array<{ startPeriod: number; limit: number; numberPhases?: number }>;
  validFrom?: string;
  validTo?: string;
  /** 1.6 needs the station's transaction id inside a TxProfile. */
  transactionId?: number | string;
}

const PURPOSE_16 = {
  charge_point_max_profile: 'ChargePointMaxProfile',
  tx_default_profile: 'TxDefaultProfile',
  tx_profile: 'TxProfile',
} as const;

/** 2.0.1 renamed exactly one of the three. Of course it did. */
const PURPOSE_201 = {
  charge_point_max_profile: 'ChargingStationMaxProfile',
  tx_default_profile: 'TxDefaultProfile',
  tx_profile: 'TxProfile',
} as const;

export function toSetChargingProfile(p: SimpleProfile, protocol: Protocol, connectorOrEvse: number) {
  const schedule = {
    // Numbering inside the profile. 2.0.1 requires it; 1.6 ignores it.
    id: p.profileId,
    chargingRateUnit: p.rateUnit,
    chargingSchedulePeriod: p.periods.map((period) => ({
      startPeriod: period.startPeriod,
      /**
       * `limit` is a DECIMAL and stations care about the precision.
       * 1.6 says one decimal place; sending 22000.0001 is a formation
       * violation on strict firmware. Round it.
       */
      limit: Math.round(period.limit * 10) / 10,
      ...(period.numberPhases ? { numberPhases: period.numberPhases } : {}),
    })),
  };

  if (protocol === 'ocpp1.6') {
    return {
      action: 'SetChargingProfile',
      payload: {
        connectorId: connectorOrEvse,
        csChargingProfiles: {
          chargingProfileId: p.profileId,
          stackLevel: p.stackLevel,
          chargingProfilePurpose: PURPOSE_16[p.purpose],
          chargingProfileKind: 'Absolute',
          ...(p.validFrom ? { validFrom: p.validFrom } : {}),
          ...(p.validTo ? { validTo: p.validTo } : {}),
          // A TxProfile without transactionId is rejected by most 1.6
          // firmware, and the spec agrees with them.
          ...(p.purpose === 'tx_profile' && p.transactionId != null
            ? { transactionId: Number(p.transactionId) }
            : {}),
          chargingSchedule: {
            chargingRateUnit: schedule.chargingRateUnit,
            chargingSchedulePeriod: schedule.chargingSchedulePeriod,
          },
        },
      },
    };
  }

  return {
    action: 'SetChargingProfile',
    payload: {
      // 0 addresses the whole station in 2.0.1 too, but ONLY for
      // ChargingStationMaxProfile. Anything else needs a real EVSE.
      evseId: connectorOrEvse,
      chargingProfile: {
        id: p.profileId,
        stackLevel: p.stackLevel,
        chargingProfilePurpose: PURPOSE_201[p.purpose],
        chargingProfileKind: 'Absolute',
        ...(p.validFrom ? { validFrom: p.validFrom } : {}),
        ...(p.validTo ? { validTo: p.validTo } : {}),
        // 2.0.1 transaction ids are strings and this one is not optional
        // for a TxProfile either.
        ...(p.purpose === 'tx_profile' && p.transactionId != null
          ? { transactionId: String(p.transactionId) }
          : {}),
        // Note the array: 2.0.1 allows several schedules so a station can
        // pick one based on ISO 15118 negotiation with the car.
        chargingSchedule: [schedule],
      },
    },
  };
}
```

Wire it into the Milestone 6 mapper table:

```ts
// src/ocpp/commands/map.ts
set_charging_profile: {
  toWire(p, protocol) {
    return toSetChargingProfile(
      {
        profileId: Number(p.profileId),
        purpose: p.purpose as SimpleProfile['purpose'],
        stackLevel: Number(p.stackLevel ?? 0),
        rateUnit: 'W',
        // The dashboard sends one number in kW. Expand it here — the UI
        // should not have to know what a chargingSchedulePeriod is.
        periods: [{ startPeriod: 0, limit: Number(p.limitKw) * 1000 }],
        validFrom: p.validFrom as string | undefined,
        validTo: p.validTo as string | undefined,
        transactionId: p.transactionId as string | undefined,
      },
      protocol,
      Number(p.evseId ?? 0),
    );
  },
  readVerdict: statusVerdict,
},

clear_charging_profile: {
  toWire(p, protocol) {
    if (protocol === 'ocpp1.6') {
      return {
        action: 'ClearChargingProfile',
        payload: {
          ...(p.profileId ? { id: Number(p.profileId) } : {}),
          ...(p.evseId != null ? { connectorId: Number(p.evseId) } : {}),
          ...(p.purpose ? { chargingProfilePurpose: PURPOSE_16[p.purpose] } : {}),
        },
      };
    }
    return {
      action: 'ClearChargingProfile',
      payload: {
        ...(p.profileId ? { chargingProfileId: Number(p.profileId) } : {}),
        chargingProfileCriteria: {
          ...(p.evseId != null ? { evseId: Number(p.evseId) } : {}),
          ...(p.purpose ? { chargingProfilePurpose: PURPOSE_201[p.purpose] } : {}),
        },
      },
    };
  },
  // 1.6 answers Accepted/Unknown — "Unknown" means "no profile matched",
  // which is a successful no-op, not a failure.
  readVerdict(r) {
    const s = String(r?.status ?? '');
    return s === 'Accepted' || s === 'Unknown' ? 'accepted' : 'rejected';
  },
},
```

### 3. Site load management

This is the actual feature. Everything above was plumbing.

```ts
// src/domain/load-management.ts
import { query } from '../db/index.js';
import { issueCommand } from './commands.js';
import { logger } from '../logger.js';

/**
 * Share a site's grid capacity between the cars currently charging.
 *
 * The algorithm below is EQUAL SHARE with a floor, and it is deliberately the
 * simplest thing that works. Know why each rule exists:
 *
 *  1. Reserve headroom. Never allocate 100% of the connection — meter
 *     accuracy, power factor and inrush all eat margin, and a breaker that
 *     trips costs an outage. 90% is a normal default.
 *
 *  2. Respect a minimum. Below roughly 6 A (about 1.4 kW single-phase) most
 *     cars STOP CHARGING rather than charge slowly, and many will not restart
 *     on their own. An allocation of 0.5 kW is worse than refusing the car.
 *
 *  3. Do not allocate to cars that cannot use it. A car tapering at 7 kW on a
 *     50 kW charger does not need 25 kW, and giving it 25 kW starves the car
 *     next to it. Allocate against RECENT ACTUAL DRAW, not connector rating.
 *
 *  4. Re-run on every change. A car finishing frees capacity that should go
 *     to the others within seconds, not at the next cron tick.
 *
 * Real operators go further — priority tiers, reserved capacity for fleet
 * vehicles, price-following schedules, ISO 15118 bidirectional. Equal share
 * with a floor is the baseline all of those are measured against, and being
 * able to explain the three rules above is the point.
 */

const HEADROOM = 0.9;
const MIN_ALLOCATION_KW = 1.4;

export async function rebalanceSite(locationId: string) {
  const site = await query(
    `SELECT id, name, grid_capacity_kw FROM locations WHERE id = $1`,
    [locationId],
  ).then((r) => r.rows[0]);

  if (!site?.grid_capacity_kw) return;   // no declared limit, nothing to manage

  const { rows: live } = await query(
    `SELECT s.id            AS session_id,
            s.station_id,
            s.evse_id,
            s.transaction_id,
            st.max_power_kw AS station_max_kw,
            -- Recent actual draw. The last five samples, so one anomalous
            -- reading does not swing the allocation.
            COALESCE((
              SELECT avg(mv.power_kw) FROM (
                SELECT power_kw FROM meter_values
                 WHERE session_id = s.id AND power_kw IS NOT NULL
                 ORDER BY measured_at DESC LIMIT 5
              ) mv
            ), 0) AS recent_kw
       FROM sessions s
       JOIN stations st ON st.id = s.station_id
      WHERE st.location_id = $1
        AND s.status IN ('active','suspended')`,
    [locationId],
  );

  if (live.length === 0) return;

  const budget = Number(site.grid_capacity_kw) * HEADROOM;

  /**
   * Water-filling.
   *
   * Give everyone an equal share; anyone who cannot use their share gives the
   * remainder back, and it is re-divided among those who can. Repeat until
   * nothing changes. Converges in at most N passes and is easy to read, which
   * matters more here than being clever — this code decides whether a site
   * stays up.
   */
  const demand = live.map((s) => ({
    ...s,
    // What this car could plausibly take: its recent draw plus a little
    // headroom to let it ramp, capped by the hardware.
    want: Math.min(Number(s.station_max_kw), Math.max(Number(s.recent_kw) * 1.2, MIN_ALLOCATION_KW)),
    allocation: 0,
  }));

  let remaining = budget;
  let open = demand.filter((d) => d.allocation === 0);

  while (open.length > 0 && remaining > 0.01) {
    const share = remaining / open.length;
    const satisfied = open.filter((d) => d.want <= share);

    if (satisfied.length === 0) {
      // Nobody is cheap enough to satisfy fully: everyone gets the share.
      for (const d of open) d.allocation = share;
      remaining = 0;
      break;
    }
    for (const d of satisfied) {
      d.allocation = d.want;
      remaining -= d.want;
    }
    open = open.filter((d) => d.allocation === 0);
  }

  for (const d of demand) {
    /**
     * The floor, applied last and deliberately.
     *
     * If the fair share is below what a car can actually use, giving it that
     * share means it stops charging and the capacity is wasted anyway. The
     * honest options are: leave it below the floor and accept it pauses, or
     * pause it explicitly and give its capacity to someone who can use it.
     * We do the first and log it, because silently suspending someone's
     * charge is a support ticket.
     */
    if (d.allocation < MIN_ALLOCATION_KW) {
      logger.warn(
        { sessionId: d.session_id, allocationKw: d.allocation, site: site.name },
        'allocation below the usable minimum — the car may stop charging',
      );
    }

    await applyLimit(d);
  }
}

async function applyLimit(d: { station_id: string; evse_id: number; session_id: string;
                               transaction_id: string | null; allocation: number }) {
  // Do not resend an unchanged limit. Every SetChargingProfile is a round
  // trip to a device on a mobile connection, and a rebalance that fires on
  // every meter value would flood the fleet with no-op commands.
  const current = await query(
    `SELECT periods->0->>'limit' AS limit_w FROM charging_profiles
      WHERE session_id = $1 AND purpose = 'tx_profile' AND applied
      ORDER BY created_at DESC LIMIT 1`,
    [d.session_id],
  ).then((r) => r.rows[0]);

  const targetW = Math.round(d.allocation * 1000);
  if (current && Math.abs(Number(current.limit_w) - targetW) < 200) return;   // within 0.2 kW

  await issueCommand({
    stationId: d.station_id,
    command: 'set_charging_profile',
    payload: {
      evseId: d.evse_id,
      limitKw: d.allocation,
      purpose: 'tx_profile',
      // Stack level 1 so it beats the operator's TxDefaultProfile at level 0.
      stackLevel: 1,
      sessionId: d.session_id,
      transactionId: d.transaction_id,
    },
  });
}
```

Trigger it where capacity changes:

```ts
// after a session starts, ends, or reports a meter value
await rebalanceSite(station.location_id);
```

> **Debounce it.** With 20 sessions reporting every 10 seconds, that is two
> rebalances a second. Coalesce per site: a rebalance for site X within the
> next 5 seconds replaces any pending one. Ten lines with a `Map<string,
> NodeJS.Timeout>`, and it turns a chatty system into a calm one.

### 4. GetCompositeSchedule — asking the station what it thinks

```ts
get_composite_schedule: {
  toWire(p, protocol) {
    if (protocol === 'ocpp1.6') {
      return {
        action: 'GetCompositeSchedule',
        payload: {
          connectorId: Number(p.evseId ?? 0),
          duration: Number(p.durationSeconds),
          chargingRateUnit: 'W',
        },
      };
    }
    return {
      action: 'GetCompositeSchedule',
      payload: {
        evseId: Number(p.evseId ?? 0),
        duration: Number(p.durationSeconds),
        chargingRateUnit: 'W',
      },
    };
  },
  readVerdict: statusVerdict,
},
```

This is the debugging tool for everything above. It asks the station: *given
every profile you currently hold, what will you actually do for the next N
seconds?* When an operator says "the limit is not working", this is how you find
out whether the station disagrees with you or the car is simply not drawing
what it could.

---

## Prove it works

### 1. A single limit

Create a site with `grid_capacity_kw = 22`, one station, one session. From the
station detail page set a 7 kW limit.

```
→ SetChargingProfile {"connectorId":1,"csChargingProfiles":{
     "chargingProfileId":1,"stackLevel":1,
     "chargingProfilePurpose":"TxProfile","transactionId":48213,
     "chargingSchedule":{"chargingRateUnit":"W",
       "chargingSchedulePeriod":[{"startPeriod":0,"limit":7000}]}}}
← {"status":"Accepted"}
```

Then watch the session's power chart in the dashboard drop to ~7 kW within a
couple of meter values.

> **This only works if your simulator honours the profile.** That is
> [Milestone S3](../08-build-the-simulator/README.md#s3): the simulated station
> clamps its charging power to the lowest applicable limit, exactly as real
> hardware does. Build that first or you are testing nothing — the profile
> will be Accepted and the power will not move, and you will not be able to
> tell whether your CPMS or your test rig is wrong.

### 2. Contention

Site capacity 50 kW, three stations rated 22 kW each. Start all three.

| Cars charging | Expect each |
|---|---|
| 1 | 22 kW (its own max, not 45) |
| 2 | 22 kW each (44 < 45 budget) |
| 3 | ~15 kW each |

Stop one and watch the other two climb back to 22 within a rebalance cycle. The
site total must never exceed 45 kW (50 × 0.9).

### 3. The taper case

Start a session on a station whose simulated car is near full — the simulator's
taper curve (also [Milestone S3](../08-build-the-simulator/README.md#s3)) drops
its draw to about 5 kW above 80% SoC. With three cars and a 50 kW site:

- the tapering car gets ~6 kW, not 15,
- the other two get ~19 kW each.

If all three get 15 kW, you are allocating against connector rating instead of
actual draw. That is rule 3, and it is the one that separates a working load
manager from a fair-looking one.

### 4. Verify with the station, not with your own database

Send `GetCompositeSchedule` for 3600 seconds. The station's answer must match
what you believe you set. If it does not, one of these is true and the response
tells you which:

- a `ChargePointMaxProfile` is capping you lower,
- another `TxProfile` at a higher stack level wins,
- your `validFrom` is in the future,
- the station rejected the profile and you recorded it as applied anyway.

### 5. Break it deliberately

| Do this | Expect |
|---|---|
| Send a `TxProfile` with no `transactionId` on 1.6 | `Rejected` — and now you know why the field is there |
| Set a limit above the station's `ChargePointMaxProfile` | Accepted, but the composite schedule still shows the lower number |
| Set a 0.5 kW limit | Accepted; the car probably stops. Your log warned you |
| Clear all profiles mid-charge | Power returns to the connector maximum |

---

## What you can now explain

- Why several charging profiles apply at once and the most restrictive wins.
- What `stackLevel` does, and what it does *not* do.
- Why A and W are not interchangeable, and what a wrong phase assumption costs.
- Why `startPeriod` is relative, and how a schedule with two periods behaves.
- Why load management allocates against recent draw rather than rated power.
- Why there is a minimum allocation, and what happens below it.
- What `GetCompositeSchedule` is for, and why it is the only way to know what a
  station will really do.

> **This is the answer to "what did you build that was hard?"** Load management
> is a genuine distributed-systems problem — partial information, devices that
> lag, and a physical constraint you cannot violate.

---

Next: **[Milestone 11 — tariffs, payments and the driver →](milestone-11-tariffs-payments.md)**
