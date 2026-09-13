/**
 * @ocpp/ocpp — a reference catalogue of OCPP 1.6J and 2.0.1, plus the
 * cross-version translation both your backend and this UI need.
 *
 * Nothing here opens a socket. It is knowledge in a form the UI can render:
 * the log inspector uses it to explain frames, the simulator uses it to offer
 * the right actions, and you can read it while you build.
 */
export * from './types';
export * from './ocpp16';
export * from './ocpp201';
export * from './mapping';

import type { Protocol } from '@ocpp/contracts';
import type { MessageDoc } from './types';
import { OCPP16_MESSAGES } from './ocpp16';
import { OCPP201_MESSAGES } from './ocpp201';

export const ALL_MESSAGES: MessageDoc[] = [...OCPP16_MESSAGES, ...OCPP201_MESSAGES];

const index = new Map<string, MessageDoc>();
for (const doc of ALL_MESSAGES) index.set(`${doc.protocol}:${doc.action}`, doc);

/** Look up the documentation for one action. Returns undefined if unknown. */
export function findMessage(protocol: Protocol, action: string): MessageDoc | undefined {
  return index.get(`${protocol}:${action}`);
}

export function messagesFor(protocol: Protocol): MessageDoc[] {
  return ALL_MESSAGES.filter((d) => d.protocol === protocol);
}

/** Messages the station sends to us. */
export function inboundMessages(protocol: Protocol): MessageDoc[] {
  return messagesFor(protocol).filter((d) => d.origin === 'cp_to_csms' || d.origin === 'both');
}

/** Messages we send to the station. */
export function outboundMessages(protocol: Protocol): MessageDoc[] {
  return messagesFor(protocol).filter((d) => d.origin === 'csms_to_cp' || d.origin === 'both');
}

export function messagesByGrouping(protocol: Protocol): Map<string, MessageDoc[]> {
  const out = new Map<string, MessageDoc[]>();
  for (const doc of messagesFor(protocol)) {
    const list = out.get(doc.grouping) ?? [];
    list.push(doc);
    out.set(doc.grouping, list);
  }
  return out;
}

/**
 * Side-by-side comparison for the docs and the "protocol compare" screen.
 * Every row is one concept with its name in each version.
 */
export function comparisonRows(): Array<{
  concept: string;
  ocpp16: string | null;
  ocpp201: string | null;
  note: string;
}> {
  return [
    {
      concept: 'Station announces itself',
      ocpp16: 'BootNotification',
      ocpp201: 'BootNotification',
      note: '2.0.1 nests the hardware fields and adds a boot `reason`.',
    },
    {
      concept: 'Keep-alive',
      ocpp16: 'Heartbeat',
      ocpp201: 'Heartbeat',
      note: 'Identical.',
    },
    {
      concept: 'Connector state',
      ocpp16: 'StatusNotification (9 states + errorCode)',
      ocpp201: 'StatusNotification (5 states)',
      note: '2.0.1 moved charging detail to chargingState and faults to NotifyEvent.',
    },
    {
      concept: 'Charge begins',
      ocpp16: 'StartTransaction',
      ocpp201: 'TransactionEvent (Started)',
      note: 'The transaction id moved from the CSMS to the station.',
    },
    {
      concept: 'Measurements',
      ocpp16: 'MeterValues',
      ocpp201: 'TransactionEvent (Updated)',
      note: '2.0.1 keeps MeterValues only for samples outside a transaction.',
    },
    {
      concept: 'Charge ends',
      ocpp16: 'StopTransaction',
      ocpp201: 'TransactionEvent (Ended)',
      note: 'One message type replaces three.',
    },
    {
      concept: 'Ask to start remotely',
      ocpp16: 'RemoteStartTransaction',
      ocpp201: 'RequestStartTransaction',
      note: 'Renamed to make clear the station decides. Adds remoteStartId for correlation.',
    },
    {
      concept: 'Ask to stop remotely',
      ocpp16: 'RemoteStopTransaction',
      ocpp201: 'RequestStopTransaction',
      note: 'transactionId became a string.',
    },
    {
      concept: 'Read settings',
      ocpp16: 'GetConfiguration',
      ocpp201: 'GetVariables',
      note: 'Flat key/value bag became a typed component/variable tree.',
    },
    {
      concept: 'Write settings',
      ocpp16: 'ChangeConfiguration',
      ocpp201: 'SetVariables',
      note: '2.0.1 writes many variables in one call, with per-variable results.',
    },
    {
      concept: 'Discover capabilities',
      ocpp16: null,
      ocpp201: 'GetBaseReport → NotifyReport',
      note: 'No 1.6 equivalent. You had to consult the vendor datasheet.',
    },
    {
      concept: 'Report a fault',
      ocpp16: 'StatusNotification.errorCode',
      ocpp201: 'NotifyEvent',
      note: '2.0.1 faults are first-class events with severity and explicit clearing.',
    },
    {
      concept: 'Show text on the screen',
      ocpp16: null,
      ocpp201: 'SetDisplayMessage',
      note: 'New. 1.6 vendors used DataTransfer for this, incompatibly.',
    },
    {
      concept: 'Show live cost',
      ocpp16: null,
      ocpp201: 'CostUpdated',
      note: 'New, and what makes prepaid charging feel finished.',
    },
    {
      concept: 'Security events',
      ocpp16: 'Security whitepaper (optional)',
      ocpp201: 'SecurityEventNotification',
      note: 'Moved into the core specification.',
    },
    {
      concept: 'Certificate management',
      ocpp16: 'Security whitepaper (optional)',
      ocpp201: 'SignCertificate / CertificateSigned / InstallCertificate',
      note: 'Enables certificate rotation without a site visit.',
    },
    {
      concept: 'Plug & Charge (ISO 15118)',
      ocpp16: null,
      ocpp201: 'NotifyEVChargingNeeds, Get15118EVCertificate',
      note: 'The main commercial reason operators move to 2.0.1.',
    },
    {
      concept: 'Reconcile after an outage',
      ocpp16: null,
      ocpp201: 'GetTransactionStatus',
      note: 'In 1.6 you guessed. In 2.0.1 you can ask.',
    },
    {
      concept: 'Diagnostics upload',
      ocpp16: 'GetDiagnostics',
      ocpp201: 'GetLog',
      note: '2.0.1 can request the security log specifically.',
    },
    {
      concept: 'Reservation expiry',
      ocpp16: null,
      ocpp201: 'ReservationStatusUpdate',
      note: 'The station now tells you instead of you watching a clock.',
    },
  ];
}
