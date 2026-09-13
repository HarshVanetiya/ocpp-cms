import { z } from 'zod';
import {
  AddressSchema,
  GeoPointSchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import {
  CommandNameSchema,
  CommandStatusSchema,
  ConnectorStatusSchema,
  ConnectorTypeSchema,
  PowerTypeSchema,
  ProtocolSchema,
  StationStatusSchema,
} from './enums';

/**
 * Stations, EVSEs and connectors.
 *
 * ## The hierarchy, and why it is three levels
 *
 * OCPP 1.6 has a flat model: a charge point has connectors numbered 1..n, and
 * connector 0 means "the whole station".
 *
 * OCPP 2.0.1 inserts a level in between:
 *
 *     ChargingStation
 *       └── EVSE 1          (one car can charge here)
 *             ├── Connector 1   (Type 2 socket)
 *             └── Connector 2   (CCS cable)
 *       └── EVSE 2
 *             └── Connector 1
 *
 * An EVSE is "a place where exactly one vehicle can charge at a time". A
 * multi-standard DC charger with a CCS cable and a CHAdeMO cable that can
 * only serve one car at once is ONE EVSE with TWO connectors. That is the
 * distinction 1.6 could not express, and it is why 2.0.1 added the level.
 *
 * We store the 2.0.1 shape because it is the richer one, and we project 1.6
 * onto it: a 1.6 charge point with 2 connectors becomes 2 EVSEs with 1
 * connector each, since in 1.6 every connector really can charge its own car.
 * Connector 0 is not stored as a connector at all — it becomes the station.
 *
 * Do the projection once, in the gateway. Everything above is protocol-blind.
 */

export const ConnectorSchema = z.object({
  id: IdSchema,
  /** Position within the EVSE, 1-based. This is what goes on the wire. */
  connectorId: z.number().int().min(1),
  evseId: z.number().int().min(1),
  type: ConnectorTypeSchema,
  powerType: PowerTypeSchema,
  maxPowerKw: z.number().nonnegative(),
  maxAmperage: z.number().int().nonnegative().optional(),
  maxVoltage: z.number().int().nonnegative().optional(),
  status: ConnectorStatusSchema,
  /**
   * OCPP 1.6 `StatusNotification.errorCode`. 2.0.1 does not have this field —
   * it reports faults through separate NotifyEvent messages instead — so this
   * is null for 2.0.1 stations. Do not invent a value; null is informative.
   */
  errorCode: z.string().nullable().optional(),
  vendorErrorCode: z.string().nullable().optional(),
  statusUpdatedAt: TimestampSchema.nullable(),
  /** Set while a transaction is running on this connector. */
  activeSessionId: IdSchema.nullable(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const EvseSchema = z.object({
  id: IdSchema,
  /** Position within the station, 1-based. This is what goes on the wire. */
  evseId: z.number().int().min(1),
  connectors: z.array(ConnectorSchema),
  /** Set only when the station reports per-EVSE availability separately. */
  status: ConnectorStatusSchema.optional(),
});
export type Evse = z.infer<typeof EvseSchema>;

export const StationSchema = z.object({
  id: IdSchema,
  /**
   * The OCPP identity. This is the last path segment of the WebSocket URL:
   *
   *     wss://csms.example.com/ocpp/1.6/CP-AMS-0001
   *                                     ^^^^^^^^^^^
   *
   * It is how the station identifies itself before any message is exchanged,
   * and it is the primary key from the station's point of view. Treat it as
   * immutable and unique. Our own `id` is a separate UUID because identities
   * are chosen by whoever installs the hardware and you do not want them as
   * foreign keys everywhere.
   */
  identity: z.string().min(1).max(48),
  name: z.string(),
  protocol: ProtocolSchema,
  status: StationStatusSchema,

  vendor: z.string(),
  model: z.string(),
  serialNumber: z.string().nullable(),
  firmwareVersion: z.string().nullable(),
  /** 1.6 only: SIM card identifiers reported in BootNotification. */
  iccid: z.string().nullable().optional(),
  imsi: z.string().nullable().optional(),

  evses: z.array(EvseSchema),

  locationId: IdSchema.nullable(),
  coordinates: GeoPointSchema.nullable(),
  address: AddressSchema.nullable(),

  /**
   * Seconds. We hand this to the station in the BootNotification response and
   * it obeys us. Mark the station offline at roughly 2.5x this value — one
   * missed heartbeat is normal, three is not.
   */
  heartbeatIntervalSeconds: z.number().int().positive(),
  lastHeartbeatAt: TimestampSchema.nullable(),
  lastBootAt: TimestampSchema.nullable(),
  connectedAt: TimestampSchema.nullable(),
  disconnectedAt: TimestampSchema.nullable(),

  /**
   * OCPP security profile, 0-3:
   *   0 no security (plain ws://) — lab only
   *   1 HTTP Basic auth over TLS
   *   2 TLS with server certificate + Basic auth
   *   3 mutual TLS with client certificates
   * Production fleets run profile 2 or 3.
   */
  securityProfile: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),

  tariffId: IdSchema.nullable(),
  maxPowerKw: z.number().nonnegative(),
  tags: z.array(z.string()),

  /** Free-form operator note, shown on the station detail page. */
  note: z.string().nullable().optional(),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Station = z.infer<typeof StationSchema>;

/**
 * Trimmed station shape for list and map views. Sending full `evses` for 500
 * stations makes the stations table slow for no benefit — the table only
 * renders counts.
 */
export const StationSummarySchema = z.object({
  id: IdSchema,
  identity: z.string(),
  name: z.string(),
  protocol: ProtocolSchema,
  status: StationStatusSchema,
  vendor: z.string(),
  model: z.string(),
  coordinates: GeoPointSchema.nullable(),
  locationId: IdSchema.nullable(),
  locationName: z.string().nullable(),
  connectorCount: z.number().int(),
  availableConnectorCount: z.number().int(),
  chargingConnectorCount: z.number().int(),
  faultedConnectorCount: z.number().int(),
  maxPowerKw: z.number(),
  lastHeartbeatAt: TimestampSchema.nullable(),
  activeSessionCount: z.number().int(),
  tags: z.array(z.string()),
});
export type StationSummary = z.infer<typeof StationSummarySchema>;

export const StationListQuerySchema = PageQuerySchema.extend({
  status: StationStatusSchema.optional(),
  protocol: ProtocolSchema.optional(),
  locationId: IdSchema.optional(),
  connectorStatus: ConnectorStatusSchema.optional(),
  tag: z.string().optional(),
});
export type StationListQuery = z.infer<typeof StationListQuerySchema>;

export const StationListResponseSchema = paginated(StationSummarySchema);
export type StationListResponse = z.infer<typeof StationListResponseSchema>;

export const CreateStationSchema = z.object({
  identity: z.string().min(1).max(48),
  name: z.string().min(1),
  protocol: ProtocolSchema,
  vendor: z.string().min(1),
  model: z.string().min(1),
  serialNumber: z.string().optional(),
  locationId: IdSchema.nullable().optional(),
  coordinates: GeoPointSchema.nullable().optional(),
  address: AddressSchema.nullable().optional(),
  heartbeatIntervalSeconds: z.number().int().positive().default(300),
  securityProfile: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(1),
  tariffId: IdSchema.nullable().optional(),
  maxPowerKw: z.number().nonnegative().default(22),
  tags: z.array(z.string()).default([]),
  /**
   * Declare the physical layout up front so the station appears in the UI
   * before it ever connects. Real installs know their hardware in advance.
   */
  evses: z
    .array(
      z.object({
        evseId: z.number().int().min(1),
        connectors: z.array(
          z.object({
            connectorId: z.number().int().min(1),
            type: ConnectorTypeSchema,
            powerType: PowerTypeSchema,
            maxPowerKw: z.number().nonnegative(),
          }),
        ),
      }),
    )
    .default([]),
});
export type CreateStation = z.infer<typeof CreateStationSchema>;

export const UpdateStationSchema = CreateStationSchema.partial().omit({ identity: true });
export type UpdateStation = z.infer<typeof UpdateStationSchema>;

/* ------------------------------------------------------------------ *
 * Configuration / variables
 * ------------------------------------------------------------------ */

/**
 * One tunable setting on a station.
 *
 * 1.6 calls these "configuration keys" and they are flat strings:
 *   { key: "HeartbeatInterval", value: "300", readonly: false }
 *
 * 2.0.1 replaced this with the Device Model: a tree of Components, each with
 * Variables, each with typed attributes and characteristics:
 *   component { name: "OCPPCommCtrlr" }, variable { name: "HeartbeatInterval" }
 *
 * We flatten 2.0.1 into the same row shape by joining component and variable
 * names with a dot ("OCPPCommCtrlr.HeartbeatInterval"), and keep the parts in
 * `component`/`variable` so the UI can group them. The learner gets one table
 * component that serves both protocols.
 */
export const ConfigurationKeySchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  readonly: z.boolean(),
  /** 2.0.1 only. Null for 1.6 stations. */
  component: z.string().nullable().optional(),
  variable: z.string().nullable().optional(),
  /** 2.0.1 `DataEnumType` — string, integer, decimal, boolean, dateTime, ... */
  dataType: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type ConfigurationKey = z.infer<typeof ConfigurationKeySchema>;

export const StationConfigurationSchema = z.object({
  stationId: IdSchema,
  protocol: ProtocolSchema,
  keys: z.array(ConfigurationKeySchema),
  /** 1.6's GetConfiguration returns keys it did not recognise separately. */
  unknownKeys: z.array(z.string()).default([]),
  fetchedAt: TimestampSchema,
});
export type StationConfiguration = z.infer<typeof StationConfigurationSchema>;

export const UpdateConfigurationSchema = z.object({
  key: z.string(),
  value: z.string(),
  component: z.string().optional(),
  variable: z.string().optional(),
});
export type UpdateConfiguration = z.infer<typeof UpdateConfigurationSchema>;

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * A command the operator issued. We persist these because they are
 * asynchronous: the dashboard polls or subscribes for the outcome, and the
 * audit trail ("who reset this station at 3am?") is a real operational need.
 */
export const CommandSchema = z.object({
  id: IdSchema,
  stationId: IdSchema,
  stationIdentity: z.string(),
  command: CommandNameSchema,
  status: CommandStatusSchema,
  /** Whatever the canonical command needs — shapes are in `commandPayloads`. */
  payload: z.record(z.string(), z.unknown()),
  /** The station's immediate answer to the CALL, verbatim. */
  response: z.record(z.string(), z.unknown()).nullable(),
  /** The OCPP message id we used, so you can find it in the frame log. */
  ocppMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  requestedBy: IdSchema.nullable(),
  requestedByName: z.string().nullable(),
  createdAt: TimestampSchema,
  sentAt: TimestampSchema.nullable(),
  respondedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});
export type Command = z.infer<typeof CommandSchema>;

/**
 * Canonical command payloads. The gateway translates these into the right
 * wire message for the station's protocol.
 *
 * Keep these protocol-neutral. `reset: { type: 'immediate' | 'on_idle' }`
 * rather than 1.6's Hard/Soft, because "hard/soft" describes the 1.6 wire and
 * "immediate/on idle" describes the intent. Map at the edge:
 *   1.6:    immediate → Hard,      on_idle → Soft
 *   2.0.1:  immediate → Immediate, on_idle → OnIdle
 */
export const CommandPayloadSchemas = {
  remote_start: z.object({
    evseId: z.number().int().min(1).optional(),
    connectorId: z.number().int().min(1).optional(),
    idToken: z.string().min(1),
    /** Optional cap so the driver's prepaid amount is enforced by the station. */
    chargingProfile: z.record(z.string(), z.unknown()).optional(),
  }),
  remote_stop: z.object({ sessionId: IdSchema }),
  reset: z.object({
    type: z.enum(['immediate', 'on_idle']),
    evseId: z.number().int().min(1).optional().describe('2.0.1 can reset a single EVSE'),
  }),
  unlock_connector: z.object({
    evseId: z.number().int().min(1),
    connectorId: z.number().int().min(1),
  }),
  change_availability: z.object({
    operational: z.enum(['operative', 'inoperative']),
    evseId: z.number().int().min(0).optional().describe('0 or omitted = whole station'),
    connectorId: z.number().int().min(0).optional(),
  }),
  trigger_message: z.object({
    requestedMessage: z.string().describe('e.g. BootNotification, StatusNotification, MeterValues'),
    evseId: z.number().int().min(1).optional(),
    connectorId: z.number().int().min(1).optional(),
  }),
  get_configuration: z.object({ keys: z.array(z.string()).optional() }),
  set_configuration: z.object({
    key: z.string(),
    value: z.string(),
    component: z.string().optional(),
    variable: z.string().optional(),
  }),
  clear_cache: z.object({}),
  reserve_now: z.object({
    evseId: z.number().int().min(1).optional(),
    connectorId: z.number().int().min(1).optional(),
    idToken: z.string(),
    expiresAt: TimestampSchema,
  }),
  cancel_reservation: z.object({ reservationId: z.number().int() }),
  set_charging_profile: z.object({
    evseId: z.number().int().min(0),
    /**
     * Simplified profile. The docs show how this expands into the full OCPP
     * ChargingProfile structure — that expansion is Milestone 10.
     */
    limitKw: z.number().positive(),
    purpose: z.enum(['tx_profile', 'tx_default_profile', 'charge_point_max_profile']),
    validFrom: TimestampSchema.optional(),
    validTo: TimestampSchema.optional(),
    sessionId: IdSchema.optional(),
  }),
  clear_charging_profile: z.object({
    evseId: z.number().int().min(0).optional(),
    purpose: z.enum(['tx_profile', 'tx_default_profile', 'charge_point_max_profile']).optional(),
  }),
  get_composite_schedule: z.object({
    evseId: z.number().int().min(0),
    durationSeconds: z.number().int().positive(),
  }),
  update_firmware: z.object({
    location: z.string().describe('URL the station downloads the image from'),
    retrieveAt: TimestampSchema.optional(),
    retries: z.number().int().optional(),
  }),
  get_diagnostics: z.object({
    location: z.string().describe('URL the station uploads the log bundle to'),
    startTime: TimestampSchema.optional(),
    stopTime: TimestampSchema.optional(),
  }),
  get_local_list_version: z.object({}),
  send_local_list: z.object({
    listVersion: z.number().int(),
    updateType: z.enum(['full', 'differential']),
    tokenIds: z.array(IdSchema),
  }),
  data_transfer: z.object({
    vendorId: z.string(),
    messageId: z.string().optional(),
    data: z.string().optional(),
  }),
} as const;

export const CreateCommandSchema = z.object({
  command: CommandNameSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type CreateCommand = z.infer<typeof CreateCommandSchema>;

/* ------------------------------------------------------------------ *
 * Station statistics (detail page header)
 * ------------------------------------------------------------------ */

export const StationStatsSchema = z.object({
  stationId: IdSchema,
  sessionsTotal: z.number().int(),
  sessions30d: z.number().int(),
  energyTotalWh: z.number(),
  energy30dWh: z.number(),
  revenueTotalMinor: MoneyMinorSchema,
  revenue30dMinor: MoneyMinorSchema,
  currency: z.string(),
  uptimePercent30d: z.number().min(0).max(100),
  utilizationPercent30d: z.number().min(0).max(100),
  faultCount30d: z.number().int(),
  avgSessionDurationSeconds: z.number(),
});
export type StationStats = z.infer<typeof StationStatsSchema>;
