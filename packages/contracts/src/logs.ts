import { z } from 'zod';
import { CursorQuerySchema, IdSchema, TimestampSchema, cursorPaginated } from './common';
import {
  MessageDirectionSchema,
  MessageTypeIdSchema,
  OcppErrorCodeSchema,
  ProtocolSchema,
} from './enums';

/**
 * The OCPP frame log — the single most useful screen in this whole project.
 *
 * Every message in and out, stored verbatim, searchable, with request and
 * response stitched together. When something goes wrong in charging, this is
 * where you look, and being able to say "I built a protocol inspector" is
 * worth more in an interview than any CRUD screen.
 *
 * ## Store the raw frame
 *
 * Persist the exact JSON array that crossed the wire, not your parsed version
 * of it. When a station sends something malformed you need to SEE the
 * malformed thing. A log that only contains successfully-parsed messages is
 * useless precisely when you need it.
 *
 * ## Stitching
 *
 * A CALLRESULT contains no action name — only the message id. To show
 * "BootNotification → Accepted (43ms)" you must join the result back to the
 * request by `messageId`. Two ways:
 *
 *   (a) Write one row per frame and join at read time.
 *   (b) Write one row per EXCHANGE and update it when the result arrives.
 *
 * We do (a) on the wire and expose (b) to the UI: the API returns exchanges
 * with the response embedded. It keeps the write path append-only (fast, no
 * locks) and the read path convenient. Explaining that trade-off is a good
 * interview answer.
 */

export const OcppFrameSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  stationId: IdSchema.nullable(),
  stationIdentity: z.string(),
  protocol: ProtocolSchema,
  direction: MessageDirectionSchema,
  messageTypeId: MessageTypeIdSchema,
  /** Correlation id from index 1 of the frame. */
  messageId: z.string(),
  /** Present on CALL frames only — a CALLRESULT has no action of its own. */
  action: z.string().nullable(),
  payload: z.unknown(),
  /** The literal array as received/sent, for when the parse was wrong. */
  raw: z.string().nullable(),
  errorCode: OcppErrorCodeSchema.nullable(),
  errorDescription: z.string().nullable(),
  sessionId: IdSchema.nullable(),
  /**
   * Did this frame pass JSON-schema validation for its action?
   * Null means we did not attempt validation (unknown action).
   * Surfacing this in the UI turns the inspector into a conformance tool.
   */
  valid: z.boolean().nullable(),
  validationErrors: z.array(z.string()).nullable(),
});
export type OcppFrame = z.infer<typeof OcppFrameSchema>;

/**
 * A request paired with its response — what the inspector table actually
 * renders, one row per exchange.
 */
export const OcppExchangeSchema = z.object({
  id: IdSchema,
  messageId: z.string(),
  timestamp: TimestampSchema,
  stationId: IdSchema.nullable(),
  stationIdentity: z.string(),
  protocol: ProtocolSchema,
  /** Who started the exchange. */
  direction: MessageDirectionSchema,
  action: z.string(),
  request: OcppFrameSchema,
  response: OcppFrameSchema.nullable(),
  /** Null while we are still waiting for the answer. */
  durationMs: z.number().nullable(),
  outcome: z.enum(['pending', 'ok', 'error', 'timeout']),
  sessionId: IdSchema.nullable(),
});
export type OcppExchange = z.infer<typeof OcppExchangeSchema>;

export const OcppLogQuerySchema = CursorQuerySchema.extend({
  stationId: IdSchema.optional(),
  stationIdentity: z.string().optional(),
  protocol: ProtocolSchema.optional(),
  direction: MessageDirectionSchema.optional(),
  action: z.string().optional().describe('Comma-separated list is accepted'),
  outcome: z.enum(['pending', 'ok', 'error', 'timeout']).optional(),
  sessionId: IdSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  /** Free-text search across the serialised payload. */
  q: z.string().optional(),
  /** Show only frames that failed schema validation. */
  invalidOnly: z.coerce.boolean().optional(),
});
export type OcppLogQuery = z.infer<typeof OcppLogQuerySchema>;

export const OcppLogResponseSchema = cursorPaginated(OcppExchangeSchema);
export type OcppLogResponse = z.infer<typeof OcppLogResponseSchema>;

/* ------------------------------------------------------------------ *
 * Application log
 * ------------------------------------------------------------------ */

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const SystemLogSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  level: LogLevelSchema,
  /** Which part of the system: gateway, api, billing, ocpi, scheduler... */
  source: z.string(),
  message: z.string(),
  stationId: IdSchema.nullable(),
  sessionId: IdSchema.nullable(),
  userId: IdSchema.nullable(),
  /**
   * Carry a request/trace id on every log line. When you split this into
   * services, this field is the only thing that lets you follow one charge
   * across four processes.
   */
  correlationId: z.string().nullable(),
  context: z.record(z.string(), z.unknown()).nullable(),
});
export type SystemLog = z.infer<typeof SystemLogSchema>;

export const SystemLogQuerySchema = CursorQuerySchema.extend({
  level: LogLevelSchema.optional(),
  source: z.string().optional(),
  stationId: IdSchema.optional(),
  correlationId: z.string().optional(),
  q: z.string().optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type SystemLogQuery = z.infer<typeof SystemLogQuerySchema>;

export const SystemLogResponseSchema = cursorPaginated(SystemLogSchema);
export type SystemLogResponse = z.infer<typeof SystemLogResponseSchema>;

/* ------------------------------------------------------------------ *
 * Audit trail
 * ------------------------------------------------------------------ */

/** Who did what, in the dashboard. Separate from system logs on purpose. */
export const AuditEntrySchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  actorId: IdSchema.nullable(),
  actorName: z.string(),
  action: z.string().describe('station.reset, tariff.update, user.suspend, ...'),
  targetType: z.string(),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = CursorQuerySchema.extend({
  actorId: IdSchema.optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditResponseSchema = cursorPaginated(AuditEntrySchema);
export type AuditResponse = z.infer<typeof AuditResponseSchema>;
