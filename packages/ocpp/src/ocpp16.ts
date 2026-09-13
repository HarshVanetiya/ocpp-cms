import type { MessageDoc } from './types';

/**
 * OCPP 1.6J message catalogue.
 *
 * "J" means JSON over WebSocket. There is also OCPP 1.6S (SOAP), which you
 * will occasionally meet on very old hardware and should politely decline to
 * support. Everything here is the JSON variant.
 *
 * 1.6 is still the workhorse of the industry — the large majority of
 * chargers in the field speak it, and will for years. Learn it first; 2.0.1
 * makes far more sense once you know what problems it was fixing.
 */

const m = (doc: MessageDoc): MessageDoc => doc;

export const OCPP16_MESSAGES: MessageDoc[] = [
  /* =============================== CORE =============================== */
  m({
    action: 'BootNotification',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 2,
    summary: 'Station introduces itself and asks for permission to operate',
    detail:
      'The first message after the WebSocket opens. The station tells you what it is; ' +
      'you tell it whether it may work, how often to send heartbeats, and what time it is. ' +
      'Your answer of `Accepted`, `Pending` or `Rejected` is the gate for the whole session: ' +
      'until you say Accepted, the station may only send BootNotification and Heartbeat.',
    whenItFires:
      'On power-up, after a reset, and after the station reconnects following a network drop. ' +
      'A station stuck in a boot loop will send this repeatedly — that pattern in your log ' +
      'usually means you answered Rejected or the station cannot parse your response.',
    requestFields: [
      {
        name: 'chargePointVendor',
        type: 'string(20)',
        required: true,
        description: 'Manufacturer name, free text.',
      },
      {
        name: 'chargePointModel',
        type: 'string(20)',
        required: true,
        description: 'Model name, free text.',
        gotcha:
          'Only 20 characters. Real vendors truncate awkwardly; do not try to parse meaning out of it.',
      },
      {
        name: 'chargePointSerialNumber',
        type: 'string(25)',
        required: false,
        description: 'Serial number of the charge point.',
      },
      {
        name: 'chargeBoxSerialNumber',
        type: 'string(25)',
        required: false,
        description: 'Deprecated in 1.6 but still widely sent. Treat as an alias of the above.',
      },
      {
        name: 'firmwareVersion',
        type: 'string(50)',
        required: false,
        description: 'Currently installed firmware. Store it — you will want it for fleet reports.',
      },
      { name: 'iccid', type: 'string(20)', required: false, description: 'SIM card ICCID.' },
      { name: 'imsi', type: 'string(20)', required: false, description: 'SIM card IMSI.' },
      {
        name: 'meterType',
        type: 'string(25)',
        required: false,
        description: 'Type of the built-in energy meter.',
      },
      {
        name: 'meterSerialNumber',
        type: 'string(25)',
        required: false,
        description: 'Serial number of the energy meter. Matters for legal metrology.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station may operate.',
        values: ['Accepted', 'Pending', 'Rejected'],
        gotcha:
          'Pending means "wait, I am configuring you" — the station stays connected and keeps ' +
          'sending BootNotification at `interval`. Rejected means "go away and retry later". ' +
          'Using Rejected for an unknown station is correct; using it for a temporary database ' +
          'error is not, because some firmware backs off very aggressively.',
      },
      {
        name: 'currentTime',
        type: 'dateTime',
        required: true,
        description:
          'The station sets its clock from this. Send real UTC with a Z suffix. A wrong clock ' +
          'here corrupts every timestamp in every transaction the station ever reports.',
      },
      {
        name: 'interval',
        type: 'integer',
        required: true,
        description:
          'Heartbeat interval in seconds when Accepted; retry interval when Pending or Rejected.',
        gotcha:
          'The same field means two different things depending on status. 300 is a sane ' +
          'heartbeat; 10 as a retry interval on Rejected will hammer you.',
      },
    ],
    counterpart: 'BootNotification',
  }),

  m({
    action: 'Heartbeat',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 2,
    summary: 'Keep-alive and clock sync',
    detail:
      'An empty message whose only job is to prove the station is still there, and to let it ' +
      're-sync its clock from your response. A station only sends it when nothing else has been ' +
      'sent for `interval` seconds — a busy station may never send one at all.',
    whenItFires:
      'Every `interval` seconds of silence. If you have not heard ANY message for about 2.5 ' +
      'intervals, mark the station offline. Do not mark it offline after one missed beat; ' +
      'mobile networks lose single packets constantly.',
    requestFields: [],
    responseFields: [
      {
        name: 'currentTime',
        type: 'dateTime',
        required: true,
        description: 'Current UTC time, used by the station to correct its clock drift.',
      },
    ],
    counterpart: 'Heartbeat',
  }),

  m({
    action: 'StatusNotification',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 5,
    summary: 'A connector changed state, or reported a fault',
    detail:
      'The station reports the state of one connector. This is how the dashboard knows a plug ' +
      'is free, occupied or broken. It is also the only way 1.6 reports hardware faults.',
    whenItFires:
      'On every state change, and usually once per connector right after boot. Also on demand ' +
      'via TriggerMessage.',
    requestFields: [
      {
        name: 'connectorId',
        type: 'integer',
        required: true,
        description: 'Which connector. 0 means the charge point as a whole, not a socket.',
        gotcha:
          'connectorId 0 is the single most common source of bugs in a first CPMS. A Faulted ' +
          'on connector 0 means the WHOLE STATION is broken, not connector zero — there is no ' +
          'connector zero. Handle it as a station-level status or you will show phantom connectors.',
      },
      {
        name: 'errorCode',
        type: 'enum',
        required: true,
        description: 'Fault code. `NoError` when everything is fine — it is required either way.',
        values: [
          'ConnectorLockFailure',
          'EVCommunicationError',
          'GroundFailure',
          'HighTemperature',
          'InternalError',
          'LocalListConflict',
          'NoError',
          'OtherError',
          'OverCurrentFailure',
          'OverVoltage',
          'PowerMeterFailure',
          'PowerSwitchFailure',
          'ReaderFailure',
          'ResetFailure',
          'UnderVoltage',
          'WeakSignal',
        ],
      },
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'The connector state.',
        values: [
          'Available',
          'Preparing',
          'Charging',
          'SuspendedEV',
          'SuspendedEVSE',
          'Finishing',
          'Reserved',
          'Unavailable',
          'Faulted',
        ],
        gotcha:
          'SuspendedEV means the CAR stopped drawing (usually it is full). SuspendedEVSE means ' +
          'the CHARGER stopped supplying (load management, or a fault). Drivers phone about the ' +
          'first and engineers get paged about the second, so never collapse them into one state.',
      },
      {
        name: 'timestamp',
        type: 'dateTime',
        required: false,
        description: 'When the change happened at the station.',
        gotcha:
          'Optional, and often absent or wrong. Store both the station timestamp and your own ' +
          'received-at time, and show your own in the UI. Station clocks drift and reset.',
      },
      { name: 'info', type: 'string(50)', required: false, description: 'Free-text detail.' },
      {
        name: 'vendorId',
        type: 'string(255)',
        required: false,
        description: 'Namespace for vendorErrorCode.',
      },
      {
        name: 'vendorErrorCode',
        type: 'string(50)',
        required: false,
        description: 'Manufacturer-specific error code. The one the field engineer actually needs.',
      },
    ],
    responseFields: [],
    counterpart: 'StatusNotification',
  }),

  m({
    action: 'Authorize',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 5,
    summary: 'May this card start a charge?',
    detail:
      'Sent when someone presents an RFID card. You look the tag up and answer. This is a pure ' +
      'question — it does not start anything.',
    whenItFires:
      'On card presentation, before StartTransaction. A station with a cached authorization may ' +
      'skip it entirely and go straight to StartTransaction, so never assume Authorize always ' +
      'precedes a transaction.',
    requestFields: [
      {
        name: 'idTag',
        type: 'string(20)',
        required: true,
        description: 'The identifier read from the card.',
        gotcha:
          'Maximum 20 characters in 1.6. Readers differ on byte order and case for the same ' +
          'physical card — normalise to uppercase before comparing, and store the normalised form.',
      },
    ],
    responseFields: [
      {
        name: 'idTagInfo.status',
        type: 'enum',
        required: true,
        description: 'The decision.',
        values: ['Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'],
      },
      {
        name: 'idTagInfo.expiryDate',
        type: 'dateTime',
        required: false,
        description: 'When this authorization stops being valid. The station caches until then.',
      },
      {
        name: 'idTagInfo.parentIdTag',
        type: 'string(20)',
        required: false,
        description:
          'Groups cards together. Any card sharing a parentIdTag may stop a transaction started ' +
          'by another — this is how a household or a fleet shares one charger.',
      },
    ],
    counterpart: 'Authorize',
  }),

  m({
    action: 'StartTransaction',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 5,
    summary: 'A charge has begun',
    detail:
      'The station tells you energy is about to flow. You answer with a transactionId that the ' +
      'station will quote in every MeterValues and in StopTransaction. YOU allocate that id in ' +
      '1.6 — this is reversed in 2.0.1.',
    whenItFires: 'After the cable is connected and authorization has succeeded.',
    requestFields: [
      {
        name: 'connectorId',
        type: 'integer',
        required: true,
        description: 'Which connector. Must be > 0 here.',
      },
      { name: 'idTag', type: 'string(20)', required: true, description: 'Who is charging.' },
      {
        name: 'meterStart',
        type: 'integer',
        required: true,
        description: 'Meter reading in Wh at the moment charging began.',
        gotcha:
          'This is the LIFETIME register of the meter, not zero. Energy delivered is ' +
          'meterStop − meterStart. Storing meterStart as the session total is a classic bug that ' +
          'produces sessions of 4,000,000 kWh.',
      },
      {
        name: 'reservationId',
        type: 'integer',
        required: false,
        description: 'Set when this charge consumes an existing reservation.',
      },
      {
        name: 'timestamp',
        type: 'dateTime',
        required: true,
        description: 'When charging started, per the station clock.',
      },
    ],
    responseFields: [
      {
        name: 'transactionId',
        type: 'integer',
        required: true,
        description: 'The id you assign. Must be unique across your entire CSMS.',
        gotcha:
          'Integer, and the station may store it in 32 bits. Do not use a timestamp in ' +
          'milliseconds. A per-CSMS sequence is correct. Never reuse an id, even years later.',
      },
      {
        name: 'idTagInfo.status',
        type: 'enum',
        required: true,
        description:
          'You may still reject here. If you do, the station must stop and will send ' +
          'StopTransaction with reason DeAuthorized.',
        values: ['Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'],
      },
    ],
    counterpart: 'TransactionEvent (eventType=Started)',
  }),

  m({
    action: 'StopTransaction',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 5,
    summary: 'The charge has ended',
    detail:
      'Final meter reading and the reason it stopped. This is the message that produces a bill, ' +
      'so treat it as the most important one in the protocol.',
    whenItFires:
      'When the cable is unplugged, a card is presented again, you send RemoteStopTransaction, ' +
      'or the station faults. Also sent for transactions that were queued offline, sometimes ' +
      'hours later.',
    requestFields: [
      {
        name: 'transactionId',
        type: 'integer',
        required: true,
        description: 'The id you handed out in StartTransaction.',
      },
      {
        name: 'meterStop',
        type: 'integer',
        required: true,
        description: 'Final meter reading in Wh.',
      },
      {
        name: 'timestamp',
        type: 'dateTime',
        required: true,
        description: 'When charging stopped.',
      },
      {
        name: 'idTag',
        type: 'string(20)',
        required: false,
        description: 'Who stopped it. Absent when the car simply unplugged.',
      },
      {
        name: 'reason',
        type: 'enum',
        required: false,
        description: 'Why it stopped. Absent means "Local" by specification.',
        values: [
          'EmergencyStop',
          'EVDisconnected',
          'HardReset',
          'Local',
          'Other',
          'PowerLoss',
          'Reboot',
          'Remote',
          'SoftReset',
          'UnlockCommand',
          'DeAuthorized',
        ],
      },
      {
        name: 'transactionData',
        type: 'MeterValue[]',
        required: false,
        description: 'A final batch of meter samples, often the whole session at once.',
        gotcha:
          'Stations that were offline dump their entire buffered session here. Be ready for a ' +
          'single message containing thousands of samples — and be ready for it to arrive for a ' +
          'transaction you already closed.',
      },
    ],
    responseFields: [
      {
        name: 'idTagInfo',
        type: 'IdTagInfo',
        required: false,
        description: 'Optional updated status for the card that stopped the charge.',
      },
    ],
    counterpart: 'TransactionEvent (eventType=Ended)',
  }),

  m({
    action: 'MeterValues',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'core',
    core: true,
    milestone: 5,
    summary: 'Periodic measurements during a charge',
    detail:
      'A batch of samples. The nesting is three deep: a list of timestamps, each holding a list ' +
      'of sampled values, each with its own measurand, unit, phase and context. Flatten it on ' +
      'the way in — see the note on pivoting in the contracts package.',
    whenItFires:
      'Every `MeterValueSampleInterval` seconds during a transaction, and at the clock-aligned ' +
      'interval outside one. Both intervals are configuration keys you control.',
    requestFields: [
      { name: 'connectorId', type: 'integer', required: true, description: 'Which connector.' },
      {
        name: 'transactionId',
        type: 'integer',
        required: false,
        description: 'Present when these samples belong to a transaction.',
        gotcha:
          'Absent for clock-aligned samples taken while idle. Do not assume every MeterValues ' +
          'has a transaction to attach to.',
      },
      {
        name: 'meterValue[].timestamp',
        type: 'dateTime',
        required: true,
        description: 'When this sample set was taken.',
      },
      {
        name: 'meterValue[].sampledValue[].value',
        type: 'string',
        required: true,
        description: 'The reading — as a STRING, even though it is a number.',
        gotcha:
          'It really is a string in the schema. Parse it defensively; some firmware sends ' +
          '"1234.00", some sends "1,234", and some sends an empty string for "no reading".',
      },
      {
        name: 'meterValue[].sampledValue[].measurand',
        type: 'enum',
        required: false,
        description: 'What was measured. Defaults to Energy.Active.Import.Register when absent.',
        values: [
          'Energy.Active.Import.Register',
          'Power.Active.Import',
          'Current.Import',
          'Voltage',
          'SoC',
          'Temperature',
          'Current.Offered',
          'Power.Offered',
          'Energy.Active.Export.Register',
          'Frequency',
        ],
      },
      {
        name: 'meterValue[].sampledValue[].unit',
        type: 'enum',
        required: false,
        description: 'Wh, kWh, W, kW, A, V, Celsius, Percent...',
        gotcha:
          'Wh and kWh are both legal for the same measurand. Normalise to Wh at ingest or your ' +
          'energy totals will be out by a factor of 1000 for some vendors only.',
      },
      {
        name: 'meterValue[].sampledValue[].phase',
        type: 'enum',
        required: false,
        description: 'L1, L2, L3, N or a combination. Absent means the total across all phases.',
      },
      {
        name: 'meterValue[].sampledValue[].context',
        type: 'enum',
        required: false,
        description: 'Why the sample was taken: Sample.Periodic, Transaction.Begin, Trigger...',
      },
    ],
    responseFields: [],
    counterpart: 'TransactionEvent (with meterValue) / MeterValues',
  }),

  m({
    action: 'DataTransfer',
    protocol: 'ocpp1.6',
    origin: 'both',
    grouping: 'data_transfer',
    core: false,
    milestone: 7,
    summary: 'Vendor-specific escape hatch',
    detail:
      'The officially sanctioned way to send something the specification does not cover. Both ' +
      'sides may send it. In practice it carries everything from display messages to payment ' +
      'terminal data, and every vendor uses it differently.',
    whenItFires: 'Whenever a vendor needs a feature OCPP does not have.',
    requestFields: [
      {
        name: 'vendorId',
        type: 'string(255)',
        required: true,
        description: 'Reverse-DNS vendor namespace, e.g. com.example.',
      },
      { name: 'messageId', type: 'string(50)', required: false, description: 'Vendor message type.' },
      { name: 'data', type: 'string', required: false, description: 'Free-form payload, often JSON-in-a-string.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether you understood it.',
        values: ['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId'],
      },
      { name: 'data', type: 'string', required: false, description: 'Vendor response payload.' },
    ],
    counterpart: 'DataTransfer',
  }),

  /* ========================= REMOTE CONTROL ========================== */
  m({
    action: 'RemoteStartTransaction',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Ask a station to start charging',
    detail:
      'What the driver app and the dashboard "start" buttons turn into. The station answers ' +
      'Accepted or Rejected immediately — but Accepted only means it will try.',
    whenItFires: 'Driver taps start in the app; operator clicks start in the dashboard.',
    requestFields: [
      {
        name: 'idTag',
        type: 'string(20)',
        required: true,
        description: 'The identifier to bill. Must be one you will later authorize.',
      },
      {
        name: 'connectorId',
        type: 'integer',
        required: false,
        description: 'Which connector. Omit to let the station choose.',
        gotcha:
          'Omitting it on a multi-connector station means the station picks, and it may pick the ' +
          'one the driver is not standing at. Always send it when you know it.',
      },
      {
        name: 'chargingProfile',
        type: 'ChargingProfile',
        required: false,
        description:
          'Optional limits for this transaction. This is how you cap the energy a prepaid ' +
          'driver can draw — nothing else enforces the amount they paid.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station will attempt it.',
        values: ['Accepted', 'Rejected'],
        gotcha:
          'Accepted does NOT mean charging started. The transaction only exists once ' +
          'StartTransaction arrives, which may be much later or never, because the driver still ' +
          'has to plug in. Design your UI around that gap.',
      },
    ],
    counterpart: 'RequestStartTransaction',
  }),

  m({
    action: 'RemoteStopTransaction',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Ask a station to stop a charge',
    requestFields: [
      {
        name: 'transactionId',
        type: 'integer',
        required: true,
        description: 'Which transaction to stop.',
      },
    ],
    detail:
      'Stops one transaction by id. As with remote start, the real confirmation is the ' +
      'StopTransaction that follows.',
    whenItFires: 'Driver taps stop; operator stops a session; prepaid limit reached.',
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station will attempt it.',
        values: ['Accepted', 'Rejected'],
        gotcha:
          'Rejected usually means the transactionId is unknown to the station — which means your ' +
          'database and the station disagree about what is running. Worth alerting on.',
      },
    ],
    counterpart: 'RequestStopTransaction',
  }),

  m({
    action: 'UnlockConnector',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: false,
    milestone: 6,
    summary: 'Release a stuck cable',
    detail:
      'Physically unlocks the connector latch. A real support workflow: the driver cannot get ' +
      'their cable out and phones you.',
    whenItFires: 'Support agent clicks unlock.',
    requestFields: [
      { name: 'connectorId', type: 'integer', required: true, description: 'Which connector.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result of the attempt.',
        values: ['Unlocked', 'UnlockFailed', 'NotSupported'],
        gotcha:
          'Many DC chargers have tethered cables that cannot unlock, and answer NotSupported. ' +
          'Hide the button for those, or your support team will keep clicking it.',
      },
    ],
    counterpart: 'UnlockConnector',
  }),

  m({
    action: 'Reset',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Reboot the station',
    detail:
      'Hard is a power-cycle: it drops everything immediately. Soft asks the software to restart ' +
      'gracefully, finishing what it can first.',
    whenItFires: 'Operator clicks reset, usually after a fault the station will not clear.',
    requestFields: [
      {
        name: 'type',
        type: 'enum',
        required: true,
        description: 'Hard = immediate power cycle. Soft = graceful software restart.',
        values: ['Hard', 'Soft'],
        gotcha:
          'A Hard reset during a transaction loses the session — you will get a StopTransaction ' +
          'with reason HardReset if you are lucky, and nothing at all if you are not. Warn the ' +
          'operator when a session is running.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station accepted the reset.',
        values: ['Accepted', 'Rejected'],
      },
    ],
    counterpart: 'Reset',
  }),

  m({
    action: 'ChangeAvailability',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Take a connector or the whole station out of service',
    detail:
      'Marks hardware Operative or Inoperative. Used for maintenance windows and for disabling a ' +
      'connector that keeps faulting.',
    whenItFires: 'Operator schedules maintenance, or disables a broken plug.',
    requestFields: [
      {
        name: 'connectorId',
        type: 'integer',
        required: true,
        description: '0 for the whole station, or a specific connector.',
      },
      {
        name: 'type',
        type: 'enum',
        required: true,
        description: 'The target availability.',
        values: ['Inoperative', 'Operative'],
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'Scheduled'],
        gotcha:
          'Scheduled means "there is a transaction running, I will do it when that finishes". ' +
          'Your UI must show a pending state, not success — the connector is still live.',
      },
    ],
    counterpart: 'ChangeAvailability',
  }),

  m({
    action: 'GetConfiguration',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Read the station settings',
    detail:
      'Returns key/value pairs. Send no keys to get everything the station is willing to share.',
    whenItFires: 'Operator opens the configuration tab.',
    requestFields: [
      {
        name: 'key',
        type: 'string[]',
        required: false,
        description: 'Specific keys to read. Omit for all of them.',
      },
    ],
    responseFields: [
      {
        name: 'configurationKey',
        type: 'KeyValue[]',
        required: false,
        description: 'Each with key, readonly and value.',
      },
      {
        name: 'unknownKey',
        type: 'string[]',
        required: false,
        description: 'Keys you asked for that the station does not have.',
        gotcha:
          'Surface these in the UI. An unknown key usually means the station does not support ' +
          'the feature you were about to configure, which is useful to know early.',
      },
    ],
    counterpart: 'GetVariables',
  }),

  m({
    action: 'ChangeConfiguration',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Write one station setting',
    detail: 'Sets a single key. Values are always strings, even numeric ones.',
    whenItFires: 'Operator edits a configuration value.',
    requestFields: [
      { name: 'key', type: 'string(50)', required: true, description: 'Key name, case-sensitive.' },
      {
        name: 'value',
        type: 'string(500)',
        required: true,
        description: 'New value, as a string. "300", not 300.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'RebootRequired', 'NotSupported'],
        gotcha:
          'RebootRequired means the value is stored but not active. Your UI must say so, ' +
          'otherwise the operator will think the change did nothing and change it again.',
      },
    ],
    counterpart: 'SetVariables',
  }),

  m({
    action: 'ClearCache',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'core',
    core: true,
    milestone: 6,
    summary: 'Forget cached authorizations',
    detail:
      'Stations cache Authorize results so they can work offline. When you block a card, the ' +
      'cache is what still lets it charge — clear it.',
    whenItFires: 'Immediately after blocking or deleting a token.',
    requestFields: [],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected'],
      },
    ],
    counterpart: 'ClearCache',
  }),

  m({
    action: 'TriggerMessage',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'remote_trigger',
    core: false,
    milestone: 6,
    summary: 'Ask the station to send a message now',
    detail:
      'Rather than waiting for the next heartbeat or status change, ask for one on demand. The ' +
      'refresh button on a station page is exactly this.',
    whenItFires: 'Operator clicks refresh; you want current state after a reconnect.',
    requestFields: [
      {
        name: 'requestedMessage',
        type: 'enum',
        required: true,
        description: 'Which message to ask for.',
        values: [
          'BootNotification',
          'DiagnosticsStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'StatusNotification',
        ],
      },
      {
        name: 'connectorId',
        type: 'integer',
        required: false,
        description: 'For per-connector messages.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'NotImplemented'],
      },
    ],
    counterpart: 'TriggerMessage',
  }),

  /* =========================== RESERVATION =========================== */
  m({
    action: 'ReserveNow',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'reservation',
    core: false,
    milestone: 7,
    summary: 'Hold a connector for one driver',
    detail: 'The connector reports Reserved and refuses other cards until the reservation expires.',
    whenItFires: 'Driver reserves a charger in the app.',
    requestFields: [
      { name: 'connectorId', type: 'integer', required: true, description: '0 lets the station choose.' },
      { name: 'expiryDate', type: 'dateTime', required: true, description: 'When the hold lapses.' },
      { name: 'idTag', type: 'string(20)', required: true, description: 'Who the hold is for.' },
      {
        name: 'parentIdTag',
        type: 'string(20)',
        required: false,
        description: 'Allows any card in the group to claim it.',
      },
      {
        name: 'reservationId',
        type: 'integer',
        required: true,
        description: 'Your id for this reservation, quoted back in StartTransaction.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable'],
      },
    ],
    counterpart: 'ReserveNow',
  }),

  m({
    action: 'CancelReservation',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'reservation',
    core: false,
    milestone: 7,
    summary: 'Release a held connector',
    detail: 'Cancels by reservation id.',
    whenItFires: 'Driver cancels, or the hold is cleaned up by a scheduled job.',
    requestFields: [
      { name: 'reservationId', type: 'integer', required: true, description: 'Which reservation.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected'],
      },
    ],
    counterpart: 'CancelReservation',
  }),

  /* ========================= LOCAL AUTH LIST ========================= */
  m({
    action: 'GetLocalListVersion',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'local_auth_list',
    core: false,
    milestone: 7,
    summary: 'Which version of the offline card list does the station hold?',
    detail:
      'The local list lets a station authorize cards with no network. Versioning it means you ' +
      'can send differences instead of the whole list every time.',
    whenItFires: 'Before syncing the list, and as a periodic consistency check.',
    requestFields: [],
    responseFields: [
      {
        name: 'listVersion',
        type: 'integer',
        required: true,
        description: 'Current version. 0 means empty, -1 means not supported.',
      },
    ],
    counterpart: 'GetLocalListVersion',
  }),

  m({
    action: 'SendLocalList',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'local_auth_list',
    core: false,
    milestone: 7,
    summary: 'Push the offline card list',
    detail:
      'Full replaces everything; Differential applies changes. Differential is what you want in ' +
      'production — a full list of 10,000 cards over a mobile link is painful.',
    whenItFires: 'After token changes, on a schedule, or when versions disagree.',
    requestFields: [
      {
        name: 'listVersion',
        type: 'integer',
        required: true,
        description: 'The version this update produces. Must increase.',
      },
      {
        name: 'updateType',
        type: 'enum',
        required: true,
        description: 'Full replacement or incremental change.',
        values: ['Differential', 'Full'],
      },
      {
        name: 'localAuthorizationList',
        type: 'AuthorizationData[]',
        required: false,
        description: 'Entries. An entry with no idTagInfo means DELETE this card.',
        gotcha:
          'Omitting idTagInfo is how you delete — it is not a malformed entry. Easy to get ' +
          'backwards, and getting it backwards leaves blocked cards working offline.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Failed', 'NotSupported', 'VersionMismatch'],
      },
    ],
    counterpart: 'SendLocalList',
  }),

  /* ========================== SMART CHARGING ========================= */
  m({
    action: 'SetChargingProfile',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'smart_charging',
    core: false,
    milestone: 10,
    summary: 'Limit how much power a station or transaction may draw',
    detail:
      'The heart of load management. A profile is a schedule of limits over time. Three purposes ' +
      'stack: ChargePointMaxProfile caps the whole station, TxDefaultProfile applies to any ' +
      'transaction, TxProfile applies to one specific transaction and wins over the others.',
    whenItFires:
      'Site load management, prepaid energy caps, and demand response from the grid operator.',
    requestFields: [
      {
        name: 'connectorId',
        type: 'integer',
        required: true,
        description: '0 for a station-wide limit.',
      },
      {
        name: 'csChargingProfiles.chargingProfileId',
        type: 'integer',
        required: true,
        description: 'Your id for this profile.',
      },
      {
        name: 'csChargingProfiles.stackLevel',
        type: 'integer',
        required: true,
        description: 'Higher wins when profiles overlap.',
      },
      {
        name: 'csChargingProfiles.chargingProfilePurpose',
        type: 'enum',
        required: true,
        description: 'Which of the three roles this profile plays.',
        values: ['ChargePointMaxProfile', 'TxDefaultProfile', 'TxProfile'],
      },
      {
        name: 'csChargingProfiles.chargingProfileKind',
        type: 'enum',
        required: true,
        description: 'Absolute times, recurring daily/weekly, or relative to transaction start.',
        values: ['Absolute', 'Recurring', 'Relative'],
      },
      {
        name: 'csChargingProfiles.chargingSchedule.chargingRateUnit',
        type: 'enum',
        required: true,
        description: 'W or A.',
        gotcha:
          'Amps or watts is a per-station capability, not a choice. Sending A to a station that ' +
          'only accepts W gets you a rejection with no useful detail. Read the supported unit ' +
          'from the configuration key `ChargingScheduleAllowedChargingRateUnit` first.',
      },
      {
        name: 'csChargingProfiles.chargingSchedule.chargingSchedulePeriod[]',
        type: 'array',
        required: true,
        description: 'Each period has startPeriod (seconds from schedule start) and limit.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'NotSupported'],
      },
    ],
    counterpart: 'SetChargingProfile',
  }),

  m({
    action: 'ClearChargingProfile',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'smart_charging',
    core: false,
    milestone: 10,
    summary: 'Remove charging limits',
    detail: 'Clears by id, or by any combination of connector, purpose and stack level.',
    whenItFires: 'Load management releases a constraint; a prepaid session ends.',
    requestFields: [
      { name: 'id', type: 'integer', required: false, description: 'A specific profile id.' },
      { name: 'connectorId', type: 'integer', required: false, description: 'Filter by connector.' },
      {
        name: 'chargingProfilePurpose',
        type: 'enum',
        required: false,
        description: 'Filter by purpose.',
      },
      { name: 'stackLevel', type: 'integer', required: false, description: 'Filter by stack level.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Unknown'],
      },
    ],
    counterpart: 'ClearChargingProfile',
  }),

  m({
    action: 'GetCompositeSchedule',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'smart_charging',
    core: false,
    milestone: 10,
    summary: 'Ask the station what limit it will actually apply',
    detail:
      'With several stacked profiles, the effective limit is not obvious. This asks the station ' +
      'to flatten them and tell you the answer. Invaluable when load management misbehaves.',
    whenItFires: 'Debugging smart charging; verifying a profile took effect.',
    requestFields: [
      { name: 'connectorId', type: 'integer', required: true, description: 'Which connector.' },
      { name: 'duration', type: 'integer', required: true, description: 'How many seconds ahead.' },
      { name: 'chargingRateUnit', type: 'enum', required: false, description: 'W or A.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected'],
      },
      {
        name: 'chargingSchedule',
        type: 'ChargingSchedule',
        required: false,
        description: 'The flattened schedule the station will follow.',
      },
    ],
    counterpart: 'GetCompositeSchedule',
  }),

  /* ======================== FIRMWARE & DIAGNOSTICS =================== */
  m({
    action: 'UpdateFirmware',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'firmware_management',
    core: false,
    milestone: 7,
    summary: 'Tell the station to fetch and install firmware',
    detail:
      'You give a URL; the station downloads and installs it itself. You do not push bytes over ' +
      'OCPP. Progress arrives as FirmwareStatusNotification.',
    whenItFires: 'Fleet firmware rollout.',
    requestFields: [
      {
        name: 'location',
        type: 'string',
        required: true,
        description: 'URL to download from. Often FTP on older hardware.',
        gotcha:
          'The station fetches this itself, so the URL must be reachable from the STATION\'s ' +
          'network, not yours. Localhost URLs are a classic wasted afternoon.',
      },
      {
        name: 'retrieveDate',
        type: 'dateTime',
        required: true,
        description: 'When to start downloading. Stagger these across a fleet.',
      },
      { name: 'retries', type: 'integer', required: false, description: 'Download retry count.' },
      { name: 'retryInterval', type: 'integer', required: false, description: 'Seconds between retries.' },
    ],
    responseFields: [],
    counterpart: 'UpdateFirmware',
  }),

  m({
    action: 'FirmwareStatusNotification',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'firmware_management',
    core: false,
    milestone: 7,
    summary: 'Firmware update progress',
    detail: 'Progress reports during an update.',
    whenItFires: 'After UpdateFirmware, at each stage.',
    requestFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Where the update has got to.',
        values: [
          'Downloaded',
          'DownloadFailed',
          'Downloading',
          'Idle',
          'InstallationFailed',
          'Installing',
          'Installed',
        ],
      },
    ],
    responseFields: [],
    counterpart: 'FirmwareStatusNotification',
  }),

  m({
    action: 'GetDiagnostics',
    protocol: 'ocpp1.6',
    origin: 'csms_to_cp',
    grouping: 'firmware_management',
    core: false,
    milestone: 7,
    summary: 'Ask the station to upload its logs',
    detail: 'You supply an upload URL; the station posts a log bundle to it.',
    whenItFires: 'Investigating a fault you cannot reproduce.',
    requestFields: [
      { name: 'location', type: 'string', required: true, description: 'Upload target URL.' },
      { name: 'startTime', type: 'dateTime', required: false, description: 'Oldest log to include.' },
      { name: 'stopTime', type: 'dateTime', required: false, description: 'Newest log to include.' },
      { name: 'retries', type: 'integer', required: false, description: 'Upload retry count.' },
    ],
    responseFields: [
      {
        name: 'fileName',
        type: 'string(255)',
        required: false,
        description: 'What the station will call the file.',
      },
    ],
    counterpart: 'GetLog',
  }),

  m({
    action: 'DiagnosticsStatusNotification',
    protocol: 'ocpp1.6',
    origin: 'cp_to_csms',
    grouping: 'firmware_management',
    core: false,
    milestone: 7,
    summary: 'Diagnostics upload progress',
    detail: 'Progress of a diagnostics upload.',
    whenItFires: 'After GetDiagnostics.',
    requestFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Upload state.',
        values: ['Idle', 'Uploaded', 'UploadFailed', 'Uploading'],
      },
    ],
    responseFields: [],
    counterpart: 'LogStatusNotification',
  }),
];
