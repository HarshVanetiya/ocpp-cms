import type { ConnectorStatus, Protocol, StopReason } from '@ocpp/contracts';

/**
 * Cross-version translation.
 *
 * This is the code that lets ONE CPMS serve both protocol versions. It lives
 * in a shared package because both the gateway (your backend) and the UI
 * (this repo) need to agree on it.
 *
 * Everything here is a pure function over plain data — no I/O, no state. That
 * makes it trivially unit-testable, which is exactly what you want for the
 * layer that decides how much a customer gets billed.
 */

/* ------------------------------------------------------------------ *
 * Action name mapping
 * ------------------------------------------------------------------ */

/**
 * Canonical command → the action name to put on the wire, per protocol.
 *
 * Your gateway looks a command up here and builds the right payload. When
 * someone asks "how did you handle both versions?", this table plus
 * `toConnectorStatus` below is the concrete answer.
 */
export const ACTION_BY_PROTOCOL: Record<string, Record<Protocol, string | null>> = {
  remote_start: {
    'ocpp1.6': 'RemoteStartTransaction',
    'ocpp2.0.1': 'RequestStartTransaction',
  },
  remote_stop: {
    'ocpp1.6': 'RemoteStopTransaction',
    'ocpp2.0.1': 'RequestStopTransaction',
  },
  reset: { 'ocpp1.6': 'Reset', 'ocpp2.0.1': 'Reset' },
  unlock_connector: { 'ocpp1.6': 'UnlockConnector', 'ocpp2.0.1': 'UnlockConnector' },
  change_availability: { 'ocpp1.6': 'ChangeAvailability', 'ocpp2.0.1': 'ChangeAvailability' },
  trigger_message: { 'ocpp1.6': 'TriggerMessage', 'ocpp2.0.1': 'TriggerMessage' },
  get_configuration: { 'ocpp1.6': 'GetConfiguration', 'ocpp2.0.1': 'GetVariables' },
  set_configuration: { 'ocpp1.6': 'ChangeConfiguration', 'ocpp2.0.1': 'SetVariables' },
  clear_cache: { 'ocpp1.6': 'ClearCache', 'ocpp2.0.1': 'ClearCache' },
  reserve_now: { 'ocpp1.6': 'ReserveNow', 'ocpp2.0.1': 'ReserveNow' },
  cancel_reservation: { 'ocpp1.6': 'CancelReservation', 'ocpp2.0.1': 'CancelReservation' },
  set_charging_profile: { 'ocpp1.6': 'SetChargingProfile', 'ocpp2.0.1': 'SetChargingProfile' },
  clear_charging_profile: { 'ocpp1.6': 'ClearChargingProfile', 'ocpp2.0.1': 'ClearChargingProfile' },
  get_composite_schedule: { 'ocpp1.6': 'GetCompositeSchedule', 'ocpp2.0.1': 'GetCompositeSchedule' },
  update_firmware: { 'ocpp1.6': 'UpdateFirmware', 'ocpp2.0.1': 'UpdateFirmware' },
  get_diagnostics: { 'ocpp1.6': 'GetDiagnostics', 'ocpp2.0.1': 'GetLog' },
  get_local_list_version: { 'ocpp1.6': 'GetLocalListVersion', 'ocpp2.0.1': 'GetLocalListVersion' },
  send_local_list: { 'ocpp1.6': 'SendLocalList', 'ocpp2.0.1': 'SendLocalList' },
  data_transfer: { 'ocpp1.6': 'DataTransfer', 'ocpp2.0.1': 'DataTransfer' },
};

export function wireActionFor(command: string, protocol: Protocol): string | null {
  return ACTION_BY_PROTOCOL[command]?.[protocol] ?? null;
}

/* ------------------------------------------------------------------ *
 * Connector status
 * ------------------------------------------------------------------ */

/** OCPP 1.6 `StatusNotification.status` → canonical. A straight rename. */
const STATUS_16: Record<string, ConnectorStatus> = {
  Available: 'available',
  Preparing: 'preparing',
  Charging: 'charging',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Finishing: 'finishing',
  Reserved: 'reserved',
  Unavailable: 'unavailable',
  Faulted: 'faulted',
};

/** OCPP 2.0.1 `TransactionEvent.transactionInfo.chargingState` → canonical. */
const CHARGING_STATE_201: Record<string, ConnectorStatus> = {
  Charging: 'charging',
  EVConnected: 'preparing',
  SuspendedEV: 'suspended_ev',
  SuspendedEVSE: 'suspended_evse',
  Idle: 'finishing',
};

/**
 * Turn a protocol status into a canonical one.
 *
 * For 2.0.1 you must pass the live transaction's `chargingState` as well,
 * because `Occupied` on its own does not say whether the car is charging,
 * paused or finished. Read the long comment on `ConnectorStatusSchema` in
 * the contracts package for why 2.0.1 split it this way.
 */
export function toConnectorStatus(
  protocol: Protocol,
  wireStatus: string,
  chargingState?: string | null,
): ConnectorStatus {
  if (protocol === 'ocpp1.6') {
    return STATUS_16[wireStatus] ?? 'unavailable';
  }

  switch (wireStatus) {
    case 'Available':
      return 'available';
    case 'Reserved':
      return 'reserved';
    case 'Unavailable':
      return 'unavailable';
    case 'Faulted':
      return 'faulted';
    case 'Occupied':
      // The interesting case: ask the transaction what it is doing.
      if (chargingState && CHARGING_STATE_201[chargingState]) {
        return CHARGING_STATE_201[chargingState];
      }
      // Occupied with no transaction yet means a cable is in but nothing has
      // been authorized. `preparing` is the honest answer.
      return 'preparing';
    default:
      return 'unavailable';
  }
}

/** Canonical → the 1.6 wire value. Used by the simulator. */
export function toWireStatus16(status: ConnectorStatus): string {
  const entry = Object.entries(STATUS_16).find(([, v]) => v === status);
  return entry?.[0] ?? 'Unavailable';
}

/** Canonical → 2.0.1 connectorStatus + chargingState. Note it returns BOTH. */
export function toWireStatus201(status: ConnectorStatus): {
  connectorStatus: string;
  chargingState: string | null;
} {
  switch (status) {
    case 'available':
      return { connectorStatus: 'Available', chargingState: null };
    case 'reserved':
      return { connectorStatus: 'Reserved', chargingState: null };
    case 'unavailable':
      return { connectorStatus: 'Unavailable', chargingState: null };
    case 'faulted':
      return { connectorStatus: 'Faulted', chargingState: null };
    case 'preparing':
      return { connectorStatus: 'Occupied', chargingState: 'EVConnected' };
    case 'charging':
      return { connectorStatus: 'Occupied', chargingState: 'Charging' };
    case 'suspended_ev':
      return { connectorStatus: 'Occupied', chargingState: 'SuspendedEV' };
    case 'suspended_evse':
      return { connectorStatus: 'Occupied', chargingState: 'SuspendedEVSE' };
    case 'finishing':
      return { connectorStatus: 'Occupied', chargingState: 'Idle' };
  }
}

/* ------------------------------------------------------------------ *
 * Stop reasons
 * ------------------------------------------------------------------ */

const STOP_REASON_16: Record<string, StopReason> = {
  EmergencyStop: 'emergency_stop',
  EVDisconnected: 'ev_disconnected',
  HardReset: 'hard_reset',
  Local: 'local',
  Other: 'other',
  PowerLoss: 'power_loss',
  Reboot: 'reboot',
  Remote: 'remote',
  SoftReset: 'soft_reset',
  UnlockCommand: 'unlock_command',
  DeAuthorized: 'de_authorized',
};

const STOP_REASON_201: Record<string, StopReason> = {
  ...STOP_REASON_16,
  EnergyLimitReached: 'energy_limit_reached',
  TimeLimitReached: 'time_limit_reached',
  SOCLimitReached: 'energy_limit_reached',
  StoppedByEV: 'stopped_by_evse',
  MasterPass: 'master_pass',
  ImmediateReset: 'hard_reset',
  LocalOutOfCredit: 'de_authorized',
  GroundFault: 'other',
  OvercurrentFault: 'other',
  PowerQuality: 'other',
  Timeout: 'other',
};

/**
 * Note the default: OCPP 1.6 says an ABSENT reason means `Local`. Defaulting
 * to `other` instead would silently mislabel every ordinary unplug.
 */
export function toStopReason(protocol: Protocol, wireReason?: string | null): StopReason {
  if (!wireReason) return 'local';
  const table = protocol === 'ocpp1.6' ? STOP_REASON_16 : STOP_REASON_201;
  return table[wireReason] ?? 'other';
}

/* ------------------------------------------------------------------ *
 * Authorization status
 * ------------------------------------------------------------------ */

/**
 * Canonical authorization result → the wire value.
 *
 * `no_credit` is ours, not OCPP's. 2.0.1 has a real `NoCredit` status; 1.6
 * does not, so we map it to `Blocked` there. Losing that detail on the wire
 * is unavoidable — which is exactly why we keep the richer value internally
 * and let the driver app show the real reason.
 */
export function toWireAuthStatus(protocol: Protocol, status: string): string {
  const map16: Record<string, string> = {
    accepted: 'Accepted',
    blocked: 'Blocked',
    expired: 'Expired',
    invalid: 'Invalid',
    concurrent_tx: 'ConcurrentTx',
    no_credit: 'Blocked',
  };
  const map201: Record<string, string> = {
    accepted: 'Accepted',
    blocked: 'Blocked',
    expired: 'Expired',
    invalid: 'Invalid',
    concurrent_tx: 'ConcurrentTx',
    no_credit: 'NoCredit',
  };
  return (protocol === 'ocpp1.6' ? map16 : map201)[status] ?? 'Invalid';
}

/* ------------------------------------------------------------------ *
 * Reset types
 * ------------------------------------------------------------------ */

export function toWireResetType(protocol: Protocol, type: 'immediate' | 'on_idle'): string {
  if (protocol === 'ocpp1.6') return type === 'immediate' ? 'Hard' : 'Soft';
  return type === 'immediate' ? 'Immediate' : 'OnIdle';
}

/* ------------------------------------------------------------------ *
 * Measurands
 * ------------------------------------------------------------------ */

/** Wire measurand → our canonical column name, plus the unit we store in. */
export const MEASURAND_MAP: Record<string, { field: string; storeAs: string }> = {
  'Energy.Active.Import.Register': { field: 'energyWh', storeAs: 'Wh' },
  'Power.Active.Import': { field: 'powerKw', storeAs: 'kW' },
  'Current.Import': { field: 'currentA', storeAs: 'A' },
  Voltage: { field: 'voltageV', storeAs: 'V' },
  SoC: { field: 'soc', storeAs: '%' },
  Temperature: { field: 'temperatureC', storeAs: 'C' },
  'Current.Offered': { field: 'currentOfferedA', storeAs: 'A' },
  'Power.Offered': { field: 'powerOfferedKw', storeAs: 'kW' },
};

/**
 * Normalise a sampled value to the unit we store.
 *
 * This tiny function prevents the most expensive class of bug in a CPMS:
 * energy totals that are wrong by a factor of 1000 for one vendor only,
 * discovered a month later when a customer queries their bill.
 */
export function normaliseSample(
  measurand: string,
  rawValue: string | number,
  unit?: string | null,
): number | null {
  const n = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;

  const u = (unit ?? '').toLowerCase();
  switch (measurand) {
    case 'Energy.Active.Import.Register':
    case 'Energy.Active.Export.Register':
      if (u === 'kwh') return n * 1000;
      return n; // Wh, or unspecified which the spec says is Wh
    case 'Power.Active.Import':
    case 'Power.Offered':
      if (u === 'w' || u === '') return n / 1000;
      return n; // already kW
    default:
      return n;
  }
}
