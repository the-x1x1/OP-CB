import type { GeoPosition } from '@opcb/world-model';

/** One grid point of a wind layer: where, and its eastward and northward components in m/s. */
export interface WindPoint {
  latitude: number;
  longitude: number;
  u: number;
  v: number;
}

/** Points farther than this from the view's middle say nothing about the wind there. */
export const WIND_REACH_KM = 1600;
const NEAREST = 4;
const EARTH_KM = 6371.0088;
const rad = Math.PI / 180;

function distanceKm(a: GeoPosition, lat: number, lon: number): number {
  const dLat = (lat - a.latitude) * rad;
  const dLon = (lon - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The wind at `at` from a grid of points (the `wind` layer, ADR-002 amendment 2026-11-11):
 * the u and v of the nearest four points within reach, weighted by the inverse square of
 * their distance — on a point, that point's own wind. Components are averaged, not speeds
 * and directions, so opposite winds either side cancel as they would. Undefined with no point
 * in reach. `fromDeg` is where the wind blows from, clockwise from north; undefined in a calm.
 */
export function windAt(
  points: readonly WindPoint[],
  at: GeoPosition | undefined,
): { speedMps: number; fromDeg?: number } | undefined {
  if (!at || !points.length) return undefined;
  const near: Array<{ d: number; p: WindPoint }> = [];
  for (const p of points) {
    const d = distanceKm(at, p.latitude, p.longitude);
    if (d > WIND_REACH_KM) continue;
    if (near.length < NEAREST) near.push({ d, p });
    else {
      let far = 0;
      for (let i = 1; i < near.length; i++) if (near[i]!.d > near[far]!.d) far = i;
      if (d < near[far]!.d) near[far] = { d, p };
    }
  }
  if (!near.length) return undefined;
  let u = 0,
    v = 0,
    w = 0;
  for (const { d, p } of near) {
    if (d < 0.5) return reading(p.u, p.v);
    const k = 1 / (d * d);
    u += k * p.u;
    v += k * p.v;
    w += k;
  }
  return reading(u / w, v / w);
}

function reading(u: number, v: number): { speedMps: number; fromDeg?: number } {
  const speedMps = Math.hypot(u, v);
  if (speedMps < 0.05) return { speedMps: 0 };
  const toward = (Math.atan2(u, v) / rad + 360) % 360;
  return { speedMps, fromDeg: (toward + 180) % 360 };
}

/** The WND row: `FROM 274° 7.4 M/S`, `CALM`, or undefined with no wind layer in reach. */
export function windReadout(r: ReturnType<typeof windAt>): string | undefined {
  if (!r) return undefined;
  if (r.fromDeg === undefined || r.speedMps < 0.5) return 'CALM';
  const deg = String(Math.round(r.fromDeg) % 360).padStart(3, '0');
  return `FROM ${deg}° ${r.speedMps.toFixed(1)} M/S`;
}

/** The wind layer's points among the objects shown: `wind` objects with u and v. */
export function windPoints(
  objects: Iterable<{ type: string; position?: GeoPosition; properties: Record<string, unknown> }>,
): WindPoint[] {
  const out: WindPoint[] = [];
  for (const o of objects) {
    if (o.type !== 'wind' || !o.position) continue;
    const u = o.properties['uMps'],
      v = o.properties['vMps'];
    if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) continue;
    out.push({ latitude: o.position.latitude, longitude: o.position.longitude, u, v });
  }
  return out;
}
