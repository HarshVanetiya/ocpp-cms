import type {
  AuthorizationRecord,
  Cdr,
  Location,
  Payment,
  Session,
  SessionStatus,
  Station,
  Tariff,
  Token,
  User,
} from '@ocpp/contracts';
import type { Rng } from './random';

/**
 * Sessions, and the money that follows them.
 *
 * The shapes here are the ones the pricing engine you write must reproduce.
 * Everything is derived rather than random where it can be: cost comes from
 * the tariff and the energy, not from a dice roll, so the numbers on screen
 * add up if you check them.
 */

/**
 * Price a session under a tariff.
 *
 * A deliberately simplified version of the engine described in the tariff
 * milestone — it walks elements, takes the first whose restrictions match,
 * and applies every price component in it. Reading this before you write the
 * real one is a shortcut worth taking.
 */
export function priceSession(
  tariff: Tariff | undefined,
  input: { energyWh: number; durationSeconds: number; parkingSeconds: number; startedAt: string },
): { totalMinor: number; breakdown: Session['costBreakdown'] } {
  if (!tariff) return { totalMinor: 0, breakdown: [] };

  const started = new Date(input.startedAt);
  const hhmm = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;

  const element =
    tariff.elements.find((el) => {
      const rest = el.restrictions;
      if (!rest) return true;
      if (rest.startTime && rest.endTime) {
        // A window that wraps midnight (23:00–07:00) is legal and is the
        // case people forget: the comparison flips when start > end.
        const wraps = rest.startTime > rest.endTime;
        const inside = wraps
          ? hhmm >= rest.startTime || hhmm < rest.endTime
          : hhmm >= rest.startTime && hhmm < rest.endTime;
        if (!inside) return false;
      }
      return true;
    }) ?? tariff.elements[0];

  const breakdown: Session['costBreakdown'] = [];
  let total = 0;

  for (const pc of element?.priceComponents ?? []) {
    if (pc.kind === 'flat') {
      breakdown.push({
        label: 'Session fee',
        kind: 'flat',
        quantity: 1,
        unit: 'session',
        unitPriceMinor: pc.priceMinor,
        amountMinor: pc.priceMinor,
      });
      total += pc.priceMinor;
    } else if (pc.kind === 'energy') {
      // Round the billable quantity UP once, at the end — never per sample.
      const billableWh = Math.ceil(input.energyWh / pc.stepSize) * pc.stepSize;
      const kwh = billableWh / 1000;
      const amount = Math.round(kwh * pc.priceMinor);
      breakdown.push({
        label: 'Energy',
        kind: 'energy',
        quantity: Number(kwh.toFixed(3)),
        unit: 'kWh',
        unitPriceMinor: pc.priceMinor,
        amountMinor: amount,
      });
      total += amount;
    } else if (pc.kind === 'time') {
      const billable = Math.ceil(input.durationSeconds / pc.stepSize) * pc.stepSize;
      const hours = billable / 3600;
      const amount = Math.round(hours * pc.priceMinor);
      breakdown.push({
        label: 'Time',
        kind: 'time',
        quantity: Number(hours.toFixed(3)),
        unit: 'h',
        unitPriceMinor: pc.priceMinor,
        amountMinor: amount,
      });
      total += amount;
    } else if (pc.kind === 'parking_time' && input.parkingSeconds > 0) {
      const billable = Math.ceil(input.parkingSeconds / pc.stepSize) * pc.stepSize;
      const hours = billable / 3600;
      const amount = Math.round(hours * pc.priceMinor);
      breakdown.push({
        label: 'Idle time',
        kind: 'parking_time',
        quantity: Number(hours.toFixed(3)),
        unit: 'h',
        unitPriceMinor: pc.priceMinor,
        amountMinor: amount,
      });
      total += amount;
    }
  }

  return { totalMinor: total, breakdown };
}

export interface SessionBuildResult {
  sessions: Session[];
  cdrs: Cdr[];
  payments: Payment[];
  authorizations: AuthorizationRecord[];
}

export function buildSessions(
  r: Rng,
  ctx: {
    stations: Station[];
    locations: Location[];
    tokens: Token[];
    users: User[];
    tariffs: Tariff[];
    now: number;
  },
): SessionBuildResult {
  const { stations, locations, tokens, users, tariffs, now } = ctx;
  const sessions: Session[] = [];
  const cdrs: Cdr[] = [];
  const payments: Payment[] = [];
  const authorizations: AuthorizationRecord[] = [];

  const locById = new Map(locations.map((l) => [l.id, l]));
  const tariffById = new Map(tariffs.map((t) => [t.id, t]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const activeTokens = tokens.filter((t) => t.status === 'active');
  const onlineStations = stations.filter((s) => s.status === 'online');

  let cdrSeq = 4100;
  let txSeq = 48000;

  function makeSession(status: SessionStatus, startedAtMs: number): Session | null {
    const station = r.pick(status === 'active' ? onlineStations : stations);
    if (!station) return null;
    const evse = r.pick(station.evses);
    const connector = r.pick(evse.connectors);
    const token = r.pick(activeTokens);
    if (!token) return null;
    const user = token.userId ? userById.get(token.userId) : undefined;
    const loc = station.locationId ? locById.get(station.locationId) : undefined;
    const tariff = station.tariffId ? tariffById.get(station.tariffId) : undefined;

    const isDc = connector.powerType === 'dc';
    // DC sessions are short and big; AC sessions are long and small. Using one
    // distribution for both makes every chart look wrong.
    const durationSeconds =
      status === 'active'
        ? Math.floor((now - startedAtMs) / 1000)
        : isDc
          ? r.int(600, 3600)
          : r.int(1800, 8 * 3600);

    const effectiveKw = Math.min(connector.maxPowerKw, isDc ? r.float(40, 150, 1) : r.float(3.5, 11, 1));
    const energyWh = Math.round((effectiveKw * durationSeconds) / 3.6);
    const meterStartWh = r.int(1_000_000, 9_000_000);

    const startedAt = new Date(startedAtMs).toISOString();
    const endedAtMs = startedAtMs + durationSeconds * 1000;
    const parkingSeconds = status === 'completed' && isDc && r.bool(0.25) ? r.int(300, 5400) : 0;

    const { totalMinor, breakdown } = priceSession(tariff, {
      energyWh,
      durationSeconds,
      parkingSeconds,
      startedAt,
    });

    const sessionId = r.uuid();

    // Driver-app sessions are prepaid: an amount is authorised up front and
    // captured down to the real cost at the end.
    const prepaid = token.type === 'app_user';
    let paymentId: string | null = null;
    let authorizedAmountMinor: number | null = null;

    if (prepaid) {
      // Drivers type round numbers.
      authorizedAmountMinor = r.pick([1000, 1500, 2000, 2500, 3000, 4000, 5000]);
      const payment: Payment = {
        id: r.uuid(),
        reference: `PAY-${r.int(100000, 999999)}`,
        status:
          status === 'completed' ? 'captured' : status === 'active' ? 'authorized' : 'cancelled',
        provider: 'dummy',
        userId: user?.id ?? null,
        userName: user?.name ?? null,
        sessionId,
        stationIdentity: station.identity,
        currency: 'EUR',
        authorizedAmountMinor,
        capturedAmountMinor:
          status === 'completed' ? Math.min(totalMinor, authorizedAmountMinor) : null,
        refundedAmountMinor:
          status === 'completed' ? Math.max(0, authorizedAmountMinor - totalMinor) : null,
        failureCode: null,
        failureMessage: null,
        createdAt: startedAt,
        authorizedAt: startedAt,
        capturedAt: status === 'completed' ? new Date(endedAtMs).toISOString() : null,
        refundedAt: null,
        expiresAt: new Date(startedAtMs + 24 * 3600_000).toISOString(),
      };
      payments.push(payment);
      paymentId = payment.id;
    }

    const session: Session = {
      id: sessionId,
      transactionId:
        status === 'pending'
          ? null
          : station.protocol === 'ocpp1.6'
            ? String(txSeq++)
            // 2.0.1 transaction ids are station-allocated strings, so they look
            // nothing like the CSMS's neat sequence in 1.6.
            : `${station.identity.toLowerCase()}-${r.uuid().slice(0, 8)}`,
      protocol: station.protocol,
      status,
      stationId: station.id,
      stationIdentity: station.identity,
      stationName: station.name,
      locationId: loc?.id ?? null,
      locationName: loc?.name ?? null,
      evseId: evse.evseId,
      connectorId: connector.connectorId,
      idToken: {
        value: token.value,
        type: token.type,
        tokenId: token.id,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
      },
      startedAt: status === 'pending' ? null : startedAt,
      endedAt: status === 'completed' || status === 'failed' ? new Date(endedAtMs).toISOString() : null,
      durationSeconds,
      meterStartWh: status === 'pending' ? null : meterStartWh,
      meterStopWh: status === 'completed' ? meterStartWh + energyWh : null,
      energyDeliveredWh: status === 'pending' ? 0 : energyWh,
      currentPowerKw: status === 'active' ? effectiveKw : null,
      currentSoc: status === 'active' ? r.int(30, 92) : null,
      stopReason:
        status === 'completed'
          ? r.weighted([
              ['ev_disconnected', 6],
              ['local', 3],
              ['remote', 2],
              ['energy_limit_reached', 1],
            ] as const)
          : status === 'failed'
            ? r.pick(['power_loss', 'emergency_stop', 'de_authorized'] as const)
            : null,
      tariffId: tariff?.id ?? null,
      tariffName: tariff?.name ?? null,
      currency: 'EUR',
      costMinor: status === 'pending' ? 0 : totalMinor,
      costBreakdown: status === 'pending' ? [] : breakdown,
      paymentId,
      authorizedAmountMinor,
      cdrId: null,
      createdAt: startedAt,
      updatedAt: new Date(status === 'active' ? now : endedAtMs).toISOString(),
    };

    if (status === 'completed') {
      const cdr: Cdr = {
        id: r.uuid(),
        sessionId: session.id,
        reference: `CDR-${cdrSeq++}`,
        stationIdentity: station.identity,
        locationName: loc?.name ?? null,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
        tokenValue: token.value,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationSeconds,
        energyDeliveredWh: energyWh,
        currency: 'EUR',
        totalCostMinor: totalMinor,
        totalEnergyCostMinor: breakdown.find((b) => b.kind === 'energy')?.amountMinor ?? 0,
        totalTimeCostMinor: breakdown.find((b) => b.kind === 'time')?.amountMinor ?? 0,
        totalFlatCostMinor: breakdown.find((b) => b.kind === 'flat')?.amountMinor ?? 0,
        totalParkingCostMinor: breakdown.find((b) => b.kind === 'parking_time')?.amountMinor ?? 0,
        vatPercent: 21,
        tariffId: tariff?.id ?? null,
        // Frozen copy: tariffs change, a CDR must stay reproducible from itself.
        tariffSnapshot: tariff ? { name: tariff.name, elements: tariff.elements } : null,
        paymentId,
        issuedAt: new Date(endedAtMs + 2000).toISOString(),
        ocpiPushedAt: null,
      };
      cdrs.push(cdr);
      session.cdrId = cdr.id;

      if (user) {
        user.sessionCount += 1;
        user.totalEnergyWh += energyWh;
        user.totalSpentMinor += totalMinor;
      }
    }

    // Every session has an authorization decision behind it.
    authorizations.push({
      id: r.uuid(),
      timestamp: new Date(startedAtMs - 2000).toISOString(),
      stationId: station.id,
      stationIdentity: station.identity,
      evseId: evse.evseId,
      tokenValue: token.value,
      tokenType: token.type,
      tokenId: token.id,
      userId: user?.id ?? null,
      userName: user?.name ?? null,
      result: 'accepted',
      reason: null,
      source: r.weighted([
        ['csms', 7],
        ['auth_cache', 2],
        ['local_list', 1],
      ] as const),
      latencyMs: r.int(8, 120),
    });

    return session;
  }

  // ---- historical sessions, weighted towards the last week ----
  for (let i = 0; i < 420; i += 1) {
    const ageMs = (r() ** 2) * 30 * 86_400_000;
    const status: SessionStatus = r.weighted([
      ['completed', 92],
      ['failed', 5],
      ['cancelled', 3],
    ] as const);
    const s = makeSession(status, now - ageMs - 3600_000);
    if (s) sessions.push(s);
  }

  // ---- live sessions, attached to connectors that say they are charging ----
  const chargingConnectors = stations
    .filter((s) => s.status === 'online')
    .flatMap((s) =>
      s.evses.flatMap((e) =>
        e.connectors
          .filter((c) => c.status === 'charging' || c.status === 'suspended_ev')
          .map((c) => ({ station: s, evse: e, connector: c })),
      ),
    );

  for (const { station, evse, connector } of chargingConnectors) {
    const startedAtMs = now - r.int(120, 9000) * 1000;
    const s = makeSession('active', startedAtMs);
    if (!s) continue;
    // Re-point the generated session at the connector that is actually busy,
    // so the station detail page and the sessions list agree.
    s.stationId = station.id;
    s.stationIdentity = station.identity;
    s.stationName = station.name;
    s.evseId = evse.evseId;
    s.connectorId = connector.connectorId;
    connector.activeSessionId = s.id;
    sessions.push(s);
  }

  // ---- a few rejected authorizations, for the support screens ----
  for (let i = 0; i < 40; i += 1) {
    const station = r.pick(stations);
    const token = r.pick(tokens);
    const user = token.userId ? userById.get(token.userId) : undefined;
    const result = r.weighted([
      ['invalid', 5],
      ['expired', 3],
      ['blocked', 3],
      ['concurrent_tx', 1],
      ['no_credit', 2],
    ] as const);
    authorizations.push({
      id: r.uuid(),
      timestamp: r.pastIso(14 * 86_400_000, now),
      stationId: station.id,
      stationIdentity: station.identity,
      evseId: r.pick(station.evses).evseId,
      tokenValue: result === 'invalid' ? `UNKNOWN-${r.int(1000, 9999)}` : token.value,
      tokenType: token.type,
      tokenId: result === 'invalid' ? null : token.id,
      userId: result === 'invalid' ? null : (user?.id ?? null),
      userName: result === 'invalid' ? null : (user?.name ?? null),
      result,
      reason:
        result === 'expired'
          ? 'Token validity ended 2026-07-01'
          : result === 'no_credit'
            ? 'Account balance is zero'
            : result === 'concurrent_tx'
              ? 'Token already charging at CP-RTM-0012'
              : null,
      source: 'csms',
      latencyMs: r.int(6, 90),
    });
  }

  authorizations.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  sessions.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  cdrs.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  payments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { sessions, cdrs, payments, authorizations };
}
