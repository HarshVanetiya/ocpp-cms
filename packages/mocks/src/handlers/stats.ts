import type { DashboardStats, TimeRange, TimeSeries, TopStationsResponse } from '@ocpp/contracts';
import { world } from '../world';

/**
 * Derived analytics.
 *
 * Everything here is computed from the fixtures rather than invented, so the
 * KPI row and the sessions table always agree. When you write the real
 * versions, the same rule applies and it is the reason people trust a
 * dashboard: two screens must never disagree about the same number.
 */

const RANGE_MS: Record<TimeRange, number> = {
  '1h': 3600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  '12m': 365 * 86_400_000,
};

const BUCKETS: Record<TimeRange, { count: number; label: string }> = {
  '1h': { count: 30, label: '2m' },
  '24h': { count: 24, label: '1h' },
  '7d': { count: 28, label: '6h' },
  '30d': { count: 30, label: '1d' },
  '90d': { count: 30, label: '3d' },
  '12m': { count: 12, label: '1mo' },
};

function trend(current: number, previous: number) {
  const changePercent =
    previous === 0 ? (current === 0 ? 0 : null) : ((current - previous) / previous) * 100;
  return { value: current, previous, changePercent: changePercent === null ? null : Number(changePercent.toFixed(1)) };
}

export function dashboardStats(range: TimeRange): DashboardStats {
  const now = Date.now();
  const span = RANGE_MS[range];
  const from = now - span;
  const prevFrom = from - span;

  const { stations, sessions } = world.fixtures;
  const connectors = stations.flatMap((s) => s.evses.flatMap((e) => e.connectors));

  const inRange = sessions.filter((s) => s.startedAt && new Date(s.startedAt).getTime() >= from);
  const inPrev = sessions.filter(
    (s) =>
      s.startedAt &&
      new Date(s.startedAt).getTime() >= prevFrom &&
      new Date(s.startedAt).getTime() < from,
  );

  const completed = inRange.filter((s) => s.status === 'completed');
  const completedPrev = inPrev.filter((s) => s.status === 'completed');
  const active = sessions.filter((s) => s.status === 'active');

  const energy = inRange.reduce((sum, s) => sum + s.energyDeliveredWh, 0);
  const energyPrev = inPrev.reduce((sum, s) => sum + s.energyDeliveredWh, 0);
  const revenue = completed.reduce((sum, s) => sum + s.costMinor, 0);
  const revenuePrev = completedPrev.reduce((sum, s) => sum + s.costMinor, 0);

  const byStatus = {} as DashboardStats['connectors']['byStatus'];
  for (const c of connectors) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  }

  const online = stations.filter((s) => s.status === 'online').length;
  const busy = connectors.filter((c) =>
    ['charging', 'preparing', 'finishing', 'suspended_ev', 'suspended_evse'].includes(c.status),
  ).length;

  return {
    range,
    generatedAt: new Date(now).toISOString(),
    currency: 'EUR',
    stations: {
      total: stations.length,
      online,
      offline: stations.filter((s) => s.status === 'offline').length,
      faulted: stations.filter((s) =>
        s.evses.some((e) => e.connectors.some((c) => c.status === 'faulted')),
      ).length,
      availabilityPercent: Number(((online / Math.max(1, stations.length)) * 100).toFixed(1)),
    },
    connectors: {
      total: connectors.length,
      byStatus,
      utilizationPercent: Number(((busy / Math.max(1, connectors.length)) * 100).toFixed(1)),
    },
    sessions: {
      active: active.length,
      completed: trend(completed.length, completedPrev.length),
      failed: inRange.filter((s) => s.status === 'failed').length,
      avgDurationSeconds: Math.round(
        completed.reduce((sum, s) => sum + s.durationSeconds, 0) / Math.max(1, completed.length),
      ),
      avgEnergyWh: Math.round(
        completed.reduce((sum, s) => sum + s.energyDeliveredWh, 0) / Math.max(1, completed.length),
      ),
    },
    energy: {
      totalWh: trend(Math.round(energy), Math.round(energyPrev)),
      peakPowerKw: Number(
        active.reduce((sum, s) => sum + (s.currentPowerKw ?? 0), 0).toFixed(1),
      ),
    },
    revenue: {
      totalMinor: trend(revenue, revenuePrev),
      avgSessionMinor: Math.round(revenue / Math.max(1, completed.length)),
    },
    protocolSplit: {
      'ocpp1.6': stations.filter((s) => s.protocol === 'ocpp1.6').length,
      'ocpp2.0.1': stations.filter((s) => s.protocol === 'ocpp2.0.1').length,
    },
  };
}

/**
 * Bucket sessions into a time series.
 *
 * Note that we bucket by START time and attribute the whole session's energy to
 * that bucket. That is a simplification — strictly the energy of a six-hour
 * session belongs spread across six hourly buckets. Real CPMS analytics do
 * spread it, using the meter values. Knowing that you simplified, and why, is
 * the difference between a shortcut and a mistake.
 */
export function timeSeries(
  metric: 'energy' | 'sessions' | 'revenue',
  range: TimeRange,
  groupBy: 'none' | 'protocol' = 'none',
): TimeSeries {
  const now = Date.now();
  const span = RANGE_MS[range];
  const { count, label } = BUCKETS[range];
  const bucketMs = span / count;
  const from = now - span;

  const relevant = world.fixtures.sessions.filter(
    (s) => s.startedAt && new Date(s.startedAt).getTime() >= from,
  );

  const keys = groupBy === 'protocol' ? (['ocpp1.6', 'ocpp2.0.1'] as const) : (['all'] as const);

  const series = keys.map((key) => {
    const points = Array.from({ length: count }, (_, i) => {
      const start = from + i * bucketMs;
      const end = start + bucketMs;
      const bucket = relevant.filter((s) => {
        const t = new Date(s.startedAt as string).getTime();
        if (t < start || t >= end) return false;
        return key === 'all' || s.protocol === key;
      });
      const value =
        metric === 'energy'
          ? bucket.reduce((sum, s) => sum + s.energyDeliveredWh, 0) / 1000
          : metric === 'revenue'
            ? bucket.reduce((sum, s) => sum + s.costMinor, 0) / 100
            : bucket.length;
      return { t: new Date(start).toISOString(), value: Number(value.toFixed(2)) };
    });

    return {
      key,
      label:
        key === 'ocpp1.6' ? 'OCPP 1.6J' : key === 'ocpp2.0.1' ? 'OCPP 2.0.1' : 'All stations',
      points,
    };
  });

  return {
    metric,
    unit: metric === 'energy' ? 'kWh' : metric === 'revenue' ? 'EUR' : 'sessions',
    range,
    bucket: label,
    series,
  };
}

export function topStations(range: TimeRange, limit: number): TopStationsResponse {
  const from = Date.now() - RANGE_MS[range];
  const byStation = new Map<string, { sessions: number; energyWh: number; revenueMinor: number }>();

  for (const s of world.fixtures.sessions) {
    if (!s.startedAt || new Date(s.startedAt).getTime() < from) continue;
    const entry = byStation.get(s.stationId) ?? { sessions: 0, energyWh: 0, revenueMinor: 0 };
    entry.sessions += 1;
    entry.energyWh += s.energyDeliveredWh;
    entry.revenueMinor += s.costMinor;
    byStation.set(s.stationId, entry);
  }

  const rows = [...byStation.entries()]
    .map(([stationId, agg]) => {
      const station = world.stationById(stationId);
      const location = station?.locationId ? world.locationById(station.locationId) : null;
      return {
        stationId,
        stationName: station?.name ?? 'Unknown',
        locationName: location?.name ?? null,
        sessions: agg.sessions,
        energyWh: Math.round(agg.energyWh),
        revenueMinor: agg.revenueMinor,
        utilizationPercent: Number(Math.min(100, (agg.sessions / 40) * 100).toFixed(1)),
      };
    })
    .sort((a, b) => b.energyWh - a.energyWh)
    .slice(0, limit);

  return { range, currency: 'EUR', data: rows };
}

/** Sites ranked for the driver app's "nearby" list. */
export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  // Haversine. Close enough for a list that is sorted, not navigated by.
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
