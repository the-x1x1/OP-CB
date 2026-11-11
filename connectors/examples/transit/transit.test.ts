import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@opcb/provider-sdk';
import { parseDefinition } from '@opcb/connector-sdk';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import { WorldState } from '@opcb/state-engine';

/**
 * The MBTA definition end to end over the answer recorded live on 2026-11-11
 * (fixtures/connectors/gtfs-rt/recorded/mbta-vehicles.pb, header + 4 vehicles), with the
 * clock at the minute it was read: what the connector suite, whose clock is fixed in
 * September, cannot run on a recorded feed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const READ_AT = '2026-11-11T03:29:30.000Z';

test('MBTA: the recorded feed becomes four transit vehicles with their route, trip, stop and load', async () => {
  const parsed = parseDefinition(JSON.parse(readFileSync(path.join(here, 'mbta-gtfs-rt.json'), 'utf8')));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.issues.join('; '));
  const def = parsed.definition;
  const provider = defaultConnectorRegistry.createProvider(def);
  const bytes = new Uint8Array(readFileSync(path.join(root, 'fixtures/connectors/gtfs-rt/recorded/mbta-vehicles.pb')));
  const accepts: string[] = [];
  await provider.initialize(
    testing.createFixtureContext({
      providerId: def.id,
      clock: new testing.VirtualClock(Date.parse(READ_AT)),
      responder: (req) => {
        accepts.push(String(req.headers?.['Accept'] ?? ''));
        return { status: 200, headers: { 'content-type': 'application/x-protobuf' }, body: bytes };
      },
    }),
  );
  await provider.start();
  const observations = await provider.query!({ signal: new AbortController().signal, background: true });
  assert.match(accepts[0]!, /^application\/x-protobuf/, 'asks for protobuf');
  const now = Date.parse(READ_AT);
  const state = new WorldState({ clock: { now: () => now }, flushDelayMs: 0 });
  state.ingest(observations, { snapshot: true, withdraws: true, providerId: def.id });
  state.flush();
  const objects = [...state.all()];
  assert.deepEqual(objects.map((o) => o.id).sort(), [
    'transit-vehicle:mbta-gtfs-rt:O-548CA387',
    'transit-vehicle:mbta-gtfs-rt:y1832',
    'transit-vehicle:mbta-gtfs-rt:y2023',
    'transit-vehicle:mbta-gtfs-rt:ynk230',
  ]);
  const bus = objects.find((o) => o.id.endsWith(':y1832'))!;
  assert.equal(bus.type, 'transit-vehicle');
  assert.equal(bus.labels['name'], '1832');
  // `route` is mapped as a label, but only the world model's label keys stay labels (state-engine
  // LABEL_KEYS); it is kept with the properties, and the Transit section reads routeId.
  assert.equal(bus.properties['route'], '60');
  assert.equal(bus.observedAt, '2026-11-11T03:29:12.000Z', "the vehicle's own report time");
  assert.ok(
    Math.abs(bus.position!.latitude - 42.334991) < 2e-5 && Math.abs(bus.position!.longitude + 71.085104) < 2e-5,
  );
  assert.equal(bus.motion?.headingDegrees, 292);
  for (const [k, v] of Object.entries({
    routeId: '60',
    tripId: '78181228',
    directionId: 0,
    tripStart: '20261110 22:50:00',
    scheduleRelationship: 'SCHEDULED',
    stopId: '899',
    stopSequence: 1,
    stopStatus: 'STOPPED_AT',
    occupancy: 'MANY_SEATS_AVAILABLE',
    occupancyPercent: 0,
  }))
    assert.equal(bus.properties[k], v, k);
  assert.equal(bus.freshness, 'LIVE');
  // The added shuttle has no direction, no bearing and no stop: nothing is filled in for them.
  const shuttle = objects.find((o) => o.id.endsWith(':ynk230'))!;
  assert.equal(shuttle.properties['scheduleRelationship'], 'ADDED');
  assert.equal(shuttle.properties['directionId'], undefined);
  assert.equal(shuttle.properties['stopId'], undefined);
  assert.equal(shuttle.motion?.headingDegrees, undefined);
});
