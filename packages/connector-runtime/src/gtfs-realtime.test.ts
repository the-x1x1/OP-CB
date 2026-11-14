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

test('gtfs-realtime: a recorded MBTA answer decodes to the values of MBTA’s own JSON feed', () => {
  // recorded/mbta-vehicles.pb: header + the first 4 of 367 entities, read 2026-11-11 03:29 UTC
  // (meta.json beside it). The expected values were read from
  // https://cdn.mbta.com/realtime/VehiclePositions.json the same minute.
  const f = decodeGtfsRealtime(feed('recorded/mbta-vehicles.pb'));
  assert.deepEqual(f.header, { gtfs_realtime_version: '2.0', incrementality: 'FULL_DATASET', timestamp: 1794367756 });
  assert.equal(f.entities, 4);
  const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 2e-5;
  const want = [
    {
      id: 'y1832',
      route: '60',
      trip: '78181228',
      dir: 0,
      start: '22:50:00',
      label: '1832',
      lat: 42.334991,
      lon: -71.085104,
      bearing: 292,
      stop: '899',
      seq: 1,
      status: 'STOPPED_AT',
      ts: 1794367752,
      occ: 'MANY_SEATS_AVAILABLE',
    },
    {
      id: 'O-548CA387',
      route: 'Orange',
      trip: '79436600',
      dir: 1,
      start: '22:03:00',
      label: '1514',
      lat: 42.3925,
      lon: -71.07715,
      bearing: 355,
      stop: '70279',
      seq: 160,
      status: 'STOPPED_AT',
      ts: 1794367736,
    },
    {
      id: 'ynk230',
      route: 'Shuttle-Generic',
      trip: 'BL-40770992',
      label: '230',
      lat: 42.348704,
      lon: -71.077994,
      status: 'IN_TRANSIT_TO',
      ts: 1794367732,
      rel: 'ADDED',
    },
    {
      id: 'y2023',
      route: '134',
      trip: '78265394',
      dir: 1,
      start: '22:19:00',
      label: '2023',
      lat: 42.429977,
      lon: -71.129822,
      bearing: 144,
      stop: '9146',
      seq: 23,
      status: 'IN_TRANSIT_TO',
      ts: 1794367751,
      occ: 'MANY_SEATS_AVAILABLE',
    },
  ];
  assert.deepEqual(
    f.vehicles.map((v) => v.id),
    want.map((w) => w.id),
  );
  f.vehicles.forEach((v, i) => {
    const w = want[i]!;
    const vp = v.vehicle;
    const trip = vp['trip'] as Record<string, unknown>;
    const pos = vp['position'] as Record<string, unknown>;
    assert.equal(v.feedTimestamp, 1794367756);
    assert.equal(trip['route_id'], w.route, w.id);
    assert.equal(trip['trip_id'], w.trip, w.id);
    assert.equal(trip['direction_id'], w.dir, w.id);
    assert.equal(trip['start_time'], w.start, w.id);
    assert.equal(trip['schedule_relationship'], w.rel ?? 'SCHEDULED', w.id);
    assert.deepEqual(vp['vehicle'], { id: w.id, label: w.label });
    assert.ok(near(pos['latitude'], w.lat) && near(pos['longitude'], w.lon), `${w.id} position`);
    assert.equal(pos['bearing'], w.bearing, w.id);
    assert.equal(vp['stop_id'], w.stop, w.id);
    assert.equal(vp['current_stop_sequence'], w.seq, w.id);
    assert.equal(vp['current_status'], w.status, w.id);
    assert.equal(vp['timestamp'], w.ts, w.id);
    assert.equal(vp['occupancy_status'], w.occ, w.id);
    assert.equal(vp['occupancy_percentage'], w.occ ? 0 : undefined, w.id);
    assert.equal('multi_carriage_details' in vp, false, `${w.id}: carriages skipped`);
  });
});

test('the drafter: a pasted GTFS Realtime URL becomes a gtfs-rt draft with the shared mapping', async () => {
  const { draftDefinition } = await import('./draft.js');
  const { defaultConnectorRegistry } = await import('./registry.js');
  const { GTFS_RT_VEHICLE_MAPPING } = await import('./connectors/gtfs-rt.js');
  const bytes = feed('recorded/mbta-vehicles.pb');
  const text = new TextDecoder().decode(bytes);
  const d = draftDefinition({ url: 'https://cdn.mbta.com/realtime/VehiclePositions.pb', text, bytes });
  assert.equal(d.connector, 'gtfs-rt');
  assert.equal(d.definition['objectType'], 'transit-vehicle');
  assert.deepEqual((d.definition['endpoint'] as Record<string, unknown>)['intervalSeconds'], 30);
  assert.deepEqual(d.definition['mapping'], GTFS_RT_VEHICLE_MAPPING);
  assert.equal(d.definition['review'], 'user-configured');
  assert.equal(d.definition['enabled'], false);
  assert.match(d.notes[0]!, /4 vehicle position\(s\) of 4 entities on 4 route\(s\)/);
  assert.match(d.notes[1]!, /about 1 MB a day/);
  assert.ok(!d.todo.some((t) => t.startsWith('objectType:') || t.startsWith('freshness:')), 'decided by the format');
  assert.ok(
    d.todo.some((t) => t.startsWith('attribution')),
    'the licence is still the operator’s to name',
  );
  assert.ok(defaultConnectorRegistry.validate(d.definition).ok, 'the draft validates as it is');
  // Served without a content type and from a URL without .pb (OVapi): recognised from the bytes.
  const bare = draftDefinition({ url: 'https://gtfs.example.org/nl/vehiclePositions', text, bytes });
  assert.equal(bare.connector, 'gtfs-rt');
});

test('the drafter: a GTFS Realtime feed of trip updates only is refused with why; JSON is drafted as before', async () => {
  const { draftDefinition } = await import('./draft.js');
  const tu = feed('trip-updates-only.pb');
  assert.throws(
    () =>
      draftDefinition({
        url: 'https://agency.example/TripUpdates.pb',
        text: new TextDecoder().decode(tu),
        bytes: tu,
        contentType: 'application/x-protobuf',
      }),
    /no vehicle positions.*VehiclePositions feed/,
  );
  assert.throws(
    () =>
      draftDefinition({
        url: 'https://agency.example/x.pb',
        text: 'nope',
        bytes: new Uint8Array([0x0a, 0x99]),
        contentType: 'application/octet-stream',
      }),
    /binary but not a GTFS Realtime feed/,
  );
  const json = '{"items":[{"id":"a","lat":1,"lon":2}]}';
  const j = draftDefinition({ url: 'https://x.example/a.json', text: json, bytes: new TextEncoder().encode(json) });
  assert.equal(j.connector, 'rest-json', 'text with bytes beside it is not taken for protobuf');
});

test('every GTFS Realtime example uses the shared mapping', async () => {
  const { readdirSync } = await import('node:fs');
  const { GTFS_RT_VEHICLE_MAPPING } = await import('./connectors/gtfs-rt.js');
  const dir2 = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'connectors',
    'examples',
    'transit',
  );
  const files = readdirSync(dir2).filter((f) => f.endsWith('-gtfs-rt.json'));
  assert.equal(files.length, 7);
  for (const f of files)
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir2, f), 'utf8'))['mapping'], GTFS_RT_VEHICLE_MAPPING, f);
});
