import { z } from 'zod';
import {
  CurrencySchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import { TokenStatusSchema, TokenTypeSchema, UserRoleSchema, UserStatusSchema } from './enums';

/**
 * Users and tokens.
 *
 * ## Two kinds of people
 *
 * A CPMS has operators (people who log into the dashboard) and drivers
 * (people who charge cars). It is tempting to build two tables. Do not — in
 * the real world an operator also drives, and you end up duplicating them.
 *
 * One `users` table, a `role` column, and a separate `tokens` table for the
 * physical things that identify someone at a charger. `role: 'driver'` gets
 * no dashboard access; `role: 'admin' | 'operator' | 'viewer'` does.
 *
 * ## Why tokens are their own entity
 *
 * A driver can have several: an RFID card in the car, a second card at home,
 * and the phone app. Each must be revocable on its own — losing a card should
 * not lock you out of the app. So `tokens` is a child table of `users`, and
 * authorization looks up the TOKEN, then walks to the user.
 */

export const UserSchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string(),
  phone: z.string().nullable(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  avatarUrl: z.string().nullable(),

  /**
   * Prepaid balance for drivers. Operators have `null`.
   * In this project the money is fake — see `payment.ts`.
   */
  balanceMinor: MoneyMinorSchema.nullable(),
  currency: CurrencySchema.nullable(),

  /** Denormalised counters, cheap to maintain and expensive to compute live. */
  tokenCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  totalEnergyWh: z.number().nonnegative(),
  totalSpentMinor: MoneyMinorSchema,

  /** Optional grouping for fleet/corporate accounts. */
  groupId: IdSchema.nullable(),
  groupName: z.string().nullable(),

  lastLoginAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type User = z.infer<typeof UserSchema>;

export const UserListQuerySchema = PageQuerySchema.extend({
  role: UserRoleSchema.optional(),
  status: UserStatusSchema.optional(),
  groupId: IdSchema.optional(),
});
export type UserListQuery = z.infer<typeof UserListQuerySchema>;

export const UserListResponseSchema = paginated(UserSchema);
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

export const CreateUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1),
  phone: z.string().optional(),
  role: UserRoleSchema.default('driver'),
  groupId: IdSchema.nullable().optional(),
  /** Omit to send an invite instead of setting a password directly. */
  password: z.string().min(8).optional(),
  balanceMinor: MoneyMinorSchema.optional(),
  currency: CurrencySchema.optional(),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = CreateUserSchema.partial().omit({ password: true }).extend({
  status: UserStatusSchema.optional(),
});
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

/* ------------------------------------------------------------------ *
 * Tokens (RFID cards, app identities)
 * ------------------------------------------------------------------ */

export const TokenSchema = z.object({
  id: IdSchema,
  /**
   * The value that arrives on the wire in `idTag` (1.6) or `idToken.idToken`
   * (2.0.1).
   *
   * Two gotchas that will cost you an afternoon each:
   *  1. 1.6 caps `idTag` at 20 characters; 2.0.1 allows 36. Validate per
   *     protocol, not globally.
   *  2. RFID readers disagree about byte order and case. Normalise to
   *     uppercase hex without separators on the way in, and store the
   *     normalised form. Compare normalised to normalised, always.
   */
  value: z.string().min(1).max(36),
  type: TokenTypeSchema,
  status: TokenStatusSchema,
  label: z.string().nullable().describe('What the driver calls it: "car card", "keyring"'),

  userId: IdSchema.nullable(),
  userName: z.string().nullable(),
  groupId: IdSchema.nullable(),

  validFrom: TimestampSchema.nullable(),
  validUntil: TimestampSchema.nullable(),

  /**
   * Include this token in the SendLocalList we push to stations.
   *
   * Why it matters: a station that loses its network link can still charge
   * people on its local list. Without local lists, one flaky router takes a
   * whole site offline. With them, the site keeps working and reconciles
   * later. This is worth mentioning in an interview.
   */
  inLocalList: z.boolean(),

  lastUsedAt: TimestampSchema.nullable(),
  useCount: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Token = z.infer<typeof TokenSchema>;

export const TokenListQuerySchema = PageQuerySchema.extend({
  userId: IdSchema.optional(),
  status: TokenStatusSchema.optional(),
  type: TokenTypeSchema.optional(),
  inLocalList: z.coerce.boolean().optional(),
});
export type TokenListQuery = z.infer<typeof TokenListQuerySchema>;

export const TokenListResponseSchema = paginated(TokenSchema);
export type TokenListResponse = z.infer<typeof TokenListResponseSchema>;

export const CreateTokenSchema = z.object({
  value: z.string().min(1).max(36),
  type: TokenTypeSchema.default('rfid'),
  label: z.string().optional(),
  userId: IdSchema.nullable().optional(),
  validFrom: TimestampSchema.optional(),
  validUntil: TimestampSchema.nullable().optional(),
  inLocalList: z.boolean().default(true),
});
export type CreateToken = z.infer<typeof CreateTokenSchema>;

export const UpdateTokenSchema = CreateTokenSchema.partial().extend({
  status: TokenStatusSchema.optional(),
});
export type UpdateToken = z.infer<typeof UpdateTokenSchema>;

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type Login = z.infer<typeof LoginSchema>;

/**
 * Token pair. Short-lived access token, long-lived refresh token.
 *
 * `expiresIn` is SECONDS FROM NOW, not an absolute timestamp. Absolute
 * timestamps break as soon as a client's clock is wrong, and phone clocks are
 * wrong surprisingly often.
 */
export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().describe('Seconds until the access token expires'),
  tokenType: z.literal('Bearer'),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const AuthSessionSchema = z.object({
  user: UserSchema,
  tokens: AuthTokensSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const RefreshSchema = z.object({ refreshToken: z.string() });
export type Refresh = z.infer<typeof RefreshSchema>;

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

export const UserGroupSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  /** Group-wide tariff override, applied before the station's own tariff. */
  tariffId: IdSchema.nullable(),
  monthlyBudgetMinor: MoneyMinorSchema.nullable(),
  currency: CurrencySchema.nullable(),
  createdAt: TimestampSchema,
});
export type UserGroup = z.infer<typeof UserGroupSchema>;

export const UserGroupListResponseSchema = paginated(UserGroupSchema);
export type UserGroupListResponse = z.infer<typeof UserGroupListResponseSchema>;
