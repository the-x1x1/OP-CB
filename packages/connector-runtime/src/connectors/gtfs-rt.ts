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
