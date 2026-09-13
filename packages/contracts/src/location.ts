import { z } from 'zod';
import {
  AddressSchema,
  GeoPointSchema,
  IdSchema,
  MoneyMinorSchema,
  PageQuerySchema,
  TimestampSchema,
  paginated,
} from './common';
import { ConnectorTypeSchema, PowerTypeSchema } from './enums';

/**
 * Locations — a physical site containing one or more stations.
 *
 * ## Why a separate entity from Station
 *
 * Drivers navigate to SITES, not to individual chargers. "Tesco Extra car
 * park" has eight stations; a map pin per station makes the map unreadable
 * and the drive-there experience wrong. Operators also think in sites: a
 * site has an electrical supply limit, opening hours and an owner.
 *
 * This is also the OCPI unit of exchange. When you publish your network to a
 * roaming partner you publish LOCATIONS, each containing EVSEs. Getting this
 * hierarchy right now means the OCPI milestone is mostly a serialisation
 * exercise instead of a redesign.
 */

export const OpeningHoursSchema = z.object({
  twentyFourSeven: z.boolean(),
  /** Ignored when twentyFourSeven is true. */
  regularHours: z
    .array(
      z.object({
        /** 1 = Monday ... 7 = Sunday, matching OCPI. */
        weekday: z.number().int().min(1).max(7),
        periodBegin: z.string().describe('HH:mm'),
        periodEnd: z.string().describe('HH:mm'),
      }),
    )
    .default([]),
});
export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

export const FacilitySchema = z.enum([
  'parking_lot',
  'restaurant',
  'cafe',
  'mall',
  'supermarket',
  'hotel',
  'museum',
  'sport',
  'nature',
  'airport',
  'bus_stop',
  'taxi_stand',
  'wifi',
  'toilets',
]);
export type Facility = z.infer<typeof FacilitySchema>;

export const LocationSchema = z.object({
  id: IdSchema,
  name: z.string(),
  address: AddressSchema,
  coordinates: GeoPointSchema,
  timeZone: z.string().describe('IANA zone, e.g. Europe/Amsterdam. Needed to apply tariff hours.'),
  openingHours: OpeningHoursSchema,
  facilities: z.array(FacilitySchema),
  operatorName: z.string().nullable(),
  /**
   * Site electrical limit in kW. The sum of every station's max power will
   * usually exceed this — that is normal and it is why load management
   * exists. Milestone 10 uses this number.
   */
  gridCapacityKw: z.number().positive().nullable(),
  stationCount: z.number().int().nonnegative(),
  connectorCount: z.number().int().nonnegative(),
  availableConnectorCount: z.number().int().nonnegative(),
  chargingConnectorCount: z.number().int().nonnegative(),
  faultedConnectorCount: z.number().int().nonnegative(),
  maxPowerKw: z.number().nonnegative(),
  photoUrl: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Location = z.infer<typeof LocationSchema>;

export const LocationListQuerySchema = PageQuerySchema.extend({
  country: z.string().optional(),
  city: z.string().optional(),
  /** Bounding box for map viewport loading: "minLon,minLat,maxLon,maxLat". */
  bbox: z.string().optional(),
});
export type LocationListQuery = z.infer<typeof LocationListQuerySchema>;

export const LocationListResponseSchema = paginated(LocationSchema);
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

export const CreateLocationSchema = z.object({
  name: z.string().min(1),
  address: AddressSchema,
  coordinates: GeoPointSchema,
  timeZone: z.string().default('UTC'),
  openingHours: OpeningHoursSchema.default({ twentyFourSeven: true, regularHours: [] }),
  facilities: z.array(FacilitySchema).default([]),
  operatorName: z.string().optional(),
  gridCapacityKw: z.number().positive().nullable().optional(),
});
export type CreateLocation = z.infer<typeof CreateLocationSchema>;

export const UpdateLocationSchema = CreateLocationSchema.partial();
export type UpdateLocation = z.infer<typeof UpdateLocationSchema>;

/* ------------------------------------------------------------------ *
 * Driver-facing projection
 * ------------------------------------------------------------------ */

/**
 * What the driver app shows on the map and in the list.
 *
 * Note what is NOT here: no station identities, no OCPP details, no operator
 * notes. Drivers get a different projection of the same data, and keeping the
 * projections in separate types stops internal fields leaking into a public
 * app by accident.
 */
export const NearbyLocationSchema = z.object({
  id: IdSchema,
  name: z.string(),
  address: z.string().describe('Pre-formatted single line, ready to render'),
  coordinates: GeoPointSchema,
  distanceMeters: z.number().nonnegative().nullable(),
  availableConnectorCount: z.number().int(),
  totalConnectorCount: z.number().int(),
  maxPowerKw: z.number(),
  connectorTypes: z.array(ConnectorTypeSchema),
  /** "from 0.45/kWh" — already resolved from the tariff for this site. */
  fromPriceMinor: MoneyMinorSchema.nullable(),
  currency: z.string().nullable(),
  openNow: z.boolean(),
  facilities: z.array(FacilitySchema),
  photoUrl: z.string().nullable(),
});
export type NearbyLocation = z.infer<typeof NearbyLocationSchema>;

export const NearbyQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusMeters: z.coerce.number().int().positive().max(200_000).default(10_000),
  minPowerKw: z.coerce.number().optional(),
  connectorType: ConnectorTypeSchema.optional(),
  availableOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type NearbyQuery = z.infer<typeof NearbyQuerySchema>;

/** A single connector as the driver sees it, on the location detail screen. */
export const DriverConnectorSchema = z.object({
  id: IdSchema,
  stationId: IdSchema,
  stationIdentity: z.string(),
  stationName: z.string(),
  evseId: z.number().int(),
  connectorId: z.number().int(),
  type: ConnectorTypeSchema,
  powerType: PowerTypeSchema,
  maxPowerKw: z.number(),
  available: z.boolean(),
  statusLabel: z.string(),
  pricePerKwhMinor: MoneyMinorSchema.nullable(),
  currency: z.string().nullable(),
});
export type DriverConnector = z.infer<typeof DriverConnectorSchema>;

export const DriverLocationDetailSchema = NearbyLocationSchema.extend({
  connectors: z.array(DriverConnectorSchema),
  openingHours: OpeningHoursSchema,
  timeZone: z.string(),
});
export type DriverLocationDetail = z.infer<typeof DriverLocationDetailSchema>;
