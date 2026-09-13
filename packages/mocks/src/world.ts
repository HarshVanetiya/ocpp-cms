import type {
  ActivityItem,
  Command,
  Connector,
  Location,
  OcppExchange,
  OcppFrame,
  Protocol,
  ServerEvent,
  Session,
  SimFrame,
  Station,
  SystemLog,
} from '@ocpp/contracts';
import { toWireStatus16, toWireStatus201 } from '@ocpp/ocpp';
import { rng, type Rng } from './random';
import {
  SEED,
  buildLocations,
  buildStations,
  buildTariffs,
  buildTokens,
  buildUsers,
  type Fixtures,
} from './seed';
import { buildSessions } from './seed-sessions';
import { buildOcpi } from './seed-ocpi';
import { SIM_SCENARIOS, buildSimStations } from './seed-sim';

/**
 * The mock world.
 *
 * Not a static JSON blob: a small simulation that ticks. Sessions accumulate
 * energy, connectors change state, frames appear in the log, and the realtime
 * channel pushes it all out. That is what makes learn mode useful — you can
 * see what a live dashboard is supposed to feel like before you have written a
 * single line of backend.
 *
 * Everything is derived from one seed, so the fleet is identical on every
 * reload and a bug you see once you can see again.
 */

const MAX_LOG = 600;

class World {
  readonly rng: Rng = rng(SEED);
  fixtures!: Fixtures;

  /** Rolling OCPP exchange log, newest first. */
  ocppLog: OcppExchange[] = [];
  systemLog: SystemLog[] = [];
  activity: ActivityItem[] = [];
  commands: Command[] = [];
  simFrames: SimFrame[] = [];

  private listeners = new Set<(event: ServerEvent) => void>();
  private simListeners = new Set<(event: unknown) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private msgSeq = 0;

  constructor() {
    this.build();
  }

  /* ----------------------------- assembly ---------------------------- */

  build() {
    const r = this.rng;
    const now = Date.now();

    const locations = buildLocations(r, now);
    const stations = buildStations(r, locations, now);
    const { users, groups } = buildUsers(r, now);
    const tokens = buildTokens(r, users, now);
    const tariffs = buildTariffs(r, stations, now);
    const { sessions, cdrs, payments, authorizations } = buildSessions(r, {
      stations,
      locations,
      tokens,
      users,
      tariffs,
      now,
    });
    const ocpi = buildOcpi(r, { cdrs, now });

    // Roll station counts up into their locations.
    for (const loc of locations) {
      const own = stations.filter((s) => s.locationId === loc.id);
      const connectors = own.flatMap((s) => s.evses.flatMap((e) => e.connectors));
      loc.stationCount = own.length;
      loc.connectorCount = connectors.length;
      loc.availableConnectorCount = connectors.filter((c) => c.status === 'available').length;
      loc.chargingConnectorCount = connectors.filter((c) => c.status === 'charging').length;
      loc.faultedConnectorCount = connectors.filter((c) => c.status === 'faulted').length;
      loc.maxPowerKw = connectors.reduce((m, c) => Math.max(m, c.maxPowerKw), 0);
    }

    this.fixtures = {
      locations,
      stations,
      users,
      groups,
      tokens,
      tariffs,
      sessions,
      cdrs,
      payments,
      authorizations,
      ocpiParties: ocpi.parties,
      ocpiTokens: ocpi.tokens,
      ocpiCdrs: ocpi.ocpiCdrs,
      ocpiLogs: ocpi.logs,
      simStations: buildSimStations(r, now),
      simScenarios: SIM_SCENARIOS,
    };

    this.seedLogs(now);
  }

  /* ------------------------------ logging ---------------------------- */

  private nextMessageId() {
    this.msgSeq += 1;
    return `${this.msgSeq.toString(16).padStart(4, '0')}-${this.rng.uuid().slice(0, 4)}`;
  }

  private frame(
    partial: Pick<OcppFrame, 'stationId' | 'stationIdentity' | 'protocol' | 'direction'> & {
      messageId: string;
      messageTypeId: OcppFrame['messageTypeId'];
      action: string | null;
      payload: unknown;
      timestamp?: string;
      sessionId?: string | null;
      valid?: boolean | null;
      validationErrors?: string[] | null;
      errorCode?: OcppFrame['errorCode'];
      errorDescription?: string | null;
    },
  ): OcppFrame {
    const arr =
      partial.messageTypeId === 2
        ? [2, partial.messageId, partial.action, partial.payload]
        : partial.messageTypeId === 3
          ? [3, partial.messageId, partial.payload]
          : [4, partial.messageId, partial.errorCode, partial.errorDescription, partial.payload];
    return {
      id: this.rng.uuid(),
      timestamp: partial.timestamp ?? new Date().toISOString(),
      stationId: partial.stationId,
      stationIdentity: partial.stationIdentity,
      protocol: partial.protocol,
      direction: partial.direction,
      messageTypeId: partial.messageTypeId,
      messageId: partial.messageId,
      action: partial.action,
      payload: partial.payload,
      raw: JSON.stringify(arr),
      errorCode: partial.errorCode ?? null,
      errorDescription: partial.errorDescription ?? null,
      sessionId: partial.sessionId ?? null,
      valid: partial.valid ?? true,
      validationErrors: partial.validationErrors ?? null,
    };
  }

  /**
   * Record a request/response pair as one exchange.
   *
   * The wire has two frames; the UI wants one row. Stitching happens here,
   * exactly as the docs describe doing it in your own backend.
   */
  pushExchange(input: {
    station: Station;
    direction: 'inbound' | 'outbound';
    action: string;
    request: unknown;
    response?: unknown;
    sessionId?: string | null;
    outcome?: OcppExchange['outcome'];
    durationMs?: number | null;
    invalid?: { errors: string[] };
    timestamp?: string;
  }): OcppExchange {
    const messageId = this.nextMessageId();
    const ts = input.timestamp ?? new Date().toISOString();
    const base = {
      stationId: input.station.id,
      stationIdentity: input.station.identity,
      protocol: input.station.protocol,
    };

    const request = this.frame({
      ...base,
      direction: input.direction,
      messageId,
      messageTypeId: 2,
      action: input.action,
      payload: input.request,
      timestamp: ts,
      sessionId: input.sessionId ?? null,
      valid: input.invalid ? false : true,
      validationErrors: input.invalid?.errors ?? null,
    });

    const durationMs = input.durationMs ?? this.rng.int(4, 140);
    const outcome = input.outcome ?? (input.invalid ? 'error' : 'ok');

    const response =
      outcome === 'pending'
        ? null
        : this.frame({
            ...base,
            direction: input.direction === 'inbound' ? 'outbound' : 'inbound',
            messageId,
            messageTypeId: outcome === 'error' ? 4 : 3,
            action: null,
            payload: outcome === 'error' ? {} : (input.response ?? {}),
            timestamp: new Date(new Date(ts).getTime() + durationMs).toISOString(),
            sessionId: input.sessionId ?? null,
            errorCode: outcome === 'error' ? 'FormationViolation' : null,
            errorDescription: outcome === 'error' ? (input.invalid?.errors[0] ?? 'Schema violation') : null,
          });

    const exchange: OcppExchange = {
      id: this.rng.uuid(),
      messageId,
      timestamp: ts,
      stationId: input.station.id,
      stationIdentity: input.station.identity,
      protocol: input.station.protocol,
      direction: input.direction,
      action: input.action,
      request,
      response,
      durationMs: outcome === 'pending' ? null : durationMs,
      outcome,
      sessionId: input.sessionId ?? null,
    };

    this.ocppLog.unshift(exchange);
    // Bounded: an unbounded array in a long-lived tab is a memory leak that
    // eventually freezes the browser. Your backend needs the same discipline,
    // just with a retention policy instead of a slice.
    if (this.ocppLog.length > MAX_LOG) this.ocppLog.length = MAX_LOG;

    this.emit({ type: 'ocpp.message', at: ts, data: exchange });
    return exchange;
  }

  pushSystemLog(entry: Omit<SystemLog, 'id' | 'timestamp'> & { timestamp?: string }) {
    const log: SystemLog = {
      id: this.rng.uuid(),
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...entry,
    };
    this.systemLog.unshift(log);
    if (this.systemLog.length > MAX_LOG) this.systemLog.length = MAX_LOG;
    this.emit({ type: 'system.log', at: log.timestamp, data: log });
    return log;
  }

  pushActivity(item: Omit<ActivityItem, 'id' | 'timestamp'> & { timestamp?: string }) {
    const entry: ActivityItem = {
      id: this.rng.uuid(),
      timestamp: item.timestamp ?? new Date().toISOString(),
      ...item,
    };
    this.activity.unshift(entry);
    if (this.activity.length > 120) this.activity.length = 120;
    this.emit({ type: 'activity', at: entry.timestamp, data: entry });
    return entry;
  }

  /** Seeds a plausible backlog so the log screen is not empty on first load. */
  private seedLogs(now: number) {
    const r = this.rng;
    const online = this.fixtures.stations.filter((s) => s.status === 'online');

    for (let i = 120; i >= 0; i -= 1) {
      const station = r.pick(online);
      if (!station) break;
      const ts = new Date(now - i * r.int(1500, 9000)).toISOString();
      const action = r.weighted(
        station.protocol === 'ocpp1.6'
          ? ([
              ['Heartbeat', 9],
              ['StatusNotification', 5],
              ['MeterValues', 6],
              ['Authorize', 2],
              ['StartTransaction', 1],
              ['StopTransaction', 1],
              ['BootNotification', 1],
            ] as const)
          : ([
              ['Heartbeat', 9],
              ['StatusNotification', 4],
              ['TransactionEvent', 8],
              ['Authorize', 2],
              ['NotifyEvent', 1],
              ['BootNotification', 1],
            ] as const),
      );
      this.pushExchange({
        station,
        direction: 'inbound',
        action,
        request: this.samplePayload(station, action),
        response: this.sampleResponse(station, action),
        timestamp: ts,
        // One malformed frame in the backlog, so the inspector's error state
        // is visible without waiting for one to occur.
        invalid: i === 37 ? { errors: ['connectorId: expected integer, received string'] } : undefined,
      });
    }

    // Seed the simulator's own wire log too, so its pane is not empty on first
    // open while waiting for the first tick.
    for (const sim of this.fixtures.simStations.filter((x) => x.connectionState === 'connected')) {
      for (let i = 6; i >= 0; i -= 1) {
        const action = r.weighted([
          ['Heartbeat', 4],
          ['StatusNotification', 3],
          ['MeterValues', 3],
          ['BootNotification', 1],
        ] as const);
        const messageId = this.nextMessageId();
        const payload = { evseId: 1 };
        this.simFrames.push({
          id: r.uuid(),
          timestamp: new Date(now - i * r.int(4000, 20_000)).toISOString(),
          stationId: sim.id,
          stationIdentity: sim.identity,
          protocol: sim.protocol,
          direction: 'outbound',
          messageTypeId: 2,
          messageId,
          action,
          payload,
          raw: JSON.stringify([2, messageId, action, payload]),
          errorCode: null,
          errorDescription: null,
          durationMs: r.int(4, 90),
        });
      }
    }
    this.simFrames.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    this.pushSystemLog({
      level: 'info',
      source: 'gateway',
      message: 'Mock backend ready — every response below is generated in your browser.',
      stationId: null,
      sessionId: null,
      userId: null,
      correlationId: null,
      context: null,
    });
  }

  samplePayload(station: Station, action: string): unknown {
    const r = this.rng;
    const evse = r.pick(station.evses);
    const connector = r.pick(evse.connectors);
    const now = new Date().toISOString();

    switch (action) {
      case 'Heartbeat':
        return {};
      case 'BootNotification':
        return station.protocol === 'ocpp1.6'
          ? {
              chargePointVendor: station.vendor,
              chargePointModel: station.model,
              chargePointSerialNumber: station.serialNumber,
              firmwareVersion: station.firmwareVersion,
            }
          : {
              chargingStation: {
                model: station.model,
                vendorName: station.vendor,
                serialNumber: station.serialNumber,
                firmwareVersion: station.firmwareVersion,
              },
              reason: 'PowerUp',
            };
      case 'StatusNotification':
        return station.protocol === 'ocpp1.6'
          ? {
              connectorId: connector.connectorId,
              errorCode: connector.status === 'faulted' ? 'GroundFailure' : 'NoError',
              status: toWireStatus16(connector.status),
              timestamp: now,
            }
          : {
              timestamp: now,
              connectorStatus: toWireStatus201(connector.status).connectorStatus,
              evseId: evse.evseId,
              connectorId: connector.connectorId,
            };
      case 'Authorize':
        return station.protocol === 'ocpp1.6'
          ? { idTag: r.pick(this.fixtures.tokens).value.slice(0, 20) }
          : { idToken: { idToken: r.pick(this.fixtures.tokens).value, type: 'ISO14443' } };
      case 'StartTransaction':
        return {
          connectorId: connector.connectorId,
          idTag: r.pick(this.fixtures.tokens).value.slice(0, 20),
          meterStart: r.int(1_000_000, 9_000_000),
          timestamp: now,
        };
      case 'StopTransaction':
        return {
          transactionId: r.int(48000, 48999),
          meterStop: r.int(1_000_000, 9_000_000),
          timestamp: now,
          reason: 'EVDisconnected',
        };
      case 'MeterValues':
        return {
          connectorId: connector.connectorId,
          transactionId: r.int(48000, 48999),
          meterValue: [
            {
              timestamp: now,
              sampledValue: [
                {
                  value: String(r.int(1_000_000, 9_000_000)),
                  measurand: 'Energy.Active.Import.Register',
                  unit: 'Wh',
                  context: 'Sample.Periodic',
                },
                { value: r.float(3, 22, 1).toFixed(1), measurand: 'Power.Active.Import', unit: 'kW' },
                { value: String(r.int(20, 95)), measurand: 'SoC', unit: 'Percent' },
              ],
            },
          ],
        };
      case 'TransactionEvent':
        return {
          eventType: r.pick(['Started', 'Updated', 'Ended'] as const),
          timestamp: now,
          triggerReason: r.pick(['MeterValuePeriodic', 'ChargingStateChanged', 'CablePluggedIn'] as const),
          seqNo: r.int(0, 400),
          transactionInfo: {
            transactionId: `${station.identity.toLowerCase()}-${r.uuid().slice(0, 8)}`,
            chargingState: 'Charging',
          },
          evse: { id: evse.evseId, connectorId: connector.connectorId },
        };
      case 'NotifyEvent':
        return {
          generatedAt: now,
          seqNo: 0,
          eventData: [
            {
              eventId: r.int(1, 9999),
              timestamp: now,
              trigger: 'Alerting',
              actualValue: 'GroundFailure',
              eventNotificationType: 'HardWiredNotification',
              component: { name: 'Connector', evse: { id: evse.evseId } },
              variable: { name: 'Problem' },
              cleared: false,
            },
          ],
        };
      default:
        return {};
    }
  }

  sampleResponse(station: Station, action: string): unknown {
    const now = new Date().toISOString();
    switch (action) {
      case 'Heartbeat':
        return { currentTime: now };
      case 'BootNotification':
        return { status: 'Accepted', currentTime: now, interval: station.heartbeatIntervalSeconds };
      case 'Authorize':
        return station.protocol === 'ocpp1.6'
          ? { idTagInfo: { status: 'Accepted' } }
          : { idTokenInfo: { status: 'Accepted' } };
      case 'StartTransaction':
        return { transactionId: this.rng.int(48000, 48999), idTagInfo: { status: 'Accepted' } };
      case 'TransactionEvent':
        return { totalCost: this.rng.float(0.5, 28, 2) };
      default:
        return {};
    }
  }

  /* ------------------------------ realtime --------------------------- */

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSim(listener: (event: unknown) => void): () => void {
    this.simListeners.add(listener);
    return () => {
      this.simListeners.delete(listener);
    };
  }

  emit(event: ServerEvent) {
    this.listeners.forEach((l) => l(event));
  }

  emitSim(event: unknown) {
    this.simListeners.forEach((l) => l(event));
  }

  /* -------------------------------- tick ----------------------------- */

  start(intervalMs = 2000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const r = this.rng;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // --- advance live sessions ---
    const active = this.fixtures.sessions.filter((s) => s.status === 'active');
    for (const session of active) {
      const station = this.fixtures.stations.find((s) => s.id === session.stationId);
      if (!station) continue;

      const kw = session.currentPowerKw ?? 11;
      const deltaWh = Math.round((kw * 2000) / 3600);
      session.energyDeliveredWh += deltaWh;
      session.durationSeconds += 2;
      session.updatedAt = nowIso;
      if (session.currentSoc !== null && r.bool(0.12)) {
        session.currentSoc = Math.min(100, session.currentSoc + 1);
      }
      // Recompute cost from the running energy rather than nudging it, so the
      // number on screen always matches the tariff.
      const tariff = this.fixtures.tariffs.find((t) => t.id === session.tariffId);
      const energyPrice =
        tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'energy')?.priceMinor ?? 45;
      const flat = tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'flat')?.priceMinor ?? 0;
      session.costMinor = flat + Math.round((session.energyDeliveredWh / 1000) * energyPrice);

      this.emit({
        type: 'session.updated',
        at: nowIso,
        data: {
          sessionId: session.id,
          stationId: session.stationId,
          stationIdentity: session.stationIdentity,
          evseId: session.evseId,
          connectorId: session.connectorId,
          status: session.status,
          energyDeliveredWh: session.energyDeliveredWh,
          currentPowerKw: session.currentPowerKw,
          currentSoc: session.currentSoc,
          costMinor: session.costMinor,
          currency: session.currency,
          durationSeconds: session.durationSeconds,
          userName: session.idToken.userName,
        },
      });

      this.emit({
        type: 'meter.value',
        at: nowIso,
        data: {
          sessionId: session.id,
          timestamp: nowIso,
          energyWh: (session.meterStartWh ?? 0) + session.energyDeliveredWh,
          powerKw: session.currentPowerKw,
          currentA: session.currentPowerKw ? Number(((session.currentPowerKw * 1000) / 400).toFixed(1)) : null,
          voltageV: 400,
          soc: session.currentSoc,
          temperatureC: null,
        },
      });

      // A meter sample on the wire, roughly every 10s per session.
      if (r.bool(0.2)) {
        this.pushExchange({
          station,
          direction: 'inbound',
          action: station.protocol === 'ocpp1.6' ? 'MeterValues' : 'TransactionEvent',
          request: this.samplePayload(station, station.protocol === 'ocpp1.6' ? 'MeterValues' : 'TransactionEvent'),
          response: {},
          sessionId: session.id,
        });
      }
    }

    // --- occasional heartbeat from a random station ---
    const online = this.fixtures.stations.filter((s) => s.status === 'online');
    if (online.length > 0 && r.bool(0.7)) {
      const station = r.pick(online);
      station.lastHeartbeatAt = nowIso;
      this.pushExchange({
        station,
        direction: 'inbound',
        action: 'Heartbeat',
        request: {},
        response: { currentTime: nowIso },
      });
    }

    // --- occasional connector state change ---
    if (online.length > 0 && r.bool(0.16)) {
      const station = r.pick(online);
      const evse = r.pick(station.evses);
      const connector = r.pick(evse.connectors);
      const next = this.nextStatus(connector, r);
      if (next !== connector.status) {
        connector.status = next;
        connector.statusUpdatedAt = nowIso;
        if (station.protocol === 'ocpp1.6') {
          connector.errorCode = next === 'faulted' ? 'GroundFailure' : 'NoError';
        }

        this.pushExchange({
          station,
          direction: 'inbound',
          action: 'StatusNotification',
          request: this.samplePayload(station, 'StatusNotification'),
          response: {},
        });

        this.emit({
          type: 'connector.status',
          at: nowIso,
          data: {
            stationId: station.id,
            stationIdentity: station.identity,
            evseId: evse.evseId,
            connectorId: connector.connectorId,
            status: next,
            errorCode: connector.errorCode ?? null,
          },
        });

        if (next === 'faulted') {
          this.pushActivity({
            kind: 'station_faulted',
            title: 'Connector faulted',
            description: `${station.identity} EVSE ${evse.evseId} reported GroundFailure`,
            stationId: station.id,
            stationName: station.name,
            sessionId: null,
            severity: 'danger',
          });
        }
      }
    }

    // --- the simulator's own wire log ---
    const simConnected = this.fixtures.simStations.filter((s) => s.connectionState === 'connected');
    if (simConnected.length > 0 && r.bool(0.6)) {
      const sim = r.pick(simConnected);
      const action = r.weighted([
        ['MeterValues', 5],
        ['Heartbeat', 3],
        ['StatusNotification', 2],
      ] as const);
      const messageId = this.nextMessageId();
      const frame: SimFrame = {
        id: r.uuid(),
        timestamp: nowIso,
        stationId: sim.id,
        stationIdentity: sim.identity,
        protocol: sim.protocol as Protocol,
        direction: 'outbound',
        messageTypeId: 2,
        messageId,
        action,
        payload: {},
        raw: JSON.stringify([2, messageId, action, {}]),
        errorCode: null,
        errorDescription: null,
        durationMs: r.int(4, 60),
      };
      sim.messagesSent += 1;
      this.simFrames.unshift(frame);
      if (this.simFrames.length > 300) this.simFrames.length = 300;
      this.emitSim({ type: 'sim.frame', at: nowIso, data: frame });
    }
  }

  private nextStatus(connector: Connector, r: Rng): Connector['status'] {
    switch (connector.status) {
      case 'available':
        return r.weighted([
          ['available', 6],
          ['preparing', 3],
          ['reserved', 1],
        ] as const);
      case 'preparing':
        return r.weighted([
          ['charging', 7],
          ['available', 2],
          ['faulted', 1],
        ] as const);
      case 'charging':
        return r.weighted([
          ['charging', 12],
          ['suspended_ev', 2],
          ['finishing', 2],
        ] as const);
      case 'suspended_ev':
        return r.weighted([
          ['charging', 4],
          ['suspended_ev', 5],
          ['finishing', 2],
        ] as const);
      case 'finishing':
        return r.weighted([
          ['available', 8],
          ['finishing', 2],
        ] as const);
      case 'faulted':
        return r.weighted([
          ['faulted', 8],
          ['available', 2],
        ] as const);
      default:
        return connector.status;
    }
  }

  /* ------------------------------ helpers ---------------------------- */

  stationById(id: string) {
    return this.fixtures.stations.find((s) => s.id === id || s.identity === id) ?? null;
  }

  locationById(id: string) {
    return this.fixtures.locations.find((l) => l.id === id) ?? null;
  }

  /** Flattened connector list with their station and location, for lookups. */
  allConnectors(): Array<{ station: Station; location: Location | null; connector: Connector; evseId: number }> {
    return this.fixtures.stations.flatMap((station) =>
      station.evses.flatMap((evse) =>
        evse.connectors.map((connector) => ({
          station,
          location: station.locationId ? this.locationById(station.locationId) : null,
          connector,
          evseId: evse.evseId,
        })),
      ),
    );
  }

  sessionById(id: string): Session | null {
    return this.fixtures.sessions.find((s) => s.id === id) ?? null;
  }
}

/** One world per page load. */
export const world = new World();
