import { z } from 'zod';
import { IdSchema, MoneyMinorSchema, TimestampSchema } from './common';
import {
  CommandStatusSchema,
  ConnectorStatusSchema,
  SessionStatusSchema,
  StationStatusSchema,
} from './enums';
import { OcppExchangeSchema, SystemLogSchema } from './logs';
import { ActivityItemSchema } from './dashboard';

/**
 * The realtime channel.
 *
 * ## Transport
 *
 * Primary:  WebSocket at `GET /api/v1/realtime` (upgrade).
 * Fallback: Server-Sent Events at `GET /api/v1/realtime/sse`.
 *
 * Implement the WebSocket first; the client falls back to SSE automatically if
 * the upgrade fails, which it does behind some corporate proxies. SSE is a
 * plain HTTP response that never ends, so it is genuinely easy to add later —
 * about 20 lines.
 *
 * ## Authentication
 *
 * Browsers cannot set headers on a WebSocket handshake, so you cannot send
 * `Authorization: Bearer ...`. The two workable options:
 *   (a) `?token=<jwt>` in the query string  — simple, but the token lands in
 *       access logs, so use short-lived tokens.
 *   (b) Connect unauthenticated, then send an `auth` frame as the first
 *       message and close the socket if it does not arrive within 5 seconds.
 *
 * This contract uses (a) for simplicity and the docs explain how to move to
 * (b). Being able to name this problem is itself a good interview signal.
 *
 * ## Subscriptions
 *
 * A dashboard on the stations page does not want every meter value from 500
 * stations. The client sends a `subscribe` frame naming topics; the server
 * only forwards matching events. Without this you will melt a laptop.
 *
 * Topics are strings with optional wildcards:
 *   `stations`                 all station status changes
 *   `station:<id>`             everything about one station
 *   `sessions`                 session lifecycle for the whole fleet
 *   `session:<id>`             one session, including meter values
 *   `ocpp`                     every frame, fleet-wide (the log page)
 *   `ocpp:<stationId>`         frames for one station
 *   `logs`                     system logs
 *   `activity`                 the overview feed
 */

/* ------------------------- client → server ------------------------- */

export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topics: z.array(z.string()) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(z.string()) }),
  z.object({ type: z.literal('ping'), t: z.number() }),
  z.object({ type: z.literal('auth'), token: z.string() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/* ------------------------- server → client ------------------------- */

export const StationStatusEventSchema = z.object({
  stationId: IdSchema,
  stationIdentity: z.string(),
  status: StationStatusSchema,
  lastHeartbeatAt: TimestampSchema.nullable(),
});

export const ConnectorStatusEventSchema = z.object({
  stationId: IdSchema,
  stationIdentity: z.string(),
  evseId: z.number().int(),
  connectorId: z.number().int(),
  status: ConnectorStatusSchema,
  errorCode: z.string().nullable(),
});

export const SessionEventSchema = z.object({
  sessionId: IdSchema,
  stationId: IdSchema,
  stationIdentity: z.string(),
  evseId: z.number().int(),
  connectorId: z.number().int(),
  status: SessionStatusSchema,
  energyDeliveredWh: z.number(),
  currentPowerKw: z.number().nullable(),
  currentSoc: z.number().nullable(),
  costMinor: MoneyMinorSchema,
  currency: z.string(),
  durationSeconds: z.number().int(),
  userName: z.string().nullable(),
});

export const MeterEventSchema = z.object({
  sessionId: IdSchema,
  timestamp: TimestampSchema,
  energyWh: z.number().nullable(),
  powerKw: z.number().nullable(),
  currentA: z.number().nullable(),
  voltageV: z.number().nullable(),
  soc: z.number().nullable(),
  temperatureC: z.number().nullable(),
});

export const CommandEventSchema = z.object({
  commandId: IdSchema,
  stationId: IdSchema,
  command: z.string(),
  status: CommandStatusSchema,
  response: z.record(z.string(), z.unknown()).nullable(),
  errorMessage: z.string().nullable(),
});

export const PaymentEventSchema = z.object({
  paymentId: IdSchema,
  sessionId: IdSchema.nullable(),
  status: z.string(),
  capturedAmountMinor: MoneyMinorSchema.nullable(),
  currency: z.string(),
});

/**
 * Every server event is a discriminated union on `type`. The client switches
 * on it and TypeScript narrows `data` to the right shape automatically — this
 * is the single best reason to use TypeScript on a realtime app.
 */
export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ocpp.message'),
    at: TimestampSchema,
    data: OcppExchangeSchema,
  }),
  z.object({
    type: z.literal('station.status'),
    at: TimestampSchema,
    data: StationStatusEventSchema,
  }),
  z.object({
    type: z.literal('connector.status'),
    at: TimestampSchema,
    data: ConnectorStatusEventSchema,
  }),
  z.object({ type: z.literal('session.started'), at: TimestampSchema, data: SessionEventSchema }),
  z.object({ type: z.literal('session.updated'), at: TimestampSchema, data: SessionEventSchema }),
  z.object({ type: z.literal('session.ended'), at: TimestampSchema, data: SessionEventSchema }),
  z.object({ type: z.literal('meter.value'), at: TimestampSchema, data: MeterEventSchema }),
  z.object({ type: z.literal('command.update'), at: TimestampSchema, data: CommandEventSchema }),
  z.object({ type: z.literal('payment.update'), at: TimestampSchema, data: PaymentEventSchema }),
  z.object({ type: z.literal('system.log'), at: TimestampSchema, data: SystemLogSchema }),
  z.object({ type: z.literal('activity'), at: TimestampSchema, data: ActivityItemSchema }),
  z.object({
    type: z.literal('subscribed'),
    at: TimestampSchema,
    data: z.object({ topics: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal('pong'),
    at: TimestampSchema,
    data: z.object({ t: z.number() }),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** Handy alias: given an event type, what shape is its `data`? */
export type ServerEventData<T extends ServerEventType> = Extract<ServerEvent, { type: T }>['data'];

export const REALTIME_TOPICS = {
  stations: 'stations',
  station: (id: string) => `station:${id}`,
  sessions: 'sessions',
  session: (id: string) => `session:${id}`,
  ocpp: 'ocpp',
  ocppStation: (id: string) => `ocpp:${id}`,
  logs: 'logs',
  activity: 'activity',
} as const;
