import type { MessageDoc } from './types';

/**
 * OCPP 2.0.1 message catalogue.
 *
 * ## What 2.0.1 actually changed, and why
 *
 * It is not "1.6 with more messages". Four structural changes matter:
 *
 * 1. TRANSACTIONS BECAME ONE MESSAGE. StartTransaction, StopTransaction and
 *    MeterValues collapsed into `TransactionEvent` with eventType
 *    Started / Updated / Ended. And the STATION now allocates the
 *    transaction id, not you. This fixes a real 1.6 problem: if the station
 *    was offline when charging began, it had no id to put in its buffered
 *    messages, so offline transactions were genuinely messy.
 *
 * 2. THE DEVICE MODEL REPLACED CONFIGURATION KEYS. Instead of a flat bag of
 *    strings, a station exposes a tree of Components, each with Variables,
 *    each with typed attributes and characteristics. You can now ask "what
 *    can you do?" and get a machine-readable answer, which 1.6 could never
 *    do.
 *
 * 3. SECURITY BECAME PART OF THE SPEC. Certificate management, security
 *    profiles and security event logging are in the core specification
 *    rather than a bolt-on whitepaper.
 *
 * 4. ISO 15118 SUPPORT. Plug & Charge — the car identifies itself over the
 *    cable and no card or app is needed. This is the feature that pushed
 *    most operators to 2.0.1 in the first place.
 *
 * ## What stayed the same
 *
 * The RPC framing. CALL/CALLRESULT/CALLERROR arrays with a message id are
 * identical, so your gateway's transport layer is shared between versions.
 * Only the payloads and the action names differ. That is the whole reason a
 * single CPMS can serve both without much pain.
 */

const m = (doc: MessageDoc): MessageDoc => doc;

export const OCPP201_MESSAGES: MessageDoc[] = [
  /* ========================== PROVISIONING =========================== */
  m({
    action: 'BootNotification',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'provisioning',
    core: true,
    milestone: 7,
    summary: 'Station introduces itself and asks for permission to operate',
    detail:
      'Same role as in 1.6, but restructured: the vendor and model fields moved into a nested ' +
      '`chargingStation` object, and a `reason` field was added so you know WHY it booted.',
    whenItFires:
      'Power-up, reset, reconnection, and whenever the station is told to re-boot-notify. The ' +
      '`reason` field tells you which — very useful for spotting stations that are crash-looping ' +
      'rather than merely reconnecting.',
    requestFields: [
      {
        name: 'chargingStation.model',
        type: 'string(20)',
        required: true,
        description: 'Model name.',
      },
      {
        name: 'chargingStation.vendorName',
        type: 'string(50)',
        required: true,
        description: 'Manufacturer.',
      },
      {
        name: 'chargingStation.serialNumber',
        type: 'string(25)',
        required: false,
        description: 'Serial number.',
      },
      {
        name: 'chargingStation.firmwareVersion',
        type: 'string(50)',
        required: false,
        description: 'Installed firmware.',
      },
      {
        name: 'chargingStation.modem.iccid',
        type: 'string(20)',
        required: false,
        description: 'SIM ICCID, now nested under modem.',
      },
      {
        name: 'chargingStation.modem.imsi',
        type: 'string(20)',
        required: false,
        description: 'SIM IMSI.',
      },
      {
        name: 'reason',
        type: 'enum',
        required: true,
        description: 'Why the station is booting. New in 2.0.1 and genuinely useful.',
        values: [
          'ApplicationReset',
          'FirmwareUpdate',
          'LocalReset',
          'PowerUp',
          'RemoteReset',
          'ScheduledReset',
          'Triggered',
          'Unknown',
          'Watchdog',
        ],
        gotcha:
          'Repeated `Watchdog` reasons mean the station firmware is hanging and resetting itself. ' +
          'Alert on it — in 1.6 this was invisible and sites would quietly reboot all night.',
      },
    ],
    responseFields: [
      {
        name: 'currentTime',
        type: 'dateTime',
        required: true,
        description: 'UTC time for the station to sync to.',
      },
      {
        name: 'interval',
        type: 'integer',
        required: true,
        description: 'Heartbeat interval when Accepted, retry interval otherwise.',
      },
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Permission to operate.',
        values: ['Accepted', 'Pending', 'Rejected'],
      },
      {
        name: 'statusInfo',
        type: 'StatusInfo',
        required: false,
        description:
          'Structured reason with reasonCode and additionalInfo. New in 2.0.1 — use it, because ' +
          'a bare Rejected with no explanation is an unpleasant thing to debug from a van.',
      },
    ],
    counterpart: 'BootNotification',
  }),

  m({
    action: 'Heartbeat',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'availability',
    core: true,
    milestone: 7,
    summary: 'Keep-alive and clock sync',
    detail: 'Identical in purpose and shape to 1.6.',
    whenItFires: 'Every heartbeat interval of silence.',
    requestFields: [],
    responseFields: [
      { name: 'currentTime', type: 'dateTime', required: true, description: 'Current UTC time.' },
    ],
    counterpart: 'Heartbeat',
  }),

  m({
    action: 'StatusNotification',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'availability',
    core: true,
    milestone: 7,
    summary: 'A connector changed state',
    detail:
      'Much simpler than 1.6: five states instead of nine, and no error code. Faults are now ' +
      'reported separately through NotifyEvent, and the detail of what a charging connector is ' +
      'doing lives in TransactionEvent.chargingState.',
    whenItFires: 'On connector state change and after boot.',
    requestFields: [
      { name: 'timestamp', type: 'dateTime', required: true, description: 'Now required, unlike 1.6.' },
      {
        name: 'connectorStatus',
        type: 'enum',
        required: true,
        description: 'The state.',
        values: ['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'],
        gotcha:
          'There is no Charging state. `Occupied` covers plugged-in, charging, suspended and ' +
          'finishing. To fill a dashboard you must combine this with the live transaction\'s ' +
          'chargingState. This is the single biggest surprise when moving from 1.6.',
      },
      { name: 'evseId', type: 'integer', required: true, description: 'Which EVSE.' },
      { name: 'connectorId', type: 'integer', required: true, description: 'Which connector in it.' },
    ],
    responseFields: [],
    counterpart: 'StatusNotification',
  }),

  /* ========================== AUTHORIZATION ========================== */
  m({
    action: 'Authorize',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'authorization',
    core: true,
    milestone: 7,
    summary: 'May this identifier start a charge?',
    detail:
      'Same question as 1.6, richer identifier. `idToken` is now an object with a type, and the ' +
      'response can carry ISO 15118 certificate validation results for Plug & Charge.',
    whenItFires: 'Card presented, app start, or a car authenticating over the cable.',
    requestFields: [
      {
        name: 'idToken.idToken',
        type: 'string(36)',
        required: true,
        description: 'The identifier. 36 chars now, up from 20.',
      },
      {
        name: 'idToken.type',
        type: 'enum',
        required: true,
        description: 'What kind of identifier this is.',
        values: [
          'Central',
          'eMAID',
          'ISO14443',
          'ISO15693',
          'KeyCode',
          'Local',
          'MacAddress',
          'NoAuthorization',
        ],
        gotcha:
          'The type is now explicit, which means you can tell an RFID card from a Plug & Charge ' +
          'contract id. In 1.6 both arrived as a bare string and you had to guess.',
      },
      {
        name: 'certificate',
        type: 'string(5500)',
        required: false,
        description: 'PEM certificate chain for Plug & Charge.',
      },
      {
        name: 'iso15118CertificateHashData',
        type: 'array',
        required: false,
        description: 'Hashes for OCSP validation, so the full chain need not be sent.',
      },
    ],
    responseFields: [
      {
        name: 'idTokenInfo.status',
        type: 'enum',
        required: true,
        description: 'The decision.',
        values: [
          'Accepted',
          'Blocked',
          'ConcurrentTx',
          'Expired',
          'Invalid',
          'NoCredit',
          'NotAllowedTypeEVSE',
          'NotAtThisLocation',
          'NotAtThisTime',
          'Unknown',
        ],
        gotcha:
          'Far richer than 1.6\'s five values. `NoCredit`, `NotAtThisTime` and `NotAtThisLocation` ' +
          'let the station show the driver a useful message instead of a generic refusal.',
      },
      {
        name: 'idTokenInfo.cacheExpiryDateTime',
        type: 'dateTime',
        required: false,
        description: 'How long the station may cache this decision.',
      },
      {
        name: 'idTokenInfo.groupIdToken',
        type: 'IdToken',
        required: false,
        description: 'The 2.0.1 equivalent of parentIdTag.',
      },
      {
        name: 'idTokenInfo.personalMessage',
        type: 'MessageContent',
        required: false,
        description: 'Text to show on the station display. "Welcome back, Alex."',
      },
    ],
    counterpart: 'Authorize',
  }),

  /* =========================== TRANSACTIONS ========================== */
  m({
    action: 'TransactionEvent',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'transactions',
    core: true,
    milestone: 7,
    summary: 'Everything about a charging transaction, in one message',
    detail:
      'The headline change of 2.0.1. StartTransaction, StopTransaction and MeterValues are now ' +
      'a single action distinguished by `eventType`. The station allocates `transactionId` ' +
      'itself, so it can open a transaction while offline and tell you later — the thing 1.6 ' +
      'handled badly.\n\n' +
      'The `triggerReason` field says WHY this event fired, which turns your log from a list of ' +
      'numbers into a readable story: Authorized, CablePluggedIn, ChargingStateChanged, ' +
      'MeterValuePeriodic, StopAuthorized, EVCommunicationLost, and so on.',
    whenItFires:
      'Started once at the beginning, Updated repeatedly during charging, Ended once at the end. ' +
      'A station that was offline sends the whole sequence when it reconnects, with the original ' +
      'timestamps and increasing seqNo values.',
    requestFields: [
      {
        name: 'eventType',
        type: 'enum',
        required: true,
        description: 'Which part of the transaction lifecycle this is.',
        values: ['Started', 'Updated', 'Ended'],
      },
      {
        name: 'timestamp',
        type: 'dateTime',
        required: true,
        description: 'When the event happened at the station, not when it reached you.',
      },
      {
        name: 'triggerReason',
        type: 'enum',
        required: true,
        description: 'What caused this event.',
        values: [
          'Authorized',
          'CablePluggedIn',
          'ChargingRateChanged',
          'ChargingStateChanged',
          'Deauthorized',
          'EnergyLimitReached',
          'EVCommunicationLost',
          'EVConnectTimeout',
          'MeterValueClock',
          'MeterValuePeriodic',
          'TimeLimitReached',
          'Trigger',
          'UnlockCommand',
          'StopAuthorized',
          'EVDeparted',
          'EVDetected',
          'RemoteStop',
          'RemoteStart',
          'AbnormalCondition',
          'SignedDataReceived',
          'ResetCommand',
        ],
      },
      {
        name: 'seqNo',
        type: 'integer',
        required: true,
        description: 'Sequence number within this transaction, starting at 0.',
        gotcha:
          'This is how you detect gaps and reordering after an offline period. Store it and ' +
          'check for holes — a missing seqNo means a lost event, and a lost Ended event means a ' +
          'session that never closes and never bills.',
      },
      {
        name: 'transactionInfo.transactionId',
        type: 'string(36)',
        required: true,
        description: 'Allocated by the STATION, not by you. String, not integer.',
        gotcha:
          'The reversal from 1.6. Your database must accept an id you did not create, and it may ' +
          'collide across stations from different vendors — always scope uniqueness by station.',
      },
      {
        name: 'transactionInfo.chargingState',
        type: 'enum',
        required: false,
        description: 'What the transaction is doing right now. Replaces 1.6 connector statuses.',
        values: ['Charging', 'EVConnected', 'SuspendedEV', 'SuspendedEVSE', 'Idle'],
      },
      {
        name: 'transactionInfo.stoppedReason',
        type: 'enum',
        required: false,
        description: 'Only on eventType Ended.',
        values: [
          'DeAuthorized',
          'EmergencyStop',
          'EnergyLimitReached',
          'EVDisconnected',
          'GroundFault',
          'ImmediateReset',
          'Local',
          'LocalOutOfCredit',
          'MasterPass',
          'Other',
          'OvercurrentFault',
          'PowerLoss',
          'PowerQuality',
          'Reboot',
          'Remote',
          'SOCLimitReached',
          'StoppedByEV',
          'TimeLimitReached',
          'Timeout',
        ],
      },
      {
        name: 'idToken',
        type: 'IdToken',
        required: false,
        description: 'Who is charging. Usually only on the Started event.',
      },
      { name: 'evse.id', type: 'integer', required: false, description: 'Which EVSE.' },
      {
        name: 'evse.connectorId',
        type: 'integer',
        required: false,
        description: 'Which connector.',
      },
      {
        name: 'meterValue',
        type: 'MeterValue[]',
        required: false,
        description: 'Samples, same nested structure as 1.6 MeterValues.',
      },
      {
        name: 'offline',
        type: 'boolean',
        required: false,
        description: 'True when this event was buffered while the station had no connection.',
        gotcha:
          'Treat offline events as historical: do not fire "charging started" push notifications ' +
          'for a transaction that began two hours ago and has already ended.',
      },
      {
        name: 'cableMaxCurrent',
        type: 'integer',
        required: false,
        description: 'Amp rating the cable reports. Explains why a car charges slower than expected.',
      },
      {
        name: 'reservationId',
        type: 'integer',
        required: false,
        description: 'Reservation this transaction consumed.',
      },
    ],
    responseFields: [
      {
        name: 'totalCost',
        type: 'decimal',
        required: false,
        description: 'Running cost. The station can display it to the driver live.',
        gotcha:
          'This is the 2.0.1 feature that makes prepaid charging pleasant — you compute cost and ' +
          'the station shows it on its own screen. 1.6 had no equivalent.',
      },
      {
        name: 'chargingPriority',
        type: 'integer',
        required: false,
        description: 'Priority for load management, -9 to 9.',
      },
      {
        name: 'idTokenInfo',
        type: 'IdTokenInfo',
        required: false,
        description: 'Updated authorization status, e.g. to stop a session that ran out of credit.',
      },
      {
        name: 'updatedPersonalMessage',
        type: 'MessageContent',
        required: false,
        description: 'New text for the station display.',
      },
    ],
    counterpart: 'StartTransaction / StopTransaction / MeterValues',
  }),

  m({
    action: 'MeterValues',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'meter_values',
    core: false,
    milestone: 7,
    summary: 'Measurements outside a transaction',
    detail:
      'Still exists, but only for samples NOT tied to a transaction — clock-aligned readings ' +
      'while a connector is idle. Anything during a charge goes inside TransactionEvent.',
    whenItFires: 'Clock-aligned sampling on an idle connector.',
    requestFields: [
      { name: 'evseId', type: 'integer', required: true, description: 'Which EVSE. 0 for the station.' },
      { name: 'meterValue', type: 'MeterValue[]', required: true, description: 'Sample batches.' },
    ],
    responseFields: [],
    counterpart: 'MeterValues',
  }),

  m({
    action: 'RequestStartTransaction',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'transactions',
    core: true,
    milestone: 7,
    summary: 'Ask a station to start charging',
    detail:
      'Renamed from RemoteStartTransaction, and the rename is meaningful: you REQUEST, the ' +
      'station decides. It can also return the transactionId immediately if it already knows it.',
    whenItFires: 'Driver app start; dashboard start; an OCPI partner command.',
    requestFields: [
      {
        name: 'idToken',
        type: 'IdToken',
        required: true,
        description: 'Who to bill, as a typed object.',
      },
      {
        name: 'remoteStartId',
        type: 'integer',
        required: true,
        description: 'Your correlation id, echoed back in the resulting TransactionEvent.',
        gotcha:
          'This solves a genuine 1.6 pain: matching "the start I requested" to "the transaction ' +
          'that appeared". In 1.6 you had to guess by connector and time. Always send it and ' +
          'always store it.',
      },
      { name: 'evseId', type: 'integer', required: false, description: 'Which EVSE. Omit to let the station choose.' },
      {
        name: 'chargingProfile',
        type: 'ChargingProfile',
        required: false,
        description: 'Limits for this transaction. Purpose must be TxProfile.',
      },
      {
        name: 'groupIdToken',
        type: 'IdToken',
        required: false,
        description: 'Group token, for shared authorization.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station will attempt it.',
        values: ['Accepted', 'Rejected'],
      },
      {
        name: 'transactionId',
        type: 'string(36)',
        required: false,
        description: 'Returned when the station can allocate the id right away.',
      },
      { name: 'statusInfo', type: 'StatusInfo', required: false, description: 'Structured reason.' },
    ],
    counterpart: 'RemoteStartTransaction',
  }),

  m({
    action: 'RequestStopTransaction',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'transactions',
    core: true,
    milestone: 7,
    summary: 'Ask a station to stop a charge',
    detail: 'Stops by transactionId, which is now a string.',
    whenItFires: 'Driver stop; operator stop; credit exhausted.',
    requestFields: [
      {
        name: 'transactionId',
        type: 'string(36)',
        required: true,
        description: 'The station-allocated id.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station will attempt it.',
        values: ['Accepted', 'Rejected'],
      },
      { name: 'statusInfo', type: 'StatusInfo', required: false, description: 'Structured reason.' },
    ],
    counterpart: 'RemoteStopTransaction',
  }),

  m({
    action: 'GetTransactionStatus',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'transactions',
    core: false,
    milestone: 7,
    summary: 'Is this transaction still running, and are messages still queued?',
    detail:
      'New in 2.0.1. Lets you reconcile after a network outage: the station tells you whether it ' +
      'still considers a transaction open and whether it has unsent messages for it.',
    whenItFires: 'After a reconnect, or when your records and the station disagree.',
    requestFields: [
      {
        name: 'transactionId',
        type: 'string(36)',
        required: false,
        description: 'Omit to ask about queued messages in general.',
      },
    ],
    responseFields: [
      {
        name: 'ongoingIndicator',
        type: 'boolean',
        required: false,
        description: 'Is the transaction still active at the station?',
      },
      {
        name: 'messagesInQueue',
        type: 'boolean',
        required: true,
        description: 'Does the station still have buffered messages to deliver?',
      },
    ],
    counterpart: null,
  }),

  /* ========================== DEVICE MODEL =========================== */
  m({
    action: 'GetVariables',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'device_management',
    core: true,
    milestone: 7,
    summary: 'Read device-model variables',
    detail:
      'The replacement for GetConfiguration. You address a variable by the Component it belongs ' +
      'to, the Variable name, and which attribute you want (Actual, Target, MinSet, MaxSet). ' +
      'Far more precise than 1.6\'s flat string bag, and considerably more verbose.',
    whenItFires: 'Operator opens the configuration tab; capability discovery after boot.',
    requestFields: [
      {
        name: 'getVariableData[].component.name',
        type: 'string(50)',
        required: true,
        description: 'Component, e.g. OCPPCommCtrlr, SampledDataCtrlr, AuthCtrlr.',
      },
      {
        name: 'getVariableData[].component.evse',
        type: 'EVSE',
        required: false,
        description: 'Scope the component to one EVSE or connector.',
      },
      {
        name: 'getVariableData[].variable.name',
        type: 'string(50)',
        required: true,
        description: 'Variable, e.g. HeartbeatInterval.',
      },
      {
        name: 'getVariableData[].attributeType',
        type: 'enum',
        required: false,
        description: 'Which attribute to read. Defaults to Actual.',
        values: ['Actual', 'Target', 'MinSet', 'MaxSet'],
      },
    ],
    responseFields: [
      {
        name: 'getVariableResult[].attributeStatus',
        type: 'enum',
        required: true,
        description: 'Per-variable result.',
        values: ['Accepted', 'Rejected', 'UnknownComponent', 'UnknownVariable', 'NotSupportedAttributeType'],
        gotcha:
          'The result is PER VARIABLE, not per message. A request for ten variables can return ' +
          'six Accepted and four UnknownVariable. Handle partial success or your UI will show ' +
          'blank rows with no explanation.',
      },
      {
        name: 'getVariableResult[].attributeValue',
        type: 'string(2500)',
        required: false,
        description: 'The value, still as a string.',
      },
    ],
    counterpart: 'GetConfiguration',
  }),

  m({
    action: 'SetVariables',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'device_management',
    core: true,
    milestone: 7,
    summary: 'Write device-model variables',
    detail: 'The replacement for ChangeConfiguration. Writes several variables in one call.',
    whenItFires: 'Operator edits configuration; automated fleet configuration.',
    requestFields: [
      {
        name: 'setVariableData[].component.name',
        type: 'string(50)',
        required: true,
        description: 'Target component.',
      },
      {
        name: 'setVariableData[].variable.name',
        type: 'string(50)',
        required: true,
        description: 'Target variable.',
      },
      {
        name: 'setVariableData[].attributeValue',
        type: 'string(1000)',
        required: true,
        description: 'New value as a string.',
      },
      {
        name: 'setVariableData[].attributeType',
        type: 'enum',
        required: false,
        description: 'Defaults to Actual.',
      },
    ],
    responseFields: [
      {
        name: 'setVariableResult[].attributeStatus',
        type: 'enum',
        required: true,
        description: 'Per-variable result.',
        values: ['Accepted', 'Rejected', 'RebootRequired', 'UnknownComponent', 'UnknownVariable', 'NotSupportedAttributeType'],
      },
    ],
    counterpart: 'ChangeConfiguration',
  }),

  m({
    action: 'GetBaseReport',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'device_management',
    core: true,
    milestone: 7,
    summary: 'Ask the station to describe everything it can do',
    detail:
      'The capability-discovery message that 1.6 completely lacked. The station replies with ' +
      'NotifyReport messages listing every component, variable and characteristic it has. ' +
      'Run this once at boot and you never have to guess what a station supports.',
    whenItFires: 'After the first successful boot of a newly registered station.',
    requestFields: [
      {
        name: 'requestId',
        type: 'integer',
        required: true,
        description: 'Correlates the NotifyReport messages that follow.',
      },
      {
        name: 'reportBase',
        type: 'enum',
        required: true,
        description: 'How much detail to return.',
        values: ['ConfigurationInventory', 'FullInventory', 'SummaryInventory'],
        gotcha:
          'FullInventory on a large station can produce dozens of NotifyReport messages over ' +
          'several minutes. Do not block a UI on it.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Whether the station will produce the report.',
        values: ['Accepted', 'Rejected', 'NotSupported', 'EmptyResultSet'],
      },
    ],
    counterpart: null,
  }),

  m({
    action: 'NotifyReport',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'device_management',
    core: true,
    milestone: 7,
    summary: 'One page of a device-model report',
    detail:
      'The station streams its inventory back in chunks. `tbc` (to be continued) tells you ' +
      'whether more pages are coming.',
    whenItFires: 'After GetBaseReport or GetReport.',
    requestFields: [
      { name: 'requestId', type: 'integer', required: true, description: 'Which request this answers.' },
      { name: 'generatedAt', type: 'dateTime', required: true, description: 'When the report was made.' },
      { name: 'seqNo', type: 'integer', required: true, description: 'Page number, from 0.' },
      {
        name: 'tbc',
        type: 'boolean',
        required: false,
        description: 'True when more pages follow. Defaults to false.',
        gotcha:
          'Do not treat the report as complete until you receive a page with tbc false or absent. ' +
          'Acting on a partial inventory produces confusing "unsupported feature" errors later.',
      },
      {
        name: 'reportData',
        type: 'ReportData[]',
        required: false,
        description: 'Components with their variables, attributes and characteristics.',
      },
    ],
    responseFields: [],
    counterpart: null,
  }),

  m({
    action: 'NotifyEvent',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'diagnostics',
    core: true,
    milestone: 7,
    summary: 'Something notable happened — including faults',
    detail:
      'Where 1.6 faults went. In 1.6, errorCode rode along on StatusNotification; in 2.0.1 a ' +
      'fault is its own event with a severity, a component, and a technical code. This is also ' +
      'how variable monitors report threshold breaches.',
    whenItFires: 'Hardware faults, threshold crossings, and monitored variable changes.',
    requestFields: [
      { name: 'generatedAt', type: 'dateTime', required: true, description: 'When it happened.' },
      { name: 'seqNo', type: 'integer', required: true, description: 'Page number for long batches.' },
      {
        name: 'eventData[].trigger',
        type: 'enum',
        required: true,
        description: 'What kind of monitor fired.',
        values: ['Alerting', 'Delta', 'Periodic'],
      },
      {
        name: 'eventData[].actualValue',
        type: 'string(2500)',
        required: true,
        description: 'The value that triggered it.',
      },
      {
        name: 'eventData[].eventNotificationType',
        type: 'enum',
        required: true,
        description: 'Whether this monitor was set by you or is built into the firmware.',
        values: ['HardWiredNotification', 'HardWiredMonitor', 'PreconfiguredMonitor', 'CustomMonitor'],
      },
      {
        name: 'eventData[].component',
        type: 'Component',
        required: true,
        description: 'Which part of the station.',
      },
      {
        name: 'eventData[].variable',
        type: 'Variable',
        required: true,
        description: 'Which variable.',
      },
      {
        name: 'eventData[].cleared',
        type: 'boolean',
        required: false,
        description: 'True when this event CLEARS a previous alert.',
        gotcha:
          'Faults now have an explicit clear event, which 1.6 never had — there you inferred ' +
          'recovery from a NoError status. Track open faults by component and close them on ' +
          'cleared, or your fault list will only ever grow.',
      },
    ],
    responseFields: [],
    counterpart: 'StatusNotification (errorCode field)',
  }),

  /* ======================== REMOTE CONTROL =========================== */
  m({
    action: 'Reset',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'provisioning',
    core: true,
    milestone: 7,
    summary: 'Reboot the station or one EVSE',
    detail:
      'Two improvements over 1.6: the type names say what they mean, and you can reset a single ' +
      'EVSE rather than the whole station.',
    whenItFires: 'Operator reset.',
    requestFields: [
      {
        name: 'type',
        type: 'enum',
        required: true,
        description: 'Immediate reboots now; OnIdle waits for transactions to finish.',
        values: ['Immediate', 'OnIdle'],
      },
      {
        name: 'evseId',
        type: 'integer',
        required: false,
        description: 'Reset just this EVSE. Omit for the whole station.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'Scheduled'],
      },
    ],
    counterpart: 'Reset',
  }),

  m({
    action: 'ChangeAvailability',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'availability',
    core: true,
    milestone: 7,
    summary: 'Take an EVSE or the station out of service',
    detail: 'Same idea as 1.6, addressed by EVSE rather than connector number.',
    whenItFires: 'Maintenance.',
    requestFields: [
      {
        name: 'operationalStatus',
        type: 'enum',
        required: true,
        description: 'Target state.',
        values: ['Inoperative', 'Operative'],
      },
      {
        name: 'evse',
        type: 'EVSE',
        required: false,
        description: 'Omit for the whole station — no more magic connector 0.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'Scheduled'],
      },
    ],
    counterpart: 'ChangeAvailability',
  }),

  m({
    action: 'UnlockConnector',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'availability',
    core: false,
    milestone: 7,
    summary: 'Release a stuck cable',
    detail: 'Now addressed by EVSE and connector rather than a single connector number.',
    whenItFires: 'Support request.',
    requestFields: [
      { name: 'evseId', type: 'integer', required: true, description: 'Which EVSE.' },
      { name: 'connectorId', type: 'integer', required: true, description: 'Which connector.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Unlocked', 'UnlockFailed', 'OngoingAuthorizedTransaction', 'UnknownConnector'],
        gotcha:
          'OngoingAuthorizedTransaction is a new and useful refusal: it will not unlock while ' +
          'someone is legitimately charging. 1.6 would simply fail with no reason.',
      },
    ],
    counterpart: 'UnlockConnector',
  }),

  m({
    action: 'TriggerMessage',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'remote_trigger',
    core: false,
    milestone: 7,
    summary: 'Ask the station to send a message now',
    detail: 'Same as 1.6 with a longer list of requestable messages.',
    whenItFires: 'Refresh; post-reconnect reconciliation.',
    requestFields: [
      {
        name: 'requestedMessage',
        type: 'enum',
        required: true,
        description: 'Which message to ask for.',
        values: [
          'BootNotification',
          'LogStatusNotification',
          'FirmwareStatusNotification',
          'Heartbeat',
          'MeterValues',
          'SignChargingStationCertificate',
          'SignV2GCertificate',
          'StatusNotification',
          'TransactionEvent',
          'SignCombinedCertificate',
          'PublishFirmwareStatusNotification',
        ],
      },
      { name: 'evse', type: 'EVSE', required: false, description: 'Scope to one EVSE.' },
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

  m({
    action: 'ClearCache',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'authorization',
    core: true,
    milestone: 7,
    summary: 'Forget cached authorizations',
    detail: 'Unchanged from 1.6.',
    whenItFires: 'After blocking a token.',
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

  /* =========================== DISPLAY =============================== */
  m({
    action: 'SetDisplayMessage',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'display_message',
    core: false,
    milestone: 7,
    summary: 'Put text on the station screen',
    detail:
      'Entirely new in 2.0.1. Schedule a message, target one transaction or the idle screen, ' +
      'set priority. This is how you show tariffs, promotions or "out of order" notices.',
    whenItFires: 'Marketing messages; maintenance notices; per-driver greetings.',
    requestFields: [
      { name: 'message.id', type: 'integer', required: true, description: 'Your id for the message.' },
      {
        name: 'message.priority',
        type: 'enum',
        required: true,
        description: 'Where it appears.',
        values: ['AlwaysFront', 'InFront', 'NormalCycle'],
      },
      {
        name: 'message.state',
        type: 'enum',
        required: false,
        description: 'Only show in this station state.',
        values: ['Charging', 'Faulted', 'Idle', 'Unavailable'],
      },
      {
        name: 'message.message.content',
        type: 'string(512)',
        required: true,
        description: 'The text.',
      },
      {
        name: 'message.message.format',
        type: 'enum',
        required: true,
        description: 'Text rendering format.',
        values: ['ASCII', 'HTML', 'URI', 'UTF8'],
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'NotSupported', 'Rejected', 'UnknownTransaction'],
      },
    ],
    counterpart: null,
  }),

  m({
    action: 'CostUpdated',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'tariff_cost',
    core: false,
    milestone: 11,
    summary: 'Push the running cost to the station display',
    detail:
      'New in 2.0.1. You compute cost as meter values arrive and push it so the driver sees a ' +
      'live price on the charger itself. Prepaid charging without this feels broken.',
    whenItFires: 'Every meter value, or on a timer, during a transaction.',
    requestFields: [
      { name: 'totalCost', type: 'decimal', required: true, description: 'Running cost so far.' },
      { name: 'transactionId', type: 'string(36)', required: true, description: 'Which transaction.' },
    ],
    responseFields: [],
    counterpart: null,
  }),

  /* =========================== SECURITY ============================== */
  m({
    action: 'SecurityEventNotification',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'security',
    core: true,
    milestone: 13,
    summary: 'A security-relevant event occurred at the station',
    detail:
      'Firmware updates, failed authentications, tampered enclosures, certificate expiry. In 1.6 ' +
      'this existed only in the optional security whitepaper; in 2.0.1 it is core.',
    whenItFires:
      'Enclosure opened, reset, firmware changed, invalid credentials, certificate about to expire.',
    requestFields: [
      {
        name: 'type',
        type: 'string(50)',
        required: true,
        description: 'Event type from the specification list.',
        values: [
          'FirmwareUpdated',
          'FailedToAuthenticateAtCsms',
          'CsmsFailedToAuthenticate',
          'SettingSystemTime',
          'StartupOfTheDevice',
          'ResetOrReboot',
          'SecurityLogWasCleared',
          'ReconfigurationOfSecurityParameters',
          'MemoryExhaustion',
          'InvalidMessages',
          'AttemptedReplayAttacks',
          'TamperDetectionActivated',
          'InvalidFirmwareSignature',
          'InvalidCsmsCertificate',
        ],
        gotcha:
          'TamperDetectionActivated means someone physically opened the charger. Page a human. ' +
          'This is the message that turns your CPMS into something a security team cares about.',
      },
      { name: 'timestamp', type: 'dateTime', required: true, description: 'When it happened.' },
      { name: 'techInfo', type: 'string(255)', required: false, description: 'Extra detail.' },
    ],
    responseFields: [],
    counterpart: null,
  }),

  m({
    action: 'SignCertificate',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'security',
    core: false,
    milestone: 13,
    summary: 'Station asks you to sign its certificate request',
    detail:
      'The station generates a key pair and sends you a CSR; you (or your CA) sign it and return ' +
      'the certificate via CertificateSigned. This is how security profile 3 (mutual TLS) is ' +
      'bootstrapped and rotated without a site visit.',
    whenItFires: 'Initial provisioning and certificate renewal.',
    requestFields: [
      { name: 'csr', type: 'string(5500)', required: true, description: 'PEM-encoded CSR.' },
      {
        name: 'certificateType',
        type: 'enum',
        required: false,
        description: 'What the certificate is for.',
        values: ['ChargingStationCertificate', 'V2GCertificate'],
      },
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
    counterpart: null,
  }),

  m({
    action: 'CertificateSigned',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'security',
    core: false,
    milestone: 13,
    summary: 'Return the signed certificate to the station',
    detail: 'The answer to SignCertificate, sent as a separate CALL.',
    whenItFires: 'After your CA signs the CSR.',
    requestFields: [
      {
        name: 'certificateChain',
        type: 'string(10000)',
        required: true,
        description: 'PEM chain, leaf first.',
      },
      { name: 'certificateType', type: 'enum', required: false, description: 'Matching type.' },
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
    counterpart: null,
  }),

  /* ======================== SMART CHARGING =========================== */
  m({
    action: 'SetChargingProfile',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'smart_charging',
    core: false,
    milestone: 10,
    summary: 'Limit how much power an EVSE or transaction may draw',
    detail:
      'Same concept as 1.6 with more purposes and better ISO 15118 integration. Profiles are now ' +
      'addressed by evseId, and a new PriorityCharging purpose supports "charge this one fast".',
    whenItFires: 'Load management; prepaid caps; grid demand response.',
    requestFields: [
      { name: 'evseId', type: 'integer', required: true, description: '0 for a station-wide limit.' },
      {
        name: 'chargingProfile.chargingProfilePurpose',
        type: 'enum',
        required: true,
        description: 'Role of this profile.',
        values: [
          'ChargingStationExternalConstraints',
          'ChargingStationMaxProfile',
          'TxDefaultProfile',
          'TxProfile',
          'PriorityCharging',
        ],
      },
      {
        name: 'chargingProfile.chargingSchedule[]',
        type: 'ChargingSchedule[]',
        required: true,
        description: 'Now an ARRAY — several schedules in different units may be offered.',
        gotcha:
          'It is a list in 2.0.1 where 1.6 had a single object. Sending an object instead of an ' +
          'array is a very common porting bug and produces an unhelpful schema error.',
      },
      {
        name: 'chargingProfile.transactionId',
        type: 'string(36)',
        required: false,
        description: 'Required when purpose is TxProfile.',
      },
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
    counterpart: 'SetChargingProfile',
  }),

  m({
    action: 'NotifyEVChargingNeeds',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'iso15118',
    core: false,
    milestone: 10,
    summary: 'The car says what it wants',
    detail:
      'With ISO 15118 the vehicle negotiates: it reports target state of charge, departure time ' +
      'and energy needed. This has no 1.6 equivalent at all — it is the foundation of genuinely ' +
      'smart charging, because you can now optimise against a deadline instead of guessing.',
    whenItFires: 'When an ISO 15118 vehicle connects and completes its handshake.',
    requestFields: [
      { name: 'evseId', type: 'integer', required: true, description: 'Which EVSE.' },
      {
        name: 'chargingNeeds.requestedEnergyTransfer',
        type: 'enum',
        required: true,
        description: 'AC or DC, single or three phase, bidirectional.',
        values: ['AC_single_phase', 'AC_two_phase', 'AC_three_phase', 'DC'],
      },
      {
        name: 'chargingNeeds.departureTime',
        type: 'dateTime',
        required: false,
        description: 'When the driver wants to leave. The input smart charging was missing.',
      },
      {
        name: 'chargingNeeds.acChargingParameters',
        type: 'object',
        required: false,
        description: 'Energy amount, max voltage, max current, min current.',
      },
      {
        name: 'chargingNeeds.dcChargingParameters',
        type: 'object',
        required: false,
        description: 'Includes stateOfCharge and energyAmount — the battery telling you its state.',
      },
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
    counterpart: null,
  }),

  /* ========================= LOCAL AUTH LIST ========================= */
  m({
    action: 'SendLocalList',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'local_auth_list',
    core: false,
    milestone: 7,
    summary: 'Push the offline authorization list',
    detail: 'Same mechanism as 1.6, using typed IdToken objects.',
    whenItFires: 'Token changes; scheduled sync.',
    requestFields: [
      { name: 'versionNumber', type: 'integer', required: true, description: 'Resulting version.' },
      {
        name: 'updateType',
        type: 'enum',
        required: true,
        description: 'Full or incremental.',
        values: ['Differential', 'Full'],
      },
      {
        name: 'localAuthorizationList',
        type: 'AuthorizationData[]',
        required: false,
        description: 'Entries; omit idTokenInfo to delete one.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Failed', 'VersionMismatch'],
      },
    ],
    counterpart: 'SendLocalList',
  }),

  m({
    action: 'GetLocalListVersion',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'local_auth_list',
    core: false,
    milestone: 7,
    summary: 'Which list version does the station hold?',
    detail: 'Unchanged from 1.6.',
    whenItFires: 'Before syncing.',
    requestFields: [],
    responseFields: [
      { name: 'versionNumber', type: 'integer', required: true, description: 'Current version.' },
    ],
    counterpart: 'GetLocalListVersion',
  }),

  /* =========================== FIRMWARE ============================== */
  m({
    action: 'UpdateFirmware',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'firmware_management',
    core: false,
    milestone: 7,
    summary: 'Install new firmware, now with signature verification',
    detail:
      'The important addition over 1.6 is `signature` and `signingCertificate`: the station can ' +
      'verify the image is genuine before installing it. Unsigned firmware updates were a real ' +
      'attack path in 1.6 deployments.',
    whenItFires: 'Fleet rollout.',
    requestFields: [
      { name: 'requestId', type: 'integer', required: true, description: 'Correlates status reports.' },
      { name: 'firmware.location', type: 'string(512)', required: true, description: 'Download URL.' },
      {
        name: 'firmware.retrieveDateTime',
        type: 'dateTime',
        required: true,
        description: 'When to download.',
      },
      {
        name: 'firmware.signingCertificate',
        type: 'string(5500)',
        required: false,
        description: 'Certificate that signed the image.',
      },
      {
        name: 'firmware.signature',
        type: 'string(800)',
        required: false,
        description: 'Signature over the image.',
      },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'AcceptedCanceled', 'InvalidCertificate', 'RevokedCertificate'],
      },
    ],
    counterpart: 'UpdateFirmware',
  }),

  m({
    action: 'GetLog',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'diagnostics',
    core: false,
    milestone: 7,
    summary: 'Ask for a log bundle',
    detail:
      'Replaces GetDiagnostics, and adds a log TYPE so you can request the security log ' +
      'specifically rather than everything.',
    whenItFires: 'Fault investigation; security audit.',
    requestFields: [
      { name: 'requestId', type: 'integer', required: true, description: 'Correlates status reports.' },
      {
        name: 'logType',
        type: 'enum',
        required: true,
        description: 'Which log to collect.',
        values: ['DiagnosticsLog', 'SecurityLog'],
      },
      { name: 'log.remoteLocation', type: 'string(512)', required: true, description: 'Upload URL.' },
      { name: 'log.oldestTimestamp', type: 'dateTime', required: false, description: 'Range start.' },
      { name: 'log.latestTimestamp', type: 'dateTime', required: false, description: 'Range end.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'AcceptedCanceled'],
      },
      { name: 'filename', type: 'string(255)', required: false, description: 'Name of the upload.' },
    ],
    counterpart: 'GetDiagnostics',
  }),

  m({
    action: 'DataTransfer',
    protocol: 'ocpp2.0.1',
    origin: 'both',
    grouping: 'data_transfer',
    core: false,
    milestone: 7,
    summary: 'Vendor-specific escape hatch',
    detail: 'Unchanged in purpose from 1.6.',
    whenItFires: 'Vendor extensions.',
    requestFields: [
      { name: 'vendorId', type: 'string(255)', required: true, description: 'Vendor namespace.' },
      { name: 'messageId', type: 'string(50)', required: false, description: 'Vendor message type.' },
      { name: 'data', type: 'any', required: false, description: 'Now any JSON, not just a string.' },
    ],
    responseFields: [
      {
        name: 'status',
        type: 'enum',
        required: true,
        description: 'Result.',
        values: ['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId'],
      },
    ],
    counterpart: 'DataTransfer',
  }),

  m({
    action: 'ReserveNow',
    protocol: 'ocpp2.0.1',
    origin: 'csms_to_cp',
    grouping: 'reservation',
    core: false,
    milestone: 7,
    summary: 'Hold an EVSE for one driver',
    detail: 'Now optionally constrained to a connector type, so a CCS reservation stays CCS.',
    whenItFires: 'Driver reserves in the app.',
    requestFields: [
      { name: 'id', type: 'integer', required: true, description: 'Reservation id.' },
      { name: 'expiryDateTime', type: 'dateTime', required: true, description: 'When it lapses.' },
      { name: 'idToken', type: 'IdToken', required: true, description: 'Who it is for.' },
      { name: 'evseId', type: 'integer', required: false, description: 'Which EVSE.' },
      {
        name: 'connectorType',
        type: 'enum',
        required: false,
        description: 'Reserve a specific connector type.',
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
    action: 'ReservationStatusUpdate',
    protocol: 'ocpp2.0.1',
    origin: 'cp_to_csms',
    grouping: 'reservation',
    core: false,
    milestone: 7,
    summary: 'A reservation expired or was removed',
    detail:
      'New in 2.0.1. In 1.6 you had to guess when a reservation lapsed by watching the clock; ' +
      'now the station tells you, so you can release the hold and refund promptly.',
    whenItFires: 'Reservation expiry or cancellation at the station.',
    requestFields: [
      { name: 'reservationId', type: 'integer', required: true, description: 'Which reservation.' },
      {
        name: 'reservationUpdateStatus',
        type: 'enum',
        required: true,
        description: 'What happened.',
        values: ['Expired', 'Removed'],
      },
    ],
    responseFields: [],
    counterpart: null,
  }),
];
