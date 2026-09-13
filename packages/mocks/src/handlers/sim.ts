import type { SimRun, SimStation } from '@ocpp/contracts';
import { world } from '../world';
import { cursorPage, mock, mockError, paginate } from './resolver';

/**
 * Simulator endpoints.
 *
 * The simulator's mock is thinner than the CPMS's on purpose: a simulator is
 * mostly state plus a WebSocket, and the interesting part is the behaviour, not
 * the CRUD. Enough is faked here for every screen to work.
 */

const r = world.rng;
const runs: SimRun[] = [];

function findSim(id: string): SimStation | undefined {
  return world.fixtures.simStations.find((s) => s.id === id || s.identity === id);
}

export const simHandlers = [
  mock('simHealth', () => ({
    status: 'ok' as const,
    version: 'mock-1.0.0',
    stationCount: world.fixtures.simStations.length,
    connectedCount: world.fixtures.simStations.filter((s) => s.connectionState === 'connected').length,
    defaultCsmsUrl: 'ws://localhost:3000/ocpp',
  })),

  mock('listSimStations', ({ url }) => paginate(world.fixtures.simStations, url)),

  mock('getSimStation', ({ params }) => {
    const sim = findSim(String(params.id));
    if (!sim) return mockError('NOT_FOUND', 'No simulated station with that id', 404);
    return sim;
  }),

  mock('createSimStation', ({ body }) => {
    const input = body as Record<string, unknown>;
    const count = Math.max(1, Number(input.count ?? 1));
    const created: SimStation[] = [];
    const now = Date.now();

    for (let i = 0; i < count; i += 1) {
      const identity =
        count === 1
          ? String(input.identity)
          : `${String(input.identity)}-${String(i + 1).padStart(3, '0')}`;
      if (world.fixtures.simStations.some((s) => s.identity === identity)) {
        return mockError('CONFLICT', `${identity} already exists`, 409);
      }
      const connectorCount = Number(input.connectorCount ?? 2);
      const station: SimStation = {
        id: r.uuid(),
        identity,
        name: String(input.name ?? identity),
        protocol: (input.protocol as SimStation['protocol']) ?? 'ocpp1.6',
        csmsUrl: String(input.csmsUrl ?? 'ws://localhost:3000/ocpp'),
        connectionState: 'disconnected',
        vendor: String(input.vendor ?? 'SimuVolt'),
        model: String(input.model ?? 'SV-22AC'),
        serialNumber: String(input.serialNumber ?? `SV-${r.int(100000, 999999)}`),
        firmwareVersion: String(input.firmwareVersion ?? '1.4.2'),
        connectors: Array.from({ length: connectorCount }, (_, c) => ({
          connectorId: 1,
          evseId: c + 1,
          type: (input.connectorType as never) ?? 'iec_62196_t2',
          powerType: (input.powerType as never) ?? 'ac_3_phase',
          maxPowerKw: Number(input.maxPowerKw ?? 22),
          status: 'unavailable' as const,
          cablePluggedIn: false,
          transactionId: null,
          meterWh: r.int(0, 500_000),
          powerKw: 0,
          soc: null,
        })),
        autoHeartbeat: input.autoHeartbeat !== false,
        heartbeatIntervalSeconds: Number(input.heartbeatIntervalSeconds ?? 60),
        autoMeterValues: input.autoMeterValues !== false,
        meterValueIntervalSeconds: Number(input.meterValueIntervalSeconds ?? 10),
        chargingPowerKw: Number(input.chargingPowerKw ?? 11),
        defaultIdToken: String(input.defaultIdToken ?? 'DEADBEEF'),
        faults: {
          dropConnection: false,
          ignoreRemoteCommands: false,
          respondWithErrors: false,
          sendInvalidPayloads: false,
          responseDelayMs: 0,
          reportFaulted: false,
        },
        coordinates: null,
        lastError: null,
        connectedAt: null,
        messagesSent: 0,
        messagesReceived: 0,
        createdAt: new Date(now).toISOString(),
      };
      world.fixtures.simStations.push(station);
      created.push(station);
      world.emitSim({ type: 'sim.station', at: station.createdAt, data: station });
    }

    return { data: created };
  }),

  mock('updateSimStation', ({ params, body }) => {
    const sim = findSim(String(params.id));
    if (!sim) return mockError('NOT_FOUND', 'No simulated station with that id', 404);
    const input = body as Record<string, unknown>;
    const { faults, ...rest } = input;
    Object.assign(sim, rest);
    if (faults) Object.assign(sim.faults, faults as object);
    world.emitSim({ type: 'sim.station', at: new Date().toISOString(), data: sim });
    return sim;
  }),

  mock('deleteSimStation', ({ params }) => {
    const idx = world.fixtures.simStations.findIndex((s) => s.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No simulated station with that id', 404);
    const [removed] = world.fixtures.simStations.splice(idx, 1);
    world.emitSim({ type: 'sim.station.removed', at: new Date().toISOString(), data: { id: removed.id } });
    return { success: true };
  }),

  /**
   * Actions.
   *
   * Each one models a PHYSICAL event where a physical event exists, and its
   * consequences follow automatically — plug in a cable and the status changes,
   * which is exactly how real hardware behaves.
   */
  mock('simAction', ({ params, body }) => {
    const sim = findSim(String(params.id));
    if (!sim) return mockError('NOT_FOUND', 'No simulated station with that id', 404);
    const input = body as { action: string; evseId?: number; connectorId?: number };
    const nowIso = new Date().toISOString();
    const connector =
      sim.connectors.find((c) => c.evseId === (input.evseId ?? 1)) ?? sim.connectors[0];

    let message = '';
    let messageId: string | null = null;

    switch (input.action) {
      case 'connect':
        sim.connectionState = 'connected';
        sim.connectedAt = nowIso;
        sim.lastError = null;
        sim.connectors.forEach((c) => {
          if (c.status === 'unavailable') c.status = 'available';
        });
        message = `Connected to ${sim.csmsUrl}/${sim.identity}`;
        break;

      case 'disconnect':
        sim.connectionState = 'disconnected';
        sim.connectedAt = null;
        sim.connectors.forEach((c) => {
          c.status = 'unavailable';
        });
        message = 'WebSocket closed without a close frame';
        break;

      case 'plug_in':
        if (connector) {
          connector.cablePluggedIn = true;
          connector.status = 'preparing';
        }
        message = `Cable plugged into EVSE ${connector?.evseId}`;
        break;

      case 'plug_out':
        if (connector) {
          connector.cablePluggedIn = false;
          connector.status = 'available';
          connector.transactionId = null;
          connector.powerKw = 0;
        }
        message = `Cable removed from EVSE ${connector?.evseId}`;
        break;

      case 'swipe_card':
      case 'send_authorize':
        message = `Authorize sent for ${sim.defaultIdToken}`;
        messageId = r.uuid().slice(0, 8);
        break;

      case 'start_charging':
        if (connector) {
          connector.status = 'charging';
          connector.powerKw = sim.chargingPowerKw;
          connector.transactionId = String(r.int(49000, 49999));
          connector.soc = 35;
        }
        message = `Transaction ${connector?.transactionId} started`;
        messageId = r.uuid().slice(0, 8);
        break;

      case 'stop_charging':
        if (connector) {
          connector.status = 'finishing';
          connector.powerKw = 0;
          connector.transactionId = null;
        }
        message = 'Transaction stopped';
        messageId = r.uuid().slice(0, 8);
        break;

      case 'suspend_ev':
        if (connector) {
          connector.status = 'suspended_ev';
          connector.powerKw = 0;
        }
        message = 'Vehicle paused charging (battery full or scheduled)';
        break;

      case 'resume':
        if (connector) {
          connector.status = 'charging';
          connector.powerKw = sim.chargingPowerKw;
        }
        message = 'Charging resumed';
        break;

      case 'trigger_fault':
        if (connector) connector.status = 'faulted';
        sim.lastError = 'Injected fault: GroundFailure';
        message = 'Reported GroundFailure';
        break;

      case 'clear_fault':
        if (connector) connector.status = 'available';
        sim.lastError = null;
        message = 'Fault cleared';
        break;

      case 'reboot':
        sim.connectionState = 'connecting';
        sim.connectors.forEach((c) => {
          c.status = 'unavailable';
          c.transactionId = null;
          c.powerKw = 0;
        });
        message = 'Rebooting — BootNotification will follow';
        setTimeout(() => {
          sim.connectionState = 'connected';
          sim.connectors.forEach((c) => {
            c.status = 'available';
          });
          world.emitSim({ type: 'sim.station', at: new Date().toISOString(), data: sim });
        }, 2500);
        break;

      default:
        message = `Sent ${input.action}`;
        messageId = r.uuid().slice(0, 8);
    }

    sim.messagesSent += 1;

    const frame = {
      id: r.uuid(),
      timestamp: nowIso,
      stationId: sim.id,
      stationIdentity: sim.identity,
      protocol: sim.protocol,
      direction: 'outbound' as const,
      messageTypeId: 2 as const,
      messageId: messageId ?? r.uuid().slice(0, 8),
      action: input.action,
      payload: input,
      raw: JSON.stringify([2, messageId ?? '0000', input.action, input]),
      errorCode: null,
      errorDescription: null,
      durationMs: r.int(4, 90),
    };
    world.simFrames.unshift(frame);
    if (world.simFrames.length > 300) world.simFrames.length = 300;

    world.emitSim({ type: 'sim.frame', at: nowIso, data: frame });
    world.emitSim({ type: 'sim.station', at: nowIso, data: sim });

    return { accepted: true, message, messageId, station: sim };
  }),

  mock('simFrames', ({ url }) => {
    const stationId = url.searchParams.get('stationId');
    const direction = url.searchParams.get('direction');
    const action = url.searchParams.get('action');
    const rows = world.simFrames.filter((f) => {
      if (stationId && f.stationId !== stationId) return false;
      if (direction && f.direction !== direction) return false;
      if (action && f.action !== action) return false;
      return true;
    });
    return cursorPage(rows, url);
  }),

  mock('listScenarios', () => ({ data: world.fixtures.simScenarios })),

  mock('runScenario', ({ body }) => {
    const input = body as { scenarioId: string; stationId: string; speed?: number };
    const scenario = world.fixtures.simScenarios.find((s) => s.id === input.scenarioId);
    if (!scenario) return mockError('NOT_FOUND', 'No scenario with that id', 404);
    const sim = findSim(input.stationId);
    if (!sim) return mockError('NOT_FOUND', 'No simulated station with that id', 404);

    const run: SimRun = {
      id: r.uuid(),
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      stationId: sim.id,
      stationIdentity: sim.identity,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: scenario.steps.map((s) => ({
        stepId: s.id,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        messageId: null,
        request: null,
        response: null,
        assertion: null,
        error: null,
      })),
    };
    runs.unshift(run);

    // Walk the steps on a timer so the runner UI actually animates.
    const speed = input.speed ?? 1;
    let cursor = 0;
    const advance = () => {
      if (cursor >= run.steps.length) {
        run.status = run.steps.some((s) => s.status === 'failed') ? 'failed' : 'passed';
        run.finishedAt = new Date().toISOString();
        world.emitSim({ type: 'sim.run', at: run.finishedAt, data: run });
        return;
      }
      const step = run.steps[cursor];
      const def = scenario.steps[cursor];
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      world.emitSim({ type: 'sim.run', at: step.startedAt, data: run });

      setTimeout(
        () => {
          step.status = 'passed';
          step.finishedAt = new Date().toISOString();
          step.messageId = r.uuid().slice(0, 8);
          step.request = def.payload ?? {};
          step.response = { status: 'Accepted' };
          if (def.expect) {
            step.assertion = {
              passed: true,
              expected: `${def.expect.field} = ${def.expect.equals ?? 'present'}`,
              actual: String(def.expect.equals ?? 'present'),
            };
          }
          world.emitSim({ type: 'sim.run', at: step.finishedAt, data: run });
          cursor += 1;
          advance();
        },
        Math.max(200, (def.delayMsBefore || 600) / speed),
      );
    };
    advance();

    return run;
  }),

  mock('getRun', ({ params }) => {
    const run = runs.find((x) => x.id === String(params.id));
    if (!run) return mockError('NOT_FOUND', 'No run with that id', 404);
    return run;
  }),

  mock('listRuns', ({ url }) => paginate(runs, url)),

  mock('abortRun', ({ params }) => {
    const run = runs.find((x) => x.id === String(params.id));
    if (!run) return mockError('NOT_FOUND', 'No run with that id', 404);
    run.status = 'aborted';
    run.finishedAt = new Date().toISOString();
    run.steps.forEach((s) => {
      if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
    });
    return { success: true };
  }),
];
