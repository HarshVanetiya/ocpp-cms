import { z } from 'zod';
import {
  CurrencySchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import { SessionStatusSchema } from './enums';

/**
 * The driver-facing API.
 *
 * ## Why this is a separate namespace, not just "the same endpoints"
 *
 * Three reasons, and they are all the kind of thing a senior engineer will
 * ask about:
 *
 *  1. AUTHORIZATION SHAPE. An operator asks "give me all sessions". A driver
 *     asks "give me MY sessions" and must never be able to ask anything else.
 *     If both use `GET /sessions?userId=`, then one missing check leaks the
 *     whole fleet. `GET /driver/sessions` takes the user from the token and
 *     has no parameter to forget.
 *
 *  2. PAYLOAD SHAPE. Drivers do not need station identities, OCPP protocol
 *     versions or operator notes. Sending them wastes mobile bandwidth and
 *     leaks internals.
 *
 *  3. CHANGE RATE. The dashboard API changes when operators want new
 *     features; the driver API is a public contract with an app you cannot
 *     force people to update. Different lifecycles want different namespaces.
 *
 * Base path: `/api/v1/driver`. Every endpoint requires a driver token.
 */

/* ------------------------------------------------------------------ *
 * Starting a charge — the core flow
 * ------------------------------------------------------------------ */

/**
 * The whole driver journey, which is what this project is really teaching:
 *
 *   1. Driver picks a connector in the app.
 *   2. Driver types an amount, e.g. 25.00.
 *      → POST /driver/charge/start
 *   3. Backend calls the dummy payment API to AUTHORIZE 2500 minor units.
 *      If it declines, stop here and tell the driver.
 *   4. Backend creates a Session in status `pending`.
 *   5. Backend sends RemoteStartTransaction (1.6) or
 *      RequestStartTransaction (2.0.1) to the station, including a charging
 *      profile that caps the energy to what 2500 buys at this tariff.
 *   6. Station answers Accepted. The session is STILL `pending` — this only
 *      means the station will try.
 *   7. Driver plugs in. Station sends StartTransaction / TransactionEvent
 *      (Started). NOW the session becomes `active`.
 *   8. Meter values arrive; the app shows live kWh, kW and running cost.
 *   9. Driver taps stop, or the cap is reached, or the car is full.
 *  10. Station sends StopTransaction / TransactionEvent (Ended).
 *  11. Backend prices the session, CAPTURES the actual cost (never more than
 *      the authorization), releases the rest, and issues a CDR.
 *
 * Step 6→7 is the one people miss. There is a gap, sometimes a long one,
 * between "paid" and "charging", and the app must show something honest
 * during it. The driver app in this repo has a dedicated waiting state with a
 * timeout that refunds.
 */
export const StartChargeSchema = z.object({
  /** From the location detail screen, or from scanning a QR code. */
  connectorId: IdSchema,
  /**
   * What the driver typed, in minor units. The UI multiplies by 100.
   * This becomes both the payment authorization and the station's energy cap.
   */
  amountMinor: MoneyMinorSchema,
  currency: CurrencySchema,
  /** Which of the driver's tokens to present. Defaults to their app token. */
  tokenId: IdSchema.optional(),
  /** Send a UUID; retrying with the same key must not double-charge. */
  idempotencyKey: z.string().optional(),
});
export type StartCharge = z.infer<typeof StartChargeSchema>;

export const StartChargeResponseSchema = z.object({
  sessionId: IdSchema,
  paymentId: IdSchema,
  status: SessionStatusSchema,
  /** How long we will wait for the car to be plugged in before refunding. */
  plugInDeadlineAt: TimestampSchema,
  /** Estimated energy the authorized amount buys at the current tariff. */
  estimatedKwh: z.number().nullable(),
  message: z.string(),
});
export type StartChargeResponse = z.infer<typeof StartChargeResponseSchema>;

/**
 * QR code resolution. The sticker on a charger encodes a connector; scanning
 * it must land the driver on the right screen without them typing anything.
 */
export const ResolveConnectorSchema = z.object({
  /** Either a raw QR payload, or a human-typed code printed under it. */
  code: z.string().min(1),
});
export type ResolveConnector = z.infer<typeof ResolveConnectorSchema>;

/* ------------------------------------------------------------------ *
 * Live session
 * ------------------------------------------------------------------ */

/** What the "charging now" screen renders. Deliberately small — it polls. */
export const DriverSessionSchema = z.object({
  id: IdSchema,
  status: SessionStatusSchema,
  locationName: z.string(),
  stationName: z.string(),
  connectorLabel: z.string().describe('"EVSE 1 · CCS2 · 150 kW"'),
  startedAt: TimestampSchema.nullable(),
  durationSeconds: z.number().int(),
  energyDeliveredWh: z.number(),
  currentPowerKw: z.number().nullable(),
  currentSoc: z.number().nullable(),
  costMinor: MoneyMinorSchema,
  currency: CurrencySchema,
  authorizedAmountMinor: MoneyMinorSchema,
  /** costMinor / authorizedAmountMinor, clamped to 100. Drives the ring gauge. */
  budgetUsedPercent: z.number().min(0).max(100),
  estimatedKwhRemaining: z.number().nullable(),
  /** Human sentence for the current state, written by the backend. */
  statusMessage: z.string(),
  canStop: z.boolean(),
});
export type DriverSession = z.infer<typeof DriverSessionSchema>;

export const DriverSessionListQuerySchema = PageQuerySchema.extend({
  status: SessionStatusSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type DriverSessionListQuery = z.infer<typeof DriverSessionListQuerySchema>;

export const DriverSessionListResponseSchema = paginated(DriverSessionSchema);
export type DriverSessionListResponse = z.infer<typeof DriverSessionListResponseSchema>;

export const ActiveSessionsResponseSchema = z.object({ data: z.array(DriverSessionSchema) });
export type ActiveSessionsResponse = z.infer<typeof ActiveSessionsResponseSchema>;

/* ------------------------------------------------------------------ *
 * Receipt
 * ------------------------------------------------------------------ */

export const ReceiptSchema = z.object({
  sessionId: IdSchema,
  cdrId: IdSchema.nullable(),
  reference: z.string(),
  locationName: z.string(),
  locationAddress: z.string(),
  stationName: z.string(),
  connectorLabel: z.string(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationSeconds: z.number().int(),
  energyDeliveredWh: z.number(),
  currency: CurrencySchema,
  lines: z.array(
    z.object({
      label: z.string(),
      quantity: z.number(),
      unit: z.string(),
      unitPriceMinor: MoneyMinorSchema,
      amountMinor: MoneyMinorSchema,
    }),
  ),
  subtotalMinor: MoneyMinorSchema,
  vatPercent: z.number().nullable(),
  vatMinor: MoneyMinorSchema,
  totalMinor: MoneyMinorSchema,
  authorizedAmountMinor: MoneyMinorSchema,
  /** authorized − captured. The number the driver actually cares about. */
  refundedMinor: MoneyMinorSchema,
  paymentReference: z.string().nullable(),
  issuedAt: TimestampSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/* ------------------------------------------------------------------ *
 * Driver profile
 * ------------------------------------------------------------------ */

export const DriverProfileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  balanceMinor: MoneyMinorSchema.nullable(),
  currency: CurrencySchema,
  tokens: z.array(
    z.object({
      id: IdSchema,
      label: z.string().nullable(),
      type: z.string(),
      maskedValue: z.string().describe('Never return the full token to the app'),
      status: z.string(),
      lastUsedAt: TimestampSchema.nullable(),
    }),
  ),
  stats: z.object({
    sessionCount: z.number().int(),
    totalEnergyWh: z.number(),
    totalSpentMinor: MoneyMinorSchema,
    /** kg avoided versus an equivalent petrol car. Every driver app has this. */
    co2SavedKg: z.number(),
  }),
  favouriteLocationIds: z.array(IdSchema),
});
export type DriverProfile = z.infer<typeof DriverProfileSchema>;
