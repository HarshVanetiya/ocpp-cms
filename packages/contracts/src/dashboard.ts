import { z } from 'zod';
import { CurrencySchema, IdSchema, MoneyMinorSchema, TimestampSchema } from './common';
import { ConnectorStatusSchema, ProtocolSchema } from './enums';

/**
 * Aggregates for the overview screen.
 *
 * ## Do not compute these live from the transactions table
 *
 * `SELECT sum(energy) FROM sessions WHERE started_at > now() - interval '1 day'`
 * is fine with 10,000 rows and a disaster with 10,000,000. The overview page
 * is the most-viewed screen in any CPMS and it must not be the slowest.
 *
 * The docs cover three strategies in order of effort:
 *   1. Compute live. Correct, fine to start with, and what you will do first.
 *   2. Cache in Redis for 30 seconds. Ten lines, removes almost all the load.
 *   3. Maintain rollup tables written by the session-ended handler.
 *
 * Ship (1), measure, then move to (2). Knowing WHEN to do (3) is the
 * interesting part, and "when the p95 on /dashboard/stats crossed 300ms" is a
 * much better answer than "microservices".
 */

export const TimeRangeSchema = z.enum(['1h', '24h', '7d', '30d', '90d', '12m']);
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/** A value with its change versus the preceding, equal-length period. */
export const TrendValueSchema = z.object({
  value: z.number(),
  previous: z.number(),
  changePercent: z.number().nullable(),
});
export type TrendValue = z.infer<typeof TrendValueSchema>;

export const DashboardStatsSchema = z.object({
  range: TimeRangeSchema,
  generatedAt: TimestampSchema,
  currency: CurrencySchema,

  stations: z.object({
    total: z.number().int(),
    online: z.number().int(),
    offline: z.number().int(),
    faulted: z.number().int(),
    /** Online / total, as a percentage. The number an SLA is written against. */
    availabilityPercent: z.number(),
  }),

  connectors: z.object({
    total: z.number().int(),
    /**
     * PARTIAL on purpose.
     *
     * `z.record(enum, …)` demands every enum key be present, so a fleet that
     * happens to have no reserved connectors would fail validation. A stats
     * endpoint should be allowed to omit the zeroes — the UI treats a missing
     * key as 0. (This is not hypothetical: it is the first bug this project's
     * own response validation caught.)
     */
    byStatus: z.partialRecord(ConnectorStatusSchema, z.number().int()),
    /** Share of connectors that spent the period occupied. */
    utilizationPercent: z.number(),
  }),

  sessions: z.object({
    active: z.number().int(),
    completed: TrendValueSchema,
    failed: z.number().int(),
    avgDurationSeconds: z.number(),
    avgEnergyWh: z.number(),
  }),

  energy: z.object({
    totalWh: TrendValueSchema,
    peakPowerKw: z.number(),
  }),

  revenue: z.object({
    totalMinor: TrendValueSchema,
    avgSessionMinor: MoneyMinorSchema,
  }),

  /** Partial for the same reason as `byStatus` above. */
  protocolSplit: z.partialRecord(ProtocolSchema, z.number().int()),
});
export type DashboardStats = z.infer<typeof DashboardStatsSchema>;

export const TimeSeriesPointSchema = z.object({
  t: TimestampSchema,
  value: z.number(),
});
export type TimeSeriesPoint = z.infer<typeof TimeSeriesPointSchema>;

export const TimeSeriesSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  range: TimeRangeSchema,
  bucket: z.string().describe('The bucket width actually used, e.g. 1h'),
  series: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      points: z.array(TimeSeriesPointSchema),
    }),
  ),
});
export type TimeSeries = z.infer<typeof TimeSeriesSchema>;

export const TimeSeriesQuerySchema = z.object({
  range: TimeRangeSchema.default('24h'),
  /** Split the series by a dimension instead of returning one line. */
  groupBy: z.enum(['none', 'protocol', 'location', 'station']).default('none'),
  locationId: IdSchema.optional(),
  stationId: IdSchema.optional(),
});
export type TimeSeriesQuery = z.infer<typeof TimeSeriesQuerySchema>;

/** Small feed on the overview page: the last few notable things that happened. */
export const ActivityItemSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  kind: z.enum([
    'session_started',
    'session_ended',
    'station_online',
    'station_offline',
    'station_faulted',
    'command_sent',
    'payment_captured',
    'auth_rejected',
  ]),
  title: z.string(),
  description: z.string(),
  stationId: IdSchema.nullable(),
  stationName: z.string().nullable(),
  sessionId: IdSchema.nullable(),
  severity: z.enum(['info', 'success', 'warning', 'danger']),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const ActivityResponseSchema = z.object({ data: z.array(ActivityItemSchema) });
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** Leaderboards on the overview page. */
export const TopStationSchema = z.object({
  stationId: IdSchema,
  stationName: z.string(),
  locationName: z.string().nullable(),
  sessions: z.number().int(),
  energyWh: z.number(),
  revenueMinor: MoneyMinorSchema,
  utilizationPercent: z.number(),
});
export type TopStation = z.infer<typeof TopStationSchema>;

export const TopStationsResponseSchema = z.object({
  range: TimeRangeSchema,
  currency: CurrencySchema,
  data: z.array(TopStationSchema),
});
export type TopStationsResponse = z.infer<typeof TopStationsResponseSchema>;
