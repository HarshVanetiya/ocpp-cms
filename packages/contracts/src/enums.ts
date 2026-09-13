import { z } from 'zod';

/**
 * THE CANONICAL MODEL.
 *
 * This file is the most important idea in the whole project, so read the
 * comments even if you skim everything else.
 *
 * A CPMS that supports two protocol versions has a choice:
 *
 *   (a) Keep OCPP 1.6 objects and OCPP 2.0.1 objects separate all the way up
 *       to the UI, and write every feature twice.
 *   (b) Translate both protocols into ONE internal vocabulary at the edge, and
 *       write every feature once.
 *
 * Real products do (b), and so do we. The WebSocket gateway is the only place
 * in the system that knows the words "StartTransaction" or "TransactionEvent".
 * Everything above it — the database, the REST API, the dashboard — speaks the
 * canonical vocabulary defined below.
 *
 * When an interviewer asks "how did you support 1.6 and 2.0.1 at the same
 * time?", the answer is this file.
 */

/* ------------------------------------------------------------------ *
 * Protocol
 * ------------------------------------------------------------------ */

/**
 * The WebSocket subprotocol string the charge point offers during the HTTP
 * upgrade handshake (`Sec-WebSocket-Protocol` header). These are the exact
 * values from the OCPP specifications — do not invent your own.
 */
export const ProtocolSchema = z.enum(['ocpp1.6', 'ocpp2.0.1']);
export type Protocol = z.infer<typeof ProtocolSchema>;

export const PROTOCOL_LABEL: Record<Protocol, string> = {
  'ocpp1.6': 'OCPP 1.6J',
  'ocpp2.0.1': 'OCPP 2.0.1',
};

/* ------------------------------------------------------------------ *
 * Station connectivity
 * ------------------------------------------------------------------ */

/**
 * Is the station's WebSocket currently connected, and is it healthy?
 *
 * This is NOT the same as connector status. A station can be `online` while
 * every one of its connectors is `faulted`. Keep the two separate — mixing
 * them is the single most common modelling mistake in a first CPMS.
 *
 * - `online`      WebSocket open, heartbeats arriving on time.
 * - `offline`     No WebSocket, or heartbeats stopped arriving.
 * - `pending`     We accepted the socket but it has not sent BootNotification
 *                 yet, or we answered BootNotification with Pending.
 * - `rejected`    We answered BootNotification with Rejected (unknown station).
 * - `unavailable` Operator has taken the whole station out of service.
 */
export const StationStatusSchema = z.enum([
  'online',
  'offline',
  'pending',
  'rejected',
  'unavailable',
]);
export type StationStatus = z.infer<typeof StationStatusSchema>;

/* ------------------------------------------------------------------ *
 * Connector status — the canonical version
 * ------------------------------------------------------------------ */

/**
 * What is physically happening at one connector.
 *
 * We use the OCPP 1.6 status set as the canonical one because it is finer
 * grained than 2.0.1's, and a finer set can always represent a coarser one.
 * The gateway maps both protocols into these values.
 *
 * ### Mapping from OCPP 1.6 `StatusNotification.status`
 * Straight 1:1 — the names below are the 1.6 names lower-cased:
 *   Available → available, Preparing → preparing, Charging → charging,
 *   SuspendedEV → suspended_ev, SuspendedEVSE → suspended_evse,
 *   Finishing → finishing, Reserved → reserved, Unavailable → unavailable,
 *   Faulted → faulted.
 *
 * ### Mapping from OCPP 2.0.1
 * 2.0.1 deliberately shrank the status list to five values and moved the
 * charging detail into `TransactionEvent.chargingState`. So you need BOTH
 * messages to reconstruct the canonical status:
 *
 *   StatusNotification.connectorStatus = Available    → available
 *   StatusNotification.connectorStatus = Reserved     → reserved
 *   StatusNotification.connectorStatus = Unavailable  → unavailable
 *   StatusNotification.connectorStatus = Faulted      → faulted
 *   StatusNotification.connectorStatus = Occupied     → look at the live
 *       transaction's `chargingState`:
 *           Charging      → charging
 *           EVConnected   → preparing
 *           SuspendedEV   → suspended_ev
 *           SuspendedEVSE → suspended_evse
 *           Idle          → finishing
 *       and if there is no transaction yet → preparing
 *
 * That asymmetry is a great thing to be able to explain out loud. It is the
 * clearest example of 2.0.1 separating "what is the socket doing" from "what
 * is the transaction doing".
 */
export const ConnectorStatusSchema = z.enum([
  'available',
  'preparing',
  'charging',
  'suspended_ev',
  'suspended_evse',
  'finishing',
  'reserved',
  'unavailable',
  'faulted',
]);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const CONNECTOR_STATUS_LABEL: Record<ConnectorStatus, string> = {
  available: 'Available',
  preparing: 'Preparing',
  charging: 'Charging',
  suspended_ev: 'Suspended (EV)',
  suspended_evse: 'Suspended (EVSE)',
  finishing: 'Finishing',
  reserved: 'Reserved',
  unavailable: 'Unavailable',
  faulted: 'Faulted',
};

/**
 * How the UI colours each status. Kept in the contract rather than in the
 * frontend so the simulator, the dashboard and the driver app agree.
 */
export const CONNECTOR_STATUS_TONE: Record<
  ConnectorStatus,
  'ok' | 'busy' | 'warn' | 'danger' | 'idle'
> = {
  available: 'ok',
  preparing: 'busy',
  charging: 'busy',
  suspended_ev: 'warn',
  suspended_evse: 'warn',
  finishing: 'busy',
  reserved: 'warn',
  unavailable: 'idle',
  faulted: 'danger',
};

/* ------------------------------------------------------------------ *
 * Physical connector types
 * ------------------------------------------------------------------ */

/** Subset of OCPI's `ConnectorType`, which is the de-facto standard list. */
export const ConnectorTypeSchema = z.enum([
  'iec_62196_t2',
  'iec_62196_t2_combo',
  'chademo',
  'iec_62196_t1',
  'iec_62196_t1_combo',
  'tesla_s',
  'domestic_f',
  'gbt_ac',
  'gbt_dc',
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

export const CONNECTOR_TYPE_LABEL: Record<ConnectorType, string> = {
  iec_62196_t2: 'Type 2',
  iec_62196_t2_combo: 'CCS2',
  chademo: 'CHAdeMO',
  iec_62196_t1: 'Type 1',
  iec_62196_t1_combo: 'CCS1',
  tesla_s: 'Tesla',
  domestic_f: 'Schuko',
  gbt_ac: 'GB/T AC',
  gbt_dc: 'GB/T DC',
};

export const PowerTypeSchema = z.enum(['ac_1_phase', 'ac_3_phase', 'dc']);
export type PowerType = z.infer<typeof PowerTypeSchema>;

/* ------------------------------------------------------------------ *
 * Transactions / sessions
 * ------------------------------------------------------------------ */

/**
 * Canonical session lifecycle.
 *
 * 1.6 gives you two hard events: StartTransaction and StopTransaction.
 * 2.0.1 gives you one event type with three variants:
 *   TransactionEvent(eventType=Started | Updated | Ended).
 *
 * Both collapse into the states below.
 *
 * `pending` exists because a driver-initiated session in this project is
 * created BEFORE the car is plugged in: the driver pays, we hold the amount,
 * we send RemoteStartTransaction, and only then does the station open a real
 * transaction. Without a `pending` state you cannot show the driver anything
 * between "paid" and "charging".
 */
export const SessionStatusSchema = z.enum([
  'pending',
  'active',
  'suspended',
  'completed',
  'failed',
  'cancelled',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Why a session ended.
 *
 * This is OCPP 1.6's `Reason` list plus 2.0.1's additions, lower-cased and
 * snake-cased. Where 2.0.1 renamed a reason we keep the 1.6 name and map to
 * it, because the 1.6 name is the one people say out loud.
 */
export const StopReasonSchema = z.enum([
  'local',
  'remote',
  'ev_disconnected',
  'emergency_stop',
  'power_loss',
  'reboot',
  'hard_reset',
  'soft_reset',
  'unlock_command',
  'de_authorized',
  'energy_limit_reached',
  'time_limit_reached',
  'stopped_by_evse',
  'master_pass',
  'other',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

/**
 * The result of authorizing an identifier.
 *
 * 1.6 calls this `idTagInfo.status`, 2.0.1 calls it `idTokenInfo.status`.
 * The values are almost identical, which is why one canonical enum works.
 *
 *   accepted        → charging may start
 *   blocked         → the token is known but barred
 *   expired         → the token's validity date has passed
 *   invalid         → we have never seen this token
 *   concurrent_tx   → this token already has a transaction running elsewhere
 *   no_credit       → (our own addition) the driver has no money on the
 *                     account. OCPP has no such status, so the gateway maps
 *                     it to `Blocked` on the wire. Keeping it distinct
 *                     internally lets the driver app show a useful message.
 */
export const AuthorizationStatusSchema = z.enum([
  'accepted',
  'blocked',
  'expired',
  'invalid',
  'concurrent_tx',
  'no_credit',
]);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatusSchema>;

/** Token types, aligned with OCPP 2.0.1 `IdTokenEnumType` + OCPI. */
export const TokenTypeSchema = z.enum([
  'rfid',
  'iso14443',
  'iso15693',
  'key_code',
  'local',
  'mac_address',
  'emaid',
  'central',
  'app_user',
  'no_authorization',
]);
export type TokenType = z.infer<typeof TokenTypeSchema>;

export const TokenStatusSchema = z.enum(['active', 'blocked', 'expired', 'pending']);
export type TokenStatus = z.infer<typeof TokenStatusSchema>;

/* ------------------------------------------------------------------ *
 * Remote commands
 * ------------------------------------------------------------------ */

/**
 * Commands the operator can push to a station.
 *
 * These are canonical names. The gateway picks the right wire message per
 * protocol — this table is worth memorising before an interview:
 *
 * | canonical            | OCPP 1.6                  | OCPP 2.0.1                       |
 * |----------------------|---------------------------|----------------------------------|
 * | remote_start         | RemoteStartTransaction    | RequestStartTransaction          |
 * | remote_stop          | RemoteStopTransaction     | RequestStopTransaction           |
 * | reset                | Reset (Hard/Soft)         | Reset (Immediate/OnIdle)         |
 * | unlock_connector     | UnlockConnector           | UnlockConnector                  |
 * | change_availability  | ChangeAvailability        | ChangeAvailability               |
 * | trigger_message      | TriggerMessage            | TriggerMessage                   |
 * | get_configuration    | GetConfiguration          | GetVariables                     |
 * | set_configuration    | ChangeConfiguration       | SetVariables                     |
 * | clear_cache          | ClearCache                | ClearCache                       |
 * | reserve_now          | ReserveNow                | ReserveNow                       |
 * | cancel_reservation   | CancelReservation         | CancelReservation                |
 * | set_charging_profile | SetChargingProfile        | SetChargingProfile               |
 * | clear_charging_profile | ClearChargingProfile    | ClearChargingProfile             |
 * | get_composite_schedule | GetCompositeSchedule    | GetCompositeSchedule             |
 * | update_firmware      | UpdateFirmware            | UpdateFirmware                   |
 * | get_diagnostics      | GetDiagnostics            | GetLog (LogType=DiagnosticsLog)  |
 * | get_local_list_version | GetLocalListVersion     | GetLocalListVersion              |
 * | send_local_list      | SendLocalList             | SendLocalList                    |
 * | data_transfer        | DataTransfer              | DataTransfer                     |
 *
 * Note the renames on the first two rows. 2.0.1 dropped the word
 * "Transaction" from the request names because the request only *asks* for a
 * transaction — the station decides. That distinction (request vs. command)
 * is a favourite interview question.
 */
export const CommandNameSchema = z.enum([
  'remote_start',
  'remote_stop',
  'reset',
  'unlock_connector',
  'change_availability',
  'trigger_message',
  'get_configuration',
  'set_configuration',
  'clear_cache',
  'reserve_now',
  'cancel_reservation',
  'set_charging_profile',
  'clear_charging_profile',
  'get_composite_schedule',
  'update_firmware',
  'get_diagnostics',
  'get_local_list_version',
  'send_local_list',
  'data_transfer',
]);
export type CommandName = z.infer<typeof CommandNameSchema>;

export const COMMAND_LABEL: Record<CommandName, string> = {
  remote_start: 'Remote start',
  remote_stop: 'Remote stop',
  reset: 'Reset',
  unlock_connector: 'Unlock connector',
  change_availability: 'Change availability',
  trigger_message: 'Trigger message',
  get_configuration: 'Read configuration',
  set_configuration: 'Write configuration',
  clear_cache: 'Clear auth cache',
  reserve_now: 'Reserve now',
  cancel_reservation: 'Cancel reservation',
  set_charging_profile: 'Set charging profile',
  clear_charging_profile: 'Clear charging profile',
  get_composite_schedule: 'Get composite schedule',
  update_firmware: 'Update firmware',
  get_diagnostics: 'Get diagnostics',
  get_local_list_version: 'Local list version',
  send_local_list: 'Send local list',
  data_transfer: 'Data transfer',
};

/**
 * Lifecycle of a command we pushed to a station.
 *
 * This models something people usually get wrong on their first CPMS: a
 * remote command is ASYNCHRONOUS and has TWO results.
 *
 *   1. The station answers the CALL with Accepted/Rejected. That is
 *      `accepted` / `rejected` below. It only means "I will try".
 *   2. The actual outcome arrives later as a separate message — a
 *      StatusNotification, a StartTransaction, a TransactionEvent. That is
 *      `succeeded`.
 *
 * If your UI marks a remote start as "done" when the CALLRESULT arrives, it
 * will lie to the operator. The dashboard in this repo waits for the
 * follow-up event.
 */
export const CommandStatusSchema = z.enum([
  'queued',
  'sent',
  'accepted',
  'rejected',
  'succeeded',
  'failed',
  'timeout',
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

/* ------------------------------------------------------------------ *
 * OCPP wire-level framing
 * ------------------------------------------------------------------ */

/**
 * OCPP-J puts a number at index 0 of every array to say what kind of frame
 * this is. These four values are the entire framing protocol.
 *
 *   2 CALL        [2, "<msgId>", "<Action>", {payload}]
 *   3 CALLRESULT  [3, "<msgId>", {payload}]
 *   4 CALLERROR   [4, "<msgId>", "<errorCode>", "<description>", {details}]
 *   5 CALLRESULTERROR  (OCPP 2.1 only, included so the inspector can label it)
 *
 * Note there is no "action" in a CALLRESULT. You can only know what a result
 * is a result OF by remembering which action you sent with that message id.
 * That is why your gateway needs a pending-call map keyed by message id, with
 * a timeout. Forgetting the timeout leaks memory forever — ask anyone who has
 * run a CPMS in production.
 */
export const MessageTypeIdSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type MessageTypeId = z.infer<typeof MessageTypeIdSchema>;

export const MESSAGE_TYPE_LABEL: Record<number, string> = {
  2: 'CALL',
  3: 'CALLRESULT',
  4: 'CALLERROR',
  5: 'CALLRESULTERROR',
};

/**
 * Direction, always described from the CSMS's point of view.
 *
 * `inbound`  = charge point → CSMS
 * `outbound` = CSMS → charge point
 *
 * Pick one point of view and never flip it. Logs where "in" sometimes means
 * "into the station" are unreadable.
 */
export const MessageDirectionSchema = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

/**
 * The RPC error codes OCPP defines for CALLERROR. Return the right one — the
 * station's logs are the only place a field engineer will look.
 */
export const OcppErrorCodeSchema = z.enum([
  'NotImplemented',
  'NotSupported',
  'InternalError',
  'ProtocolError',
  'SecurityError',
  'FormationViolation',
  'PropertyConstraintViolation',
  'OccurrenceConstraintViolation',
  'TypeConstraintViolation',
  'GenericError',
]);
export type OcppErrorCode = z.infer<typeof OcppErrorCodeSchema>;

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

/**
 * Canonical measurand names, from OCPP 1.6 `MeasurandValues` / 2.0.1
 * `MeasurandEnumType`. We only model the handful a dashboard actually plots.
 */
export const MeasurandSchema = z.enum([
  'energy_active_import_register',
  'power_active_import',
  'current_import',
  'voltage',
  'soc',
  'temperature',
  'current_offered',
  'power_offered',
]);
export type Measurand = z.infer<typeof MeasurandSchema>;

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

export const UserRoleSchema = z.enum(['admin', 'operator', 'viewer', 'driver']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(['active', 'invited', 'suspended']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

/* ------------------------------------------------------------------ *
 * Money movement
 * ------------------------------------------------------------------ */

/**
 * Our dummy payment provider's lifecycle. It mirrors how a real PSP works
 * (authorize a maximum, capture the actual amount later) because that is the
 * only model that fits charging: you do not know the final cost until the car
 * stops.
 */
export const PaymentStatusSchema = z.enum([
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'cancelled',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
