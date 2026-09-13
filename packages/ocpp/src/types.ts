import type { Protocol } from '@ocpp/contracts';

/**
 * The catalogue's own types.
 *
 * This package is a REFERENCE, not a runtime. It describes every OCPP message
 * in both versions so that:
 *
 *   - the log inspector can explain a frame instead of just pretty-printing it,
 *   - the simulator can offer the right actions for the selected protocol,
 *   - and you have one place to look things up while you build the backend.
 *
 * None of it sends anything. It is documentation that the UI can read.
 */

/** Who is allowed to initiate this message. */
export type MessageOrigin =
  /** Charge point → CSMS. The station speaks first. */
  | 'cp_to_csms'
  /** CSMS → charge point. We speak first. */
  | 'csms_to_cp'
  /** Either side may send it (DataTransfer is the only real example). */
  | 'both';

/**
 * OCPP 1.6 groups messages into "profiles"; a station declares which ones it
 * supports. 2.0.1 renamed these to "functional blocks" and re-cut them.
 */
export type Grouping =
  | 'core'
  | 'firmware_management'
  | 'local_auth_list'
  | 'reservation'
  | 'smart_charging'
  | 'remote_trigger'
  | 'security'
  | 'provisioning'
  | 'authorization'
  | 'availability'
  | 'transactions'
  | 'device_management'
  | 'diagnostics'
  | 'meter_values'
  | 'display_message'
  | 'data_transfer'
  | 'tariff_cost'
  | 'iso15118';

export interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  /** What it is, in plain words. */
  description: string;
  /** Allowed values, when it is an enum. */
  values?: string[];
  /** Something that will bite you. Rendered as a warning in the inspector. */
  gotcha?: string;
}

export interface MessageDoc {
  /** The exact action string on the wire. Case-sensitive. */
  action: string;
  protocol: Protocol;
  origin: MessageOrigin;
  grouping: Grouping;
  /** One line, shown in log rows. */
  summary: string;
  /** A paragraph, shown when a frame is expanded. */
  detail: string;
  /** Why this message exists and when it fires. */
  whenItFires: string;
  requestFields: FieldDoc[];
  responseFields: FieldDoc[];
  /** The equivalent action in the other protocol version, if there is one. */
  counterpart: string | null;
  /** Is this message required for a minimally conformant implementation? */
  core: boolean;
  /** Build-order hint, matching the docs' milestones. */
  milestone: number;
}
