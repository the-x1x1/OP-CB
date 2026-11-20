import { normalizeLongitude, type GeoBounds, type WorldGeometry } from '@opcb/world-model';

/**
 * The points with their longitudes made continuous from the first one, so a group that lies
 * across 180° (Chukotka, Fiji) is a group and not two ends of the world: 179.9° and −179.9°
 * become 179.9° and 180.1°. Groups here are regional, far narrower than 180°.
 */
export function continuousPoints(points: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const first = points[0];
  if (!first) return [];
  return points.map(([lon, lat]) => {
    const d = lon - first[0];
    return [d > 180 ? lon - 360 : d < -180 ? lon + 360 : lon, lat];
  });
}

/** Andrew's monotone chain convex hull on lon/lat pairs (planar; fine for regional clusters). Returns a closed ring. */
export function convexHull(points: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p] as const)).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  if (pts.length < 3) return [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) return [];
  hull.push(hull[0]!);
  return hull;
}

/** Bounds of a regional group of points, the short way round: west > east when it lies across 180°. */
export function boundsOfPoints(points: ReadonlyArray<[number, number]>): GeoBounds | undefined {
  if (points.length === 0) return undefined;
  // The edges are the extreme points' own longitudes, as given: wrapping a shifted one back
  // (180.05 − 360) loses its last bits.
  const near = continuousPoints(points);
  let westAt = 0,
    eastAt = 0,
    south = 90,
    north = -90;
  near.forEach(([lon, lat], i) => {
    if (lon < near[westAt]![0]) westAt = i;
    if (lon > near[eastAt]![0]) eastAt = i;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  });
  return { west: points[westAt]![0], south, east: points[eastAt]![0], north };
}

export function boundsPolygon(b: GeoBounds, padDeg = 0): WorldGeometry {
  const w = b.west - padDeg,
    e = b.east + padDeg,
    s = Math.max(-90, b.south - padDeg),
    n = Math.min(90, b.north + padDeg);
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/**
 * Convex hull polygon when the points span an area, otherwise a padded bounding box. Across
 * 180° the ring's longitudes stay within ±180, so it steps from one side to the other the way
 * every other ring here does, instead of running the long way round the world.
 */
export function footprintGeometry(points: ReadonlyArray<[number, number]>, padDeg = 0.005): WorldGeometry | undefined {
  const near = continuousPoints(points);
  const wrapped = (ring: ReadonlyArray<[number, number]>): Array<[number, number]> =>
    ring.map(([lon, lat]) => [lon > 180 || lon < -180 ? normalizeLongitude(lon) : lon, lat]);
  const hull = convexHull(near);
  if (hull.length >= 4) return { type: 'Polygon', coordinates: [wrapped(hull)] };
  if (near.length === 0) return undefined;
  let west = Infinity,
    east = -Infinity,
    south = 90,
    north = -90;
  for (const [lon, lat] of near) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const box = boundsPolygon({ west, south, east, north }, padDeg);
  if (box.type !== 'Polygon') return box;
  return { type: 'Polygon', coordinates: [wrapped(box.coordinates[0] as Array<[number, number]>)] };
}

export function roundCoord(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}
