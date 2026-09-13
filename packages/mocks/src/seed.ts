import type {
  AuthorizationRecord,
  Cdr,
  Connector,
  ConnectorStatus,
  ConnectorType,
  Evse,
  Location,
  OcpiCdr,
  OcpiParty,
  OcpiRequestLog,
  OcpiToken,
  Payment,
  PowerType,
  Protocol,
  Session,
  SimScenario,
  SimStation,
  Station,
  Tariff,
  Token,
  User,
  UserGroup,
} from '@ocpp/contracts';
import { rng, type Rng } from './random';

/**
 * The fixture set.
 *
 * Built to look like a real small network rather than a tidy demo: a mix of
 * protocol versions, a handful of faults, sessions of wildly different lengths,
 * tokens that are blocked, one OCPI partner whose handshake failed. A dataset
 * where everything works teaches you nothing about the screens that matter.
 */

const SEED = 20260913;

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */

const CITIES = [
  { city: 'Amsterdam', code: 'AMS', lat: 52.3376, lon: 4.8721, sites: 3 },
  { city: 'Rotterdam', code: 'RTM', lat: 51.9066, lon: 4.4876, sites: 2 },
  { city: 'Utrecht', code: 'UTR', lat: 52.0894, lon: 5.1103, sites: 2 },
  { city: 'Eindhoven', code: 'EIN', lat: 51.4483, lon: 5.4504, sites: 1 },
  { city: 'Den Haag', code: 'DHG', lat: 52.0812, lon: 4.3247, sites: 1 },
  { city: 'Groningen', code: 'GRN', lat: 53.2159, lon: 6.5665, sites: 1 },
] as const;

const SITE_NAMES = [
  'Zuidas P3',
  'Houthavens',
  'Sloterdijk Station',
  'Kop van Zuid',
  'Blaak Parking',
  'Jaarbeurs',
  'Science Park',
  'Strijp-S',
  'Centraal P2',
  'Zernike Campus',
];

const VENDORS = [
  { vendor: 'Alfen', models: ['Eve Single Pro', 'Eve Double Pro'] },
  { vendor: 'ABB', models: ['Terra AC', 'Terra 184'] },
  { vendor: 'Kempower', models: ['Satellite', 'Movable Charger'] },
  { vendor: 'EVBox', models: ['Elvi', 'Troniq 100'] },
  { vendor: 'Zaptec', models: ['Pro', 'Go'] },
] as const;

const FIRST = ['Zoe', 'Daan', 'Sanne', 'Luuk', 'Femke', 'Bram', 'Iris', 'Sem', 'Noor', 'Jens',
  'Eva', 'Ruben', 'Lotte', 'Thijs', 'Maud', 'Kees', 'Anouk', 'Pim', 'Roos', 'Tijn'];
const LAST = ['Hartman', 'de Vries', 'Bakker', 'Visser', 'Jansen', 'Smit', 'Meijer', 'Mulder',
  'Bos', 'Vos', 'Peters', 'Hendriks', 'Dekker', 'Brouwer', 'Kuipers'];

/* ------------------------------------------------------------------ *
 * Builders
 * ------------------------------------------------------------------ */

function buildLocations(r: Rng, now: number): Location[] {
  const out: Location[] = [];
  let nameIdx = 0;
  for (const c of CITIES) {
    for (let s = 0; s < c.sites; s += 1) {
      const name = `${c.city} ${SITE_NAMES[nameIdx % SITE_NAMES.length]}`;
      nameIdx += 1;
      out.push({
        id: r.uuid(),
        name,
        address: {
          street: `${r.pick(['Keizersgracht', 'Stationsplein', 'Havenweg', 'Parkstraat', 'Industrieweg'])} ${r.int(1, 240)}`,
          city: c.city,
          postalCode: `${r.int(1000, 9999)} ${r.pick(['AB', 'CD', 'EF', 'GH', 'JK'])}`,
          country: 'NL',
        },
        // Jitter around the city centre so pins do not stack.
        coordinates: {
          latitude: Number((c.lat + r.float(-0.045, 0.045, 4)).toFixed(5)),
          longitude: Number((c.lon + r.float(-0.06, 0.06, 4)).toFixed(5)),
        },
        timeZone: 'Europe/Amsterdam',
        openingHours: r.bool(0.75)
          ? { twentyFourSeven: true, regularHours: [] }
          : {
              twentyFourSeven: false,
              regularHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                weekday,
                periodBegin: weekday <= 5 ? '06:00' : '08:00',
                periodEnd: weekday <= 5 ? '23:00' : '20:00',
              })),
            },
        facilities: r.shuffle([
          'parking_lot',
          'supermarket',
          'cafe',
          'toilets',
          'wifi',
          'restaurant',
        ] as const).slice(0, r.int(1, 4)) as Location['facilities'],
        operatorName: 'Voltway Networks',
        gridCapacityKw: r.pick([100, 150, 250, 400, 630]),
        stationCount: 0,
        connectorCount: 0,
        availableConnectorCount: 0,
        chargingConnectorCount: 0,
        faultedConnectorCount: 0,
        maxPowerKw: 0,
        photoUrl: null,
        createdAt: new Date(now - r.int(200, 900) * 86_400_000).toISOString(),
        updatedAt: new Date(now - r.int(1, 40) * 86_400_000).toISOString(),
      });
    }
  }
  return out;
}

function connectorSpec(r: Rng, dc: boolean): { type: ConnectorType; powerType: PowerType; kw: number } {
  if (dc) {
    return {
      type: r.weighted([
        ['iec_62196_t2_combo', 8],
        ['chademo', 2],
      ] as const),
      powerType: 'dc',
      kw: r.pick([50, 75, 150, 180, 300]),
    };
  }
  return {
    type: 'iec_62196_t2',
    powerType: r.bool(0.8) ? 'ac_3_phase' : 'ac_1_phase',
    kw: r.pick([7.4, 11, 22]),
  };
}

function buildStations(r: Rng, locations: Location[], now: number): Station[] {
  const stations: Station[] = [];
  let n = 0;

  for (const loc of locations) {
    const count = r.int(3, 7);
    const dcSite = r.bool(0.35);

    for (let i = 0; i < count; i += 1) {
      n += 1;
      const code = CITIES.find((c) => c.city === loc.address.city)?.code ?? 'NLD';
      const vendor = r.pick(VENDORS);
      const protocol: Protocol = r.weighted([
        ['ocpp1.6', 7],
        ['ocpp2.0.1', 3],
      ] as const);

      // Most stations are up. A fleet where a third is offline is not
      // realistic and makes every screen look broken.
      const status = r.weighted([
        ['online', 86],
        ['offline', 8],
        ['pending', 2],
        ['unavailable', 4],
      ] as const);

      const dc = dcSite && r.bool(0.7);
      const evseCount = dc ? r.int(1, 2) : r.int(1, 2);
      const evses: Evse[] = [];

      for (let e = 1; e <= evseCount; e += 1) {
        // A DC station often has two cables on one EVSE — only one car at a
        // time. That is exactly the distinction OCPP 2.0.1 added EVSEs for.
        const connectorCount = dc && r.bool(0.4) ? 2 : 1;
        const connectors: Connector[] = [];
        for (let c = 1; c <= connectorCount; c += 1) {
          const spec = connectorSpec(r, dc);
          const cStatus: ConnectorStatus =
            status !== 'online'
              ? 'unavailable'
              : r.weighted([
                  ['available', 58],
                  ['charging', 13],
                  ['preparing', 5],
                  ['finishing', 4],
                  ['suspended_ev', 4],
                  ['suspended_evse', 2],
                  ['reserved', 3],
                  ['unavailable', 7],
                  ['faulted', 4],
                ] as const);
          connectors.push({
            id: r.uuid(),
            connectorId: c,
            evseId: e,
            type: spec.type,
            powerType: spec.powerType,
            maxPowerKw: spec.kw,
            maxAmperage: spec.powerType === 'dc' ? 500 : 32,
            maxVoltage: spec.powerType === 'dc' ? 920 : 400,
            status: cStatus,
            errorCode:
              protocol === 'ocpp1.6'
                ? cStatus === 'faulted'
                  ? r.pick(['GroundFailure', 'OverCurrentFailure', 'ConnectorLockFailure', 'HighTemperature'])
                  : 'NoError'
                : null,
            vendorErrorCode: cStatus === 'faulted' ? `VE-${r.int(100, 999)}` : null,
            statusUpdatedAt: r.pastIso(6 * 3600_000, now),
            activeSessionId: null,
          });
        }
        evses.push({ id: r.uuid(), evseId: e, connectors });
      }

      const maxPowerKw = Math.max(
        ...evses.flatMap((e) => e.connectors.map((c) => c.maxPowerKw)),
      );

      stations.push({
        id: r.uuid(),
        identity: `CP-${code}-${String(n).padStart(4, '0')}`,
        name: `${loc.name} · ${dc ? 'DC' : 'AC'} ${i + 1}`,
        protocol,
        status,
        vendor: vendor.vendor,
        model: r.pick(vendor.models),
        serialNumber: `${vendor.vendor.slice(0, 3).toUpperCase()}-${r.int(100000, 999999)}`,
        firmwareVersion: `${r.int(1, 4)}.${r.int(0, 9)}.${r.int(0, 20)}`,
        iccid: protocol === 'ocpp1.6' && r.bool(0.4) ? `894310${r.int(100000000, 999999999)}` : null,
        imsi: null,
        evses,
        locationId: loc.id,
        coordinates: {
          latitude: Number((loc.coordinates.latitude + r.float(-0.0018, 0.0018, 5)).toFixed(6)),
          longitude: Number((loc.coordinates.longitude + r.float(-0.0025, 0.0025, 5)).toFixed(6)),
        },
        address: loc.address,
        heartbeatIntervalSeconds: r.pick([60, 120, 300]),
        lastHeartbeatAt: status === 'online' ? r.pastIso(120_000, now) : r.pastIso(6 * 3600_000, now),
        lastBootAt: r.pastIso(20 * 86_400_000, now),
        connectedAt: status === 'online' ? r.pastIso(10 * 86_400_000, now) : null,
        disconnectedAt: status === 'offline' ? r.pastIso(4 * 3600_000, now) : null,
        securityProfile: r.weighted([[1, 5], [2, 4], [3, 1]] as const) as 1 | 2 | 3,
        tariffId: null,
        maxPowerKw,
        tags: r.shuffle(['public', 'fast', 'depot', 'retail', 'pilot']).slice(0, r.int(0, 2)),
        note: null,
        createdAt: new Date(now - r.int(60, 800) * 86_400_000).toISOString(),
        updatedAt: r.pastIso(10 * 86_400_000, now),
      });
    }
  }

  return stations;
}

function buildUsers(r: Rng, now: number): { users: User[]; groups: UserGroup[] } {
  const groups: UserGroup[] = [
    {
      id: r.uuid(),
      name: 'Voltway Operations',
      description: 'Internal staff vehicles',
      memberCount: 0,
      tariffId: null,
      monthlyBudgetMinor: 250_000,
      currency: 'EUR',
      createdAt: new Date(now - 400 * 86_400_000).toISOString(),
    },
    {
      id: r.uuid(),
      name: 'Meridian Logistics',
      description: 'Corporate fleet account, 18 vans',
      memberCount: 0,
      tariffId: null,
      monthlyBudgetMinor: 900_000,
      currency: 'EUR',
      createdAt: new Date(now - 260 * 86_400_000).toISOString(),
    },
  ];

  const users: User[] = [];

  const staff: Array<[string, User['role']]> = [
    ['Aisha Karim', 'admin'],
    ['Mark Feenstra', 'operator'],
    ['Julia Novak', 'operator'],
    ['Tom Wheeler', 'viewer'],
  ];

  for (const [name, role] of staff) {
    users.push({
      id: r.uuid(),
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@voltway.example`,
      name,
      phone: null,
      role,
      status: 'active',
      avatarUrl: null,
      balanceMinor: null,
      currency: null,
      tokenCount: 0,
      sessionCount: 0,
      totalEnergyWh: 0,
      totalSpentMinor: 0,
      groupId: groups[0].id,
      groupName: groups[0].name,
      lastLoginAt: r.pastIso(3 * 86_400_000, now),
      createdAt: new Date(now - r.int(200, 700) * 86_400_000).toISOString(),
      updatedAt: r.pastIso(30 * 86_400_000, now),
    });
  }

  for (let i = 0; i < 26; i += 1) {
    const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    const group = r.bool(0.3) ? groups[1] : null;
    users.push({
      id: r.uuid(),
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${i}@example.com`,
      name,
      phone: r.bool(0.6) ? `+316${r.int(10000000, 99999999)}` : null,
      role: 'driver',
      status: r.weighted([
        ['active', 22],
        ['invited', 2],
        ['suspended', 2],
      ] as const),
      avatarUrl: null,
      balanceMinor: r.int(0, 12000),
      currency: 'EUR',
      tokenCount: 0,
      sessionCount: 0,
      totalEnergyWh: 0,
      totalSpentMinor: 0,
      groupId: group?.id ?? null,
      groupName: group?.name ?? null,
      lastLoginAt: r.bool(0.85) ? r.pastIso(14 * 86_400_000, now) : null,
      createdAt: new Date(now - r.int(5, 600) * 86_400_000).toISOString(),
      updatedAt: r.pastIso(30 * 86_400_000, now),
    });
  }

  groups[0].memberCount = users.filter((u) => u.groupId === groups[0].id).length;
  groups[1].memberCount = users.filter((u) => u.groupId === groups[1].id).length;

  return { users, groups };
}

function buildTokens(r: Rng, users: User[], now: number): Token[] {
  const tokens: Token[] = [];
  const drivers = users.filter((u) => u.role === 'driver');

  for (const user of drivers) {
    const count = r.weighted([
      [1, 6],
      [2, 3],
      [0, 1],
    ] as const);
    for (let i = 0; i < count; i += 1) {
      const isApp = i === 1 || r.bool(0.25);
      tokens.push({
        id: r.uuid(),
        // Uppercase hex without separators — the normalised form. Readers
        // disagree about case and byte order for the same physical card, so
        // normalising at the edge is the only way comparisons work.
        value: isApp
          ? `APP-${r.int(100000, 999999)}`
          : Array.from({ length: 8 }, () => '0123456789ABCDEF'[r.int(0, 15)]).join(''),
        type: isApp ? 'app_user' : r.weighted([['rfid', 6], ['iso14443', 3], ['iso15693', 1]] as const),
        status:
          user.status === 'suspended'
            ? 'blocked'
            : r.weighted([
                ['active', 20],
                ['blocked', 1],
                ['expired', 1],
              ] as const),
        label: isApp ? 'Phone app' : r.pick(['Car card', 'Keyring', 'Spare card', 'Home card']),
        userId: user.id,
        userName: user.name,
        groupId: user.groupId,
        validFrom: new Date(now - r.int(30, 500) * 86_400_000).toISOString(),
        validUntil: r.bool(0.3) ? new Date(now + r.int(30, 700) * 86_400_000).toISOString() : null,
        inLocalList: r.bool(0.8),
        lastUsedAt: r.bool(0.8) ? r.pastIso(20 * 86_400_000, now) : null,
        useCount: r.int(0, 240),
        createdAt: new Date(now - r.int(30, 500) * 86_400_000).toISOString(),
        updatedAt: r.pastIso(60 * 86_400_000, now),
      });
      user.tokenCount += 1;
    }
  }
  return tokens;
}

function buildTariffs(r: Rng, stations: Station[], now: number): Tariff[] {
  const mk = (
    name: string,
    description: string,
    kind: Tariff['kind'],
    elements: Tariff['elements'],
  ): Tariff => ({
    id: r.uuid(),
    name,
    description,
    currency: 'EUR',
    kind,
    elements,
    minPriceMinor: null,
    maxPriceMinor: null,
    active: true,
    stationIds: [],
    stationCount: 0,
    validFrom: new Date(now - 200 * 86_400_000).toISOString(),
    validUntil: null,
    createdAt: new Date(now - 200 * 86_400_000).toISOString(),
    updatedAt: r.pastIso(40 * 86_400_000, now),
  });

  const tariffs: Tariff[] = [
    mk('Public AC standard', 'Flat rate for all AC public chargers.', 'simple', [
      {
        id: r.uuid(),
        priceComponents: [{ kind: 'energy', priceMinor: 45, stepSize: 1, vatPercent: 21 }],
        restrictions: null,
      },
    ]),
    mk(
      'Public DC fast',
      'Higher energy rate plus an idle fee after charging stops.',
      'simple',
      [
        {
          id: r.uuid(),
          priceComponents: [
            { kind: 'flat', priceMinor: 49, stepSize: 1, vatPercent: 21 },
            { kind: 'energy', priceMinor: 69, stepSize: 1, vatPercent: 21 },
            // Charged per hour, billed in 5-minute blocks, so a driver who
            // leaves a full car on a fast charger pays for the bay.
            { kind: 'parking_time', priceMinor: 600, stepSize: 300, vatPercent: 21 },
          ],
          restrictions: null,
        },
      ],
    ),
    mk(
      'Night saver',
      'Cheaper between 23:00 and 07:00. First matching element wins, so the night window must come first.',
      'time_of_use',
      [
        {
          id: r.uuid(),
          priceComponents: [{ kind: 'energy', priceMinor: 28, stepSize: 1, vatPercent: 21 }],
          restrictions: { startTime: '23:00', endTime: '07:00' },
        },
        {
          id: r.uuid(),
          priceComponents: [{ kind: 'energy', priceMinor: 52, stepSize: 1, vatPercent: 21 }],
          restrictions: null,
        },
      ],
    ),
    mk('Fleet — Meridian', 'Negotiated corporate rate, no idle fee.', 'simple', [
      {
        id: r.uuid(),
        priceComponents: [{ kind: 'energy', priceMinor: 34, stepSize: 1, vatPercent: 21 }],
        restrictions: null,
      },
    ]),
    mk('Staff — free', 'Employee vehicles charge at no cost.', 'free', [
      {
        id: r.uuid(),
        priceComponents: [{ kind: 'energy', priceMinor: 0, stepSize: 1, vatPercent: 0 }],
        restrictions: null,
      },
    ]),
  ];

  // Assign: DC stations to the DC tariff, everything else to public AC.
  for (const s of stations) {
    const isDc = s.evses.some((e) => e.connectors.some((c) => c.powerType === 'dc'));
    const t = isDc ? tariffs[1] : r.bool(0.2) ? tariffs[2] : tariffs[0];
    s.tariffId = t.id;
    t.stationIds.push(s.id);
  }
  tariffs.forEach((t) => {
    t.stationCount = t.stationIds.length;
  });

  return tariffs;
}

export interface Fixtures {
  locations: Location[];
  stations: Station[];
  users: User[];
  groups: UserGroup[];
  tokens: Token[];
  tariffs: Tariff[];
  sessions: Session[];
  cdrs: Cdr[];
  payments: Payment[];
  authorizations: AuthorizationRecord[];
  ocpiParties: OcpiParty[];
  ocpiTokens: OcpiToken[];
  ocpiCdrs: OcpiCdr[];
  ocpiLogs: OcpiRequestLog[];
  simStations: SimStation[];
  simScenarios: SimScenario[];
}

export { buildLocations, buildStations, buildUsers, buildTokens, buildTariffs, SEED, rng };
export type { Rng };
