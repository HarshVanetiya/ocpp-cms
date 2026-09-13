import type {
  ActivityItem,
  Command,
  Connector,
  DriverConnector,
  DriverSession,
  NearbyLocation,
  Payment,
  Receipt,
  Session,
  Station,
  StationSummary,
  User,
} from '@ocpp/contracts';
import { CONNECTOR_STATUS_LABEL, CONNECTOR_TYPE_LABEL } from '@ocpp/contracts';
import { world } from '../world';
import { priceSession } from '../seed-sessions';
import {
  cursorPage,
  matchesSearch,
  mock,
  mockError,
  paginate,
  readPage,
} from './resolver';
import { dashboardStats, distanceMetres, timeSeries, topStations } from './stats';

/**
 * Mock implementations of every core endpoint.
 *
 * Each one is a miniature, readable version of what your backend must do — the
 * filtering, the shaping, the pagination. When you get stuck implementing a
 * route, the handler for it here is a working reference you can read in thirty
 * seconds.
 */

const r = world.rng;

/* ------------------------------------------------------------------ *
 * Shaping helpers
 * ------------------------------------------------------------------ */

function toSummary(station: Station): StationSummary {
  const connectors = station.evses.flatMap((e) => e.connectors);
  const location = station.locationId ? world.locationById(station.locationId) : null;
  return {
    id: station.id,
    identity: station.identity,
    name: station.name,
    protocol: station.protocol,
    status: station.status,
    vendor: station.vendor,
    model: station.model,
    coordinates: station.coordinates,
    locationId: station.locationId,
    locationName: location?.name ?? null,
    connectorCount: connectors.length,
    availableConnectorCount: connectors.filter((c) => c.status === 'available').length,
    chargingConnectorCount: connectors.filter((c) => c.status === 'charging').length,
    faultedConnectorCount: connectors.filter((c) => c.status === 'faulted').length,
    maxPowerKw: station.maxPowerKw,
    lastHeartbeatAt: station.lastHeartbeatAt,
    activeSessionCount: world.fixtures.sessions.filter(
      (s) => s.stationId === station.id && s.status === 'active',
    ).length,
    tags: station.tags,
  };
}

function currentUser(): User {
  return (
    world.fixtures.users.find((u) => u.role === 'admin') ?? world.fixtures.users[0]
  );
}

function driverUser(): User {
  return (
    world.fixtures.users.find((u) => u.role === 'driver' && u.status === 'active') ??
    world.fixtures.users[0]
  );
}

function toDriverSession(session: Session): DriverSession {
  const station = world.stationById(session.stationId);
  const connector = station?.evses
    .find((e) => e.evseId === session.evseId)
    ?.connectors.find((c) => c.connectorId === session.connectorId);
  const authorized = session.authorizedAmountMinor ?? Math.max(2500, session.costMinor);

  return {
    id: session.id,
    status: session.status,
    locationName: session.locationName ?? 'Unknown site',
    stationName: session.stationName,
    connectorLabel: connector
      ? `EVSE ${session.evseId} · ${CONNECTOR_TYPE_LABEL[connector.type]} · ${connector.maxPowerKw} kW`
      : `EVSE ${session.evseId}`,
    startedAt: session.startedAt,
    durationSeconds: session.durationSeconds,
    energyDeliveredWh: session.energyDeliveredWh,
    currentPowerKw: session.currentPowerKw,
    currentSoc: session.currentSoc,
    costMinor: session.costMinor,
    currency: session.currency,
    authorizedAmountMinor: authorized,
    budgetUsedPercent: Number(
      Math.min(100, (session.costMinor / Math.max(1, authorized)) * 100).toFixed(1),
    ),
    estimatedKwhRemaining:
      session.status === 'active'
        ? Number(Math.max(0, (authorized - session.costMinor) / 45).toFixed(1))
        : null,
    statusMessage:
      session.status === 'pending'
        ? 'Paid. Plug in your cable to start charging.'
        : session.status === 'active'
          ? 'Charging now.'
          : session.status === 'completed'
            ? 'Finished. You were charged for what you used.'
            : 'This session did not complete.',
    canStop: session.status === 'active',
  };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export const coreHandlers = [
  /* ----------------------------- system ---------------------------- */
  mock('health', () => ({
    status: 'ok' as const,
    version: 'mock-1.0.0',
    uptimeSeconds: Math.round(performance.now() / 1000),
    protocols: ['ocpp1.6', 'ocpp2.0.1'],
    dependencies: [
      { name: 'postgres', status: 'ok' as const, latencyMs: 2 },
      { name: 'redis', status: 'ok' as const, latencyMs: 1 },
    ],
  })),

  /* ------------------------------ auth ----------------------------- */
  mock('login', ({ body }) => {
    const payload = body as { email?: string; password?: string } | null;
    // Any password works in mock mode, but an empty one must still fail —
    // otherwise you never see your own error handling.
    if (!payload?.email || !payload.password) {
      return mockError('VALIDATION_FAILED', 'Email and password are required', 400);
    }
    const user =
      world.fixtures.users.find((u) => u.email === payload.email) ?? currentUser();
    return {
      user,
      tokens: {
        accessToken: `mock.${btoa(user.id).slice(0, 24)}`,
        refreshToken: `mockr.${btoa(user.id).slice(0, 24)}`,
        expiresIn: 3600,
        tokenType: 'Bearer' as const,
      },
    };
  }),

  mock('refresh', () => ({
    accessToken: `mock.${Date.now().toString(36)}`,
    refreshToken: `mockr.${Date.now().toString(36)}`,
    expiresIn: 3600,
    tokenType: 'Bearer' as const,
  })),

  mock('logout', () => ({ success: true })),
  mock('me', () => currentUser()),

  /* ---------------------------- dashboard -------------------------- */
  mock('dashboardStats', ({ url }) =>
    dashboardStats((url.searchParams.get('range') ?? '24h') as never),
  ),
  mock('energySeries', ({ url }) =>
    timeSeries(
      'energy',
      (url.searchParams.get('range') ?? '24h') as never,
      (url.searchParams.get('groupBy') ?? 'none') as never,
    ),
  ),
  mock('sessionSeries', ({ url }) =>
    timeSeries('sessions', (url.searchParams.get('range') ?? '24h') as never),
  ),
  mock('revenueSeries', ({ url }) =>
    timeSeries('revenue', (url.searchParams.get('range') ?? '24h') as never),
  ),
  mock('activity', ({ url }) => {
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (world.activity.length < limit) seedActivity();
    return { data: world.activity.slice(0, limit) };
  }),
  mock('topStations', ({ url }) =>
    topStations(
      (url.searchParams.get('range') ?? '30d') as never,
      Number(url.searchParams.get('limit') ?? 5),
    ),
  ),

  /* ---------------------------- stations --------------------------- */
  mock('listStations', ({ url }) => {
    const { search } = readPage(url);
    const status = url.searchParams.get('status');
    const protocol = url.searchParams.get('protocol');
    const locationId = url.searchParams.get('locationId');
    const connectorStatus = url.searchParams.get('connectorStatus');
    const tag = url.searchParams.get('tag');

    let rows = world.fixtures.stations.filter((s) => {
      if (status && s.status !== status) return false;
      if (protocol && s.protocol !== protocol) return false;
      if (locationId && s.locationId !== locationId) return false;
      if (tag && !s.tags.includes(tag)) return false;
      if (
        connectorStatus &&
        !s.evses.some((e) => e.connectors.some((c) => c.status === connectorStatus))
      ) {
        return false;
      }
      return matchesSearch([s.identity, s.name, s.vendor, s.model], search);
    });

    const sort = url.searchParams.get('sort');
    if (sort) {
      const desc = sort.startsWith('-');
      const field = desc ? sort.slice(1) : sort;
      rows = [...rows].sort((a, b) => {
        const av = String((a as unknown as Record<string, unknown>)[field] ?? '');
        const bv = String((b as unknown as Record<string, unknown>)[field] ?? '');
        return desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }

    const page = paginate(rows, url);
    return { data: page.data.map(toSummary), meta: page.meta };
  }),

  mock('getStation', ({ params }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);
    return station;
  }),

  mock('createStation', ({ body }) => {
    const input = body as Record<string, unknown>;
    const identity = String(input.identity ?? '');
    if (world.fixtures.stations.some((s) => s.identity === identity)) {
      return mockError('CONFLICT', `Identity ${identity} is already registered`, 409);
    }
    const now = new Date().toISOString();
    const evses = (input.evses as Array<{ evseId: number; connectors: Array<Record<string, unknown>> }> | undefined) ?? [];
    const station: Station = {
      id: r.uuid(),
      identity,
      name: String(input.name ?? identity),
      protocol: (input.protocol as Station['protocol']) ?? 'ocpp1.6',
      // A station that has never connected is `pending`, not `online`. Showing
      // it as online before it has said a word is a lie the operator will act on.
      status: 'pending',
      vendor: String(input.vendor ?? 'Unknown'),
      model: String(input.model ?? 'Unknown'),
      serialNumber: (input.serialNumber as string) ?? null,
      firmwareVersion: null,
      iccid: null,
      imsi: null,
      evses: evses.map((e) => ({
        id: r.uuid(),
        evseId: e.evseId,
        connectors: e.connectors.map((c) => ({
          id: r.uuid(),
          connectorId: Number(c.connectorId),
          evseId: e.evseId,
          type: c.type as Connector['type'],
          powerType: c.powerType as Connector['powerType'],
          maxPowerKw: Number(c.maxPowerKw),
          maxAmperage: undefined,
          maxVoltage: undefined,
          status: 'unavailable',
          errorCode: null,
          vendorErrorCode: null,
          statusUpdatedAt: null,
          activeSessionId: null,
        })),
      })),
      locationId: (input.locationId as string) ?? null,
      coordinates: (input.coordinates as Station['coordinates']) ?? null,
      address: (input.address as Station['address']) ?? null,
      heartbeatIntervalSeconds: Number(input.heartbeatIntervalSeconds ?? 300),
      lastHeartbeatAt: null,
      lastBootAt: null,
      connectedAt: null,
      disconnectedAt: null,
      securityProfile: (input.securityProfile as 1) ?? 1,
      tariffId: (input.tariffId as string) ?? null,
      maxPowerKw: Number(input.maxPowerKw ?? 22),
      tags: (input.tags as string[]) ?? [],
      note: null,
      createdAt: now,
      updatedAt: now,
    };
    world.fixtures.stations.unshift(station);
    return station;
  }),

  mock('updateStation', ({ params, body }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);
    Object.assign(station, body as object, { updatedAt: new Date().toISOString() });
    return station;
  }),

  mock('deleteStation', ({ params }) => {
    const idx = world.fixtures.stations.findIndex((s) => s.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No station with that id', 404);
    world.fixtures.stations.splice(idx, 1);
    return { success: true };
  }),

  mock('getStationStats', ({ params }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);
    const own = world.fixtures.sessions.filter((s) => s.stationId === station.id);
    const cutoff = Date.now() - 30 * 86_400_000;
    const recent = own.filter((s) => s.startedAt && new Date(s.startedAt).getTime() >= cutoff);
    const sum = (list: Session[], f: (s: Session) => number) => list.reduce((a, s) => a + f(s), 0);
    return {
      stationId: station.id,
      sessionsTotal: own.length,
      sessions30d: recent.length,
      energyTotalWh: Math.round(sum(own, (s) => s.energyDeliveredWh)),
      energy30dWh: Math.round(sum(recent, (s) => s.energyDeliveredWh)),
      revenueTotalMinor: sum(own, (s) => s.costMinor),
      revenue30dMinor: sum(recent, (s) => s.costMinor),
      currency: 'EUR',
      uptimePercent30d: station.status === 'online' ? r.float(97, 99.9, 1) : r.float(60, 92, 1),
      utilizationPercent30d: Number(Math.min(100, (recent.length / 40) * 100).toFixed(1)),
      faultCount30d: station.evses.flatMap((e) => e.connectors).filter((c) => c.status === 'faulted').length,
      avgSessionDurationSeconds: Math.round(
        sum(recent, (s) => s.durationSeconds) / Math.max(1, recent.length),
      ),
    };
  }),

  mock('getStationConfiguration', ({ params }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);

    // 1.6 returns flat keys; 2.0.1 returns component/variable pairs. We flatten
    // 2.0.1 into the same rows so one table serves both — exactly the shaping
    // your gateway should do.
    const keys =
      station.protocol === 'ocpp1.6'
        ? [
            { key: 'HeartbeatInterval', value: String(station.heartbeatIntervalSeconds), readonly: false },
            { key: 'MeterValueSampleInterval', value: '60', readonly: false },
            { key: 'MeterValuesSampledData', value: 'Energy.Active.Import.Register,Power.Active.Import,SoC', readonly: false },
            { key: 'ConnectionTimeOut', value: '120', readonly: false },
            { key: 'NumberOfConnectors', value: String(station.evses.length), readonly: true },
            { key: 'AuthorizeRemoteTxRequests', value: 'false', readonly: false },
            { key: 'LocalAuthListEnabled', value: 'true', readonly: false },
            { key: 'SupportedFeatureProfiles', value: 'Core,FirmwareManagement,LocalAuthListManagement,SmartCharging,RemoteTrigger', readonly: true },
            { key: 'ChargingScheduleAllowedChargingRateUnit', value: 'Current,Power', readonly: true },
          ].map((k) => ({ ...k, component: null, variable: null, dataType: null, unit: null, description: null }))
        : [
            { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: String(station.heartbeatIntervalSeconds), dataType: 'integer', unit: 's' },
            { component: 'OCPPCommCtrlr', variable: 'MessageTimeout', value: '30', dataType: 'integer', unit: 's' },
            { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval', value: '60', dataType: 'integer', unit: 's' },
            { component: 'SampledDataCtrlr', variable: 'TxUpdatedMeasurands', value: 'Energy.Active.Import.Register,Power.Active.Import', dataType: 'MemberList', unit: null },
            { component: 'AuthCtrlr', variable: 'AuthorizeRemoteStart', value: 'false', dataType: 'boolean', unit: null },
            { component: 'AuthCacheCtrlr', variable: 'Enabled', value: 'true', dataType: 'boolean', unit: null },
            { component: 'SecurityCtrlr', variable: 'SecurityProfile', value: String(station.securityProfile), dataType: 'integer', unit: null },
            { component: 'DeviceDataCtrlr', variable: 'ItemsPerMessage', value: '20', dataType: 'integer', unit: null },
          ].map((k) => ({
            key: `${k.component}.${k.variable}`,
            value: k.value,
            readonly: false,
            component: k.component,
            variable: k.variable,
            dataType: k.dataType,
            unit: k.unit,
            description: null,
          }));

    return {
      stationId: station.id,
      protocol: station.protocol,
      keys,
      unknownKeys: [],
      fetchedAt: new Date().toISOString(),
    };
  }),

  mock('updateStationConfiguration', ({ params, body }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);
    return makeCommand(station, 'set_configuration', body as Record<string, unknown>, 'accepted');
  }),

  mock('sendCommand', ({ params, body }) => {
    const station = world.stationById(String(params.id));
    if (!station) return mockError('NOT_FOUND', 'No station with that id', 404);
    if (station.status !== 'online') {
      return mockError(
        'STATION_OFFLINE',
        `${station.identity} is ${station.status}; the command cannot be delivered`,
        409,
      );
    }
    const input = body as { command: string; payload?: Record<string, unknown> };
    return makeCommand(station, input.command, input.payload ?? {}, 'accepted');
  }),

  mock('listCommands', ({ params, url }) => {
    const rows = world.commands.filter((c) => c.stationId === String(params.id));
    return paginate(rows, url);
  }),

  mock('getCommand', ({ params }) => {
    const cmd = world.commands.find((c) => c.id === String(params.id));
    if (!cmd) return mockError('NOT_FOUND', 'No command with that id', 404);
    return cmd;
  }),

  /* ---------------------------- sessions --------------------------- */
  mock('listSessions', ({ url }) => {
    const { search } = readPage(url);
    const status = url.searchParams.get('status');
    const stationId = url.searchParams.get('stationId');
    const userId = url.searchParams.get('userId');
    const protocol = url.searchParams.get('protocol');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    const rows = world.fixtures.sessions.filter((s) => {
      if (status && s.status !== status) return false;
      if (stationId && s.stationId !== stationId) return false;
      if (userId && s.idToken.userId !== userId) return false;
      if (protocol && s.protocol !== protocol) return false;
      if (from && (!s.startedAt || s.startedAt < from)) return false;
      if (to && (!s.startedAt || s.startedAt > to)) return false;
      return matchesSearch(
        [s.stationIdentity, s.idToken.value, s.idToken.userName, s.transactionId],
        search,
      );
    });
    return paginate(rows, url);
  }),

  mock('getSession', ({ params }) => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    return session;
  }),

  mock('getSessionMeterValues', ({ params, url }) => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    const resolution = url.searchParams.get('resolution') ?? '1m';
    const stepSeconds = resolution === 'raw' ? 30 : resolution === '10s' ? 10 : resolution === '5m' ? 300 : 60;
    const start = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const points = Math.max(2, Math.min(400, Math.floor(session.durationSeconds / stepSeconds)));
    const meterStart = session.meterStartWh ?? 0;
    const kw = session.currentPowerKw ?? (session.energyDeliveredWh / Math.max(1, session.durationSeconds / 3600)) / 1000;

    return {
      sessionId: session.id,
      resolution,
      data: Array.from({ length: points }, (_, i) => {
        const t = start + i * stepSeconds * 1000;
        const progress = i / (points - 1);
        // Charging tapers as the battery fills — a flat line looks fake and,
        // more importantly, hides the taper your smart-charging code must handle.
        const taper = 1 - 0.35 * progress ** 2;
        return {
          sessionId: session.id,
          timestamp: new Date(t).toISOString(),
          energyWh: Math.round(meterStart + session.energyDeliveredWh * progress),
          powerKw: Number((kw * taper).toFixed(2)),
          currentA: Number(((kw * taper * 1000) / 400).toFixed(1)),
          voltageV: 395 + Math.round(Math.sin(i / 3) * 6),
          soc: session.currentSoc ? Math.round(30 + progress * (session.currentSoc - 30)) : null,
          temperatureC: Number((22 + progress * 12).toFixed(1)),
        };
      }),
    };
  }),

  mock('stopSession', ({ params }) => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    const station = world.stationById(session.stationId);
    if (!station) return mockError('NOT_FOUND', 'Station is gone', 404);
    return makeCommand(station, 'remote_stop', { sessionId: session.id }, 'accepted');
  }),

  mock('listAuthorizations', ({ url }) => {
    const result = url.searchParams.get('result');
    const stationId = url.searchParams.get('stationId');
    const rows = world.fixtures.authorizations.filter((a) => {
      if (result && a.result !== result) return false;
      if (stationId && a.stationId !== stationId) return false;
      return true;
    });
    return paginate(rows, url);
  }),

  mock('listCdrs', ({ url }) => {
    const userId = url.searchParams.get('userId');
    const rows = world.fixtures.cdrs.filter((c) => !userId || c.userId === userId);
    return paginate(rows, url);
  }),

  mock('getCdr', ({ params }) => {
    const cdr = world.fixtures.cdrs.find((c) => c.id === String(params.id));
    if (!cdr) return mockError('NOT_FOUND', 'No CDR with that id', 404);
    return cdr;
  }),

  /* ---------------------------- locations -------------------------- */
  mock('listLocations', ({ url }) => {
    const { search } = readPage(url);
    const city = url.searchParams.get('city');
    const rows = world.fixtures.locations.filter((l) => {
      if (city && l.address.city !== city) return false;
      return matchesSearch([l.name, l.address.city, l.address.street], search);
    });
    return paginate(rows, url);
  }),

  mock('getLocation', ({ params }) => {
    const loc = world.locationById(String(params.id));
    if (!loc) return mockError('NOT_FOUND', 'No location with that id', 404);
    return loc;
  }),

  mock('createLocation', ({ body }) => {
    const now = new Date().toISOString();
    const loc = {
      id: r.uuid(),
      stationCount: 0,
      connectorCount: 0,
      availableConnectorCount: 0,
      chargingConnectorCount: 0,
      faultedConnectorCount: 0,
      maxPowerKw: 0,
      photoUrl: null,
      operatorName: 'Voltway Networks',
      createdAt: now,
      updatedAt: now,
      ...(body as object),
    } as unknown as (typeof world.fixtures.locations)[number];
    world.fixtures.locations.unshift(loc);
    return loc;
  }),

  mock('updateLocation', ({ params, body }) => {
    const loc = world.locationById(String(params.id));
    if (!loc) return mockError('NOT_FOUND', 'No location with that id', 404);
    Object.assign(loc, body as object, { updatedAt: new Date().toISOString() });
    return loc;
  }),

  mock('deleteLocation', ({ params }) => {
    const idx = world.fixtures.locations.findIndex((l) => l.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No location with that id', 404);
    world.fixtures.locations.splice(idx, 1);
    return { success: true };
  }),

  /* ------------------------------ users ---------------------------- */
  mock('listUsers', ({ url }) => {
    const { search } = readPage(url);
    const role = url.searchParams.get('role');
    const status = url.searchParams.get('status');
    const rows = world.fixtures.users.filter((u) => {
      if (role && u.role !== role) return false;
      if (status && u.status !== status) return false;
      return matchesSearch([u.name, u.email, u.groupName], search);
    });
    return paginate(rows, url);
  }),

  mock('getUser', ({ params }) => {
    const user = world.fixtures.users.find((u) => u.id === String(params.id));
    if (!user) return mockError('NOT_FOUND', 'No user with that id', 404);
    return user;
  }),

  mock('createUser', ({ body }) => {
    const input = body as Record<string, unknown>;
    const email = String(input.email ?? '');
    if (world.fixtures.users.some((u) => u.email === email)) {
      return mockError('CONFLICT', 'That email is already registered', 409);
    }
    const now = new Date().toISOString();
    const user: User = {
      id: r.uuid(),
      email,
      name: String(input.name ?? ''),
      phone: (input.phone as string) ?? null,
      role: (input.role as User['role']) ?? 'driver',
      status: input.password ? 'active' : 'invited',
      avatarUrl: null,
      balanceMinor: (input.balanceMinor as number) ?? 0,
      currency: 'EUR',
      tokenCount: 0,
      sessionCount: 0,
      totalEnergyWh: 0,
      totalSpentMinor: 0,
      groupId: (input.groupId as string) ?? null,
      groupName: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    world.fixtures.users.unshift(user);
    return user;
  }),

  mock('updateUser', ({ params, body }) => {
    const user = world.fixtures.users.find((u) => u.id === String(params.id));
    if (!user) return mockError('NOT_FOUND', 'No user with that id', 404);
    Object.assign(user, body as object, { updatedAt: new Date().toISOString() });
    return user;
  }),

  mock('deleteUser', ({ params }) => {
    const idx = world.fixtures.users.findIndex((u) => u.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No user with that id', 404);
    world.fixtures.users.splice(idx, 1);
    return { success: true };
  }),

  mock('listGroups', ({ url }) => paginate(world.fixtures.groups, url)),

  /* ----------------------------- tokens ---------------------------- */
  mock('listTokens', ({ url }) => {
    const { search } = readPage(url);
    const userId = url.searchParams.get('userId');
    const status = url.searchParams.get('status');
    const type = url.searchParams.get('type');
    const rows = world.fixtures.tokens.filter((t) => {
      if (userId && t.userId !== userId) return false;
      if (status && t.status !== status) return false;
      if (type && t.type !== type) return false;
      return matchesSearch([t.value, t.label, t.userName], search);
    });
    return paginate(rows, url);
  }),

  mock('getToken', ({ params }) => {
    const token = world.fixtures.tokens.find((t) => t.id === String(params.id));
    if (!token) return mockError('NOT_FOUND', 'No token with that id', 404);
    return token;
  }),

  mock('createToken', ({ body }) => {
    const input = body as Record<string, unknown>;
    // Normalise on the way in — the same rule your backend needs.
    const value = String(input.value ?? '').toUpperCase().replace(/[\s:-]/g, '');
    if (world.fixtures.tokens.some((t) => t.value === value)) {
      return mockError('CONFLICT', 'That token value already exists', 409);
    }
    const now = new Date().toISOString();
    const user = input.userId
      ? world.fixtures.users.find((u) => u.id === input.userId)
      : undefined;
    const token = {
      id: r.uuid(),
      value,
      type: (input.type as never) ?? 'rfid',
      status: 'active' as const,
      label: (input.label as string) ?? null,
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      groupId: user?.groupId ?? null,
      validFrom: now,
      validUntil: (input.validUntil as string) ?? null,
      inLocalList: input.inLocalList !== false,
      lastUsedAt: null,
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    world.fixtures.tokens.unshift(token);
    return token;
  }),

  mock('updateToken', ({ params, body }) => {
    const token = world.fixtures.tokens.find((t) => t.id === String(params.id));
    if (!token) return mockError('NOT_FOUND', 'No token with that id', 404);
    Object.assign(token, body as object, { updatedAt: new Date().toISOString() });
    return token;
  }),

  mock('deleteToken', ({ params }) => {
    const idx = world.fixtures.tokens.findIndex((t) => t.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No token with that id', 404);
    world.fixtures.tokens.splice(idx, 1);
    return { success: true };
  }),

  /* ---------------------------- tariffs ---------------------------- */
  mock('listTariffs', ({ url }) => {
    const { search } = readPage(url);
    const rows = world.fixtures.tariffs.filter((t) => matchesSearch([t.name, t.description], search));
    return paginate(rows, url);
  }),

  mock('getTariff', ({ params }) => {
    const tariff = world.fixtures.tariffs.find((t) => t.id === String(params.id));
    if (!tariff) return mockError('NOT_FOUND', 'No tariff with that id', 404);
    return tariff;
  }),

  mock('createTariff', ({ body }) => {
    const now = new Date().toISOString();
    const input = body as Record<string, unknown>;
    const tariff = {
      id: r.uuid(),
      minPriceMinor: null,
      maxPriceMinor: null,
      stationCount: 0,
      validFrom: now,
      validUntil: null,
      createdAt: now,
      updatedAt: now,
      stationIds: [],
      ...(input as object),
      elements: ((input.elements as Array<Record<string, unknown>>) ?? []).map((el) => ({
        id: r.uuid(),
        restrictions: null,
        ...el,
      })),
    } as unknown as (typeof world.fixtures.tariffs)[number];
    world.fixtures.tariffs.unshift(tariff);
    return tariff;
  }),

  mock('updateTariff', ({ params, body }) => {
    const tariff = world.fixtures.tariffs.find((t) => t.id === String(params.id));
    if (!tariff) return mockError('NOT_FOUND', 'No tariff with that id', 404);
    Object.assign(tariff, body as object, { updatedAt: new Date().toISOString() });
    return tariff;
  }),

  mock('deleteTariff', ({ params }) => {
    const idx = world.fixtures.tariffs.findIndex((t) => t.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No tariff with that id', 404);
    world.fixtures.tariffs.splice(idx, 1);
    return { success: true };
  }),

  mock('previewTariff', ({ params, body }) => {
    const tariff = world.fixtures.tariffs.find((t) => t.id === String(params.id));
    if (!tariff) return mockError('NOT_FOUND', 'No tariff with that id', 404);
    const input = body as {
      energyKwh: number;
      durationMinutes: number;
      parkingMinutes?: number;
      startedAt?: string;
    };
    const startedAt = input.startedAt ?? new Date().toISOString();
    const { totalMinor, breakdown } = priceSession(tariff, {
      energyWh: input.energyKwh * 1000,
      durationSeconds: input.durationMinutes * 60,
      parkingSeconds: (input.parkingMinutes ?? 0) * 60,
      startedAt,
    });

    // The trace is what makes a pricing engine debuggable: it says which
    // element matched and why the others did not.
    const hhmm = new Date(startedAt).toTimeString().slice(0, 5);
    let matched = false;
    const trace = tariff.elements.map((el, elementIndex) => {
      const rest = el.restrictions;
      if (matched) return { elementIndex, matched: false, reason: 'An earlier element already matched' };
      if (!rest) {
        matched = true;
        return { elementIndex, matched: true, reason: 'No restrictions — always applies' };
      }
      if (rest.startTime && rest.endTime) {
        const wraps = rest.startTime > rest.endTime;
        const inside = wraps
          ? hhmm >= rest.startTime || hhmm < rest.endTime
          : hhmm >= rest.startTime && hhmm < rest.endTime;
        if (!inside) {
          return {
            elementIndex,
            matched: false,
            reason: `Start time ${hhmm} is outside ${rest.startTime}–${rest.endTime}`,
          };
        }
      }
      matched = true;
      return { elementIndex, matched: true, reason: 'All restrictions satisfied' };
    });

    return {
      currency: tariff.currency,
      totalMinor,
      breakdown: breakdown.map((b, i) => ({
        elementIndex: i,
        label: b.label,
        kind: b.kind,
        quantity: b.quantity,
        unit: b.unit,
        unitPriceMinor: b.unitPriceMinor,
        amountMinor: b.amountMinor,
      })),
      trace,
    };
  }),

  /* ---------------------------- payments --------------------------- */
  mock('authorizePayment', ({ body }) => {
    const input = body as { amountMinor: number; currency: string; userId?: string };
    if (!input?.amountMinor || input.amountMinor <= 0) {
      return mockError('VALIDATION_FAILED', 'Amount must be greater than zero', 400);
    }
    // A fixed decline case so the unhappy path is reachable on demand: any
    // amount ending in 13 is declined. Your real dummy provider should have an
    // equivalent — testing only the happy path tests nothing.
    if (input.amountMinor % 100 === 13) {
      return mockError('PAYMENT_DECLINED', 'Card declined by issuer (test rule: amounts ending .13)', 402);
    }
    const now = new Date().toISOString();
    const user = input.userId
      ? world.fixtures.users.find((u) => u.id === input.userId)
      : driverUser();
    const payment: Payment = {
      id: r.uuid(),
      reference: `PAY-${r.int(100000, 999999)}`,
      status: 'authorized',
      provider: 'dummy',
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      sessionId: null,
      stationIdentity: null,
      currency: input.currency ?? 'EUR',
      authorizedAmountMinor: input.amountMinor,
      capturedAmountMinor: null,
      refundedAmountMinor: null,
      failureCode: null,
      failureMessage: null,
      createdAt: now,
      authorizedAt: now,
      capturedAt: null,
      refundedAt: null,
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    world.fixtures.payments.unshift(payment);
    return payment;
  }),

  mock('capturePayment', ({ params, body }) => {
    const payment = world.fixtures.payments.find((p) => p.id === String(params.id));
    if (!payment) return mockError('NOT_FOUND', 'No payment with that id', 404);
    const amount = (body as { amountMinor: number }).amountMinor;
    if (amount > payment.authorizedAmountMinor) {
      return mockError(
        'CONFLICT',
        `Cannot capture ${amount} — only ${payment.authorizedAmountMinor} was authorised`,
        409,
      );
    }
    payment.status = 'captured';
    payment.capturedAmountMinor = amount;
    payment.refundedAmountMinor = payment.authorizedAmountMinor - amount;
    payment.capturedAt = new Date().toISOString();
    return payment;
  }),

  mock('refundPayment', ({ params, body }) => {
    const payment = world.fixtures.payments.find((p) => p.id === String(params.id));
    if (!payment) return mockError('NOT_FOUND', 'No payment with that id', 404);
    const amount = (body as { amountMinor?: number }).amountMinor ?? payment.capturedAmountMinor ?? 0;
    payment.status = 'refunded';
    payment.refundedAmountMinor = amount;
    payment.refundedAt = new Date().toISOString();
    return payment;
  }),

  mock('getPayment', ({ params }) => {
    const payment = world.fixtures.payments.find((p) => p.id === String(params.id));
    if (!payment) return mockError('NOT_FOUND', 'No payment with that id', 404);
    return payment;
  }),

  mock('listPayments', ({ url }) => {
    const status = url.searchParams.get('status');
    const rows = world.fixtures.payments.filter((p) => !status || p.status === status);
    return paginate(rows, url);
  }),

  /* ------------------------------ logs ----------------------------- */
  mock('ocppLog', ({ url }) => {
    const stationId = url.searchParams.get('stationId');
    const protocol = url.searchParams.get('protocol');
    const direction = url.searchParams.get('direction');
    const action = url.searchParams.get('action');
    const outcome = url.searchParams.get('outcome');
    const invalidOnly = url.searchParams.get('invalidOnly') === 'true';
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const actions = action ? action.split(',').map((a) => a.trim()) : null;

    const rows = world.ocppLog.filter((e) => {
      if (stationId && e.stationId !== stationId) return false;
      if (protocol && e.protocol !== protocol) return false;
      if (direction && e.direction !== direction) return false;
      if (actions && !actions.includes(e.action)) return false;
      if (outcome && e.outcome !== outcome) return false;
      if (invalidOnly && e.request.valid !== false) return false;
      if (q && !JSON.stringify(e.request.payload).toLowerCase().includes(q)) return false;
      return true;
    });
    return cursorPage(rows, url);
  }),

  mock('systemLog', ({ url }) => {
    const level = url.searchParams.get('level');
    const source = url.searchParams.get('source');
    const rows = world.systemLog.filter((l) => {
      if (level && l.level !== level) return false;
      if (source && l.source !== source) return false;
      return true;
    });
    return cursorPage(rows, url);
  }),

  mock('auditLog', ({ url }) =>
    cursorPage(
      world.commands.map((c) => ({
        id: c.id,
        timestamp: c.createdAt,
        actorId: c.requestedBy,
        actorName: c.requestedByName ?? 'System',
        action: `station.${c.command}`,
        targetType: 'station',
        targetId: c.stationId,
        targetLabel: c.stationIdentity,
        changes: c.payload,
        ipAddress: '10.0.0.14',
      })),
      url,
    ),
  ),

  /* ------------------------------ OCPI ----------------------------- */
  mock('listOcpiParties', ({ url }) => paginate(world.fixtures.ocpiParties, url)),

  mock('getOcpiParty', ({ params }) => {
    const party = world.fixtures.ocpiParties.find((p) => p.id === String(params.id));
    if (!party) return mockError('NOT_FOUND', 'No party with that id', 404);
    return party;
  }),

  mock('registerOcpiParty', ({ body }) => {
    const input = body as { name: string; countryCode: string; partyId: string; versionsUrl: string };
    const now = new Date().toISOString();
    const party = {
      id: r.uuid(),
      countryCode: input.countryCode,
      partyId: input.partyId,
      name: input.name,
      role: 'EMSP' as const,
      status: 'connected' as const,
      versionsUrl: input.versionsUrl,
      selectedVersion: '2.2.1',
      tokenForUsPreview: `tok_live_••••${r.uuid().slice(0, 4)}`,
      tokenForThemPreview: `tok_live_••••${r.uuid().slice(0, 4)}`,
      endpoints: [],
      modules: ['credentials', 'locations', 'cdrs', 'tokens'] as never,
      lastHandshakeAt: now,
      lastSyncAt: null,
      lastError: null,
      locationsPushed: 0,
      cdrsPushed: 0,
      tokensReceived: 0,
      commandsReceived: 0,
      createdAt: now,
      updatedAt: now,
    };
    world.fixtures.ocpiParties.unshift(party as never);

    // The handshake, step by step — the shape the UI renders as a timeline.
    return {
      partyId: party.id,
      success: true,
      steps: [
        { step: 'fetch_versions' as const, status: 'ok' as const, detail: `GET ${input.versionsUrl} with TOKEN_A → 200`, durationMs: 148 },
        { step: 'select_version' as const, status: 'ok' as const, detail: 'Chose 2.2.1 from [2.1.1, 2.2, 2.2.1]', durationMs: 2 },
        { step: 'fetch_endpoints' as const, status: 'ok' as const, detail: 'Discovered 7 module endpoints', durationMs: 96 },
        { step: 'post_credentials' as const, status: 'ok' as const, detail: 'POST /credentials with TOKEN_A, body carried TOKEN_B', durationMs: 212 },
        { step: 'store_tokens' as const, status: 'ok' as const, detail: 'Stored their TOKEN_C for our outbound calls; TOKEN_A discarded', durationMs: 4 },
      ],
      error: null,
    };
  }),

  mock('syncOcpiParty', ({ params }) => {
    const party = world.fixtures.ocpiParties.find((p) => p.id === String(params.id));
    if (!party) return mockError('NOT_FOUND', 'No party with that id', 404);
    party.lastSyncAt = new Date().toISOString();
    party.locationsPushed += world.fixtures.locations.length;
    return { success: true };
  }),

  mock('deleteOcpiParty', ({ params }) => {
    const idx = world.fixtures.ocpiParties.findIndex((p) => p.id === String(params.id));
    if (idx < 0) return mockError('NOT_FOUND', 'No party with that id', 404);
    world.fixtures.ocpiParties.splice(idx, 1);
    return { success: true };
  }),

  mock('ocpiLog', ({ url }) => {
    const partyId = url.searchParams.get('partyId');
    const failedOnly = url.searchParams.get('failedOnly') === 'true';
    const rows = world.fixtures.ocpiLogs.filter((l) => {
      if (partyId && l.partyId !== partyId) return false;
      if (failedOnly && (l.statusCode ?? 200) < 400) return false;
      return true;
    });
    return paginate(rows, url);
  }),

  mock('listOcpiTokens', ({ url }) => paginate(world.fixtures.ocpiTokens, url)),
  mock('listOcpiCdrs', ({ url }) => paginate(world.fixtures.ocpiCdrs, url)),

  /* ----------------------------- driver ---------------------------- */
  mock('driverProfile', () => {
    const user = driverUser();
    const tokens = world.fixtures.tokens.filter((t) => t.userId === user.id);
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: null,
      balanceMinor: user.balanceMinor,
      currency: 'EUR',
      tokens: tokens.map((t) => ({
        id: t.id,
        label: t.label,
        type: t.type,
        // Never send the full token to a public app.
        maskedValue: `••••${t.value.slice(-4)}`,
        status: t.status,
        lastUsedAt: t.lastUsedAt,
      })),
      stats: {
        sessionCount: user.sessionCount,
        totalEnergyWh: user.totalEnergyWh,
        totalSpentMinor: user.totalSpentMinor,
        // ~120 g CO2/km avoided, ~5 km per kWh. A rough but standard figure.
        co2SavedKg: Number(((user.totalEnergyWh / 1000) * 5 * 0.12).toFixed(1)),
      },
      favouriteLocationIds: world.fixtures.locations.slice(0, 2).map((l) => l.id),
    };
  }),

  mock('driverNearby', ({ url }) => {
    const lat = Number(url.searchParams.get('latitude') ?? 52.3376);
    const lon = Number(url.searchParams.get('longitude') ?? 4.8721);
    const radius = Number(url.searchParams.get('radiusMeters') ?? 10_000);
    const availableOnly = url.searchParams.get('availableOnly') === 'true';
    const minPowerKw = Number(url.searchParams.get('minPowerKw') ?? 0);

    const rows: NearbyLocation[] = world.fixtures.locations
      .map((loc) => {
        const stations = world.fixtures.stations.filter((s) => s.locationId === loc.id);
        const connectors = stations.flatMap((s) => s.evses.flatMap((e) => e.connectors));
        const tariff = world.fixtures.tariffs.find((t) => t.id === stations[0]?.tariffId);
        const energyPrice = tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'energy')?.priceMinor ?? null;
        return {
          id: loc.id,
          name: loc.name,
          address: `${loc.address.street}, ${loc.address.postalCode} ${loc.address.city}`,
          coordinates: loc.coordinates,
          distanceMeters: distanceMetres({ latitude: lat, longitude: lon }, loc.coordinates),
          availableConnectorCount: connectors.filter((c) => c.status === 'available').length,
          totalConnectorCount: connectors.length,
          maxPowerKw: loc.maxPowerKw,
          connectorTypes: [...new Set(connectors.map((c) => c.type))],
          fromPriceMinor: energyPrice,
          currency: 'EUR',
          openNow: loc.openingHours.twentyFourSeven || new Date().getHours() < 23,
          facilities: loc.facilities,
          photoUrl: null,
        };
      })
      .filter((l) => (l.distanceMeters ?? 0) <= radius)
      .filter((l) => !availableOnly || l.availableConnectorCount > 0)
      .filter((l) => l.maxPowerKw >= minPowerKw)
      .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));

    return { data: rows };
  }),

  mock('driverLocation', ({ params }) => {
    const loc = world.locationById(String(params.id));
    if (!loc) return mockError('NOT_FOUND', 'No location with that id', 404);
    const stations = world.fixtures.stations.filter((s) => s.locationId === loc.id);
    const tariff = world.fixtures.tariffs.find((t) => t.id === stations[0]?.tariffId);
    const price = tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'energy')?.priceMinor ?? null;

    const connectors: DriverConnector[] = stations.flatMap((station) =>
      station.evses.flatMap((evse) =>
        evse.connectors.map((c) => ({
          id: c.id,
          stationId: station.id,
          stationIdentity: station.identity,
          stationName: station.name,
          evseId: evse.evseId,
          connectorId: c.connectorId,
          type: c.type,
          powerType: c.powerType,
          maxPowerKw: c.maxPowerKw,
          available: c.status === 'available',
          statusLabel: CONNECTOR_STATUS_LABEL[c.status],
          pricePerKwhMinor: price,
          currency: 'EUR',
        })),
      ),
    );

    return {
      id: loc.id,
      name: loc.name,
      address: `${loc.address.street}, ${loc.address.postalCode} ${loc.address.city}`,
      coordinates: loc.coordinates,
      distanceMeters: null,
      availableConnectorCount: connectors.filter((c) => c.available).length,
      totalConnectorCount: connectors.length,
      maxPowerKw: loc.maxPowerKw,
      connectorTypes: [...new Set(connectors.map((c) => c.type))],
      fromPriceMinor: price,
      currency: 'EUR',
      openNow: true,
      facilities: loc.facilities,
      photoUrl: null,
      connectors,
      openingHours: loc.openingHours,
      timeZone: loc.timeZone,
    };
  }),

  mock('driverResolveConnector', ({ body }) => {
    const code = String((body as { code?: string }).code ?? '').trim().toUpperCase();
    const match = world
      .allConnectors()
      .find(
        ({ station, connector, evseId }) =>
          station.identity.toUpperCase() === code ||
          `${station.identity}-${evseId}`.toUpperCase() === code ||
          connector.id.toUpperCase().startsWith(code),
      );
    if (!match) return mockError('NOT_FOUND', `No connector matches "${code}"`, 404);

    const tariff = world.fixtures.tariffs.find((t) => t.id === match.station.tariffId);
    return {
      id: match.connector.id,
      stationId: match.station.id,
      stationIdentity: match.station.identity,
      stationName: match.station.name,
      evseId: match.evseId,
      connectorId: match.connector.connectorId,
      type: match.connector.type,
      powerType: match.connector.powerType,
      maxPowerKw: match.connector.maxPowerKw,
      available: match.connector.status === 'available',
      statusLabel: CONNECTOR_STATUS_LABEL[match.connector.status],
      pricePerKwhMinor:
        tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'energy')?.priceMinor ?? null,
      currency: 'EUR',
    };
  }),

  /**
   * The endpoint that ties the whole project together.
   *
   * Reading this handler is the fastest way to understand what your real
   * implementation has to do: authorise money, create a pending session,
   * push a remote start, and return something the app can wait on.
   */
  mock('driverStartCharge', ({ body }) => {
    const input = body as { connectorId: string; amountMinor: number; currency: string };
    const match = world.allConnectors().find(({ connector }) => connector.id === input.connectorId);
    if (!match) return mockError('NOT_FOUND', 'That connector no longer exists', 404);
    if (match.connector.status !== 'available') {
      return mockError('CONFLICT', `That connector is ${match.connector.status}`, 409);
    }
    if (!input.amountMinor || input.amountMinor <= 0) {
      return mockError('VALIDATION_FAILED', 'Enter an amount greater than zero', 400);
    }
    if (input.amountMinor % 100 === 13) {
      return mockError('PAYMENT_DECLINED', 'Card declined by issuer (test rule: amounts ending .13)', 402);
    }

    const user = driverUser();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tariff = world.fixtures.tariffs.find((t) => t.id === match.station.tariffId);
    const energyPrice =
      tariff?.elements[0]?.priceComponents.find((p) => p.kind === 'energy')?.priceMinor ?? 45;

    // 1. Ring-fence the money.
    const payment: Payment = {
      id: r.uuid(),
      reference: `PAY-${r.int(100000, 999999)}`,
      status: 'authorized',
      provider: 'dummy',
      userId: user.id,
      userName: user.name,
      sessionId: null,
      stationIdentity: match.station.identity,
      currency: input.currency ?? 'EUR',
      authorizedAmountMinor: input.amountMinor,
      capturedAmountMinor: null,
      refundedAmountMinor: null,
      failureCode: null,
      failureMessage: null,
      createdAt: nowIso,
      authorizedAt: nowIso,
      capturedAt: null,
      refundedAt: null,
      expiresAt: new Date(now + 24 * 3600_000).toISOString(),
    };
    world.fixtures.payments.unshift(payment);

    // 2. Create the session as PENDING — the car is not plugged in yet.
    const token =
      world.fixtures.tokens.find((t) => t.userId === user.id && t.type === 'app_user') ??
      world.fixtures.tokens.find((t) => t.userId === user.id);
    const session: Session = {
      id: r.uuid(),
      transactionId: null,
      protocol: match.station.protocol,
      status: 'pending',
      stationId: match.station.id,
      stationIdentity: match.station.identity,
      stationName: match.station.name,
      locationId: match.location?.id ?? null,
      locationName: match.location?.name ?? null,
      evseId: match.evseId,
      connectorId: match.connector.connectorId,
      idToken: {
        value: token?.value ?? 'APP-000000',
        type: 'app_user',
        tokenId: token?.id ?? null,
        userId: user.id,
        userName: user.name,
      },
      startedAt: null,
      endedAt: null,
      durationSeconds: 0,
      meterStartWh: null,
      meterStopWh: null,
      energyDeliveredWh: 0,
      currentPowerKw: null,
      currentSoc: null,
      stopReason: null,
      tariffId: tariff?.id ?? null,
      tariffName: tariff?.name ?? null,
      currency: 'EUR',
      costMinor: 0,
      costBreakdown: [],
      paymentId: payment.id,
      authorizedAmountMinor: input.amountMinor,
      cdrId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    payment.sessionId = session.id;
    world.fixtures.sessions.unshift(session);

    // 3. Push the remote start, with the energy cap attached.
    makeCommand(
      match.station,
      'remote_start',
      {
        evseId: match.evseId,
        connectorId: match.connector.connectorId,
        idToken: session.idToken.value,
        chargingProfile: { energyLimitWh: Math.round((input.amountMinor / energyPrice) * 1000) },
      },
      'accepted',
    );

    match.connector.status = 'preparing';

    // 4. In the mock, the driver "plugs in" a few seconds later so the pending
    //    → active transition is visible. Your backend waits for the station.
    setTimeout(() => {
      session.status = 'active';
      session.startedAt = new Date().toISOString();
      session.transactionId =
        match.station.protocol === 'ocpp1.6' ? String(r.int(49000, 49999)) : `${match.station.identity.toLowerCase()}-${r.uuid().slice(0, 8)}`;
      session.meterStartWh = r.int(1_000_000, 9_000_000);
      session.currentPowerKw = Math.min(match.connector.maxPowerKw, 11);
      session.currentSoc = 38;
      match.connector.status = 'charging';
      match.connector.activeSessionId = session.id;
      world.pushExchange({
        station: match.station,
        direction: 'inbound',
        action: match.station.protocol === 'ocpp1.6' ? 'StartTransaction' : 'TransactionEvent',
        request: world.samplePayload(match.station, match.station.protocol === 'ocpp1.6' ? 'StartTransaction' : 'TransactionEvent'),
        response: world.sampleResponse(match.station, match.station.protocol === 'ocpp1.6' ? 'StartTransaction' : 'TransactionEvent'),
        sessionId: session.id,
      });
    }, 6000);

    return {
      sessionId: session.id,
      paymentId: payment.id,
      status: 'pending' as const,
      plugInDeadlineAt: new Date(now + 10 * 60_000).toISOString(),
      estimatedKwh: Number(((input.amountMinor / energyPrice)).toFixed(1)),
      message: 'Payment held. Plug in within 10 minutes to start charging.',
    };
  }),

  mock('driverActiveSessions', () => {
    const user = driverUser();
    const rows = world.fixtures.sessions.filter(
      (s) => (s.status === 'active' || s.status === 'pending') && s.idToken.userId === user.id,
    );
    // Make sure the demo always has something live to look at.
    const fallback = world.fixtures.sessions.filter((s) => s.status === 'active').slice(0, 1);
    return { data: (rows.length > 0 ? rows : fallback).map(toDriverSession) };
  }),

  mock('driverSession', ({ params }) => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    return toDriverSession(session);
  }),

  mock('driverStopSession', ({ params }) => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    if (session.status !== 'active') {
      return mockError('CONFLICT', 'That session is not running', 409);
    }
    session.status = 'completed';
    session.endedAt = new Date().toISOString();
    session.currentPowerKw = null;
    session.meterStopWh = (session.meterStartWh ?? 0) + session.energyDeliveredWh;
    session.stopReason = 'remote';

    // Capture only what was used, release the rest — the whole point of the
    // authorize/capture split.
    const payment = world.fixtures.payments.find((p) => p.id === session.paymentId);
    if (payment) {
      payment.status = 'captured';
      payment.capturedAmountMinor = Math.min(session.costMinor, payment.authorizedAmountMinor);
      payment.refundedAmountMinor = payment.authorizedAmountMinor - payment.capturedAmountMinor;
      payment.capturedAt = session.endedAt;
    }

    const station = world.stationById(session.stationId);
    const connector = station?.evses
      .find((e) => e.evseId === session.evseId)
      ?.connectors.find((c) => c.connectorId === session.connectorId);
    if (connector) {
      connector.status = 'finishing';
      connector.activeSessionId = null;
    }

    return toDriverSession(session);
  }),

  mock('driverSessionHistory', ({ url }) => {
    const user = driverUser();
    const own = world.fixtures.sessions.filter(
      (s) => s.idToken.userId === user.id && s.status !== 'pending',
    );
    // The seeded driver may have few sessions; top up so the screen is useful.
    const rows = own.length >= 8 ? own : world.fixtures.sessions.filter((s) => s.status === 'completed').slice(0, 24);
    const page = paginate(rows, url);
    return { data: page.data.map(toDriverSession), meta: page.meta };
  }),

  mock('driverReceipt', ({ params }): Receipt | Response => {
    const session = world.sessionById(String(params.id));
    if (!session) return mockError('NOT_FOUND', 'No session with that id', 404);
    const payment = world.fixtures.payments.find((p) => p.id === session.paymentId);
    const cdr = world.fixtures.cdrs.find((c) => c.sessionId === session.id);
    const station = world.stationById(session.stationId);
    const location = session.locationId ? world.locationById(session.locationId) : null;
    const subtotal = session.costBreakdown.reduce((a, b) => a + b.amountMinor, 0) || session.costMinor;
    const vat = Math.round(subtotal * 0.21);

    return {
      sessionId: session.id,
      cdrId: cdr?.id ?? null,
      reference: cdr?.reference ?? `SES-${session.id.slice(0, 8).toUpperCase()}`,
      locationName: session.locationName ?? 'Unknown site',
      locationAddress: location
        ? `${location.address.street}, ${location.address.postalCode} ${location.address.city}`
        : '—',
      stationName: session.stationName,
      connectorLabel: `EVSE ${session.evseId} · connector ${session.connectorId}${station ? ` · ${station.maxPowerKw} kW` : ''}`,
      startedAt: session.startedAt ?? session.createdAt,
      endedAt: session.endedAt ?? session.updatedAt,
      durationSeconds: session.durationSeconds,
      energyDeliveredWh: session.energyDeliveredWh,
      currency: session.currency,
      lines: session.costBreakdown.map((b) => ({
        label: b.label,
        quantity: b.quantity,
        unit: b.unit,
        unitPriceMinor: b.unitPriceMinor,
        amountMinor: b.amountMinor,
      })),
      subtotalMinor: subtotal,
      vatPercent: 21,
      vatMinor: vat,
      totalMinor: session.costMinor,
      authorizedAmountMinor: payment?.authorizedAmountMinor ?? session.costMinor,
      refundedMinor: payment?.refundedAmountMinor ?? 0,
      paymentReference: payment?.reference ?? null,
      issuedAt: cdr?.issuedAt ?? session.updatedAt,
    };
  }),
];

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/**
 * Create a command record and put the matching frames on the wire.
 *
 * Note the two-phase outcome: the command goes to `accepted` immediately (the
 * station said it will try) and only reaches `succeeded` a moment later, when
 * the follow-up event would arrive. That delay is real, and a UI that skips it
 * lies to the operator.
 */
function makeCommand(
  station: Station,
  command: string,
  payload: Record<string, unknown>,
  status: Command['status'],
): Command {
  const now = new Date().toISOString();
  const exchange = world.pushExchange({
    station,
    direction: 'outbound',
    action: command,
    request: payload,
    response: { status: 'Accepted' },
  });

  const cmd: Command = {
    id: world.rng.uuid(),
    stationId: station.id,
    stationIdentity: station.identity,
    command: command as Command['command'],
    status,
    payload,
    response: { status: 'Accepted' },
    ocppMessageId: exchange.messageId,
    errorCode: null,
    errorMessage: null,
    requestedBy: currentUser().id,
    requestedByName: currentUser().name,
    createdAt: now,
    sentAt: now,
    respondedAt: now,
    completedAt: null,
  };
  world.commands.unshift(cmd);
  if (world.commands.length > 200) world.commands.length = 200;

  world.emit({
    type: 'command.update',
    at: now,
    data: {
      commandId: cmd.id,
      stationId: station.id,
      command,
      status,
      response: cmd.response,
      errorMessage: null,
    },
  });

  // The real outcome, a beat later.
  setTimeout(() => {
    cmd.status = 'succeeded';
    cmd.completedAt = new Date().toISOString();
    world.emit({
      type: 'command.update',
      at: cmd.completedAt,
      data: {
        commandId: cmd.id,
        stationId: station.id,
        command,
        status: 'succeeded',
        response: cmd.response,
        errorMessage: null,
      },
    });
  }, 2500);

  return cmd;
}

/** Fills the activity feed on first request. */
function seedActivity() {
  const recent = world.fixtures.sessions.slice(0, 14);
  const items: Array<Omit<ActivityItem, 'id'>> = recent.map((s) => ({
    timestamp: s.startedAt ?? s.createdAt,
    kind: s.status === 'active' ? 'session_started' : 'session_ended',
    title: s.status === 'active' ? 'Session started' : 'Session completed',
    description: `${s.stationIdentity} EVSE ${s.evseId}${s.idToken.userName ? ` · ${s.idToken.userName}` : ''}`,
    stationId: s.stationId,
    stationName: s.stationName,
    sessionId: s.id,
    severity: s.status === 'active' ? 'success' : 'info',
  }));
  for (const item of items.reverse()) world.pushActivity(item);
}
