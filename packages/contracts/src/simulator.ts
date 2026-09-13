import { z } from 'zod';
import { GeoPointSchema, IdSchema, TimestampSchema, paginated } from './common';
import {
  ConnectorStatusSchema,
  ConnectorTypeSchema,
  MessageDirectionSchema,
  MessageTypeIdSchema,
  PowerTypeSchema,
  ProtocolSchema,
} from './enums';

/**
 * The simulator's own API.
 *
 * ## Why the simulator is a separate service with a separate UI
 *
 * Because in real life it is a separate thing. The simulator PRETENDS TO BE
 * HARDWARE: it opens a WebSocket to your CSMS exactly as a charger would,
 * speaks OCPP, and knows nothing about your database. If you build it as a
 * feature inside the CPMS you will be tempted to take shortcuts — reading
 * session state straight from the database instead of from OCPP messages —
 * and then you have tested nothing.
 *
 * Keep them apart, make them talk only over OCPP, and your simulator becomes
 * a genuine conformance tool. That separation is the point.
 *
 * Base path: `/sim/v1`. Run it on its own port (default 3100).
 *
 * ## Directions are reversed here
 *
 * In `logs.ts`, `inbound` means "into the CSMS". Here, the simulator IS the
 * charge point, so `outbound` means "from the simulated station to the CSMS".
 * Both files describe their own process's point of view, which is why the
 * enum is reused but the meaning differs. This is stated in both places on
 * purpose — mixing them up is a genuinely easy mistake.
 */

export const SimConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error',
]);
export type SimConnectionState = z.infer<typeof SimConnectionStateSchema>;

export const SimConnectorSchema = z.object({
  connectorId: z.number().int().min(1),
  evseId: z.number().int().min(1),
  type: ConnectorTypeSchema,
  powerType: PowerTypeSchema,
  maxPowerKw: z.number().positive(),
  /** What the simulated hardware currently believes it is doing. */
  status: ConnectorStatusSchema,
  /** True once a "cable plugged in" action has been performed. */
  cablePluggedIn: z.boolean(),
  /** Protocol-level transaction id, if a transaction is open here. */
  transactionId: z.string().nullable(),
  meterWh: z.number().nonnegative(),
  powerKw: z.number().nonnegative(),
  soc: z.number().min(0).max(100).nullable(),
});
export type SimConnector = z.infer<typeof SimConnectorSchema>;

export const SimStationSchema = z.object({
  id: IdSchema,
  identity: z.string().min(1).max(48),
  name: z.string(),
  protocol: ProtocolSchema,
  csmsUrl: z.string().describe('ws://localhost:3000/ocpp — the identity is appended by the sim'),
  connectionState: SimConnectionStateSchema,

  vendor: z.string(),
  model: z.string(),
  serialNumber: z.string(),
  firmwareVersion: z.string(),

  connectors: z.array(SimConnectorSchema),

  /** Behaviour knobs. These are what make the simulator useful for testing. */
  autoHeartbeat: z.boolean(),
  heartbeatIntervalSeconds: z.number().int().positive(),
  autoMeterValues: z.boolean(),
  meterValueIntervalSeconds: z.number().int().positive(),
  /** Simulated charging speed, used to advance the meter between samples. */
  chargingPowerKw: z.number().positive(),
  /** Auth attempt uses this token value. */
  defaultIdToken: z.string(),

  /**
   * Fault injection. A CPMS that has only ever seen well-behaved stations is
   * not finished. Turn these on and watch your error handling earn its keep.
   */
  faults: z.object({
    /** Drop the WebSocket without a close frame. Tests your timeout handling. */
    dropConnection: z.boolean(),
    /** Never answer a CALL from the CSMS. Tests your pending-call timeout. */
    ignoreRemoteCommands: z.boolean(),
    /** Reply to CALLs with CALLERROR. Tests your error propagation. */
    respondWithErrors: z.boolean(),
    /** Send payloads that violate the JSON schema. Tests your validation. */
    sendInvalidPayloads: z.boolean(),
    /** Add latency to every response, in ms. Tests your UI's loading states. */
    responseDelayMs: z.number().int().nonnegative(),
    /** Report a connector as Faulted on the next status change. */
    reportFaulted: z.boolean(),
  }),

  coordinates: GeoPointSchema.nullable(),
  lastError: z.string().nullable(),
  connectedAt: TimestampSchema.nullable(),
  /** Rolling counters shown on the station card. */
  messagesSent: z.number().int().nonnegative(),
  messagesReceived: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export type SimStation = z.infer<typeof SimStationSchema>;

export const SimStationListResponseSchema = paginated(SimStationSchema);
export type SimStationListResponse = z.infer<typeof SimStationListResponseSchema>;

export const CreateSimStationSchema = z.object({
  identity: z.string().min(1).max(48),
  name: z.string().optional(),
  protocol: ProtocolSchema.default('ocpp1.6'),
  csmsUrl: z.string().default('ws://localhost:3000/ocpp'),
  vendor: z.string().default('SimuVolt'),
  model: z.string().default('SV-22AC'),
  serialNumber: z.string().optional(),
  firmwareVersion: z.string().default('1.4.2'),
  connectorCount: z.number().int().min(1).max(8).default(2),
  connectorType: ConnectorTypeSchema.default('iec_62196_t2'),
  powerType: PowerTypeSchema.default('ac_3_phase'),
  maxPowerKw: z.number().positive().default(22),
  autoHeartbeat: z.boolean().default(true),
  heartbeatIntervalSeconds: z.number().int().positive().default(60),
  autoMeterValues: z.boolean().default(true),
  meterValueIntervalSeconds: z.number().int().positive().default(10),
  chargingPowerKw: z.number().positive().default(11),
  defaultIdToken: z.string().default('DEADBEEF'),
  coordinates: GeoPointSchema.nullable().optional(),
  /** Create N stations at once with a numeric suffix. Handy for load tests. */
  count: z.number().int().min(1).max(500).default(1),
});
export type CreateSimStation = z.infer<typeof CreateSimStationSchema>;

export const UpdateSimStationSchema = CreateSimStationSchema.partial()
  .omit({ identity: true, count: true, connectorCount: true })
  .extend({
    faults: SimStationSchema.shape.faults.partial().optional(),
  });
export type UpdateSimStation = z.infer<typeof UpdateSimStationSchema>;

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * Things a human can make the simulated station do.
 *
 * These are deliberately at the level of PHYSICAL EVENTS, not OCPP messages,
 * wherever a physical event exists. "Plug in the cable" is what actually
 * happens; the StatusNotification is a consequence. Modelling it that way
 * teaches the causal chain, which is the thing worth learning.
 *
 * The raw message senders (`send_boot_notification` and friends) exist too,
 * for when you want to poke one specific message at your CSMS.
 */
export const SimActionSchema = z.enum([
  'connect',
  'disconnect',
  'plug_in',
  'plug_out',
  'swipe_card',
  'start_charging',
  'stop_charging',
  'suspend_ev',
  'resume',
  'trigger_fault',
  'clear_fault',
  'reboot',
  'send_boot_notification',
  'send_heartbeat',
  'send_status_notification',
  'send_authorize',
  'send_meter_values',
  'send_data_transfer',
  'send_diagnostics_status',
  'send_firmware_status',
  'send_security_event',
  'send_raw',
]);
export type SimAction = z.infer<typeof SimActionSchema>;

export const SIM_ACTION_LABEL: Record<SimAction, string> = {
  connect: 'Connect',
  disconnect: 'Disconnect',
  plug_in: 'Plug in cable',
  plug_out: 'Unplug cable',
  swipe_card: 'Swipe RFID card',
  start_charging: 'Start charging',
  stop_charging: 'Stop charging',
  suspend_ev: 'Car pauses charging',
  resume: 'Resume charging',
  trigger_fault: 'Trigger fault',
  clear_fault: 'Clear fault',
  reboot: 'Reboot station',
  send_boot_notification: 'BootNotification',
  send_heartbeat: 'Heartbeat',
  send_status_notification: 'StatusNotification',
  send_authorize: 'Authorize',
  send_meter_values: 'MeterValues',
  send_data_transfer: 'DataTransfer',
  send_diagnostics_status: 'DiagnosticsStatusNotification',
  send_firmware_status: 'FirmwareStatusNotification',
  send_security_event: 'SecurityEventNotification',
  send_raw: 'Send raw frame',
};

export const SimActionRequestSchema = z.object({
  action: SimActionSchema,
  evseId: z.number().int().min(1).optional(),
  connectorId: z.number().int().min(1).optional(),
  idToken: z.string().optional(),
  /** For `send_raw`: the exact array to put on the wire. */
  raw: z.unknown().optional(),
  /** Extra fields merged into the generated payload. */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type SimActionRequest = z.infer<typeof SimActionRequestSchema>;

export const SimActionResultSchema = z.object({
  accepted: z.boolean(),
  message: z.string(),
  /** The OCPP message id, if the action put something on the wire. */
  messageId: z.string().nullable(),
  station: SimStationSchema.nullable(),
});
export type SimActionResult = z.infer<typeof SimActionResultSchema>;

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

/**
 * A scripted sequence of actions.
 *
 * Scenarios are how you turn the simulator from a toy into a test suite. Each
 * one is a story ("driver arrives, card is declined, driver leaves") and each
 * step can assert what the CSMS should have replied. Run them all after every
 * change to your backend and you have conformance testing for free.
 */
export const SimStepSchema = z.object({
  id: z.string(),
  action: SimActionSchema,
  label: z.string(),
  /** Explains what the step is teaching. Shown in the runner UI. */
  note: z.string().nullable(),
  evseId: z.number().int().optional(),
  connectorId: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  delayMsBefore: z.number().int().nonnegative().default(0),
  /** Assertion on the CSMS's reply. */
  expect: z
    .object({
      field: z.string().describe('Dot path into the response payload, e.g. idTagInfo.status'),
      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
      exists: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
export type SimStep = z.infer<typeof SimStepSchema>;

export const SimScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Which protocol(s) this scenario is valid for. */
  protocol: z.enum(['ocpp1.6', 'ocpp2.0.1', 'both']),
  category: z.enum([
    'basics',
    'authorization',
    'transactions',
    'remote_control',
    'smart_charging',
    'reliability',
    'security',
    'roaming',
  ]),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  /** What you should learn by running it. Rendered above the step list. */
  learningGoal: z.string(),
  steps: z.array(SimStepSchema),
});
export type SimScenario = z.infer<typeof SimScenarioSchema>;

export const SimScenarioListResponseSchema = z.object({ data: z.array(SimScenarioSchema) });
export type SimScenarioListResponse = z.infer<typeof SimScenarioListResponseSchema>;

export const SimStepResultSchema = z.object({
  stepId: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  messageId: z.string().nullable(),
  request: z.unknown().nullable(),
  response: z.unknown().nullable(),
  assertion: z
    .object({ passed: z.boolean(), expected: z.string(), actual: z.string() })
    .nullable(),
  error: z.string().nullable(),
});
export type SimStepResult = z.infer<typeof SimStepResultSchema>;

export const SimRunSchema = z.object({
  id: IdSchema,
  scenarioId: z.string(),
  scenarioName: z.string(),
  stationId: IdSchema,
  stationIdentity: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'aborted']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  steps: z.array(SimStepResultSchema),
});
export type SimRun = z.infer<typeof SimRunSchema>;

export const RunScenarioSchema = z.object({
  scenarioId: z.string(),
  stationId: IdSchema,
  /** Multiply every step delay, so you can watch it happen or run it fast. */
  speed: z.number().positive().default(1),
});
export type RunScenario = z.infer<typeof RunScenarioSchema>;

/* ------------------------------------------------------------------ *
 * Simulator frame log + realtime
 * ------------------------------------------------------------------ */

export const SimFrameSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  stationId: IdSchema,
  stationIdentity: z.string(),
  protocol: ProtocolSchema,
  /** `outbound` = simulated station → CSMS. See the note at the top. */
  direction: MessageDirectionSchema,
  messageTypeId: MessageTypeIdSchema,
  messageId: z.string(),
  action: z.string().nullable(),
  payload: z.unknown(),
  raw: z.string(),
  errorCode: z.string().nullable(),
  errorDescription: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type SimFrame = z.infer<typeof SimFrameSchema>;

export const SimServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sim.frame'), at: TimestampSchema, data: SimFrameSchema }),
  z.object({ type: z.literal('sim.station'), at: TimestampSchema, data: SimStationSchema }),
  z.object({
    type: z.literal('sim.station.removed'),
    at: TimestampSchema,
    data: z.object({ id: IdSchema }),
  }),
  z.object({ type: z.literal('sim.run'), at: TimestampSchema, data: SimRunSchema }),
  z.object({
    type: z.literal('sim.log'),
    at: TimestampSchema,
    data: z.object({
      level: z.enum(['debug', 'info', 'warn', 'error']),
      stationId: IdSchema.nullable(),
      message: z.string(),
    }),
  }),
  z.object({
    type: z.literal('pong'),
    at: TimestampSchema,
    data: z.object({ t: z.number() }),
  }),
]);
export type SimServerEvent = z.infer<typeof SimServerEventSchema>;

export const SimHealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  stationCount: z.number().int(),
  connectedCount: z.number().int(),
  defaultCsmsUrl: z.string(),
});
export type SimHealth = z.infer<typeof SimHealthSchema>;
