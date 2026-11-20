import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeoPosition, WorldEvent, WorldObject } from '@opcb/world-model';
import type { RenderFeature, ViewState } from './contract.js';
import { DEFAULT_RULES, presentObjects } from './presentation.js';

/**
 * A property of the whole presentation pass: whatever the objects' properties, motion and
 * shapes hold, every feature handed to a renderer has finite coordinates on the globe and
 * finite numbers in its style. (Cesium throws on a NaN in a position; MapLibre drops the
 * source.) Objects are generated from a fixed seed, so a failure names a case that repeats.
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

const TYPES = [...new Set(DEFAULT_RULES.flatMap((r) => r.objectTypes))];
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const HOSTILE: unknown[] = [
  undefined,
  null,
  '',
  'text',
  '12',
  '1e999',
  true,
  false,
  0,
  -0,
  -1,
  1e308,
  -1e308,
  1e-320,
  9_007_199_254_740_993,
  [],
  [1, 2],
  ['a'],
  {},
  { a: 1 },
];
const PROPERTY_KEYS = [
  'magnitude',
  'speedMps',
  'courseDegrees',
  'headingDegrees',
  'altitudeM',
  'onGround',
  'nextPosition',
  'propagatedAt',
  'military',
  'category',
  'satelliteCategory',
  'alertKind',
  'reportType',
  'spcCategory',
  'severity',
  'cycloneLayer',
  'stormType',
  'intensityKt',
  'gustKt',
  'windRadiiKt',
  'radiusNeNm',
  'radiusSeNm',
  'radiusSwNm',
  'radiusNwNm',
  'lengthM',
  'widthM',
  'frp',
  'confidence',
  'directionDegrees',
  'gustMps',
  'temperatureC',
  'ownVessel',
  'depthKm',
  'brightness',
  'status',
  'kind',
  'trackCategory',
  'forecastHours',
];

function makeObject(next: () => number, i: number, positions: 'valid' | 'any'): WorldObject {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const type = pick(TYPES);
  const coordinate = (range: number): number => {
    if (positions === 'any' && next() < 0.25)
      return pick([
        Number.NaN,
        Infinity,
        -Infinity,
        1e308,
        range * 4,
        -range * 4,
        null as unknown as number,
        '5' as unknown as number,
      ]);
    return next() < 0.1 ? pick([range, -range, 0, -0]) : (next() * 2 - 1) * range;
  };
  const position = (): GeoPosition => ({
    latitude: coordinate(90),
    longitude: coordinate(180),
    ...(next() < 0.5
      ? { altitudeM: positions === 'any' && next() < 0.2 ? pick([Number.NaN, Infinity, -1e9]) : next() * 12_000 }
      : {}),
  });
  const properties: Record<string, unknown> = {};
  for (const key of PROPERTY_KEYS) {
    const roll = next();
    if (roll < 0.35) properties[key] = pick(HOSTILE);
    else if (roll < 0.6) properties[key] = (next() * 2 - 1) * 500;
  }
  if (next() < 0.3)
    properties['nextPosition'] = [coordinate(90), coordinate(180), next() * 500_000, T0 + next() * 200_000 - 50_000];
  if (next() < 0.3) properties['propagatedAt'] = pick([new Date(T0).toISOString(), 'never', '']);
  // Shapes are checked where they come in (world-model geometrySchema), so they stay on the globe here.
  const shape = (range: number): number => (next() * 2 - 1) * range;
  const ring = (): number[][] => {
    const base = [shape(180), shape(90)];
    const pts = Array.from({ length: 3 + Math.floor(next() * 4) }, () => [shape(180), shape(90)]);
    return [base, ...pts, base];
  };
  const geometry =
    next() < 0.4
      ? pick([
          { type: 'Point', coordinates: [shape(180), shape(90)] },
          {
            type: 'LineString',
            coordinates: [
              [shape(180), shape(90)],
              [shape(180), shape(90)],
            ],
          },
          { type: 'LineString', coordinates: [] },
          { type: 'Polygon', coordinates: [ring()] },
          { type: 'Polygon', coordinates: [] },
          { type: 'MultiPolygon', coordinates: [[ring()], [], [ring(), ring()]] },
          { type: 'MultiLineString', coordinates: [[], [[shape(180), shape(90)]]] },
          { type: 'MultiPoint', coordinates: [] },
        ])
      : undefined;
  const speed = pick([0, 5, 250, -1, 1e9, ...(positions === 'any' ? [Number.NaN, Infinity] : [])]);
  return {
    id: `p:${type}:${i}`,
    type,
    sourceRefs: [],
    observedAt: pick([
      new Date(T0 - next() * 600_000).toISOString(),
      new Date(T0).toISOString(),
      ...(positions === 'any' ? ['not a time'] : []),
    ]),
    updatedAt: new Date(T0).toISOString(),
    freshness: pick(['LIVE', 'RECENT', 'STALE', 'EXPIRED']),
    confidence: next(),
    labels:
      next() < 0.5
        ? { name: pick(['A', '', 'x'.repeat(5000), '\u202Eevil', 'line\nbreak']), callsign: pick(['', 'HAL25']) }
        : {},
    properties,
    ...(next() < 0.9 ? { position: position() } : {}),
    ...(next() < 0.5
      ? {
          motion: {
            speedMps: speed,
            headingDegrees: pick([0, 90, 359.9, 720, -90, ...(positions === 'any' ? [Number.NaN] : [])]),
            verticalSpeedMps: pick([0, 10, -10]),
          },
        }
      : {}),
    ...(geometry ? { geometry } : {}),
    provenance: { providerId: 'p', origin: 'live' },
  } as unknown as WorldObject;
}

const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
const onGlobe = (p: GeoPosition | undefined): boolean =>
  !!p &&
  finite(p.latitude) &&
  finite(p.longitude) &&
  Math.abs(p.latitude) <= 90 &&
  Math.abs(p.longitude) <= 180 &&
  (p.altitudeM === undefined || finite(p.altitudeM));
const boundsOk = (b: { west: number; south: number; east: number; north: number }): boolean =>
  [b.west, b.south, b.east, b.north].every(finite) && Math.abs(b.south) <= 90 && Math.abs(b.north) <= 90;

function problemWith(f: RenderFeature): string | undefined {
  const g = f.geometry;
  if (typeof f.id !== 'string' || !f.id) return 'no id';
  if (!finite(f.priority)) return `priority ${f.priority}`;
  if (g.kind === 'point' && !onGlobe(g.position)) return `point ${JSON.stringify(g.position)}`;
  if (g.kind === 'line' && !g.positions.every(onGlobe)) return 'a line position off the globe';
  if (g.kind === 'polygon' && !g.rings.every((r) => r.every(onGlobe))) return 'a ring position off the globe';
  if (g.kind === 'circle' && (!onGlobe(g.center) || !finite(g.radiusM) || g.radiusM < 0))
    return `circle ${JSON.stringify(g)}`;
  if (g.kind === 'cluster' && (!onGlobe(g.position) || !finite(g.count) || !boundsOk(g.bounds)))
    return `cluster ${JSON.stringify(g)}`;
  if (g.kind === 'density' && (!boundsOk(g.bounds) || !finite(g.count) || !finite(g.intensity)))
    return `density ${JSON.stringify(g)}`;
  for (const key of ['size', 'opacity', 'rotationDegrees', 'labelPriority', 'lengthM'] as const) {
    const v = f.style[key];
    if (v !== undefined && !finite(v)) return `style.${key} ${v}`;
  }
  if (f.style.size !== undefined && f.style.size < 0) return `style.size ${f.style.size}`;
  if (f.style.label !== undefined && typeof f.style.label !== 'string') return `label ${typeof f.style.label}`;
  if (typeof f.style.styleClass !== 'string' || !f.style.styleClass) return 'no style class';
  if (
    f.motion &&
    (!onGlobe(f.motion.to) || !finite(f.motion.fromMs) || !finite(f.motion.toMs) || !(f.motion.toMs > f.motion.fromMs))
  )
    return `motion ${JSON.stringify(f.motion)}`;
  return undefined;
}

const VIEWS: ViewState[] = [1.5, 4, 7, 10, 14].map((zoom) => ({
  center: { latitude: 21.3, longitude: -157.8 },
  altitudeM: 20_000_000 / 2 ** zoom,
  zoom,
  headingDegrees: 0,
  pitchDegrees: -90,
}));

function run(seed: number, count: number, positions: 'valid' | 'any'): { features: number; problems: string[] } {
  const next = rng(seed);
  const objects = Array.from({ length: count }, (_, i) => makeObject(next, i, positions));
  const problems: string[] = [];
  let features = 0;
  for (const view of VIEWS)
    for (const detail of [0, 1, 2] as const)
      for (const animate of [false, true]) {
        const selectedId = objects[Math.floor(next() * objects.length)]!.id;
        const result = presentObjects({
          objects,
          view,
          detail,
          animate,
          cullToView: false,
          selectedId,
          hoveredId: objects[0]!.id,
          nowMs: T0,
        });
        features += result.upsert.length;
        const ids = new Set<string>();
        for (const f of result.upsert) {
          if (ids.has(f.id)) problems.push(`zoom ${view.zoom}: feature id ${f.id} twice`);
          ids.add(f.id);
          const problem = problemWith(f);
          if (problem)
            problems.push(
              `zoom ${view.zoom} detail ${detail}: ${f.objectId ?? f.id} (${f.style.styleClass}): ${problem}`,
            );
        }
        for (const n of Object.values(result.stats))
          if (typeof n === 'number' && !finite(n)) problems.push(`stats ${JSON.stringify(result.stats)}`);
      }
  return { features, problems: [...new Set(problems)] };
}

test('presentation: objects on the globe with any properties, motion and shapes give only drawable features', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { features, problems } = run(seed, 400, 'valid');
    assert.ok(features > 1000, `seed ${seed}: ${features} features`);
    assert.deepEqual(problems.slice(0, 12), [], `seed ${seed}: ${problems.length} problems`);
  }
});

test('presentation: objects whose own position or motion is not a number are left out or drawn where they can be, never passed on as NaN', () => {
  for (const seed of [11, 12, 13]) {
    const { problems } = run(seed, 400, 'any');
    assert.deepEqual(problems.slice(0, 12), [], `seed ${seed}: ${problems.length} problems`);
  }
});

test('presentation: events with any shape and times do not break the pass', () => {
  const next = rng(99);
  const objects = Array.from({ length: 50 }, (_, i) => makeObject(next, i, 'valid'));
  const events = Array.from({ length: 200 }, (_, i) => {
    const o = makeObject(next, i, 'valid');
    return {
      id: `event:${i}`,
      type: [
        'earthquake',
        'weather-alert',
        'wildfire-cluster',
        'tropical-cyclone',
        'aircraft-emergency',
        'no-such-type',
      ][i % 6],
      title: 'e',
      startAt: [new Date(T0 - 3_600_000).toISOString(), 'never', ''][i % 3],
      ...(i % 4 === 0 ? { endAt: new Date(T0 - 60_000).toISOString() } : {}),
      severity: ['INFO', 'MINOR', 'MODERATE', 'SEVERE', 'EXTREME', 'constructor'][i % 6],
      objectIds: i % 2 ? [objects[i % objects.length]!.id] : [],
      ...(o.position ? { position: o.position } : {}),
      ...(o.geometry ? { geometry: o.geometry } : {}),
      properties: o.properties,
    } as unknown as WorldEvent;
  });
  for (const view of VIEWS) {
    const result = presentObjects({ objects, events, view, cullToView: false, nowMs: T0, shownAtMs: T0 });
    const problems = result.upsert.map(problemWith).filter(Boolean);
    assert.deepEqual(problems.slice(0, 8), [], `zoom ${view.zoom}`);
  }
});
