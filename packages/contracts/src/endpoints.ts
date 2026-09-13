import { z } from 'zod';
import * as C from './common';
import * as Station from './station';
import * as Session from './session';
import * as UserMod from './user';
import * as Tariff from './tariff';
import * as Payment from './payment';
import * as LocationMod from './location';
import * as Logs from './logs';
import * as Dashboard from './dashboard';
import * as Driver from './driver';
import * as Ocpi from './ocpi';
import * as Sim from './simulator';

/**
 * THE ENDPOINT REGISTRY.
 *
 * Every HTTP endpoint in the system, in one list, with its schemas attached.
 * This single object drives four things:
 *
 *   1. The OpenAPI spec (`npm run contracts:openapi`).
 *   2. The mock backend — it knows exactly which routes to fake.
 *   3. The typed API client — no hand-written URL strings anywhere.
 *   4. Your progress tracker — the dashboard shows which endpoints your
 *      backend answers and which are still mocked.
 *
 * ## For the person building the backend
 *
 * This is your to-do list. Work down it in `milestone` order. Every entry
 * tells you the method, the path, what comes in, what must go out, and which
 * screen breaks if you get it wrong.
 *
 * You do NOT have to implement all of it. The milestones are ordered so that
 * the app becomes progressively more real. Milestone 8 alone (the first
 * fifteen endpoints) makes the dashboard fully live.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface EndpointDef {
  /** Stable key used by the client and the mocks. */
  id: string;
  method: HttpMethod;
  /** Path with `:param` placeholders, relative to the service base path. */
  path: string;
  /** Which service owns it — they may end up as separate deployments. */
  service: 'core' | 'sim';
  /** Grouping for docs and the OpenAPI tag. */
  group: string;
  summary: string;
  description?: string;
  /** Milestone from the docs at which you are expected to build this. */
  milestone: number;
  /** Zod schema for the query string, if any. */
  query?: z.ZodTypeAny;
  /** Zod schema for the JSON body, if any. */
  body?: z.ZodTypeAny;
  /** Zod schema for the 200/201 response body. */
  response: z.ZodTypeAny;
  /** Does this endpoint require an Authorization header? */
  auth: boolean;
  /** Which UI screens stop working without it. Helps you prioritise. */
  usedBy: readonly string[];
}

/**
 * `const` type parameter, and it matters.
 *
 * Without it TypeScript widens `path: '/stations/:id'` to plain `string`, and
 * the API client can no longer read the `:id` out of the path at the type
 * level — so `api.getStation({ params: { id } })` loses its checking and
 * silently accepts anything. The `const` keeps every literal narrow, which is
 * why `usedBy` above is a readonly array: const-inferred array literals are
 * readonly tuples.
 */
const e = <const T extends EndpointDef>(def: T): T => def;

/* ================================================================== *
 * CORE SERVICE — base path /api/v1
 * ================================================================== */

export const coreEndpoints = {
  /* ---------------------------- system ---------------------------- */
  health: e({
    id: 'health',
    method: 'GET',
    path: '/health',
    service: 'core',
    group: 'System',
    summary: 'Liveness probe and protocol advertisement',
    description:
      'The frontend probes this on boot in learn mode. Answer it and the UI ' +
      'switches from mock data to yours. Build this one first.',
    milestone: 0,
    response: C.HealthSchema,
    auth: false,
    usedBy: ['all'],
  }),

  /* ----------------------------- auth ----------------------------- */
  login: e({
    id: 'login',
    method: 'POST',
    path: '/auth/login',
    service: 'core',
    group: 'Auth',
    summary: 'Exchange email and password for a token pair',
    milestone: 8,
    body: UserMod.LoginSchema,
    response: UserMod.AuthSessionSchema,
    auth: false,
    usedBy: ['dashboard/login', 'driver/login'],
  }),
  refresh: e({
    id: 'refresh',
    method: 'POST',
    path: '/auth/refresh',
    service: 'core',
    group: 'Auth',
    summary: 'Exchange a refresh token for a new access token',
    milestone: 8,
    body: UserMod.RefreshSchema,
    response: UserMod.AuthTokensSchema,
    auth: false,
    usedBy: ['all'],
  }),
  logout: e({
    id: 'logout',
    method: 'POST',
    path: '/auth/logout',
    service: 'core',
    group: 'Auth',
    summary: 'Revoke the current refresh token',
    milestone: 8,
    response: C.AckSchema,
    auth: true,
    usedBy: ['all'],
  }),
  me: e({
    id: 'me',
    method: 'GET',
    path: '/auth/me',
    service: 'core',
    group: 'Auth',
    summary: 'The currently authenticated user',
    milestone: 8,
    response: UserMod.UserSchema,
    auth: true,
    usedBy: ['all'],
  }),

  /* --------------------------- dashboard -------------------------- */
  dashboardStats: e({
    id: 'dashboardStats',
    method: 'GET',
    path: '/dashboard/stats',
    service: 'core',
    group: 'Dashboard',
    summary: 'Headline KPIs with period-over-period trends',
    milestone: 8,
    query: z.object({ range: Dashboard.TimeRangeSchema.default('24h') }),
    response: Dashboard.DashboardStatsSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),
  energySeries: e({
    id: 'energySeries',
    method: 'GET',
    path: '/dashboard/series/energy',
    service: 'core',
    group: 'Dashboard',
    summary: 'Energy delivered over time, optionally split by a dimension',
    milestone: 8,
    query: Dashboard.TimeSeriesQuerySchema,
    response: Dashboard.TimeSeriesSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),
  sessionSeries: e({
    id: 'sessionSeries',
    method: 'GET',
    path: '/dashboard/series/sessions',
    service: 'core',
    group: 'Dashboard',
    summary: 'Session count over time',
    milestone: 8,
    query: Dashboard.TimeSeriesQuerySchema,
    response: Dashboard.TimeSeriesSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),
  revenueSeries: e({
    id: 'revenueSeries',
    method: 'GET',
    path: '/dashboard/series/revenue',
    service: 'core',
    group: 'Dashboard',
    summary: 'Revenue over time',
    milestone: 11,
    query: Dashboard.TimeSeriesQuerySchema,
    response: Dashboard.TimeSeriesSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),
  activity: e({
    id: 'activity',
    method: 'GET',
    path: '/dashboard/activity',
    service: 'core',
    group: 'Dashboard',
    summary: 'Recent notable events across the fleet',
    milestone: 8,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
    response: Dashboard.ActivityResponseSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),
  topStations: e({
    id: 'topStations',
    method: 'GET',
    path: '/dashboard/top-stations',
    service: 'core',
    group: 'Dashboard',
    summary: 'Busiest stations for the period',
    milestone: 8,
    query: z.object({
      range: Dashboard.TimeRangeSchema.default('30d'),
      limit: z.coerce.number().int().min(1).max(50).default(5),
    }),
    response: Dashboard.TopStationsResponseSchema,
    auth: true,
    usedBy: ['dashboard/overview'],
  }),

  /* --------------------------- stations --------------------------- */
  listStations: e({
    id: 'listStations',
    method: 'GET',
    path: '/stations',
    service: 'core',
    group: 'Stations',
    summary: 'Paginated, filterable station list',
    milestone: 8,
    query: Station.StationListQuerySchema,
    response: Station.StationListResponseSchema,
    auth: true,
    usedBy: ['dashboard/stations', 'dashboard/map'],
  }),
  getStation: e({
    id: 'getStation',
    method: 'GET',
    path: '/stations/:id',
    service: 'core',
    group: 'Stations',
    summary: 'Full station record including EVSEs and connectors',
    milestone: 8,
    response: Station.StationSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  createStation: e({
    id: 'createStation',
    method: 'POST',
    path: '/stations',
    service: 'core',
    group: 'Stations',
    summary: 'Register a station before it connects',
    description:
      'Registering ahead of time is what lets you REJECT a BootNotification ' +
      'from hardware you do not know about. An open CSMS that accepts anyone ' +
      'is a security problem.',
    milestone: 8,
    body: Station.CreateStationSchema,
    response: Station.StationSchema,
    auth: true,
    usedBy: ['dashboard/stations'],
  }),
  updateStation: e({
    id: 'updateStation',
    method: 'PATCH',
    path: '/stations/:id',
    service: 'core',
    group: 'Stations',
    summary: 'Edit station metadata',
    milestone: 8,
    body: Station.UpdateStationSchema,
    response: Station.StationSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  deleteStation: e({
    id: 'deleteStation',
    method: 'DELETE',
    path: '/stations/:id',
    service: 'core',
    group: 'Stations',
    summary: 'Remove a station',
    milestone: 8,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/stations'],
  }),
  getStationStats: e({
    id: 'getStationStats',
    method: 'GET',
    path: '/stations/:id/stats',
    service: 'core',
    group: 'Stations',
    summary: 'Per-station totals and uptime',
    milestone: 8,
    response: Station.StationStatsSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  getStationConfiguration: e({
    id: 'getStationConfiguration',
    method: 'GET',
    path: '/stations/:id/configuration',
    service: 'core',
    group: 'Stations',
    summary: 'Configuration keys (1.6) or device model variables (2.0.1)',
    milestone: 6,
    response: Station.StationConfigurationSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  updateStationConfiguration: e({
    id: 'updateStationConfiguration',
    method: 'PUT',
    path: '/stations/:id/configuration',
    service: 'core',
    group: 'Stations',
    summary: 'Write one configuration key or variable',
    milestone: 6,
    body: Station.UpdateConfigurationSchema,
    response: Station.CommandSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  sendCommand: e({
    id: 'sendCommand',
    method: 'POST',
    path: '/stations/:id/commands',
    service: 'core',
    group: 'Stations',
    summary: 'Issue a remote command to a station',
    description:
      'Returns immediately with status `queued` or `sent`. The real outcome ' +
      'arrives later over the realtime channel or by polling getCommand.',
    milestone: 6,
    body: Station.CreateCommandSchema,
    response: Station.CommandSchema,
    auth: true,
    usedBy: ['dashboard/station-detail', 'driver/charge'],
  }),
  listCommands: e({
    id: 'listCommands',
    method: 'GET',
    path: '/stations/:id/commands',
    service: 'core',
    group: 'Stations',
    summary: 'Command history for a station',
    milestone: 6,
    query: C.PageQuerySchema,
    response: C.paginated(Station.CommandSchema),
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),
  getCommand: e({
    id: 'getCommand',
    method: 'GET',
    path: '/commands/:id',
    service: 'core',
    group: 'Stations',
    summary: 'Poll one command for its outcome',
    milestone: 6,
    response: Station.CommandSchema,
    auth: true,
    usedBy: ['dashboard/station-detail'],
  }),

  /* --------------------------- sessions --------------------------- */
  listSessions: e({
    id: 'listSessions',
    method: 'GET',
    path: '/sessions',
    service: 'core',
    group: 'Sessions',
    summary: 'Paginated, filterable session list',
    milestone: 8,
    query: Session.SessionListQuerySchema,
    response: Session.SessionListResponseSchema,
    auth: true,
    usedBy: ['dashboard/sessions', 'dashboard/station-detail'],
  }),
  getSession: e({
    id: 'getSession',
    method: 'GET',
    path: '/sessions/:id',
    service: 'core',
    group: 'Sessions',
    summary: 'One session in full',
    milestone: 8,
    response: Session.SessionSchema,
    auth: true,
    usedBy: ['dashboard/session-detail'],
  }),
  getSessionMeterValues: e({
    id: 'getSessionMeterValues',
    method: 'GET',
    path: '/sessions/:id/meter-values',
    service: 'core',
    group: 'Sessions',
    summary: 'Meter samples for a session, optionally downsampled',
    milestone: 8,
    query: Session.MeterValueQuerySchema,
    response: Session.MeterValueResponseSchema,
    auth: true,
    usedBy: ['dashboard/session-detail'],
  }),
  stopSession: e({
    id: 'stopSession',
    method: 'POST',
    path: '/sessions/:id/stop',
    service: 'core',
    group: 'Sessions',
    summary: 'Remotely stop a running session',
    milestone: 6,
    body: Session.StopSessionSchema,
    response: Station.CommandSchema,
    auth: true,
    usedBy: ['dashboard/session-detail', 'dashboard/sessions'],
  }),
  listAuthorizations: e({
    id: 'listAuthorizations',
    method: 'GET',
    path: '/authorizations',
    service: 'core',
    group: 'Sessions',
    summary: 'Authorization decision log',
    milestone: 8,
    query: Session.AuthorizationListQuerySchema,
    response: Session.AuthorizationListResponseSchema,
    auth: true,
    usedBy: ['dashboard/authorizations'],
  }),
  listCdrs: e({
    id: 'listCdrs',
    method: 'GET',
    path: '/cdrs',
    service: 'core',
    group: 'Sessions',
    summary: 'Charge detail records',
    milestone: 11,
    query: Session.CdrListQuerySchema,
    response: Session.CdrListResponseSchema,
    auth: true,
    usedBy: ['dashboard/billing'],
  }),
  getCdr: e({
    id: 'getCdr',
    method: 'GET',
    path: '/cdrs/:id',
    service: 'core',
    group: 'Sessions',
    summary: 'One charge detail record',
    milestone: 11,
    response: Session.CdrSchema,
    auth: true,
    usedBy: ['dashboard/billing'],
  }),

  /* -------------------------- locations --------------------------- */
  listLocations: e({
    id: 'listLocations',
    method: 'GET',
    path: '/locations',
    service: 'core',
    group: 'Locations',
    summary: 'Sites, with aggregate connector counts',
    milestone: 8,
    query: LocationMod.LocationListQuerySchema,
    response: LocationMod.LocationListResponseSchema,
    auth: true,
    usedBy: ['dashboard/map', 'dashboard/locations'],
  }),
  getLocation: e({
    id: 'getLocation',
    method: 'GET',
    path: '/locations/:id',
    service: 'core',
    group: 'Locations',
    summary: 'One site',
    milestone: 8,
    response: LocationMod.LocationSchema,
    auth: true,
    usedBy: ['dashboard/location-detail'],
  }),
  createLocation: e({
    id: 'createLocation',
    method: 'POST',
    path: '/locations',
    service: 'core',
    group: 'Locations',
    summary: 'Create a site',
    milestone: 8,
    body: LocationMod.CreateLocationSchema,
    response: LocationMod.LocationSchema,
    auth: true,
    usedBy: ['dashboard/locations'],
  }),
  updateLocation: e({
    id: 'updateLocation',
    method: 'PATCH',
    path: '/locations/:id',
    service: 'core',
    group: 'Locations',
    summary: 'Edit a site',
    milestone: 8,
    body: LocationMod.UpdateLocationSchema,
    response: LocationMod.LocationSchema,
    auth: true,
    usedBy: ['dashboard/location-detail'],
  }),
  deleteLocation: e({
    id: 'deleteLocation',
    method: 'DELETE',
    path: '/locations/:id',
    service: 'core',
    group: 'Locations',
    summary: 'Delete a site',
    milestone: 8,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/locations'],
  }),

  /* ---------------------------- users ----------------------------- */
  listUsers: e({
    id: 'listUsers',
    method: 'GET',
    path: '/users',
    service: 'core',
    group: 'Users',
    summary: 'Paginated user list',
    milestone: 8,
    query: UserMod.UserListQuerySchema,
    response: UserMod.UserListResponseSchema,
    auth: true,
    usedBy: ['dashboard/users'],
  }),
  getUser: e({
    id: 'getUser',
    method: 'GET',
    path: '/users/:id',
    service: 'core',
    group: 'Users',
    summary: 'One user',
    milestone: 8,
    response: UserMod.UserSchema,
    auth: true,
    usedBy: ['dashboard/user-detail'],
  }),
  createUser: e({
    id: 'createUser',
    method: 'POST',
    path: '/users',
    service: 'core',
    group: 'Users',
    summary: 'Create a user or send an invite',
    milestone: 8,
    body: UserMod.CreateUserSchema,
    response: UserMod.UserSchema,
    auth: true,
    usedBy: ['dashboard/users'],
  }),
  updateUser: e({
    id: 'updateUser',
    method: 'PATCH',
    path: '/users/:id',
    service: 'core',
    group: 'Users',
    summary: 'Edit a user',
    milestone: 8,
    body: UserMod.UpdateUserSchema,
    response: UserMod.UserSchema,
    auth: true,
    usedBy: ['dashboard/user-detail'],
  }),
  deleteUser: e({
    id: 'deleteUser',
    method: 'DELETE',
    path: '/users/:id',
    service: 'core',
    group: 'Users',
    summary: 'Delete a user',
    milestone: 8,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/users'],
  }),
  listGroups: e({
    id: 'listGroups',
    method: 'GET',
    path: '/groups',
    service: 'core',
    group: 'Users',
    summary: 'Fleet / corporate account groups',
    milestone: 8,
    query: C.PageQuerySchema,
    response: UserMod.UserGroupListResponseSchema,
    auth: true,
    usedBy: ['dashboard/users'],
  }),

  /* ---------------------------- tokens ---------------------------- */
  listTokens: e({
    id: 'listTokens',
    method: 'GET',
    path: '/tokens',
    service: 'core',
    group: 'Tokens',
    summary: 'RFID cards and app identities',
    milestone: 8,
    query: UserMod.TokenListQuerySchema,
    response: UserMod.TokenListResponseSchema,
    auth: true,
    usedBy: ['dashboard/tokens', 'dashboard/user-detail'],
  }),
  getToken: e({
    id: 'getToken',
    method: 'GET',
    path: '/tokens/:id',
    service: 'core',
    group: 'Tokens',
    summary: 'One token',
    milestone: 8,
    response: UserMod.TokenSchema,
    auth: true,
    usedBy: ['dashboard/tokens'],
  }),
  createToken: e({
    id: 'createToken',
    method: 'POST',
    path: '/tokens',
    service: 'core',
    group: 'Tokens',
    summary: 'Issue a token',
    milestone: 8,
    body: UserMod.CreateTokenSchema,
    response: UserMod.TokenSchema,
    auth: true,
    usedBy: ['dashboard/tokens'],
  }),
  updateToken: e({
    id: 'updateToken',
    method: 'PATCH',
    path: '/tokens/:id',
    service: 'core',
    group: 'Tokens',
    summary: 'Edit or block a token',
    milestone: 8,
    body: UserMod.UpdateTokenSchema,
    response: UserMod.TokenSchema,
    auth: true,
    usedBy: ['dashboard/tokens'],
  }),
  deleteToken: e({
    id: 'deleteToken',
    method: 'DELETE',
    path: '/tokens/:id',
    service: 'core',
    group: 'Tokens',
    summary: 'Revoke a token',
    milestone: 8,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/tokens'],
  }),

  /* ---------------------------- tariffs --------------------------- */
  listTariffs: e({
    id: 'listTariffs',
    method: 'GET',
    path: '/tariffs',
    service: 'core',
    group: 'Tariffs',
    summary: 'Pricing rules',
    milestone: 11,
    query: Tariff.TariffListQuerySchema,
    response: Tariff.TariffListResponseSchema,
    auth: true,
    usedBy: ['dashboard/tariffs'],
  }),
  getTariff: e({
    id: 'getTariff',
    method: 'GET',
    path: '/tariffs/:id',
    service: 'core',
    group: 'Tariffs',
    summary: 'One tariff',
    milestone: 11,
    response: Tariff.TariffSchema,
    auth: true,
    usedBy: ['dashboard/tariff-detail'],
  }),
  createTariff: e({
    id: 'createTariff',
    method: 'POST',
    path: '/tariffs',
    service: 'core',
    group: 'Tariffs',
    summary: 'Create a tariff',
    milestone: 11,
    body: Tariff.CreateTariffSchema,
    response: Tariff.TariffSchema,
    auth: true,
    usedBy: ['dashboard/tariffs'],
  }),
  updateTariff: e({
    id: 'updateTariff',
    method: 'PATCH',
    path: '/tariffs/:id',
    service: 'core',
    group: 'Tariffs',
    summary: 'Edit a tariff',
    milestone: 11,
    body: Tariff.UpdateTariffSchema,
    response: Tariff.TariffSchema,
    auth: true,
    usedBy: ['dashboard/tariff-detail'],
  }),
  deleteTariff: e({
    id: 'deleteTariff',
    method: 'DELETE',
    path: '/tariffs/:id',
    service: 'core',
    group: 'Tariffs',
    summary: 'Delete a tariff',
    milestone: 11,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/tariffs'],
  }),
  previewTariff: e({
    id: 'previewTariff',
    method: 'POST',
    path: '/tariffs/:id/preview',
    service: 'core',
    group: 'Tariffs',
    summary: 'Price a hypothetical session, with a match trace',
    milestone: 11,
    body: Tariff.TariffPreviewRequestSchema,
    response: Tariff.TariffPreviewResponseSchema,
    auth: true,
    usedBy: ['dashboard/tariff-detail'],
  }),

  /* --------------------------- payments --------------------------- */
  authorizePayment: e({
    id: 'authorizePayment',
    method: 'POST',
    path: '/payments/authorize',
    service: 'core',
    group: 'Payments',
    summary: 'Ring-fence an amount before charging starts',
    milestone: 11,
    body: Payment.AuthorizePaymentSchema,
    response: Payment.PaymentSchema,
    auth: true,
    usedBy: ['driver/charge'],
  }),
  capturePayment: e({
    id: 'capturePayment',
    method: 'POST',
    path: '/payments/:id/capture',
    service: 'core',
    group: 'Payments',
    summary: 'Settle the actual cost and release the rest',
    milestone: 11,
    body: Payment.CapturePaymentSchema,
    response: Payment.PaymentSchema,
    auth: true,
    usedBy: ['backend-internal'],
  }),
  refundPayment: e({
    id: 'refundPayment',
    method: 'POST',
    path: '/payments/:id/refund',
    service: 'core',
    group: 'Payments',
    summary: 'Refund a captured payment',
    milestone: 11,
    body: Payment.RefundPaymentSchema,
    response: Payment.PaymentSchema,
    auth: true,
    usedBy: ['dashboard/billing'],
  }),
  getPayment: e({
    id: 'getPayment',
    method: 'GET',
    path: '/payments/:id',
    service: 'core',
    group: 'Payments',
    summary: 'One payment',
    milestone: 11,
    response: Payment.PaymentSchema,
    auth: true,
    usedBy: ['driver/charge', 'dashboard/billing'],
  }),
  listPayments: e({
    id: 'listPayments',
    method: 'GET',
    path: '/payments',
    service: 'core',
    group: 'Payments',
    summary: 'Payment list',
    milestone: 11,
    query: Payment.PaymentListQuerySchema,
    response: Payment.PaymentListResponseSchema,
    auth: true,
    usedBy: ['dashboard/billing'],
  }),

  /* ----------------------------- logs ----------------------------- */
  ocppLog: e({
    id: 'ocppLog',
    method: 'GET',
    path: '/logs/ocpp',
    service: 'core',
    group: 'Logs',
    summary: 'OCPP frame log, request and response stitched together',
    description: 'Cursor-paginated because new rows arrive while you read.',
    milestone: 9,
    query: Logs.OcppLogQuerySchema,
    response: Logs.OcppLogResponseSchema,
    auth: true,
    usedBy: ['dashboard/logs', 'dashboard/station-detail'],
  }),
  systemLog: e({
    id: 'systemLog',
    method: 'GET',
    path: '/logs/system',
    service: 'core',
    group: 'Logs',
    summary: 'Application log',
    milestone: 9,
    query: Logs.SystemLogQuerySchema,
    response: Logs.SystemLogResponseSchema,
    auth: true,
    usedBy: ['dashboard/logs'],
  }),
  auditLog: e({
    id: 'auditLog',
    method: 'GET',
    path: '/logs/audit',
    service: 'core',
    group: 'Logs',
    summary: 'Who changed what in the dashboard',
    milestone: 13,
    query: Logs.AuditQuerySchema,
    response: Logs.AuditResponseSchema,
    auth: true,
    usedBy: ['dashboard/logs'],
  }),

  /* ----------------------------- OCPI ----------------------------- */
  listOcpiParties: e({
    id: 'listOcpiParties',
    method: 'GET',
    path: '/ocpi/parties',
    service: 'core',
    group: 'OCPI',
    summary: 'Roaming partners',
    milestone: 12,
    query: C.PageQuerySchema,
    response: Ocpi.OcpiPartyListResponseSchema,
    auth: true,
    usedBy: ['dashboard/ocpi'],
  }),
  getOcpiParty: e({
    id: 'getOcpiParty',
    method: 'GET',
    path: '/ocpi/parties/:id',
    service: 'core',
    group: 'OCPI',
    summary: 'One roaming partner',
    milestone: 12,
    response: Ocpi.OcpiPartySchema,
    auth: true,
    usedBy: ['dashboard/ocpi-detail'],
  }),
  registerOcpiParty: e({
    id: 'registerOcpiParty',
    method: 'POST',
    path: '/ocpi/parties',
    service: 'core',
    group: 'OCPI',
    summary: 'Add a partner and run the credentials handshake',
    milestone: 12,
    body: Ocpi.RegisterOcpiPartySchema,
    response: Ocpi.OcpiHandshakeResultSchema,
    auth: true,
    usedBy: ['dashboard/ocpi'],
  }),
  syncOcpiParty: e({
    id: 'syncOcpiParty',
    method: 'POST',
    path: '/ocpi/parties/:id/sync',
    service: 'core',
    group: 'OCPI',
    summary: 'Push or pull the selected modules now',
    milestone: 12,
    body: Ocpi.OcpiSyncRequestSchema,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/ocpi-detail'],
  }),
  deleteOcpiParty: e({
    id: 'deleteOcpiParty',
    method: 'DELETE',
    path: '/ocpi/parties/:id',
    service: 'core',
    group: 'OCPI',
    summary: 'Remove a partner',
    milestone: 12,
    response: C.AckSchema,
    auth: true,
    usedBy: ['dashboard/ocpi'],
  }),
  ocpiLog: e({
    id: 'ocpiLog',
    method: 'GET',
    path: '/ocpi/logs',
    service: 'core',
    group: 'OCPI',
    summary: 'OCPI HTTP traffic, both directions',
    milestone: 12,
    query: Ocpi.OcpiLogQuerySchema,
    response: Ocpi.OcpiLogResponseSchema,
    auth: true,
    usedBy: ['dashboard/ocpi-detail'],
  }),
  listOcpiTokens: e({
    id: 'listOcpiTokens',
    method: 'GET',
    path: '/ocpi/tokens',
    service: 'core',
    group: 'OCPI',
    summary: "Partner customers' tokens we accept",
    milestone: 12,
    query: C.PageQuerySchema,
    response: Ocpi.OcpiTokenListResponseSchema,
    auth: true,
    usedBy: ['dashboard/ocpi-detail'],
  }),
  listOcpiCdrs: e({
    id: 'listOcpiCdrs',
    method: 'GET',
    path: '/ocpi/cdrs',
    service: 'core',
    group: 'OCPI',
    summary: 'CDRs pushed to partners and their delivery state',
    milestone: 12,
    query: C.PageQuerySchema,
    response: Ocpi.OcpiCdrListResponseSchema,
    auth: true,
    usedBy: ['dashboard/ocpi-detail'],
  }),

  /* ---------------------------- driver ---------------------------- */
  driverProfile: e({
    id: 'driverProfile',
    method: 'GET',
    path: '/driver/profile',
    service: 'core',
    group: 'Driver',
    summary: "The signed-in driver's profile and stats",
    milestone: 11,
    response: Driver.DriverProfileSchema,
    auth: true,
    usedBy: ['driver/profile'],
  }),
  driverNearby: e({
    id: 'driverNearby',
    method: 'GET',
    path: '/driver/locations/nearby',
    service: 'core',
    group: 'Driver',
    summary: 'Sites near a point, sorted by distance',
    milestone: 11,
    query: LocationMod.NearbyQuerySchema,
    response: z.object({ data: z.array(LocationMod.NearbyLocationSchema) }),
    auth: true,
    usedBy: ['driver/map', 'driver/list'],
  }),
  driverLocation: e({
    id: 'driverLocation',
    method: 'GET',
    path: '/driver/locations/:id',
    service: 'core',
    group: 'Driver',
    summary: 'Site detail with bookable connectors',
    milestone: 11,
    response: LocationMod.DriverLocationDetailSchema,
    auth: true,
    usedBy: ['driver/location-detail'],
  }),
  driverResolveConnector: e({
    id: 'driverResolveConnector',
    method: 'POST',
    path: '/driver/connectors/resolve',
    service: 'core',
    group: 'Driver',
    summary: 'Turn a scanned QR code or typed code into a connector',
    milestone: 11,
    body: Driver.ResolveConnectorSchema,
    response: LocationMod.DriverConnectorSchema,
    auth: true,
    usedBy: ['driver/scan'],
  }),
  driverStartCharge: e({
    id: 'driverStartCharge',
    method: 'POST',
    path: '/driver/charge/start',
    service: 'core',
    group: 'Driver',
    summary: 'Authorize an amount and ask the station to start',
    description:
      'This is the endpoint that ties the whole project together: payment, ' +
      'tariff, OCPP remote start and session creation in one transaction.',
    milestone: 11,
    body: Driver.StartChargeSchema,
    response: Driver.StartChargeResponseSchema,
    auth: true,
    usedBy: ['driver/charge'],
  }),
  driverActiveSessions: e({
    id: 'driverActiveSessions',
    method: 'GET',
    path: '/driver/sessions/active',
    service: 'core',
    group: 'Driver',
    summary: 'Sessions currently running for this driver',
    milestone: 11,
    response: Driver.ActiveSessionsResponseSchema,
    auth: true,
    usedBy: ['driver/home', 'driver/charging'],
  }),
  driverSession: e({
    id: 'driverSession',
    method: 'GET',
    path: '/driver/sessions/:id',
    service: 'core',
    group: 'Driver',
    summary: 'One session, driver projection',
    milestone: 11,
    response: Driver.DriverSessionSchema,
    auth: true,
    usedBy: ['driver/charging'],
  }),
  driverStopSession: e({
    id: 'driverStopSession',
    method: 'POST',
    path: '/driver/sessions/:id/stop',
    service: 'core',
    group: 'Driver',
    summary: 'Driver-initiated stop',
    milestone: 11,
    response: Driver.DriverSessionSchema,
    auth: true,
    usedBy: ['driver/charging'],
  }),
  driverSessionHistory: e({
    id: 'driverSessionHistory',
    method: 'GET',
    path: '/driver/sessions',
    service: 'core',
    group: 'Driver',
    summary: 'Past sessions',
    milestone: 11,
    query: Driver.DriverSessionListQuerySchema,
    response: Driver.DriverSessionListResponseSchema,
    auth: true,
    usedBy: ['driver/history'],
  }),
  driverReceipt: e({
    id: 'driverReceipt',
    method: 'GET',
    path: '/driver/sessions/:id/receipt',
    service: 'core',
    group: 'Driver',
    summary: 'Itemised receipt for a finished session',
    milestone: 11,
    response: Driver.ReceiptSchema,
    auth: true,
    usedBy: ['driver/receipt'],
  }),
} as const;

/* ================================================================== *
 * SIMULATOR SERVICE — base path /sim/v1
 * ================================================================== */

export const simEndpoints = {
  simHealth: e({
    id: 'simHealth',
    method: 'GET',
    path: '/health',
    service: 'sim',
    group: 'Simulator',
    summary: 'Simulator liveness and station counts',
    milestone: 2,
    response: Sim.SimHealthSchema,
    auth: false,
    usedBy: ['simulator/all'],
  }),
  listSimStations: e({
    id: 'listSimStations',
    method: 'GET',
    path: '/stations',
    service: 'sim',
    group: 'Simulator',
    summary: 'Virtual stations and their live state',
    milestone: 2,
    query: C.PageQuerySchema,
    response: Sim.SimStationListResponseSchema,
    auth: false,
    usedBy: ['simulator/fleet'],
  }),
  getSimStation: e({
    id: 'getSimStation',
    method: 'GET',
    path: '/stations/:id',
    service: 'sim',
    group: 'Simulator',
    summary: 'One virtual station',
    milestone: 2,
    response: Sim.SimStationSchema,
    auth: false,
    usedBy: ['simulator/station'],
  }),
  createSimStation: e({
    id: 'createSimStation',
    method: 'POST',
    path: '/stations',
    service: 'sim',
    group: 'Simulator',
    summary: 'Create one or many virtual stations',
    milestone: 2,
    body: Sim.CreateSimStationSchema,
    response: z.object({ data: z.array(Sim.SimStationSchema) }),
    auth: false,
    usedBy: ['simulator/fleet'],
  }),
  updateSimStation: e({
    id: 'updateSimStation',
    method: 'PATCH',
    path: '/stations/:id',
    service: 'sim',
    group: 'Simulator',
    summary: 'Change behaviour knobs and fault injection',
    milestone: 2,
    body: Sim.UpdateSimStationSchema,
    response: Sim.SimStationSchema,
    auth: false,
    usedBy: ['simulator/station'],
  }),
  deleteSimStation: e({
    id: 'deleteSimStation',
    method: 'DELETE',
    path: '/stations/:id',
    service: 'sim',
    group: 'Simulator',
    summary: 'Destroy a virtual station',
    milestone: 2,
    response: C.AckSchema,
    auth: false,
    usedBy: ['simulator/fleet'],
  }),
  simAction: e({
    id: 'simAction',
    method: 'POST',
    path: '/stations/:id/actions',
    service: 'sim',
    group: 'Simulator',
    summary: 'Perform a physical event or send a raw message',
    milestone: 2,
    body: Sim.SimActionRequestSchema,
    response: Sim.SimActionResultSchema,
    auth: false,
    usedBy: ['simulator/station'],
  }),
  simFrames: e({
    id: 'simFrames',
    method: 'GET',
    path: '/frames',
    service: 'sim',
    group: 'Simulator',
    summary: 'Frame log from the simulator side of the wire',
    milestone: 2,
    query: C.CursorQuerySchema.extend({
      stationId: C.IdSchema.optional(),
      direction: z.enum(['inbound', 'outbound']).optional(),
      action: z.string().optional(),
    }),
    response: C.cursorPaginated(Sim.SimFrameSchema),
    auth: false,
    usedBy: ['simulator/logs', 'simulator/station'],
  }),
  listScenarios: e({
    id: 'listScenarios',
    method: 'GET',
    path: '/scenarios',
    service: 'sim',
    group: 'Simulator',
    summary: 'Built-in scripted scenarios',
    milestone: 5,
    response: Sim.SimScenarioListResponseSchema,
    auth: false,
    usedBy: ['simulator/scenarios'],
  }),
  runScenario: e({
    id: 'runScenario',
    method: 'POST',
    path: '/runs',
    service: 'sim',
    group: 'Simulator',
    summary: 'Run a scenario against a virtual station',
    milestone: 5,
    body: Sim.RunScenarioSchema,
    response: Sim.SimRunSchema,
    auth: false,
    usedBy: ['simulator/scenarios'],
  }),
  getRun: e({
    id: 'getRun',
    method: 'GET',
    path: '/runs/:id',
    service: 'sim',
    group: 'Simulator',
    summary: 'Scenario run progress and assertions',
    milestone: 5,
    response: Sim.SimRunSchema,
    auth: false,
    usedBy: ['simulator/scenarios'],
  }),
  listRuns: e({
    id: 'listRuns',
    method: 'GET',
    path: '/runs',
    service: 'sim',
    group: 'Simulator',
    summary: 'Recent scenario runs',
    milestone: 5,
    query: C.PageQuerySchema,
    response: C.paginated(Sim.SimRunSchema),
    auth: false,
    usedBy: ['simulator/scenarios'],
  }),
  abortRun: e({
    id: 'abortRun',
    method: 'POST',
    path: '/runs/:id/abort',
    service: 'sim',
    group: 'Simulator',
    summary: 'Stop a running scenario',
    milestone: 5,
    response: C.AckSchema,
    auth: false,
    usedBy: ['simulator/scenarios'],
  }),
} as const;

export const endpoints = { ...coreEndpoints, ...simEndpoints };
export type EndpointId = keyof typeof endpoints;
export type CoreEndpointId = keyof typeof coreEndpoints;
export type SimEndpointId = keyof typeof simEndpoints;

export const allEndpoints: EndpointDef[] = Object.values(endpoints);

/** Base paths. Override with env vars in the apps. */
export const SERVICE_BASE_PATH = {
  core: '/api/v1',
  sim: '/sim/v1',
} as const;

/** Full path including the service base, with `:params` intact. */
export function endpointPath(def: EndpointDef): string {
  return `${SERVICE_BASE_PATH[def.service]}${def.path}`;
}

/** Substitute `:params` and append a query string. */
export function buildPath(
  def: EndpointDef,
  params?: Record<string, string | number>,
  query?: Record<string, unknown>,
): string {
  let path = endpointPath(def);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(String(value)));
    }
  }
  const remaining = path.match(/:([A-Za-z0-9_]+)/);
  if (remaining) {
    throw new Error(`Missing path parameter "${remaining[1]}" for endpoint ${def.id}`);
  }
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) search.append(key, String(v));
      } else {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) path += `?${qs}`;
  }
  return path;
}

/** Endpoints grouped by the milestone that introduces them. */
export function endpointsByMilestone(): Map<number, EndpointDef[]> {
  const map = new Map<number, EndpointDef[]>();
  for (const def of allEndpoints) {
    const list = map.get(def.milestone) ?? [];
    list.push(def);
    map.set(def.milestone, list);
  }
  return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
}
