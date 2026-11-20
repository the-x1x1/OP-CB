import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventSchema, type WorldObject } from '@opcb/world-model';
import { EventEngine } from './engine.js';

/**
 * A property of the event rules: whatever a source wrote into an object's properties, the
 * rules do not throw, every event they make is one the world model accepts (eventSchema) with
 * an id of its own, and the same objects seen a second time make no new events. Objects are
 * generated from a fixed seed with every wrong kind of value in the properties the rules read.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.parse('2026-11-20T06:00:00.000Z');
const TYPES = [
  'earthquake',
  'fire-detection',
  'storm',
  'weather-alert',
  'aircraft',
  'vessel',
  'sensor',
  'weather-station',
  'launch',
  'satellite',
  'camera',
];
const KEYS = [
  'magnitude',
  'depthKm',
  'place',
  'status',
  'tsunami',
  'alert',
  'felt',
  'frp',
  'confidence',
  'brightness',
  'satellite',
  'daynight',
  'squawk',
  'emergency',
  'callsign',
  'onGround',
  'navIntegrity',
  'nic',
  'nacp',
  'sil',
  'gpsOkBefore',
  'mmsi',
  'navStatus',
  'shipType',
  'ownVessel',
  'name',
  'title',
  'headline',
  'event',
  'severity',
  'urgency',
  'certainty',
  'alertKind',
  'reportType',
  'spcCategory',
  'onset',
  'ends',
  'expires',
  'effective',
  'sent',
  'areaDesc',
  'description',
  'instruction',
  'stormType',
  'intensityKt',
  'category',
  'cycloneLayer',
  'basin',
  'advisory',
  'aqi',
  'pm25',
  'pm10',
  'temperatureC',
  'value',
  'limit',
  'units',
  'net',
  'windowStart',
  'windowEnd',
  'provider',
  'pad',
  'mission',
  'mainshockEventId',
  'url',
  'id',
];
const VALUES: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  4.6,
  7.9,
  12,
  500,
  7700,
  7600,
  7500,
  1e308,
  -1e308,
  '',
  ' ',
  'text',
  '7700',
  '5.5',
  'EXTREME',
  'Severe',
  'Tornado Warning',
  'tornado-emergency',
  'Tornado',
  'HIGH',
  'HU',
  'cat5',
  'red',
  'true',
  '2026-11-20T05:00:00Z',
  '2026-11-20T07:00:00Z',
  '2026-11-19T00:00:00Z',
  '2099-01-01T00:00:00Z',
  'not a time',
  '2026-02-30T00:00:00Z',
  'x'.repeat(4000),
  'line\nbreak',
  'constructor',
  '__proto__',
  [],
  [1, 2],
  ['a'],
  {},
  { a: 1 },
];

function makeObject(next: () => number, i: number): WorldObject {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const type = pick(TYPES);
  const properties: Record<string, unknown> = {};
  for (const key of KEYS) if (next() < 0.35) properties[key] = pick(VALUES);
  const observedAt = new Date(NOW - Math.floor(next() * 6 * 3_600_000)).toISOString();
  const lat = (next() * 2 - 1) * 90;
  const lon = pick([180, -180, 179.9, -179.9, (next() * 2 - 1) * 180]);
  return {
    id: `${type}:p:${i}`,
    type,
    sourceRefs: [{ observationId: `p:${i}:${observedAt}`, providerId: 'p', observedAt }],
    observedAt,
    updatedAt: observedAt,
    ...(next() < 0.2
      ? { validUntil: pick([new Date(NOW + 3_600_000).toISOString(), new Date(NOW - 60_000).toISOString()]) }
      : {}),
    freshness: pick(['LIVE', 'RECENT', 'STALE']),
    confidence: next(),
    labels: next() < 0.5 ? { name: pick(['A', '', 'x'.repeat(600)]), title: pick(['T', 'line\nbreak']) } : {},
    properties,
    ...(next() < 0.9 ? { position: { latitude: lat, longitude: lon } } : {}),
    ...(next() < 0.2
      ? {
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lon > 179 ? 179 : lon, lat > 89 ? 89 : lat],
                [Math.min(180, lon + 0.5), lat > 89 ? 89 : lat],
                [Math.min(180, lon + 0.5), Math.min(90, lat + 0.5)],
                [lon > 179 ? 179 : lon, lat > 89 ? 89 : lat],
              ],
            ],
          },
        }
      : {}),
    ...(next() < 0.4 ? { motion: { speedMps: next() * 250, headingDegrees: next() * 360 } } : {}),
    provenance: { providerId: 'p', sourceName: 'P', origin: 'live', receivedAt: observedAt },
  } as unknown as WorldObject;
}

test('event rules property: no throw, every event acceptable, and nothing new from the same objects twice', () => {
  for (const seed of [7, 8, 9, 10]) {
    const next = rng(seed);
    const engine = new EventEngine({ clock: { now: () => NOW } as never });
    const problems: string[] = [];
    const objects = Array.from({ length: 1500 }, (_, i) => makeObject(next, i));
    let made = 0;
    for (let at = 0; at < objects.length; at += 300) {
      const batch = objects.slice(at, at + 300);
      let result: ReturnType<EventEngine['ingestBatch']> | undefined;
      try {
        result = engine.ingestBatch(batch);
      } catch (err) {
        problems.push(
          `seed ${seed} batch ${at}: threw ${err instanceof Error ? `${err.message.slice(0, 120)} ${String(err.stack).split('\n')[1]?.trim().slice(0, 120)}` : String(err)}`,
        );
        continue;
      }
      made += result.added.length;
      const again = engine.ingestBatch(batch);
      if (again.added.length)
        problems.push(
          `seed ${seed} batch ${at}: ${again.added.length} new events from the same objects, e.g. ${again.added[0]!.id}`,
        );
    }
    const ids = new Set<string>();
    for (const event of engine.store.all()) {
      if (ids.has(event.id)) problems.push(`seed ${seed}: event id ${event.id} twice`);
      ids.add(event.id);
      const parsed = eventSchema.parse(event, '');
      if (!parsed.ok)
        problems.push(
          `seed ${seed}: ${event.id} (${event.type}) refused: ${parsed.issues
            .map((x) => `${x.path} ${x.message}`)
            .join('; ')
            .slice(0, 200)}`,
        );
      if (event.endAt && Date.parse(event.endAt) < Date.parse(event.startAt))
        problems.push(`seed ${seed}: ${event.id} ends before it starts`);
    }
    engine.dispose();
    assert.deepEqual([...new Set(problems)].slice(0, 10), [], `${problems.length} problems`);
    assert.ok(made > 50, `seed ${seed}: ${made} events made`);
  }
});
