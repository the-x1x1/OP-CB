import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@opcb/connector-sdk';
import { RestJsonProvider, validateRestJson } from './rest-json.js';

/**
 * GTFS Realtime vehicle positions (2026-11-10): a REST source whose body is a protobuf
 * FeedMessage (`gtfs-realtime.ts` decodes it). Each record is one vehicle,
 * `{ id, feedTimestamp?, vehicle: { trip: { trip_id, route_id, direction_id, start_date,
 * start_time, schedule_relationship }, vehicle: { id, label, license_plate,
 * wheelchair_accessible }, position: { latitude, longitude, bearing, speed, odometer },
 * stop_id, current_stop_sequence, current_status, timestamp, congestion_level,
 * occupancy_status, occupancy_percentage } }`, the proto's names, enums by name; the mapping
 * picks from it as from JSON. Trip updates and alerts in the same feed are skipped.
 */
export const GTFS_RT_CONNECTOR_ID = 'gtfs-rt';

/**
 * The mapping every GTFS Realtime definition shares (connectors/examples/transit, and the
 * drafter's for a pasted feed URL): the vehicle's id (else the entity's), its label (else its
 * id), its report time (else the feed's), and the trip, stop, status, load, traffic and access
 * as properties; speed and bearing as motion. A test keeps the examples equal to it.
 */
export const GTFS_RT_VEHICLE_MAPPING = {
  externalId: {
    path: 'vehicle.vehicle.id',
    fallback: 'id',
  },
  observedAt: {
    path: 'vehicle.timestamp',
    fallback: 'feedTimestamp',
  },
  position: {
    lat: 'vehicle.position.latitude',
    lon: 'vehicle.position.longitude',
  },
  labels: {
    name: {
      path: 'vehicle.vehicle.label',
      fallback: ['vehicle.vehicle.id', 'id'],
    },
    route: 'vehicle.trip.route_id',
  },
  properties: {
    routeId: 'vehicle.trip.route_id',
    tripId: 'vehicle.trip.trip_id',
    directionId: 'vehicle.trip.direction_id',
    tripStart: {
      concat: ['vehicle.trip.start_date', 'vehicle.trip.start_time'],
      separator: ' ',
    },
    scheduleRelationship: 'vehicle.trip.schedule_relationship',
    stopId: 'vehicle.stop_id',
    stopSequence: 'vehicle.current_stop_sequence',
    stopStatus: 'vehicle.current_status',
    occupancy: 'vehicle.occupancy_status',
    occupancyPercent: 'vehicle.occupancy_percentage',
    congestion: 'vehicle.congestion_level',
    wheelchair: 'vehicle.vehicle.wheelchair_accessible',
    licensePlate: 'vehicle.vehicle.license_plate',
  },
  motion: {
    speedMps: 'vehicle.position.speed',
    headingDegrees: 'vehicle.position.bearing',
  },
} as const;

/** What polling a feed of `bytes` every 30 s costs in a day, for the drafter's notes. */
export const GTFS_RT_FREQUENCY_NOTE = (bytes: number): string => {
  const perDay = (bytes * 2880) / 1e6;
  return `polled every 30 s, a feed of this size is about ${perDay >= 1000 ? `${(perDay / 1000).toFixed(1)} GB` : `${Math.round(perDay)} MB`} a day; raise endpoint.intervalSeconds for a metered link`;
};

/** Freshness for a 30-second vehicle feed. */
export const GTFS_RT_FRESHNESS = { liveSeconds: 120, recentSeconds: 600, expireSeconds: 1800 } as const;

export function withGtfsRtDefaults(d: ConnectorProviderDefinition): ConnectorProviderDefinition {
  return { ...d, response: { ...(d.response ?? {}), format: 'gtfs-rt' } };
}

export function validateGtfsRt(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const base = validateRestJson(withGtfsRtDefaults(d));
  if (d.response?.format && d.response.format !== 'gtfs-rt') base.errors.push('a GTFS Realtime source is gtfs-rt');
  if (d.response?.itemsPath) base.warnings.push('response.itemsPath is ignored: each vehicle is a record');
  if (d.response?.contour) base.errors.push('response.contour reads a JSON grid, not a GTFS Realtime feed');
  if (d.pagination && d.pagination.strategy !== 'none')
    base.errors.push('a GTFS Realtime feed is one answer: no pagination');
  return { ...base, ok: base.errors.length === 0 };
}

export const gtfsRtConnector: Connector = {
  metadata: {
    id: GTFS_RT_CONNECTOR_ID,
    name: 'GTFS Realtime',
    description: 'Poll a GTFS Realtime vehicle-positions feed (protobuf); each vehicle is an object at its position.',
    uses: ['endpoint', 'response', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateGtfsRt,
  createProvider: (d) => new RestJsonProvider(withGtfsRtDefaults(d), 'GTFS Realtime'),
};
