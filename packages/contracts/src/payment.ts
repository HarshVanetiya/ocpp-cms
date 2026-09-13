import { z } from 'zod';
import {
  CurrencySchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import { PaymentStatusSchema } from './enums';

/**
 * Payments — deliberately fake, deliberately realistic in shape.
 *
 * There is NO payment gateway in this project and there should not be one:
 * integrating Stripe teaches you Stripe, not charging. What you do need to
 * learn is the FLOW, because the flow is what makes charging payments
 * unusual, and it is what an interviewer will probe.
 *
 * ## The problem
 *
 * You cannot charge the card at the end, because the car may have driven
 * away and the card may decline. You cannot charge at the start, because you
 * do not know the amount yet.
 *
 * ## The answer: authorize then capture
 *
 *   1. AUTHORIZE  Before charging starts, reserve a maximum amount on the
 *                 card. The money is not taken, it is ring-fenced. In this
 *                 project the driver types this amount in themselves.
 *   2. CHARGE     The car charges. We meter it and price it live.
 *   3. CAPTURE    When the session ends we take the ACTUAL cost, which is
 *                 less than or equal to the authorized amount. The rest is
 *                 released.
 *
 * The station must also be told about the limit, otherwise the car happily
 * draws more energy than the driver paid for. That is what the
 * `set_charging_profile` command and the energy cap on the remote start are
 * for. Nothing else enforces it.
 *
 * ## What you implement
 *
 * A fake provider. `POST /payments/authorize` returns an id and marks it
 * authorized. `POST /payments/:id/capture` settles it. The docs show a
 * 60-line implementation with a configurable decline rate so you can test
 * the unhappy path, which is the only path worth testing.
 */

export const PaymentSchema = z.object({
  id: IdSchema,
  /** Our reference, shown to the driver. Not the provider's. */
  reference: z.string(),
  status: PaymentStatusSchema,
  provider: z.literal('dummy'),

  userId: IdSchema.nullable(),
  userName: z.string().nullable(),
  sessionId: IdSchema.nullable(),
  stationIdentity: z.string().nullable(),

  currency: CurrencySchema,
  /** What the driver asked to reserve. */
  authorizedAmountMinor: MoneyMinorSchema,
  /** What we actually took. Null until captured. */
  capturedAmountMinor: MoneyMinorSchema.nullable(),
  refundedAmountMinor: MoneyMinorSchema.nullable(),

  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),

  createdAt: TimestampSchema,
  authorizedAt: TimestampSchema.nullable(),
  capturedAt: TimestampSchema.nullable(),
  refundedAt: TimestampSchema.nullable(),
  /**
   * Authorizations expire. A real PSP releases a hold after ~7 days; we use
   * hours. If a session never starts, a scheduled job must void the hold —
   * otherwise the driver's money is stuck. Say this out loud in an interview.
   */
  expiresAt: TimestampSchema.nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const AuthorizePaymentSchema = z.object({
  /**
   * The amount the driver typed into the app, in minor units.
   * The UI collects a decimal and multiplies by 100 before it gets here.
   */
  amountMinor: MoneyMinorSchema.refine((v) => v > 0, 'Amount must be greater than zero'),
  currency: CurrencySchema,
  userId: IdSchema.optional(),
  stationIdentity: z.string().optional(),
  evseId: z.number().int().optional(),
  connectorId: z.number().int().optional(),
  /** Echoed back, so the driver app can correlate its own request. */
  idempotencyKey: z.string().optional().describe(
    'Send a UUID. If the same key arrives twice, return the SAME payment ' +
      'instead of creating a second one. Double-tapping a pay button must ' +
      'never take money twice.',
  ),
});
export type AuthorizePayment = z.infer<typeof AuthorizePaymentSchema>;

export const CapturePaymentSchema = z.object({
  /** Must be <= authorizedAmountMinor. Reject with 409 CONFLICT if it is not. */
  amountMinor: MoneyMinorSchema,
});
export type CapturePayment = z.infer<typeof CapturePaymentSchema>;

export const RefundPaymentSchema = z.object({
  amountMinor: MoneyMinorSchema.optional().describe('Omit for a full refund'),
  reason: z.string().optional(),
});
export type RefundPayment = z.infer<typeof RefundPaymentSchema>;

export const PaymentListQuerySchema = PageQuerySchema.extend({
  status: PaymentStatusSchema.optional(),
  userId: IdSchema.optional(),
  sessionId: IdSchema.optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
});
export type PaymentListQuery = z.infer<typeof PaymentListQuerySchema>;

export const PaymentListResponseSchema = paginated(PaymentSchema);
export type PaymentListResponse = z.infer<typeof PaymentListResponseSchema>;
