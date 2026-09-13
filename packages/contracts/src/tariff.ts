import { z } from 'zod';
import {
  CurrencySchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';

/**
 * Tariffs — how a session becomes a number.
 *
 * ## Why this looks more complicated than "price per kWh"
 *
 * It has to, and the reasons are all real:
 *
 *  - You want to charge less at night (time restrictions).
 *  - You want to charge for occupying the bay after the car is full
 *    (parking_time), otherwise one driver blocks a charger all day.
 *  - Some markets forbid selling electricity by the kWh unless you are a
 *    licensed utility, so operators bill by the minute instead (time).
 *  - You want a connection fee (flat).
 *  - DC and AC on the same site cost different amounts (power restrictions).
 *
 * We model this the way OCPI 2.2.1 does, because it is the standard every
 * roaming partner already speaks, and because copying a proven data model is
 * a legitimate engineering decision you can defend in an interview.
 *
 * ## The structure, in words
 *
 * A tariff has a list of ELEMENTS. Each element has:
 *   - PRICE COMPONENTS: what to charge and per what unit.
 *   - RESTRICTIONS: when this element applies.
 *
 * To price a session you walk the elements in order and use the FIRST one
 * whose restrictions match. That "first match wins" rule is the part people
 * get wrong — it means order is significant, so the UI must let operators
 * reorder elements.
 */

export const PriceComponentKindSchema = z.enum([
  'energy',
  'time',
  'flat',
  'parking_time',
]);
export type PriceComponentKind = z.infer<typeof PriceComponentKindSchema>;

export const PRICE_COMPONENT_UNIT: Record<PriceComponentKind, string> = {
  energy: 'kWh',
  time: 'hour charging',
  flat: 'session',
  parking_time: 'hour parked',
};

export const PriceComponentSchema = z.object({
  kind: PriceComponentKindSchema,
  /**
   * Price per unit, in minor units.
   *   energy       → per kWh
   *   time         → per hour of charging
   *   parking_time → per hour parked after charging stopped
   *   flat         → once per session
   */
  priceMinor: MoneyMinorSchema,
  /**
   * Billing increment, in the component's base unit (Wh for energy, seconds
   * for time). `stepSize: 1` bills exactly. `stepSize: 900` rounds time up to
   * the next 15 minutes.
   *
   * Rounding is ALWAYS up, and always at the end of the session, not per
   * sample. Rounding each meter sample and summing is a classic bug that
   * silently overcharges.
   */
  stepSize: z.number().int().positive().default(1),
  vatPercent: z.number().min(0).max(100).nullable().optional(),
});
export type PriceComponent = z.infer<typeof PriceComponentSchema>;

export const TariffRestrictionsSchema = z.object({
  /** Local time "HH:mm". A window that wraps midnight (22:00-06:00) is legal. */
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  startDate: z.string().nullable().optional().describe('YYYY-MM-DD'),
  endDate: z.string().nullable().optional(),
  minKwh: z.number().nullable().optional(),
  maxKwh: z.number().nullable().optional(),
  minPowerKw: z.number().nullable().optional(),
  maxPowerKw: z.number().nullable().optional(),
  minDurationSeconds: z.number().int().nullable().optional(),
  maxDurationSeconds: z.number().int().nullable().optional(),
  dayOfWeek: z
    .array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']))
    .nullable()
    .optional(),
});
export type TariffRestrictions = z.infer<typeof TariffRestrictionsSchema>;

export const TariffElementSchema = z.object({
  id: IdSchema,
  priceComponents: z.array(PriceComponentSchema).min(1),
  restrictions: TariffRestrictionsSchema.nullable(),
});
export type TariffElement = z.infer<typeof TariffElementSchema>;

export const TariffSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  currency: CurrencySchema,
  /** Purely descriptive, used for the badge in the tariff list. */
  kind: z.enum(['simple', 'time_of_use', 'tiered', 'free']),
  elements: z.array(TariffElementSchema),
  /**
   * Minimum and maximum a session can cost under this tariff. Roaming
   * partners require these so a driver can be shown a worst case up front.
   */
  minPriceMinor: MoneyMinorSchema.nullable(),
  maxPriceMinor: MoneyMinorSchema.nullable(),
  active: z.boolean(),
  /** Stations this tariff is attached to. Empty = not yet assigned. */
  stationIds: z.array(IdSchema),
  stationCount: z.number().int().nonnegative(),
  validFrom: TimestampSchema.nullable(),
  validUntil: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Tariff = z.infer<typeof TariffSchema>;

export const TariffListQuerySchema = PageQuerySchema.extend({
  active: z.coerce.boolean().optional(),
  currency: CurrencySchema.optional(),
});
export type TariffListQuery = z.infer<typeof TariffListQuerySchema>;

export const TariffListResponseSchema = paginated(TariffSchema);
export type TariffListResponse = z.infer<typeof TariffListResponseSchema>;

export const CreateTariffSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  currency: CurrencySchema,
  kind: z.enum(['simple', 'time_of_use', 'tiered', 'free']).default('simple'),
  elements: z
    .array(
      z.object({
        priceComponents: z.array(PriceComponentSchema).min(1),
        restrictions: TariffRestrictionsSchema.nullable().optional(),
      }),
    )
    .min(1),
  minPriceMinor: MoneyMinorSchema.nullable().optional(),
  maxPriceMinor: MoneyMinorSchema.nullable().optional(),
  active: z.boolean().default(true),
  stationIds: z.array(IdSchema).default([]),
  validFrom: TimestampSchema.nullable().optional(),
  validUntil: TimestampSchema.nullable().optional(),
});
export type CreateTariff = z.infer<typeof CreateTariffSchema>;

export const UpdateTariffSchema = CreateTariffSchema.partial();
export type UpdateTariff = z.infer<typeof UpdateTariffSchema>;

/**
 * "What would this session have cost?"
 *
 * Implement this endpoint and the tariff editor gets a live preview panel.
 * It is also the cheapest possible test for your pricing engine: every bug
 * you fix here becomes an obvious wrong number on screen.
 */
export const TariffPreviewRequestSchema = z.object({
  energyKwh: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  parkingMinutes: z.number().nonnegative().default(0),
  startedAt: TimestampSchema.optional(),
  powerKw: z.number().nonnegative().optional(),
});
export type TariffPreviewRequest = z.infer<typeof TariffPreviewRequestSchema>;

export const TariffPreviewResponseSchema = z.object({
  currency: CurrencySchema,
  totalMinor: MoneyMinorSchema,
  breakdown: z.array(
    z.object({
      elementIndex: z.number().int(),
      label: z.string(),
      kind: PriceComponentKindSchema,
      quantity: z.number(),
      unit: z.string(),
      unitPriceMinor: MoneyMinorSchema,
      amountMinor: MoneyMinorSchema,
    }),
  ),
  /** Which element matched, and which were skipped and why. Great for debugging. */
  trace: z.array(
    z.object({
      elementIndex: z.number().int(),
      matched: z.boolean(),
      reason: z.string(),
    }),
  ),
});
export type TariffPreviewResponse = z.infer<typeof TariffPreviewResponseSchema>;
