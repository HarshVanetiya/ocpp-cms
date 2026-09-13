import { z } from 'zod';
import {
  CurrencySchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import {
  AuthorizationStatusSchema,
  MeasurandSchema,
  ProtocolSchema,
  SessionStatusSchema,
  StopReasonSchema,
  TokenTypeSchema,
} from './enums';

/**
 * Charging sessions — the thing the whole system exists to produce.
 *
 * ## Vocabulary
 * OCPP says "transaction". OCPI says "session". The business says "charge".
 * They are the same object. We call it a Session everywhere in our own API
 * and reserve the word "transaction" for the protocol-level identifier the
 * station gave us.
 *
 * ## The two ids, and why you need both
 *
 * `id`            our UUID. Stable, unique across the fleet, safe in URLs.
 * `transactionId` the station's identifier for the same charge.
 *
 * In OCPP 1.6 the CSMS invents `transactionId` and it is an INTEGER that must
 * be unique per CSMS. In OCPP 2.0.1 the STATION invents it and it is a STRING
 * up to 36 characters. These are incompatible, which is exactly why you keep
 * your own UUID as the primary key and store theirs alongside it.
 *
 * A 1.6 station will happily send you `transactionId: 1` after a reboot if you
 * let it. Never key your database on it.
 */

export const IdTokenRefSchema = z.object({
  value: z.string().describe('The raw identifier presented at the charger'),
  type: TokenTypeSchema,
  /** Resolved from our token table, null if the token is unknown to us. */
  tokenId: IdSchema.nullable(),
  userId: IdSchema.nullable(),
  userName: z.string().nullable(),
});
export type IdTokenRef = z.infer<typeof IdTokenRefSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  /**
   * The protocol-level id, kept as a string even for 1.6 (where it is a
   * number) so one column serves both. Null while the session is `pending`:
   * we created the row when the driver paid, but no station has opened a
   * transaction yet.
   */
  transactionId: z.string().nullable(),
  protocol: ProtocolSchema,
  status: SessionStatusSchema,

  stationId: IdSchema,
  stationIdentity: z.string(),
  stationName: z.string(),
  locationId: IdSchema.nullable(),
  locationName: z.string().nullable(),
  evseId: z.number().int(),
  connectorId: z.number().int(),

  idToken: IdTokenRefSchema,

  startedAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
  durationSeconds: z.number().int().nonnegative(),

  /**
   * Meter readings in watt-hours. OCPP 1.6 sends `meterStart`/`meterStop` in
   * Wh as integers. Keep Wh, not kWh: kWh means decimals, decimals mean
   * floats, floats mean rounding disputes. Divide by 1000 in the UI only.
   */
  meterStartWh: z.number().nullable(),
  meterStopWh: z.number().nullable(),
  energyDeliveredWh: z.number().nonnegative(),

  /** Live values, updated from MeterValues / TransactionEvent. */
  currentPowerKw: z.number().nullable(),
  currentSoc: z.number().min(0).max(100).nullable(),

  stopReason: StopReasonSchema.nullable(),

  tariffId: IdSchema.nullable(),
  tariffName: z.string().nullable(),
  currency: CurrencySchema,
  /** Running cost while active, final cost once complete. */
  costMinor: MoneyMinorSchema,
  /** Breakdown so the receipt can explain the number. */
  costBreakdown: z
    .array(
      z.object({
        label: z.string(),
        kind: z.enum(['energy', 'time', 'flat', 'parking_time']),
        quantity: z.number(),
        unit: z.string(),
        unitPriceMinor: MoneyMinorSchema,
        amountMinor: MoneyMinorSchema,
      }),
    )
    .default([]),

  paymentId: IdSchema.nullable(),
  authorizedAmountMinor: MoneyMinorSchema.nullable(),

  /** Set once the session has been turned into a billing record. */
  cdrId: IdSchema.nullable(),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionListQuerySchema = PageQuerySchema.extend({
  status: SessionStatusSchema.optional(),
  stationId: IdSchema.optional(),
  locationId: IdSchema.optional(),
  userId: IdSchema.optional(),
  protocol: ProtocolSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;

export const SessionListResponseSchema = paginated(SessionSchema);
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/* ------------------------------------------------------------------ *
 * Meter values
 * ------------------------------------------------------------------ */

/**
 * One sample from the station's meter.
 *
 * On the wire this is deeply nested — a MeterValues request carries a list of
 * timestamps, each with a list of SampledValue objects, each with its own
 * measurand, unit, phase, location and context. Storing it in that shape
 * makes every chart query a nightmare.
 *
 * So we PIVOT at ingest: one row per timestamp, with the measurands we care
 * about as columns. Unrecognised measurands go into `extra`. This is a real
 * engineering trade-off worth being able to defend: we lose generality and
 * gain a table that a time-series chart can read directly.
 */
export const MeterValueSchema = z.object({
  sessionId: IdSchema,
  timestamp: TimestampSchema,
  /** Cumulative register reading, Wh. The one measurand that is never absent. */
  energyWh: z.number().nullable(),
  powerKw: z.number().nullable(),
  currentA: z.number().nullable(),
  voltageV: z.number().nullable(),
  soc: z.number().min(0).max(100).nullable(),
  temperatureC: z.number().nullable(),
  extra: z.record(z.string(), z.number()).optional(),
});
export type MeterValue = z.infer<typeof MeterValueSchema>;

export const MeterValueQuerySchema = z.object({
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  /**
   * Downsampling. A 6-hour session sampled every 10s is 2160 points; a chart
   * 600px wide cannot show them. Ask the database to bucket, do not ship them
   * all and throw them away in the browser.
   */
  resolution: z.enum(['raw', '10s', '1m', '5m', '15m', '1h']).default('raw'),
  measurands: z.array(MeasurandSchema).optional(),
});
export type MeterValueQuery = z.infer<typeof MeterValueQuerySchema>;

export const MeterValueResponseSchema = z.object({
  sessionId: IdSchema,
  resolution: z.string(),
  data: z.array(MeterValueSchema),
});
export type MeterValueResponse = z.infer<typeof MeterValueResponseSchema>;

/* ------------------------------------------------------------------ *
 * Authorization log
 * ------------------------------------------------------------------ */

/**
 * Every authorization decision, kept for support. "My card did not work" is
 * the number one support ticket in charging, and without this table you
 * cannot answer it.
 */
export const AuthorizationRecordSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  stationId: IdSchema,
  stationIdentity: z.string(),
  evseId: z.number().int().nullable(),
  tokenValue: z.string(),
  tokenType: TokenTypeSchema,
  tokenId: IdSchema.nullable(),
  userId: IdSchema.nullable(),
  userName: z.string().nullable(),
  result: AuthorizationStatusSchema,
  reason: z.string().nullable(),
  /** Did we answer from the local cache/list, or did we actually decide? */
  source: z.enum(['csms', 'local_list', 'auth_cache', 'ocpi_remote']),
  latencyMs: z.number().nullable(),
});
export type AuthorizationRecord = z.infer<typeof AuthorizationRecordSchema>;

export const AuthorizationListQuerySchema = PageQuerySchema.extend({
  stationId: IdSchema.optional(),
  userId: IdSchema.optional(),
  result: AuthorizationStatusSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type AuthorizationListQuery = z.infer<typeof AuthorizationListQuerySchema>;

export const AuthorizationListResponseSchema = paginated(AuthorizationRecordSchema);
export type AuthorizationListResponse = z.infer<typeof AuthorizationListResponseSchema>;

/* ------------------------------------------------------------------ *
 * CDR — Charge Detail Record
 * ------------------------------------------------------------------ */

/**
 * The immutable billing record produced when a session ends.
 *
 * Why a separate object from Session: a Session is mutable operational state,
 * a CDR is a financial document. Once issued it never changes — corrections
 * are issued as new credit CDRs. This is also exactly the OCPI model, so when
 * you reach the OCPI milestone this object maps almost field for field.
 */
export const CdrSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** Human-facing reference printed on the receipt. */
  reference: z.string(),
  stationIdentity: z.string(),
  locationName: z.string().nullable(),
  userId: IdSchema.nullable(),
  userName: z.string().nullable(),
  tokenValue: z.string(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationSeconds: z.number().int(),
  energyDeliveredWh: z.number(),
  currency: CurrencySchema,
  totalCostMinor: MoneyMinorSchema,
  totalEnergyCostMinor: MoneyMinorSchema,
  totalTimeCostMinor: MoneyMinorSchema,
  totalFlatCostMinor: MoneyMinorSchema,
  totalParkingCostMinor: MoneyMinorSchema,
  vatPercent: z.number().nullable(),
  tariffId: IdSchema.nullable(),
  tariffSnapshot: z.record(z.string(), z.unknown()).nullable().describe(
    'A frozen copy of the tariff as it was when the session ran. Tariffs change; ' +
      'a CDR must always be reproducible from itself.',
  ),
  paymentId: IdSchema.nullable(),
  issuedAt: TimestampSchema,
  /** Set when this CDR has been pushed to an OCPI partner. */
  ocpiPushedAt: TimestampSchema.nullable(),
});
export type Cdr = z.infer<typeof CdrSchema>;

export const CdrListQuerySchema = PageQuerySchema.extend({
  userId: IdSchema.optional(),
  stationId: IdSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type CdrListQuery = z.infer<typeof CdrListQuerySchema>;

export const CdrListResponseSchema = paginated(CdrSchema);
export type CdrListResponse = z.infer<typeof CdrListResponseSchema>;

export const StopSessionSchema = z.object({
  reason: StopReasonSchema.default('remote'),
});
export type StopSession = z.infer<typeof StopSessionSchema>;
