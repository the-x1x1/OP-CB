import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDegrees,
  boundsCenter,
  boundsContain,
  boundsIntersect,
  circleBounds,
  haversineMeters,
  normalizeLongitude,
  pointInPolygon,
  polygonBounds,
  simplifyRing,
  type GeoBounds,
} from './geo.js';

/**
 * What the geography helpers promise each other, over generated places: bounds that share a
 * point intersect, a middle is inside what it is the middle of, a circle and a ring lie
 * inside their own bounds. The spatial index and every "what is in view" question rest on
 * these agreeing. Places are generated from a fixed seed and lean on the awkward ones.
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
const lat = () => (next() < 0.25 ? pick([-90, -89.9999, 0, 60, 89.9999, 90]) : (next() * 2 - 1) * 90);
const lon = () => (next() < 0.25 ? pick([-180, -179.9999, 0, 179.9999, 180]) : (next() * 2 - 1) * 180);
const place = () => ({ latitude: lat(), longitude: lon() });
const bounds = (): GeoBounds => {
  const south = lat();
  return { south, north: Math.min(90, south + next() * 60), west: lon(), east: lon() };
};

test('a longitude is brought into range, stays the same place, and is left alone once there', () => {
  for (let i = 0; i < 5000; i++) {
    const raw = next() < 0.2 ? pick([-540, -360, -180, 0, 180, 360, 540, 720]) : (next() * 2 - 1) * 2000;
    const n = normalizeLongitude(raw);
    assert.ok(n >= -180 && n <= 180, `${raw} became ${n}`);
    const turns = (raw - n) / 360;
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9, `${raw} became a different place, ${n}`);
    assert.equal(normalizeLongitude(n), n, `${raw}: ${n} was changed again`);
  }
  // In range comes back digit for digit.
  for (const exact of [-179.9999, 179.9999, -180, 180, 0.1, -0.30000000000000004])
    assert.equal(normalizeLongitude(exact), exact);
  for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    assert.equal(Object.is(normalizeLongitude(odd), odd), true);
});

test('distance is the same both ways, never negative, never more than half way round; a bearing is a compass angle', () => {
  for (let i = 0; i < 5000; i++) {
    const a = place();
    const b = place();
    const d = haversineMeters(a, b);
    assert.ok(Number.isFinite(d) && d >= 0 && d <= 20_015_200, `${JSON.stringify([a, b])} is ${d} m`);
    assert.ok(Math.abs(d - haversineMeters(b, a)) < 1e-6, `${JSON.stringify([a, b])} differs by direction`);
    assert.equal(haversineMeters(a, a), 0);
    const bearing = bearingDegrees(a, b);
    assert.ok(bearing >= 0 && bearing < 360, `${JSON.stringify([a, b])} bears ${bearing}`);
  }
});

test('bounds that hold the same place intersect, either way round, and hold their own middle', () => {
  let shared = 0;
  for (let i = 0; i < 20_000; i++) {
    const a = bounds();
    const b = bounds();
    assert.equal(boundsIntersect(a, b), boundsIntersect(b, a), JSON.stringify([a, b]));
    const p = next() < 0.5 ? boundsCenter(a) : place();
    if (boundsContain(a, p) && boundsContain(b, p)) {
      shared++;
      assert.ok(boundsIntersect(a, b), `${JSON.stringify([a, b])} both hold ${JSON.stringify(p)}`);
    }
    assert.ok(boundsContain(a, boundsCenter(a)), `${JSON.stringify(a)} does not hold its middle`);
    // A corner of one inside the other is an intersection too.
    for (const corner of [
      { latitude: a.south, longitude: a.west },
      { latitude: a.north, longitude: a.east },
    ])
      if (boundsContain(b, corner)) assert.ok(boundsIntersect(a, b), JSON.stringify([a, b, corner]));
  }
  assert.ok(shared > 500, `${shared} pairs shared a place`);
});

test('every place inside a circle is inside the bounds given for it', () => {
  let inside = 0;
  for (let i = 0; i < 3000; i++) {
    const center = place();
    const radiusM = next() < 0.3 ? next() * 19_000_000 : next() * 800_000;
    const b = circleBounds(center, radiusM);
    assert.ok(b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180, JSON.stringify(b));
    for (let k = 0; k < 20; k++) {
      // Near the centre as often as far from it, so small circles get places too.
      const p =
        next() < 0.5
          ? place()
          : {
              latitude: Math.max(-90, Math.min(90, center.latitude + (next() * 2 - 1) * (radiusM / 111_000))),
              longitude: normalizeLongitude(center.longitude + (next() * 2 - 1) * (radiusM / 40_000)),
            };
      if (haversineMeters(center, p) > radiusM) continue;
      inside++;
      assert.ok(
        boundsContain(b, p),
        `${JSON.stringify(p)} is ${Math.round(haversineMeters(center, p))} m from ${JSON.stringify(center)}, inside ${Math.round(radiusM)}, outside ${JSON.stringify(b)}`,
      );
    }
  }
  assert.ok(inside > 5000, `${inside} places fell inside`);
});

test('every place inside a four-cornered ring is inside its bounds, across the antimeridian too', () => {
  let inside = 0;
  for (let i = 0; i < 3000; i++) {
    const south = (next() * 2 - 1) * 75;
    const west = next() < 0.4 ? 165 + next() * 14 : (next() * 2 - 1) * 150;
    const h = 0.5 + next() * 14;
    const w = 0.5 + next() * 30;
    const wrap = (x: number) => (x > 180 ? x - 360 : x);
    const ring: Array<[number, number]> = [
      [west, south],
      [wrap(west + w), south],
      [wrap(west + w), south + h],
      [west, south + h],
      [west, south],
    ];
    const b = polygonBounds(ring);
    for (let k = 0; k < 12; k++) {
      const p = { latitude: south + (next() * 1.4 - 0.2) * h, longitude: wrap(west + (next() * 1.4 - 0.2) * w) };
      if (p.longitude < -180) continue;
      const within =
        p.latitude > south &&
        p.latitude < south + h &&
        (() => {
          const dx = (((p.longitude - west) % 360) + 360) % 360;
          return dx > 0 && dx < w;
        })();
      // Away from the edges, where which side a point falls is a matter of rounding.
      const nearEdge =
        Math.min(Math.abs(p.latitude - south), Math.abs(p.latitude - south - h)) < 1e-6 ||
        (() => {
          const dx = (((p.longitude - west) % 360) + 360) % 360;
          return Math.min(dx, Math.abs(dx - w), 360 - dx) < 1e-6;
        })();
      if (nearEdge) continue;
      assert.equal(pointInPolygon(p, ring), within, `${JSON.stringify(p)} and ${JSON.stringify(ring)}`);
      if (within) {
        inside++;
        assert.ok(boundsContain(b, p), `${JSON.stringify(p)} in ${JSON.stringify(ring)} outside ${JSON.stringify(b)}`);
      }
    }
  }
  assert.ok(inside > 5000, `${inside} places fell inside`);
});

test('a simplified ring is still a ring, made only of places the outline had', () => {
  for (let i = 0; i < 400; i++) {
    const n = 3 + Math.floor(next() * 200);
    const cx = (next() * 2 - 1) * 100;
    const cy = (next() * 2 - 1) * 60;
    const ring: Array<[number, number]> = [];
    for (let k = 0; k < n; k++) {
      const angle = (k / n) * Math.PI * 2;
      const r = 1 + next() * (next() < 0.3 ? 5 : 0.2);
      ring.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
    // Sometimes the same place twice running, as real outlines have.
    if (next() < 0.3) ring.splice(1, 0, [ring[0]![0], ring[0]![1]]);
    ring.push([ring[0]![0], ring[0]![1]]);
    for (const tolerance of [0, 0.001, 0.05, 1, 50, Number.NaN]) {
      const out = simplifyRing(ring, tolerance);
      assert.ok(
        out.length >= Math.min(4, ring.length) && out.length <= ring.length,
        `${n} points became ${out.length}`,
      );
      assert.deepEqual(out[0], out[out.length - 1], 'no longer closed');
      const rounded = new Set(ring.map((c) => `${Math.round(c[0] * 1e5) / 1e5},${Math.round(c[1] * 1e5) / 1e5}`));
      for (const c of out) {
        assert.ok(Number.isFinite(c[0]) && Number.isFinite(c[1]));
        assert.ok(rounded.has(`${c[0]},${c[1]}`), `${JSON.stringify(c)} was not in the outline`);
      }
    }
  }
});
