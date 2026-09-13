import type { SimScenario, SimStation } from '@ocpp/contracts';
import type { Rng } from './random';

/**
 * Simulator fixtures.
 *
 * The scenarios are the teaching content. Each one is a story with a stated
 * learning goal, and each step optionally asserts what your CSMS replied — so
 * running them is both a demo and a conformance test of the backend you are
 * writing.
 */

export function buildSimStations(r: Rng, now: number): SimStation[] {
  const specs: Array<{
    identity: string;
    protocol: SimStation['protocol'];
    state: SimStation['connectionState'];
    evses: number;
    dc: boolean;
    faulted?: boolean;
  }> = [
    { identity: 'SIM-AMS-001', protocol: 'ocpp1.6', state: 'connected', evses: 2, dc: false },
    { identity: 'SIM-AMS-002', protocol: 'ocpp2.0.1', state: 'connected', evses: 2, dc: true },
    { identity: 'SIM-RTM-004', protocol: 'ocpp1.6', state: 'connected', evses: 2, dc: false, faulted: true },
    { identity: 'SIM-UTR-007', protocol: 'ocpp1.6', state: 'disconnected', evses: 1, dc: false },
    { identity: 'SIM-EIN-011', protocol: 'ocpp2.0.1', state: 'connected', evses: 4, dc: false },
  ];

  return specs.map((spec, idx) => ({
    id: r.uuid(),
    identity: spec.identity,
    name: spec.identity,
    protocol: spec.protocol,
    csmsUrl: 'ws://localhost:3000/ocpp',
    connectionState: spec.state,
    vendor: 'SimuVolt',
    model: spec.dc ? 'SV-150DC' : 'SV-22AC',
    serialNumber: `SV${spec.dc ? '150' : '22'}-${String(idx + 1).padStart(4, '0')}`,
    firmwareVersion: '1.4.2',
    connectors: Array.from({ length: spec.evses }, (_, i) => ({
      connectorId: 1,
      evseId: i + 1,
      type: (spec.dc ? 'iec_62196_t2_combo' : 'iec_62196_t2') as SimStation['connectors'][number]['type'],
      powerType: (spec.dc ? 'dc' : 'ac_3_phase') as SimStation['connectors'][number]['powerType'],
      maxPowerKw: spec.dc ? 150 : 22,
      status:
        spec.state !== 'connected'
          ? 'unavailable'
          : spec.faulted && i === 0
            ? 'faulted'
            : i === 0 && idx === 0
              ? 'charging'
              : i === 1 && idx === 0
                ? 'preparing'
                : 'available',
      cablePluggedIn: idx === 0 && i <= 1,
      transactionId: idx === 0 && i === 0 ? '48213' : null,
      meterWh: r.int(1_000_000, 5_000_000),
      powerKw: idx === 0 && i === 0 ? 11 : 0,
      soc: idx === 0 && i === 0 ? 64 : null,
    })),
    autoHeartbeat: true,
    heartbeatIntervalSeconds: 60,
    autoMeterValues: true,
    meterValueIntervalSeconds: 10,
    chargingPowerKw: spec.dc ? 120 : 11,
    defaultIdToken: '04A1B2C3D4E5',
    faults: {
      dropConnection: false,
      ignoreRemoteCommands: spec.faulted ?? false,
      respondWithErrors: false,
      sendInvalidPayloads: false,
      responseDelayMs: spec.faulted ? 250 : 0,
      reportFaulted: spec.faulted ?? false,
    },
    coordinates: null,
    lastError: spec.faulted ? 'Injected fault: GroundFailure on EVSE 1' : null,
    connectedAt: spec.state === 'connected' ? new Date(now - r.int(600, 9000) * 1000).toISOString() : null,
    messagesSent: spec.state === 'connected' ? r.int(200, 2500) : 0,
    messagesReceived: spec.state === 'connected' ? r.int(100, 900) : 0,
    createdAt: new Date(now - r.int(1, 30) * 86_400_000).toISOString(),
  }));
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

let stepSeq = 0;
const step = (
  action: SimScenario['steps'][number]['action'],
  label: string,
  note: string | null,
  extra: Partial<SimScenario['steps'][number]> = {},
): SimScenario['steps'][number] => ({
  id: `s${(stepSeq += 1)}`,
  action,
  label,
  note,
  delayMsBefore: 600,
  expect: null,
  ...extra,
});

export const SIM_SCENARIOS: SimScenario[] = [
  {
    id: 'boot-and-heartbeat',
    name: 'Boot and heartbeat',
    description: 'The minimum conversation a charge point must have to be considered alive.',
    protocol: 'both',
    category: 'basics',
    difficulty: 'beginner',
    learningGoal:
      'Every station starts here. Your CSMS must answer BootNotification with Accepted, a real ' +
      'UTC time and a heartbeat interval — and must not let the station do anything else until it has.',
    steps: [
      step('connect', 'Open the WebSocket', 'The subprotocol header is what selects 1.6 vs 2.0.1.'),
      step('send_boot_notification', 'Send BootNotification', 'Your answer gates everything that follows.', {
        expect: { field: 'status', equals: 'Accepted' },
      }),
      step('send_heartbeat', 'Send Heartbeat', 'The station sets its clock from currentTime in your reply.', {
        expect: { field: 'currentTime', exists: true },
        delayMsBefore: 1200,
      }),
      step('send_status_notification', 'Report connector Available', 'Now the dashboard can show a usable plug.'),
    ],
  },
  {
    id: 'happy-path-charge',
    name: 'A complete charge, start to finish',
    description: 'Plug in, authorise, charge for a while, unplug, get billed.',
    protocol: 'both',
    category: 'transactions',
    difficulty: 'beginner',
    learningGoal:
      'The full transaction lifecycle. Watch the connector status change at each step and note ' +
      'that energy delivered is meterStop minus meterStart — never meterStop alone.',
    steps: [
      step('plug_in', 'Plug in the cable', 'Physical event first; the StatusNotification is its consequence.'),
      step('swipe_card', 'Present the RFID card', 'Authorize is a question, not a command — it starts nothing.', {
        expect: { field: 'idTagInfo.status', equals: 'Accepted' },
      }),
      step('start_charging', 'Start the transaction', 'In 1.6 your CSMS allocates the transactionId here.', {
        expect: { field: 'transactionId', exists: true },
      }),
      step('send_meter_values', 'Send a meter sample', 'Values arrive as strings. Parse defensively.', { delayMsBefore: 1500 }),
      step('send_meter_values', 'Send another sample', null, { delayMsBefore: 1500 }),
      step('stop_charging', 'Stop the transaction', 'This message is what produces a bill. Treat it as sacred.'),
      step('plug_out', 'Unplug', 'Connector returns to Available.'),
    ],
  },
  {
    id: 'remote-start',
    name: 'Remote start from the app',
    description: 'The CSMS asks the station to begin, and nothing happens until a car is plugged in.',
    protocol: 'both',
    category: 'remote_control',
    difficulty: 'intermediate',
    learningGoal:
      'The gap between Accepted and actually charging. RemoteStartTransaction returning Accepted ' +
      'only means the station will try. A UI that reports success here lies to the driver.',
    steps: [
      step('connect', 'Ensure connected', null),
      step('send_status_notification', 'Report Available', null),
      step('plug_in', 'Driver plugs in AFTER the remote start', 'This ordering is the whole point of the scenario.', {
        delayMsBefore: 2500,
      }),
      step('start_charging', 'Station opens the transaction', 'Only now is the session real.'),
    ],
  },
  {
    id: 'declined-card',
    name: 'Prepaid charge, card declined',
    description: 'An expired token is presented. No transaction should ever open.',
    protocol: 'both',
    category: 'authorization',
    difficulty: 'intermediate',
    learningGoal:
      'The authorize → reject → refund path. Check that your CSMS releases the payment hold and ' +
      'that no orphan session row is left behind in the database.',
    steps: [
      step('connect', 'Connect and boot', null),
      step('plug_in', 'Plug in the cable', null),
      step('swipe_card', 'Swipe an expired card', 'Return Expired, not Invalid — the station shows a different message.', {
        payload: { idToken: 'EXPIRED-0001' },
        expect: { field: 'idTagInfo.status', equals: 'Expired' },
      }),
      step('plug_out', 'Driver gives up and unplugs', 'Your scheduled job must void the payment hold.'),
    ],
  },
  {
    id: 'offline-buffering',
    name: 'Station goes offline mid-charge',
    description: 'The network drops while a car is charging, then comes back.',
    protocol: 'both',
    category: 'reliability',
    difficulty: 'advanced',
    learningGoal:
      'The single hardest part of running a CPMS. The station buffers messages and replays them ' +
      'with their ORIGINAL timestamps. Your handlers must be idempotent and must not fire "charging ' +
      'started" notifications for events that are already two hours old.',
    steps: [
      step('plug_in', 'Plug in', null),
      step('swipe_card', 'Authorise', null),
      step('start_charging', 'Start charging', null),
      step('send_meter_values', 'One sample arrives normally', null, { delayMsBefore: 1200 }),
      step('disconnect', 'Network drops', 'No close frame — exactly like a real mobile outage.'),
      step('connect', 'Station reconnects', 'It will now replay everything it buffered.', { delayMsBefore: 3000 }),
      step('send_meter_values', 'Replayed samples arrive late', 'Note the timestamps are in the past.'),
      step('stop_charging', 'Replayed StopTransaction', 'For a transaction you may already have timed out.'),
    ],
  },
  {
    id: 'fault-and-recover',
    name: 'Connector faults and recovers',
    description: 'A ground fault takes a connector out, then it clears.',
    protocol: 'both',
    category: 'reliability',
    difficulty: 'intermediate',
    learningGoal:
      'Fault handling differs sharply between versions: 1.6 rides the error on StatusNotification, ' +
      '2.0.1 sends a separate NotifyEvent with an explicit cleared flag. Track open faults by ' +
      'component or your fault list only ever grows.',
    steps: [
      step('trigger_fault', 'Report GroundFailure', 'Connector goes Faulted. The site loses a plug.'),
      step('send_status_notification', 'Confirm Faulted state', null),
      step('clear_fault', 'Fault clears', 'In 1.6 you infer recovery from NoError; 2.0.1 tells you.', {
        delayMsBefore: 2500,
      }),
      step('send_status_notification', 'Back to Available', null),
    ],
  },
  {
    id: 'smart-charging-cap',
    name: 'Prepaid energy cap',
    description: 'A driver pays for 10 kWh. The station must stop at 10 kWh, not when the car is full.',
    protocol: 'both',
    category: 'smart_charging',
    difficulty: 'advanced',
    learningGoal:
      'Nothing but a charging profile enforces a prepaid amount. Send the cap with the remote ' +
      'start, and confirm the station stops on its own with reason EnergyLimitReached.',
    steps: [
      step('plug_in', 'Plug in', null),
      step('start_charging', 'Start with a profile attached', 'The limit rides on the remote start.'),
      step('send_meter_values', 'Energy climbs', null, { delayMsBefore: 1500 }),
      step('send_meter_values', 'Energy approaches the cap', null, { delayMsBefore: 1500 }),
      step('stop_charging', 'Station stops itself', 'Reason should be EnergyLimitReached, not Local.', {
        expect: { field: 'reason', equals: 'EnergyLimitReached' },
      }),
    ],
  },
  {
    id: 'malformed-payload',
    name: 'Station sends rubbish',
    description: 'A firmware bug produces a payload that violates the JSON schema.',
    protocol: 'both',
    category: 'security',
    difficulty: 'advanced',
    learningGoal:
      'Your CSMS must answer with a CALLERROR carrying the right code — not crash, not silently ' +
      'accept. Validate every inbound payload against the schema before it reaches your handlers.',
    steps: [
      step('send_raw', 'Send a StatusNotification with a bad enum', 'Expect FormationViolation or TypeConstraintViolation.', {
        payload: { connectorId: 'two', status: 'Charging!' },
      }),
      step('send_raw', 'Send a frame with the wrong message type id', null, { payload: { messageTypeId: 9 } }),
      step('send_heartbeat', 'Prove the connection survived', 'A malformed message must never drop the socket.'),
    ],
  },
];
