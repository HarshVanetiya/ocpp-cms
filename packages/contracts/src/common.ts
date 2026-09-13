import { z } from 'zod';

/**
 * Shared building blocks used by every endpoint in this contract.
 *
 * READ THIS FIRST if you are building the backend. Every list endpoint returns
 * the same envelope, every error returns the same envelope, and every money
 * value is an integer in minor units. Getting these three things consistent is
 * 80% of what makes an API feel professional.
 */

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** Every entity we own is identified by a UUID v4 string. */
export const IdSchema = z.string().min(1).describe('Opaque unique identifier (UUID v4)');

/** ISO-8601 timestamp, always UTC, always with a `Z` suffix. */
export const TimestampSchema = z.iso
  .datetime()
  .describe('ISO-8601 UTC timestamp, e.g. 2026-09-13T10:15:30.000Z');

/**
 * ISO-4217 currency code. We keep it a plain 3-letter string rather than an
 * enum so you can add currencies without changing the contract.
 */
export const CurrencySchema = z
  .string()
  .length(3)
  .describe('ISO-4217 currency code, e.g. EUR, USD, INR');

/**
 * Money is ALWAYS an integer in the currency's minor unit (cents, paise...).
 *
 * Why: floating point maths on money silently loses precision. `0.1 + 0.2` is
 * `0.30000000000000004` in JavaScript. A CDR that is off by a hundredth of a
 * cent is a billing dispute. Store integers, divide by 100 only when you
 * render. The frontend in this repo never does money maths in floats.
 */
export const MoneyMinorSchema = z
  .number()
  .int()
  .describe('Amount in the currency minor unit (1250 = 12.50)');

/** Geographic position. OCPI uses strings for lat/lon; we use numbers internally. */
export const GeoPointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

export const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string(),
  state: z.string().optional(),
  country: z.string().length(2).describe('ISO-3166 alpha-2 country code'),
});
export type Address = z.infer<typeof AddressSchema>;

/* ------------------------------------------------------------------ *
 * Pagination
 * ------------------------------------------------------------------ */

/**
 * Offset pagination for everything the operator browses (stations, users,
 * tariffs). Simple, supports "jump to page 7", and fine for tables.
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional().describe('Field name, prefix with - for descending: -createdAt'),
  search: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const PageMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

/**
 * Build a paginated response schema for any item schema.
 *
 * Backend rule: EVERY list endpoint returns `{ data: [...], meta: {...} }`.
 * Never a bare array — you can't add pagination to a bare array later without
 * breaking every client.
 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), meta: PageMetaSchema });
}
export type Paginated<T> = { data: T[]; meta: PageMeta };

/**
 * Cursor pagination, used only for the OCPP log feed.
 *
 * Why different: the log table grows while the operator is reading it. With
 * offset pagination, page 2 would show rows the user already saw on page 1
 * because new rows pushed everything down. A cursor anchored to a row id is
 * stable under inserts.
 */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional().describe('Opaque cursor from the previous response'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export function cursorPaginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  });
}
export type CursorPaginated<T> = {
  data: T[];
  meta: { nextCursor: string | null; hasMore: boolean };
};

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * One error shape for the whole API. The frontend has exactly one error
 * renderer because of this, and you should have exactly one error middleware.
 *
 * `code` is a stable machine-readable string — never change it once shipped.
 * `message` is for humans and may be reworded freely.
 * `details` carries field-level validation problems.
 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().describe('Stable machine-readable code, e.g. STATION_NOT_FOUND'),
    message: z.string().describe('Human-readable explanation'),
    details: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional()
      .describe('Field-level validation failures'),
    requestId: z.string().optional().describe('Correlation id, echo this in your logs'),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** The error codes the frontend special-cases. Return these exact strings. */
export const API_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT: 'CONFLICT',
  STATION_OFFLINE: 'STATION_OFFLINE',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  COMMAND_REJECTED: 'COMMAND_REJECTED',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

/**
 * `GET /api/v1/health` is the endpoint the frontend probes on boot in learn
 * mode to decide whether your backend is alive. Implement this one FIRST —
 * it is Milestone 0 in the docs and it makes the whole UI switch from mock
 * data to your data.
 */
export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  uptimeSeconds: z.number(),
  /** Which OCPP versions this CSMS currently accepts on its WebSocket endpoint. */
  protocols: z.array(z.string()).describe('e.g. ["ocpp1.6", "ocpp2.0.1"]'),
  dependencies: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['ok', 'degraded', 'down']),
        latencyMs: z.number().optional(),
      }),
    )
    .optional(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Standard no-content-ish acknowledgement for DELETE and action endpoints. */
export const AckSchema = z.object({ success: z.boolean() });
export type Ack = z.infer<typeof AckSchema>;
