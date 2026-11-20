import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, type WorldEvent, type WorldObject } from '@opcb/world-model';
import { feedTime } from '../feed.js';
import {
  boundsOfPoints,
  boundsPolygon,
  continuousPoints,
  convexHull,
  footprintGeometry,
  roundCoord,
} from '../geometry.js';
import { confidenceOf, maxSeverity, payloadSeverity, severityAtLeast } from '../severity.js';
import { compareEvents } from '../store.js';
import { withMainshock } from './earthquake.js';
import { sourceStatusEvent, type SourceChange } from './source-status.js';
import { stormTrend } from './storm.js';
import { derivedProvenance, numberProp, refsOf, shortUtc, stringProp } from './types.js';
import { linkSupersession, withSupersededBy } from './weather-alert.js';
import { CLUSTER_LINK_DISTANCE_M, clusterDetections, hullAreaKm2, wildfireClusterRule } from './wildfire-cluster.js';

const T0 = Date.parse('2026-10-15T20:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let serial = 0;
function thing(over: Partial<WorldObject> & { properties?: Record<string, unknown> } = {}): WorldObject {
  const id = `thing:p:${++serial}`;
  return {
    id,
    type: 'thing',
    labels: {},
    observedAt: at(0),
    updatedAt: at(0),
    properties: {},
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'p', observationId: `o:${id}`, observedAt: at(0) }],
    provenance: { providerId: 'p', sourceName: 'Source P', origin: 'live', receivedAt: at(0) },
    ...over,
  } as WorldObject;
}

function event(over: Partial<WorldEvent> & { id: string }): WorldEvent {
  return {
    type: 'earthquake',
    title: over.id,
    startAt: at(0),
    objectIds: [],
    observationRefs: [],
    confidence: 'HIGH',
    summary: '',
    provenance: { providerId: 'opcb', sourceName: 'OP-CB', origin: 'derived', receivedAt: at(0) },
    ...over,
  };
}

// ---- geometry -----------------------------------------------------------------

/** Twice the signed area of triangle o-a-b: positive when b is left of o→a. */
const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

test('convexHull: a closed ring that turns one way and has every point inside or on it', () => {
  let seed = 11;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  for (let round = 0; round < 200; round++) {
    const n = 3 + Math.floor(random() * 40);
    const points: Array<[number, number]> = Array.from({ length: n }, () => [
      Math.round(random() * 20) / 10 + 10,
      Math.round(random() * 20) / 10 - 5,
    ]);
    const hull = convexHull(points);
    if (hull.length === 0) continue;
    assert.deepEqual(hull[0], hull[hull.length - 1], 'closed');
    assert.ok(hull.length >= 4);
    for (let i = 0; i + 2 < hull.length; i++) assert.ok(cross(hull[i]!, hull[i + 1]!, hull[i + 2]!) > 0, 'convex');
    for (const p of points)
      for (let i = 0; i + 1 < hull.length; i++) assert.ok(cross(hull[i]!, hull[i + 1]!, p) >= -1e-12, 'inside');
    for (const v of hull)
      assert.ok(
        points.some((p) => p[0] === v[0] && p[1] === v[1]),
        'a vertex is one of the points',
      );
  }
});

test('convexHull: fewer than three distinct points, or points all in a line, have no hull', () => {
  assert.deepEqual(convexHull([]), []);
  assert.deepEqual(convexHull([[1, 1]]), []);
  assert.deepEqual(
    convexHull([
      [1, 1],
      [2, 2],
    ]),
    [],
  );
  assert.deepEqual(
    convexHull([
      [1, 1],
      [1, 1],
      [1, 1],
      [2, 2],
    ]),
    [],
  );
  assert.deepEqual(
    convexHull([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    [],
  );
  assert.equal(
    convexHull([
      [0, 0],
      [1, 0],
      [0, 1],
    ]).length,
    4,
  );
  // A point repeated does not put a repeated vertex in the ring.
  assert.equal(
    convexHull([
      [0, 0],
      [1, 0],
      [0, 1],
      [0, 0],
      [1, 0],
    ]).length,
    4,
  );
});

test('boundsOfPoints and boundsPolygon', () => {
  assert.equal(boundsOfPoints([]), undefined);
  assert.deepEqual(boundsOfPoints([[10, 5]]), { west: 10, south: 5, east: 10, north: 5 });
  assert.deepEqual(
    boundsOfPoints([
      [10, 5],
      [-3, 7],
      [4, -2],
    ]),
    { west: -3, south: -2, east: 10, north: 7 },
  );
  const box = boundsPolygon({ west: 1, south: 2, east: 3, north: 4 });
  assert.deepEqual(box, {
    type: 'Polygon',
    coordinates: [
      [
        [1, 2],
        [3, 2],
        [3, 4],
        [1, 4],
        [1, 2],
      ],
    ],
  });
  const padded = boundsPolygon({ west: 1, south: -89.999, east: 3, north: 89.999 }, 0.005);
  assert.equal(padded.type, 'Polygon');
  if (padded.type === 'Polygon') {
    const lats = padded.coordinates[0]!.map((c) => c[1]);
    assert.equal(Math.min(...lats), -90);
    assert.equal(Math.max(...lats), 90);
  }
  assert.equal(roundCoord(12.3456789), 12.34568);
  assert.equal(roundCoord(-0.000004), -0);
  assert.equal(roundCoord(179.999996), 180);
});

test('a group of points across 180° is one small group, not a band round the world', () => {
  const points: Array<[number, number]> = [
    [179.95, 65],
    [-179.95, 65.02],
    [179.98, 65.05],
    [-179.99, 64.98],
  ];
  assert.deepEqual(
    continuousPoints(points).map((p) => Math.round(p[0] * 100) / 100),
    [179.95, 180.05, 179.98, 180.01],
  );
  assert.deepEqual(
    continuousPoints([
      [-179.95, 0],
      [179.95, 0],
    ]).map((p) => Math.round(p[0] * 100) / 100),
    [-179.95, -180.05],
  );
  assert.deepEqual(
    continuousPoints([
      [10, 1],
      [20, 2],
    ]),
    [
      [10, 1],
      [20, 2],
    ],
  );
  assert.deepEqual(continuousPoints([]), []);

  const bounds = boundsOfPoints(points)!;
  assert.deepEqual([bounds.west, bounds.east], [179.95, -179.95]);
  assert.deepEqual([bounds.south, bounds.north], [64.98, 65.05]);

  const footprint = footprintGeometry(points)!;
  assert.equal(footprint.type, 'Polygon');
  if (footprint.type !== 'Polygon') return;
  const ring = footprint.coordinates[0]!;
  for (const [lon] of ring) assert.ok(Math.abs(lon) >= 179.9 && Math.abs(lon) <= 180, `longitude ${lon}`);
  assert.ok(ring.some(([lon]) => lon > 0) && ring.some(([lon]) => lon < 0));
  // About 0.1° of longitude by 0.07° of latitude at 65°N: a few tens of km², not a hemisphere.
  const area = hullAreaKm2(points);
  assert.ok(area > 5 && area < 40, `area ${area}`);
});

test('footprintGeometry: a hull when there is one, else a padded box, else nothing', () => {
  assert.equal(footprintGeometry([]), undefined);
  const single = footprintGeometry([[10, 20]])!;
  assert.deepEqual(single, boundsPolygon({ west: 10, south: 20, east: 10, north: 20 }, 0.005));
  const line = footprintGeometry(
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    0.1,
  )!;
  assert.deepEqual(line, boundsPolygon({ west: 0, south: 0, east: 2, north: 2 }, 0.1));
  const area = footprintGeometry([
    [0, 0],
    [1, 0],
    [0, 1],
  ])!;
  assert.equal(area.type === 'Polygon' && area.coordinates[0]!.length, 4);
  // A lone detection right on 180° gets a box that steps across it, within ±180.
  const edge = footprintGeometry([[180, 0]], 0.005)!;
  if (edge.type === 'Polygon') for (const [lon] of edge.coordinates[0]!) assert.ok(Math.abs(lon) <= 180);
});

// ---- wildfire clustering --------------------------------------------------------

function detection(lat: number, lon: number, sec = 0) {
  const obj = thing({
    type: 'fire-detection',
    position: { latitude: lat, longitude: lon },
    observedAt: at(sec),
    properties: { frpMw: 10 },
  });
  return { obj, lat, lon, t: T0 + sec * 1000, frp: 10 };
}

test('clusterDetections: links within 5 km and 24 h, in chains; nothing farther or later', () => {
  const near = 0.03; // about 3.3 km of latitude
  const chain = [detection(10, 20), detection(10 + near, 20), detection(10 + 2 * near, 20, 60)];
  const far = detection(10 + 2 * near + 0.06, 20, 120);
  const late = detection(10, 20.01, 25 * 3600);
  const clusters = clusterDetections([...chain, far, late]);
  assert.deepEqual(
    clusters.map((c) => c.length),
    [3, 1, 1],
  );
  assert.ok(
    haversineMeters({ latitude: 10, longitude: 20 }, { latitude: 10 + near, longitude: 20 }) < CLUSTER_LINK_DISTANCE_M,
  );
  assert.deepEqual(clusterDetections([]), []);
});

test('detections on either side of 180° are one cluster with one small footprint', () => {
  const fires = [detection(65, 179.99), detection(65.01, -179.99), detection(65.02, 179.97), detection(64.99, -179.96)];
  assert.deepEqual(
    clusterDetections(fires).map((c) => c.length),
    [4],
  );
  const events = wildfireClusterRule.evaluate(
    fires.map((f) => f.obj),
    { now: T0 + 60_000, nowIso: at(60), existing: () => [] },
  );
  assert.equal(events.length, 1);
  const cluster = events[0]!;
  assert.equal(cluster.properties!['detectionCount'], 4);
  const bounds = cluster.properties!['bounds'] as { west: number; east: number };
  assert.ok(bounds.west > 179 && bounds.east < -179, JSON.stringify(bounds));
  assert.ok((cluster.properties!['areaKm2'] as number) < 20);
  assert.equal(cluster.geometry!.type, 'Polygon');
  if (cluster.geometry!.type === 'Polygon')
    for (const [lon] of cluster.geometry!.coordinates[0]!) assert.ok(Math.abs(lon) > 179.9, `longitude ${lon}`);
});

// ---- severity and confidence ----------------------------------------------------

test('severityAtLeast, maxSeverity, payloadSeverity', () => {
  assert.equal(severityAtLeast('MINOR', undefined), true);
  assert.equal(severityAtLeast(undefined, 'INFO'), true);
  assert.equal(severityAtLeast(undefined, 'MINOR'), false);
  assert.equal(severityAtLeast('SEVERE', 'SEVERE'), true);
  assert.equal(severityAtLeast('MODERATE', 'SEVERE'), false);
  assert.equal(severityAtLeast('EXTREME', 'SEVERE'), true);
  assert.equal(maxSeverity('MINOR', 'SEVERE'), 'SEVERE');
  assert.equal(maxSeverity('EXTREME', 'INFO'), 'EXTREME');
  assert.equal(maxSeverity('MODERATE', 'MODERATE'), 'MODERATE');
  for (const [value, want] of [
    ['Extreme', 'EXTREME'],
    [' severe ', 'SEVERE'],
    ['MODERATE', 'MODERATE'],
    ['minor', 'MINOR'],
    ['Unknown', 'INFO'],
    ['', 'INFO'],
    [4, 'EXTREME'],
    [3.5, 'SEVERE'],
    [2, 'MODERATE'],
    [1, 'MINOR'],
    [0, 'INFO'],
    [-1, 'INFO'],
    [Number.NaN, 'INFO'],
    [null, 'INFO'],
    [undefined, 'INFO'],
    [{}, 'INFO'],
  ] as const)
    assert.equal(payloadSeverity(value), want, String(value));
});

test('confidenceOf: the class of the mean score; no objects is UNKNOWN; a bad score counts as zero', () => {
  assert.equal(confidenceOf([]), 'UNKNOWN');
  assert.equal(confidenceOf([thing({ confidence: 0.9 }), thing({ confidence: 0.8 })]), 'HIGH');
  assert.equal(confidenceOf([thing({ confidence: 0.9 }), thing({ confidence: 0.3 })]), 'MEDIUM');
  assert.equal(confidenceOf([thing({ confidence: 0.9 }), thing({ confidence: Number.NaN })]), 'LOW');
  assert.equal(confidenceOf([thing({ confidence: 0.1 })]), 'UNKNOWN');
});

// ---- rule helpers ---------------------------------------------------------------

test('numberProp and stringProp: the first key that has a usable value', () => {
  const o = thing({
    labels: { name: '  Kilauea ' },
    properties: { a: 'x', b: ' 12.5 ', c: 7, d: '', e: Number.NaN, name: 'other' },
  });
  assert.equal(numberProp(o, 'missing', 'a', 'b', 'c'), 12.5);
  assert.equal(numberProp(o, 'c', 'b'), 7);
  assert.equal(numberProp(o, 'd'), undefined);
  assert.equal(numberProp(o, 'e'), undefined);
  assert.equal(numberProp(o), undefined);
  assert.equal(stringProp(o, 'name'), 'Kilauea', 'a label comes before a property');
  assert.equal(stringProp(o, 'd', 'a'), 'x');
  assert.equal(stringProp(o, 'c'), undefined);
  assert.equal(stringProp(o, 'missing'), undefined);
});

test('shortUtc: minutes in UTC, and unreadable text left as it is', () => {
  assert.equal(shortUtc('2026-09-21T03:14:59.999Z'), '2026-09-21 03:14 UTC');
  assert.equal(shortUtc('2026-09-20T17:14:00-10:00'), '2026-09-21 03:14 UTC');
  assert.equal(shortUtc('soon'), 'soon');
});

test('refsOf and derivedProvenance', () => {
  const a = thing({
    provenance: { providerId: 'p', sourceName: 'Source P', origin: 'live', receivedAt: at(0), attribution: 'P Corp' },
  });
  const b = thing({});
  const c = thing({
    sourceRefs: Array.from({ length: 40 }, (_, i) => ({ providerId: 'p', observationId: `o${i}`, observedAt: at(0) })),
  });
  assert.equal(refsOf([a, b]).length, 2);
  assert.equal(refsOf([a, b, c]).length, 32);
  assert.equal(refsOf([a, b, c], 3).length, 3);
  assert.deepEqual(refsOf([]), []);
  const refs = refsOf([a, b]);
  const derived = derivedProvenance([a, b], at(5), refs);
  assert.equal(derived.origin, 'derived');
  assert.equal(derived.receivedAt, at(5));
  assert.equal(derived.attribution, 'P Corp; Source P');
  assert.equal(derived.derivedFrom, refs);
  const historical = (o: WorldObject): WorldObject => ({ ...o, provenance: { ...o.provenance, origin: 'historical' } });
  assert.equal(derivedProvenance([historical(a), historical(b)], at(5), refs).origin, 'historical');
  assert.equal(derivedProvenance([historical(a), b], at(5), refs).origin, 'derived');
  const recorded: WorldObject = { ...b, provenance: { ...b.provenance, origin: 'recorded' } };
  assert.equal(derivedProvenance([historical(a), recorded], at(5), refs).origin, 'recorded');
  const none = derivedProvenance([], at(5), []);
  assert.equal(none.origin, 'derived');
  assert.equal('attribution' in none, false);
});

test('feedTime: when it happened, or for something still to come, when it was issued or raised', () => {
  const past = event({ id: 'e:1', startAt: at(-600) });
  assert.equal(feedTime(past), at(-600));
  const forecast = event({ id: 'e:2', startAt: at(7200), properties: { issuedAt: at(-300) } });
  assert.equal(feedTime(forecast), at(-300));
  assert.equal(feedTime(event({ id: 'e:3', startAt: at(7200) })), at(0), 'no issue time: when it was raised');
  assert.equal(feedTime(event({ id: 'e:4', startAt: at(7200), properties: { issuedAt: at(3600) } })), at(0));
  assert.equal(feedTime(event({ id: 'e:5', startAt: at(7200), properties: { issuedAt: 'soon' } })), at(0));
  assert.equal(feedTime(event({ id: 'e:6', startAt: 'unreadable' })), 'unreadable');
});

test('compareEvents: newest first, then id, and an unreadable start sorts last instead of breaking the order', () => {
  const a = event({ id: 'e:a', startAt: at(0) });
  const b = event({ id: 'e:b', startAt: at(60) });
  const twin = event({ id: 'e:c', startAt: at(0) });
  const broken = event({ id: 'e:d', startAt: 'never' });
  const alsoBroken = event({ id: 'e:e', startAt: '' });
  assert.ok(compareEvents(b, a) < 0);
  assert.ok(compareEvents(a, twin) < 0);
  assert.equal(compareEvents(a, a), 0);
  const all = [broken, a, alsoBroken, b, twin];
  for (const x of all)
    for (const y of all) {
      const c = compareEvents(x, y);
      assert.ok(!Number.isNaN(c));
      assert.equal(Math.sign(c), -Math.sign(compareEvents(y, x)) || 0);
    }
  assert.deepEqual(
    [...all].sort(compareEvents).map((e) => e.id),
    ['e:b', 'e:a', 'e:c', 'e:d', 'e:e'],
  );
});

test('stormTrend: against the newest point at least twelve hours before the last', () => {
  const point = (hours: number, intensityKt?: number) => ({
    at: at(hours * 3600),
    latitude: 20,
    longitude: -150,
    ...(intensityKt !== undefined ? { intensityKt } : {}),
  });
  assert.equal(stormTrend([]), undefined);
  assert.equal(stormTrend([point(0, 50)]), undefined);
  assert.equal(stormTrend([point(0, 50), point(11.9, 90)]), undefined, 'not twelve hours yet');
  assert.deepEqual(stormTrend([point(0, 50), point(12, 65)]), { trend: 'strengthening', fromKt: 50, since: at(0) });
  assert.equal(stormTrend([point(0, 50), point(12, 64)]), undefined, 'under fifteen knots is no trend');
  assert.deepEqual(stormTrend([point(0, 100), point(6, 120), point(18, 85)]), {
    trend: 'weakening',
    fromKt: 120,
    since: at(6 * 3600),
  });
  assert.equal(stormTrend([point(0, 50), point(12)]), undefined, 'the last point has no intensity');
  assert.deepEqual(
    stormTrend([point(0, 50), point(3), point(15, 70)])!.fromKt,
    50,
    'a point without intensity is passed over',
  );
});

test('withMainshock: the nearest larger earthquake within 100 km and the week before', () => {
  const quake = (id: string, magnitude: number, sec: number, lat = 35, lon = 139): WorldEvent =>
    event({
      id,
      type: 'earthquake',
      startAt: at(sec),
      properties: { magnitude },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  const main = quake('e:main', 6.8, 0);
  const after = quake('e:after', 4.9, 3600, 35.2);
  const pool = new Map([main, after].map((e) => [e.id, e] as const));
  assert.equal(withMainshock(after, pool).properties!['mainshockEventId'], 'e:main');
  assert.equal(withMainshock(main, pool), main, 'the mainshock has none, and is returned as it is');
  assert.equal('mainshockEventId' in (withMainshock(main, pool).properties ?? {}), false);

  const cases: Array<[string, WorldEvent]> = [
    ['too small to be a mainshock', quake('e:m', 5.4, 0)],
    ['not larger than the aftershock', quake('e:m', 5.6, 0)],
    ['after it', quake('e:m', 6.8, 7200)],
    ['more than a week before', quake('e:m', 6.8, -8 * 86_400)],
    ['more than 100 km away', quake('e:m', 6.8, 0, 36.5)],
    ['not an earthquake', { ...quake('e:m', 6.8, 0), type: 'weather.alert' }],
  ];
  const bigger = quake('e:after2', 5.6, 3600, 35.2);
  for (const [why, candidate] of cases) {
    const subject = why.startsWith('not larger') ? bigger : after;
    const linked = withMainshock(subject, new Map([[candidate.id, candidate]]));
    assert.equal(linked.properties!['mainshockEventId'], undefined, why);
  }
  // Of two candidates the nearer wins; a link that no longer holds is removed.
  const nearer = quake('e:near', 6.0, -60, 35.15);
  assert.equal(
    withMainshock(after, new Map([main, nearer].map((e) => [e.id, e] as const))).properties!['mainshockEventId'],
    'e:near',
  );
  const linked = withMainshock(after, pool);
  assert.equal(withMainshock(linked, pool), linked, 'already linked: unchanged');
  assert.equal('mainshockEventId' in withMainshock(linked, new Map()).properties!, false);
});

test('withSupersededBy: marks the replaced alert and ends it when the replacement was issued', () => {
  const old = event({ id: 'e:old', type: 'weather.alert', startAt: at(0), endAt: at(7200) });
  const by = event({
    id: 'e:new',
    type: 'weather.alert',
    startAt: at(1800),
    properties: { issuedAt: at(1800), supersedes: ['e:old'] },
  });
  const out = withSupersededBy(old, by);
  assert.equal(out.properties!['supersededBy'], 'e:new');
  assert.equal(out.endAt, at(1800));
  assert.equal(withSupersededBy(out, by), out, 'again: unchanged');
  // Never ended before it began, and an end already earlier is kept.
  const early = event({ id: 'e:early', startAt: at(-600), properties: { issuedAt: at(-600) } });
  assert.equal(withSupersededBy(old, early).endAt, at(0));
  const ended = { ...old, endAt: at(600) };
  assert.equal(withSupersededBy(ended, by).endAt, at(600));
  // An alert with no end gets one.
  const open = event({ id: 'e:open', startAt: at(0) });
  assert.equal(withSupersededBy(open, by).endAt, at(1800));
  assert.equal(old.endAt, at(7200), 'the event passed in is not changed');
});

test('linkSupersession: a stored alert is linked when a fresh one replaces it; the latest replacement wins', () => {
  const stored = event({ id: 'e:1', type: 'weather.alert', startAt: at(0), endAt: at(7200) });
  const second = event({
    id: 'e:2',
    type: 'weather.alert',
    startAt: at(600),
    properties: { issuedAt: at(600), supersedes: ['e:1'] },
  });
  const third = event({
    id: 'e:3',
    type: 'weather.alert',
    startAt: at(1200),
    properties: { issuedAt: at(1200), supersedes: ['e:1', 'e:2', 'e:3', 'e:gone'] },
  });
  const out = linkSupersession(new Map([second, third].map((e) => [e.id, e] as const)), [stored]);
  const byId = new Map(out.map((e) => [e.id, e] as const));
  assert.deepEqual([...byId.keys()].sort(), ['e:1', 'e:2', 'e:3']);
  assert.equal(byId.get('e:1')!.properties!['supersededBy'], 'e:3');
  assert.equal(byId.get('e:1')!.endAt, at(1200));
  assert.equal(byId.get('e:2')!.properties!['supersededBy'], 'e:3');
  assert.equal(byId.get('e:3')!.properties!['supersededBy'], undefined, 'an alert does not replace itself');
  // Nothing fresh, nothing to do; and a second pass over the result changes nothing.
  assert.deepEqual(linkSupersession(new Map(), [stored]), []);
  const again = linkSupersession(new Map([[third.id, byId.get('e:3')!]]), [byId.get('e:1')!, byId.get('e:2')!]);
  assert.deepEqual(
    again.map((e) => e.id),
    ['e:3'],
  );
});

test('sourceStatusEvent: one event per source and moment, saying what changed', () => {
  const change = {
    providerId: 'adsb-lol',
    from: 'ONLINE',
    to: 'AUTH_REQUIRED',
    entry: { name: 'adsb.lol', health: { message: 'key rejected', lastError: { code: 'AUTH' } } },
  } as unknown as SourceChange;
  const e = sourceStatusEvent(change, '2026-10-15T20:00:00.000Z');
  assert.equal(e.id, 'event:source-status-change:adsb-lol:20261015t200000000z');
  assert.equal(e.title, 'adsb.lol: credentials required');
  assert.equal(
    e.summary,
    'adsb.lol changed from online to credentials required at 2026-10-15 20:00 UTC. Last error: AUTH.',
  );
  assert.deepEqual(e.properties, {
    providerId: 'adsb-lol',
    from: 'ONLINE',
    to: 'AUTH_REQUIRED',
    sourceName: 'adsb.lol',
    message: 'key rejected',
    errorCode: 'AUTH',
  });
  assert.equal(e.severity, 'INFO');
  assert.equal(e.provenance.origin, 'local');
  const plain = sourceStatusEvent(
    { ...change, to: 'OFFLINE', entry: { name: 'adsb.lol', health: {} } } as unknown as SourceChange,
    at(1),
  );
  assert.equal(plain.title, 'adsb.lol: offline');
  assert.equal('message' in plain.properties!, false);
  assert.notEqual(plain.id, e.id);
});
