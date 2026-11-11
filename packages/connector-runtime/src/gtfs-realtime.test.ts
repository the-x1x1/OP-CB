import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGtfsRealtime, GtfsRealtimeError } from './gtfs-realtime.js';

/**
 * The feeds are encoded by Google's protobuf library (Python) from the official field
 * numbers and types (fixtures/connectors/gtfs-rt/README.md): this reader is checked against
 * an independent encoder, not against itself.
 */
const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'connectors',
  'gtfs-rt',
);
const feed = (name: string) => new Uint8Array(readFileSync(path.join(dir, name)));

test('gtfs-realtime: vehicles, by the proto names, enums by name; other entities skipped', () => {
  const f = decodeGtfsRealtime(feed('vehicles.pb'));
  assert.deepEqual(f.header, { gtfs_realtime_version: '2.0', incrementality: 'FULL_DATASET', timestamp: 1790193595 });
  assert.equal(f.entities, 6);
  assert.deepEqual(
    f.vehicles.map((v) => v.id),
    ['v1', 'v2', 'v4'],
    'the trip update, the alert and the deleted vehicle are not vehicles',
  );
  const [v1, v2, v4] = f.vehicles;
  const vp = v1!.vehicle;
  assert.deepEqual(vp['trip'], {
    trip_id: 'T1-1405',
    start_time: '14:05:00',
    start_date: '20260923',
    schedule_relationship: 'SCHEDULED',
    route_id: '1',
    direction_id: 1,
  });
  assert.deepEqual(vp['vehicle'], {
    id: '1801',
    label: 'Bus 1801',
    license_plate: 'MA 1801',
    wheelchair_accessible: 'WHEELCHAIR_ACCESSIBLE',
  });
  const pos = vp['position'] as Record<string, number>;
  // Floats are 32-bit on the wire: equal to the encoded value to float precision.
  assert.ok(Math.abs(pos['latitude']! - 42.3601) < 1e-5 && Math.abs(pos['longitude']! + 71.0589) < 1e-5);
  assert.equal(pos['bearing'], 90);
  assert.equal(pos['speed'], 8.5);
  assert.equal(pos['odometer'], 123456.75, 'a double, all 8 bytes');
  assert.equal(vp['current_status'], 'STOPPED_AT');
  assert.equal(vp['current_stop_sequence'], 5);
  assert.equal(vp['stop_id'], 'place-dwnxg');
  assert.equal(vp['timestamp'], 1790193585);
  assert.equal(vp['congestion_level'], 'RUNNING_SMOOTHLY');
  assert.equal(vp['occupancy_status'], 'MANY_SEATS_AVAILABLE');
  assert.equal(vp['occupancy_percentage'], 30);
  assert.equal(v1!.feedTimestamp, 1790193595);

  assert.deepEqual(Object.keys(v2!.vehicle), ['position'], 'what the feed left out is left out, no defaults filled in');

  const v4p = v4!.vehicle;
  assert.equal((v4p['trip'] as Record<string, unknown>)['schedule_relationship'], 'NEW');
  assert.equal((v4p['position'] as Record<string, number>)['bearing'], 270.5);
  assert.equal('multi_carriage_details' in v4p, false, 'carriages (a negative int32: a 10-byte varint) are skipped');
});

test('gtfs-realtime: a feed of no vehicles, and what is not a feed', () => {
  assert.deepEqual(decodeGtfsRealtime(feed('empty.pb')).vehicles, []);
  const tu = decodeGtfsRealtime(feed('trip-updates-only.pb'));
  assert.equal(tu.entities, 1);
  assert.deepEqual(tu.vehicles, []);
  assert.equal(tu.header.timestamp, undefined);

  const enc = new TextEncoder();
  assert.throws(
    () => decodeGtfsRealtime(enc.encode('<!doctype html><title>Forbidden</title>')),
    /text, not a protobuf/,
  );
  assert.throws(() => decodeGtfsRealtime(enc.encode('{"error":"no key"}')), /text, not a protobuf/);
  assert.throws(() => decodeGtfsRealtime(new Uint8Array()), /empty/);
  const whole = feed('vehicles.pb');
  assert.throws(() => decodeGtfsRealtime(whole.subarray(0, whole.length - 7)), GtfsRealtimeError, 'cut short');
  // An entity with no header at all.
  assert.throws(() => decodeGtfsRealtime(whole.subarray(whole.indexOf(0x12))), /no FeedHeader|wire type|past the end/);
});
