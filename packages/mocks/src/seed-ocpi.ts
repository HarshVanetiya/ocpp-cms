import type { Cdr, OcpiCdr, OcpiParty, OcpiRequestLog, OcpiToken } from '@ocpp/contracts';
import type { Rng } from './random';

/**
 * Roaming fixtures.
 *
 * Three partners in deliberately different states — one healthy, one mid
 * handshake, one broken — because the interesting screens are the broken ones.
 */
export function buildOcpi(
  r: Rng,
  ctx: { cdrs: Cdr[]; now: number },
): {
  parties: OcpiParty[];
  tokens: OcpiToken[];
  ocpiCdrs: OcpiCdr[];
  logs: OcpiRequestLog[];
} {
  const { cdrs, now } = ctx;

  const modules = ['credentials', 'locations', 'sessions', 'cdrs', 'tariffs', 'tokens', 'commands'] as const;

  const endpointsFor = (base: string) =>
    modules.map((m) => ({
      module: m,
      role: (m === 'tokens' || m === 'commands' ? 'RECEIVER' : 'SENDER') as 'SENDER' | 'RECEIVER',
      url: `${base}/2.2.1/${m}`,
      reachable: true,
      lastCheckedAt: new Date(now - r.int(1, 90) * 60_000).toISOString(),
    }));

  const parties: OcpiParty[] = [
    {
      id: r.uuid(),
      countryCode: 'NL',
      partyId: 'MEM',
      name: 'Meridian eMobility',
      role: 'EMSP',
      status: 'connected',
      versionsUrl: 'https://ocpi.meridian.example/ocpi/versions',
      selectedVersion: '2.2.1',
      tokenForUsPreview: 'tok_live_••••4f2a',
      tokenForThemPreview: 'tok_live_••••91bd',
      endpoints: endpointsFor('https://ocpi.meridian.example/ocpi'),
      modules: [...modules],
      lastHandshakeAt: new Date(now - 62 * 86_400_000).toISOString(),
      lastSyncAt: new Date(now - r.int(4, 40) * 60_000).toISOString(),
      lastError: null,
      locationsPushed: 10,
      cdrsPushed: 184,
      tokensReceived: 2_413,
      commandsReceived: 96,
      createdAt: new Date(now - 62 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 10 * 60_000).toISOString(),
    },
    {
      id: r.uuid(),
      countryCode: 'DE',
      partyId: 'NXC',
      name: 'NexCharge Deutschland',
      role: 'EMSP',
      status: 'registering',
      versionsUrl: 'https://roaming.nexcharge.example/ocpi/versions',
      selectedVersion: '2.2.1',
      // Mid-handshake: we have sent TOKEN_B but have not stored their TOKEN_C.
      tokenForUsPreview: 'tok_test_••••7c10',
      tokenForThemPreview: null,
      endpoints: endpointsFor('https://roaming.nexcharge.example/ocpi').slice(0, 3),
      modules: ['credentials', 'locations', 'cdrs'],
      lastHandshakeAt: new Date(now - 2 * 3600_000).toISOString(),
      lastSyncAt: null,
      lastError: null,
      locationsPushed: 0,
      cdrsPushed: 0,
      tokensReceived: 0,
      commandsReceived: 0,
      createdAt: new Date(now - 2 * 3600_000).toISOString(),
      updatedAt: new Date(now - 2 * 3600_000).toISOString(),
    },
    {
      id: r.uuid(),
      countryCode: 'BE',
      partyId: 'HUB',
      name: 'Benelux Roaming Hub',
      role: 'HUB',
      status: 'error',
      versionsUrl: 'https://hub.benelux-roaming.example/ocpi/versions',
      selectedVersion: '2.2.1',
      tokenForUsPreview: 'tok_live_••••2b8e',
      tokenForThemPreview: 'tok_live_••••ff41',
      endpoints: endpointsFor('https://hub.benelux-roaming.example/ocpi').map((e, i) => ({
        ...e,
        reachable: i !== 3,
      })),
      modules: [...modules],
      lastHandshakeAt: new Date(now - 140 * 86_400_000).toISOString(),
      lastSyncAt: new Date(now - 19 * 3600_000).toISOString(),
      lastError: 'POST /cdrs returned 401 — token rejected. Re-run the credentials handshake.',
      locationsPushed: 10,
      cdrsPushed: 57,
      tokensReceived: 811,
      commandsReceived: 12,
      createdAt: new Date(now - 140 * 86_400_000).toISOString(),
      updatedAt: new Date(now - 19 * 3600_000).toISOString(),
    },
  ];

  const tokens: OcpiToken[] = [];
  for (let i = 0; i < 60; i += 1) {
    const party = r.weighted([
      [parties[0], 8],
      [parties[2], 3],
    ] as const);
    tokens.push({
      id: r.uuid(),
      partyId: party.id,
      partyName: party.name,
      countryCode: party.countryCode,
      ocpiPartyId: party.partyId,
      uid: Array.from({ length: 10 }, () => '0123456789ABCDEF'[r.int(0, 15)]).join(''),
      type: r.weighted([
        ['RFID', 7],
        ['APP_USER', 3],
      ] as const),
      // eMAID: the pan-European contract id. This is what actually identifies
      // a driver across networks — the card uid is only the physical thing.
      contractId: `${party.countryCode}${party.partyId}C${Array.from({ length: 8 }, () => '0123456789ABCDEFGHJKLMNPRSTUVWXYZ'[r.int(0, 32)]).join('')}`,
      visualNumber: r.bool(0.5) ? `${party.partyId}-${r.int(10000, 99999)}` : null,
      issuer: party.name,
      valid: r.bool(0.94),
      whitelist: r.weighted([
        ['ALWAYS', 5],
        ['ALLOWED', 4],
        ['ALLOWED_OFFLINE', 2],
        ['NEVER', 1],
      ] as const),
      lastUpdated: r.pastIso(30 * 86_400_000, now),
    });
  }

  const ocpiCdrs: OcpiCdr[] = cdrs.slice(0, 80).map((cdr) => {
    const party = r.weighted([
      [parties[0], 8],
      [parties[2], 2],
    ] as const);
    const status = r.weighted([
      ['acknowledged', 14],
      ['pushed', 3],
      ['queued', 2],
      ['failed', 1],
    ] as const);
    return {
      id: r.uuid(),
      cdrId: cdr.id,
      partyId: party.id,
      partyName: party.name,
      ocpiId: cdr.reference,
      sessionId: cdr.sessionId,
      startedAt: cdr.startedAt,
      endedAt: cdr.endedAt,
      energyWh: cdr.energyDeliveredWh,
      currency: cdr.currency,
      totalCostMinor: cdr.totalCostMinor,
      status,
      attempts: status === 'failed' ? r.int(3, 8) : 1,
      lastAttemptAt: cdr.issuedAt,
      lastError: status === 'failed' ? 'HTTP 422 — unknown location_id at receiver' : null,
    };
  });

  const logs: OcpiRequestLog[] = [];
  const samples: Array<[OcpiRequestLog['direction'], string, string, number, number]> = [
    ['outgoing', 'cdrs', 'POST', 200, 1000],
    ['incoming', 'commands', 'POST', 200, 1000],
    ['outgoing', 'locations', 'PUT', 200, 1000],
    ['incoming', 'tokens', 'PUT', 200, 1000],
    ['outgoing', 'cdrs', 'POST', 401, 2001],
    ['outgoing', 'sessions', 'PUT', 200, 1000],
  ];
  for (let i = 0; i < 45; i += 1) {
    const [direction, module, method, statusCode, ocpiStatusCode] = r.pick(samples);
    const party = r.pick(parties.filter((p) => p.status !== 'registering'));
    logs.push({
      id: r.uuid(),
      timestamp: r.pastIso(3 * 86_400_000, now),
      partyId: party.id,
      partyName: party.name,
      direction,
      module,
      method,
      url:
        direction === 'outgoing'
          ? `${party.versionsUrl.replace('/versions', '')}/2.2.1/${module}`
          : `/ocpi/cpo/2.2.1/${module}`,
      statusCode,
      ocpiStatusCode,
      ocpiStatusMessage: ocpiStatusCode === 1000 ? 'Success' : 'Invalid or missing parameters',
      requestBody: null,
      responseBody: null,
      durationMs: r.int(40, 1400),
      error: statusCode >= 400 ? 'Token rejected by receiver' : null,
    });
  }
  logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { parties, tokens, ocpiCdrs, logs };
}
