import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderFeature } from '@opcb/render-core';
import type { GeoPosition } from '@opcb/world-model';
import { circleRing, toOverlayFeature } from './geojson.js';

/**
 * What the 2D map is handed, for any feature the presentation pass may produce: positions on
 * the globe in every arrangement (across the 180th meridian, at and round the poles, the
 * same place twice). MapLibre drops a whole source for one bad coordinate and draws a ring
 * that jumps 360° as a band across the map, so every geometry here must be finite, closed
 * where it is an area, and continuous in longitude. Features are generated from a fixed seed.
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

const next = rng(2026);
const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
const LATS = [-90, -89.9999, -85.051129, -60, 0, 21.3, 60, 85.051129, 89.9999, 90];
const LONS = [-180, -179.9999, -157.8, -90, 0, 90, 179.9999, 180];
const lat = () => (next() < 0.4 ? pick(LATS) : (next() * 2 - 1) * 90);
const lon = () => (next() < 0.4 ? pick(LONS) : (next() * 2 - 1) * 180);
const place = (): GeoPosition => ({
  latitude: lat(),
  longitude: lon(),
  ...(next() < 0.2 ? { altitudeM: pick([0, 10_000, -400, 400_000]) } : {}),
});
/** Places a short way from each other, as a real outline's are; sometimes across 180°. */
function path(length: number): GeoPosition[] {
  let at = place();
  const out: GeoPosition[] = [];
  for (let i = 0; i < length; i++) {
    out.push(at);
    const stay = next() < 0.1;
    let longitude = at.longitude + (stay ? 0 : (next() * 2 - 1) * 8);
    if (longitude > 180) longitude -= 360;
    if (longitude < -180) longitude += 360;
    at = { latitude: Math.max(-90, Math.min(90, at.latitude + (stay ? 0 : (next() * 2 - 1) * 4))), longitude };
  }
  return out;
}

function feature(i: number): RenderFeature {
  const roll = next();
  const geometry: RenderFeature['geometry'] =
    roll < 0.2
      ? { kind: 'point', position: place() }
      : roll < 0.4
        ? { kind: 'line', positions: path(pick([0, 1, 2, 3, 12, 40])) }
        : roll < 0.6
          ? (() => {
              // Closed, as the world model's polygons are; none (an empty list) is left out.
              const ring = path(pick([0, 3, 4, 9, 30]));
              if (ring.length) ring.push(ring[0]!);
              const hole = path(4);
              hole.push(hole[0]!);
              return { kind: 'polygon' as const, rings: next() < 0.2 ? [ring, hole] : next() < 0.05 ? [] : [ring] };
            })()
          : roll < 0.8
            ? {
                kind: 'circle',
                center: place(),
                radiusM: pick([
                  0,
                  -5,
                  1,
                  500,
                  50_000,
                  2_000_000,
                  9_000_000,
                  10_007_543,
                  19_000_000,
                  20_015_086,
                  4e7,
                  Number.NaN,
                ]),
              }
            : roll < 0.9
              ? {
                  kind: 'cluster',
                  position: place(),
                  count: pick([1, 2, 5000]),
                  bounds: { west: lon(), south: -10, east: lon(), north: 10 },
                }
              : {
                  kind: 'density',
                  bounds: { west: lon(), south: Math.min(lat(), 0), east: lon(), north: Math.max(lat(), 0) },
                  count: pick([0, 1, 1e6]),
                  intensity: pick([0, 0.5, 1, 7, -1]),
                };
  return {
    id: `f${i}`,
    layer: 'objects',
    interactive: next() < 0.8,
    priority: pick([0, 1, 50, 1000, -3]),
    geometry,
    style: {
      styleClass: pick(['aircraft', 'earthquake.major', 'weather-alert.tornado', 'constructor', 'no-such-class']),
      ...(next() < 0.3 ? { color: pick(['#ff0000', '#abc', 'red', '', 'constructor']) } : {}),
      ...(next() < 0.3 ? { size: pick([0, 1, 14, 400]) } : {}),
      ...(next() < 0.3 ? { opacity: pick([0, 0.5, 1]) } : {}),
      ...(next() < 0.3 ? { rotationDegrees: pick([0, 359.9, 360, -90, 725]) } : {}),
      ...(next() < 0.3 ? { label: pick(['Harbour', '', 'x'.repeat(300), 'a\nb']) } : {}),
    },
  };
}

function problem(ring: ReadonlyArray<ReadonlyArray<number>>, area: boolean): string | undefined {
  if (ring.length < (area ? 4 : 2)) return `${ring.length} positions`;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    if (!p.every((v) => Number.isFinite(v))) return `position ${i} is ${JSON.stringify(p)}`;
    if (Math.abs(p[1]!) > 90) return `latitude ${p[1]}`;
    // One world copy either side is what an unwrapped outline may reach.
    if (Math.abs(p[0]!) > 540 + 1e-6) return `longitude ${p[0]}`;
    // Along the map's own top or bottom edge a ring round a pole runs the width of the world.
    const alongEdge = i > 0 && Math.abs(p[1]!) >= 85.05 && p[1] === ring[i - 1]![1];
    if (i > 0 && !alongEdge && Math.abs(p[0]! - ring[i - 1]![0]!) > 180 + 1e-6)
      return `a step of ${Math.round(Math.abs(p[0]! - ring[i - 1]![0]!))}° in longitude at ${i}`;
  }
  if (area) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) return 'not closed';
  }
  return undefined;
}

test('every feature the 2D map is handed has finite, continuous, closed geometry', () => {
  let made = 0;
  let left = 0;
  for (let i = 0; i < 20_000; i++) {
    const f = feature(i);
    const out = toOverlayFeature(f);
    if (!out) {
      left++;
      continue;
    }
    made++;
    const g = out.geometry;
    const where = `${JSON.stringify(f.geometry).slice(0, 400)} became ${JSON.stringify(g).slice(0, 300)}`;
    let why: string | undefined;
    if (g.type === 'Point') why = problem([g.coordinates, g.coordinates], false);
    else if (g.type === 'LineString') why = problem(g.coordinates, false);
    else if (g.type === 'MultiLineString') why = g.coordinates.map((c) => problem(c, false)).find(Boolean);
    else if (g.type === 'Polygon' && f.geometry.kind === 'density') {
      // A box is as wide as its bounds say, up to the whole world; it runs west to east.
      const [sw, se] = g.coordinates[0]!;
      const width = se![0]! - sw![0]!;
      why = !g.coordinates[0]!.flat().every((v) => Number.isFinite(v))
        ? 'a coordinate that is not a number'
        : width < 0 || width > 360
          ? `a box ${width}° wide`
          : undefined;
    } else if (g.type === 'Polygon') why = g.coordinates.map((c) => problem(c, true)).find(Boolean);
    else why = `a ${String((g as { type: string }).type)}`;
    assert.equal(why, undefined, `${why}: ${where}`);
    JSON.stringify(out.properties, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`a style number is ${value}: ${where}`);
      if (value === undefined) throw new Error(`a style value is missing: ${where}`);
      return value;
    });
  }
  assert.ok(made > 12_000 && left > 500, `${made} made, ${left} left out`);
});

test('a circle is a ring round its centre wherever the centre is', () => {
  for (let i = 0; i < 4000; i++) {
    const center = { latitude: lat(), longitude: lon() };
    const radiusM = pick([1, 500, 50_000, 800_000, 3_000_000, 9_000_000, 10_007_000, 15_000_000, 19_900_000]);
    const ring = circleRing(center, radiusM);
    const where = `${JSON.stringify(center)} ${radiusM} m`;
    assert.equal(problem(ring, true), undefined, `${problem(ring, true)}: ${where}`);
    // It goes round: the bearings from the centre cover the compass, so the ring is not a line.
    const lons = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    const spanLon = Math.max(...lons) - Math.min(...lons);
    const spanLat = Math.max(...lats) - Math.min(...lats);
    assert.ok(
      spanLon > 0 && spanLat > 0,
      `a circle with no width or no height: ${where} ${JSON.stringify(ring.slice(0, 4))}`,
    );
  }
});
