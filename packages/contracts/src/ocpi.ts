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
 * OCPI — Open Charge Point Interface, version 2.2.1.
 *
 * ## What it is, in one paragraph
 *
 * OCPP connects a CPMS to CHARGERS. OCPI connects a CPMS to OTHER COMPANIES.
 * If a driver with a Shell card charges at an Ionity station, OCPI is how
 * Ionity tells Shell "your customer used 43 kWh, here is the bill" and how
 * Shell's app knew the station was free in the first place. Without roaming,
 * every driver needs an account with every network, which is the world EV
 * charging is slowly leaving behind.
 *
 * ## The two roles, and the one sentence that makes it click
 *
 *   CPO — Charge Point Operator. Owns the hardware. That is us.
 *   eMSP — e-Mobility Service Provider. Owns the customer relationship and
 *          issues the card or the app.
 *
 * A module is either something you PUSH or something you HOST, and the
 * direction depends on your role. As a CPO you HOST Locations (partners read
 * your sites), and you PUSH CDRs (you tell partners what to bill). As a CPO
 * you also RECEIVE Commands (a partner asks you to start a charge for their
 * customer) — and those turn straight into the OCPP remote commands you
 * already built. That is the whole point of doing OCPI after OCPP: it is a
 * thin shell over machinery that already exists.
 *
 * ## The handshake, which is the part everyone gets wrong
 *
 * OCPI's credentials exchange is a mutual token swap and it is genuinely
 * confusing the first time:
 *
 *   1. Out of band, partner gives you TOKEN_A.
 *   2. You GET their /versions and /versions/2.2.1 using TOKEN_A to discover
 *      their endpoints.
 *   3. You POST to their /credentials with TOKEN_A in the header and TOKEN_B
 *      (which you generate) in the body. TOKEN_B is what THEY will use to
 *      call YOU.
 *   4. They reply with TOKEN_C in the body. TOKEN_C is what YOU use to call
 *      THEM from now on. TOKEN_A is dead.
 *
 * So you end up storing two tokens per partner pointing in opposite
 * directions. Draw it on a whiteboard before you code it. `OcpiPartySchema`
 * below has a field for each, named so you cannot mix them up.
 *
 * Note: OCPI tokens go in `Authorization: Token <base64>` — the scheme is the
 * literal word "Token", not "Bearer". A surprising number of integrations
 * fail on that line alone.
 */

export const OcpiRoleSchema = z.enum(['CPO', 'EMSP', 'HUB', 'NSP', 'OTHER']);
export type OcpiRole = z.infer<typeof OcpiRoleSchema>;

export const OcpiModuleSchema = z.enum([
  'credentials',
  'locations',
  'sessions',
  'cdrs',
  'tariffs',
  'tokens',
  'commands',
  'chargingprofiles',
  'hubclientinfo',
]);
export type OcpiModule = z.infer<typeof OcpiModuleSchema>;

export const OcpiConnectionStatusSchema = z.enum([
  'not_registered',
  'registering',
  'connected',
  'error',
  'suspended',
]);
export type OcpiConnectionStatus = z.infer<typeof OcpiConnectionStatusSchema>;

export const OcpiEndpointSchema = z.object({
  module: z.string(),
  /** OCPI 2.2 added roles to endpoints: SENDER hosts data, RECEIVER consumes. */
  role: z.enum(['SENDER', 'RECEIVER']),
  url: z.string(),
  reachable: z.boolean().nullable(),
  lastCheckedAt: TimestampSchema.nullable(),
});
export type OcpiEndpoint = z.infer<typeof OcpiEndpointSchema>;

export const OcpiPartySchema = z.object({
  id: IdSchema,
  /** ISO-15118 style party identification: country code + party id. */
  countryCode: z.string().length(2),
  partyId: z.string().length(3),
  name: z.string(),
  role: OcpiRoleSchema,
  status: OcpiConnectionStatusSchema,
  versionsUrl: z.string(),
  selectedVersion: z.string().nullable(),

  /**
   * Two tokens, opposite directions. Never store them in one column.
   * `tokenForUs` is what THEY send to US. `tokenForThem` is what WE send.
   * Both are stored hashed in a real system; the API returns only a preview.
   */
  tokenForUsPreview: z.string().nullable(),
  tokenForThemPreview: z.string().nullable(),

  endpoints: z.array(OcpiEndpointSchema),
  modules: z.array(OcpiModuleSchema),

  lastHandshakeAt: TimestampSchema.nullable(),
  lastSyncAt: TimestampSchema.nullable(),
  lastError: z.string().nullable(),

  /** Counters, so the operator can see the integration is alive. */
  locationsPushed: z.number().int().nonnegative(),
  cdrsPushed: z.number().int().nonnegative(),
  tokensReceived: z.number().int().nonnegative(),
  commandsReceived: z.number().int().nonnegative(),

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type OcpiParty = z.infer<typeof OcpiPartySchema>;

export const OcpiPartyListResponseSchema = paginated(OcpiPartySchema);
export type OcpiPartyListResponse = z.infer<typeof OcpiPartyListResponseSchema>;

export const RegisterOcpiPartySchema = z.object({
  countryCode: z.string().length(2),
  partyId: z.string().length(3),
  name: z.string().min(1),
  role: OcpiRoleSchema,
  versionsUrl: z.string(),
  /** TOKEN_A, handed over out of band. Used once, then discarded. */
  tokenA: z.string().min(1),
});
export type RegisterOcpiParty = z.infer<typeof RegisterOcpiPartySchema>;

/** What the handshake did, step by step. The UI renders this as a timeline. */
export const OcpiHandshakeResultSchema = z.object({
  partyId: IdSchema,
  success: z.boolean(),
  steps: z.array(
    z.object({
      step: z.enum([
        'fetch_versions',
        'select_version',
        'fetch_endpoints',
        'post_credentials',
        'store_tokens',
      ]),
      status: z.enum(['pending', 'ok', 'failed']),
      detail: z.string(),
      durationMs: z.number().nullable(),
    }),
  ),
  error: z.string().nullable(),
});
export type OcpiHandshakeResult = z.infer<typeof OcpiHandshakeResultSchema>;

/* ------------------------------------------------------------------ *
 * OCPI traffic log
 * ------------------------------------------------------------------ */

/**
 * Same idea as the OCPP frame log, for HTTP. Roaming bugs are almost always
 * "we sent them something they rejected" and you cannot debug that without
 * the exact request and response bodies.
 */
export const OcpiRequestLogSchema = z.object({
  id: IdSchema,
  timestamp: TimestampSchema,
  partyId: IdSchema.nullable(),
  partyName: z.string().nullable(),
  direction: z.enum(['outgoing', 'incoming']),
  module: z.string(),
  method: z.string(),
  url: z.string(),
  statusCode: z.number().int().nullable(),
  /** OCPI's own status code, inside the body. 1000 = success. */
  ocpiStatusCode: z.number().int().nullable(),
  ocpiStatusMessage: z.string().nullable(),
  requestBody: z.unknown().nullable(),
  responseBody: z.unknown().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
});
export type OcpiRequestLog = z.infer<typeof OcpiRequestLogSchema>;

export const OcpiLogQuerySchema = PageQuerySchema.extend({
  partyId: IdSchema.optional(),
  direction: z.enum(['outgoing', 'incoming']).optional(),
  module: z.string().optional(),
  failedOnly: z.coerce.boolean().optional(),
});
export type OcpiLogQuery = z.infer<typeof OcpiLogQuerySchema>;

export const OcpiLogResponseSchema = paginated(OcpiRequestLogSchema);
export type OcpiLogResponse = z.infer<typeof OcpiLogResponseSchema>;

/* ------------------------------------------------------------------ *
 * OCPI tokens received from partners
 * ------------------------------------------------------------------ */

/**
 * Tokens belonging to OTHER networks' customers, which we must accept at our
 * chargers. An eMSP pushes their token list to us; we cache it and authorize
 * against the cache. If a token is not cached we can do a real-time
 * authorization request instead — that is the `ocpi_remote` source in
 * `AuthorizationRecord`.
 */
export const OcpiTokenSchema = z.object({
  id: IdSchema,
  partyId: IdSchema,
  partyName: z.string(),
  countryCode: z.string(),
  ocpiPartyId: z.string(),
  uid: z.string(),
  type: z.enum(['AD_HOC_USER', 'APP_USER', 'OTHER', 'RFID']),
  contractId: z.string().describe('eMAID — the driver identifier across networks'),
  visualNumber: z.string().nullable(),
  issuer: z.string(),
  valid: z.boolean(),
  whitelist: z.enum(['ALWAYS', 'ALLOWED', 'ALLOWED_OFFLINE', 'NEVER']),
  lastUpdated: TimestampSchema,
});
export type OcpiToken = z.infer<typeof OcpiTokenSchema>;

export const OcpiTokenListResponseSchema = paginated(OcpiTokenSchema);
export type OcpiTokenListResponse = z.infer<typeof OcpiTokenListResponseSchema>;

/* ------------------------------------------------------------------ *
 * OCPI CDRs pushed to partners
 * ------------------------------------------------------------------ */

export const OcpiCdrSchema = z.object({
  id: IdSchema,
  cdrId: IdSchema,
  partyId: IdSchema,
  partyName: z.string(),
  ocpiId: z.string(),
  sessionId: IdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  energyWh: z.number(),
  currency: CurrencySchema,
  totalCostMinor: MoneyMinorSchema,
  status: z.enum(['queued', 'pushed', 'acknowledged', 'failed']),
  attempts: z.number().int(),
  lastAttemptAt: TimestampSchema.nullable(),
  lastError: z.string().nullable(),
});
export type OcpiCdr = z.infer<typeof OcpiCdrSchema>;

export const OcpiCdrListResponseSchema = paginated(OcpiCdrSchema);
export type OcpiCdrListResponse = z.infer<typeof OcpiCdrListResponseSchema>;

export const OcpiSyncRequestSchema = z.object({
  modules: z.array(OcpiModuleSchema).default(['locations', 'cdrs', 'tokens']),
  full: z.boolean().default(false).describe('Ignore lastSyncAt and resend everything'),
});
export type OcpiSyncRequest = z.infer<typeof OcpiSyncRequestSchema>;
