/**
 * Geographic primitives. All coordinates are WGS84 degrees; altitudes are metres.
 * Longitudes are normalised to [-180, 180]. Regions are used by queries, watch zones
 * and worldpacks.
 */

export interface GeoPosition {
  latitude: number;
  longitude: number;
  /** Metres. Datum is declared by `altitudeDatum`; absent altitude means surface/unknown. */
  altitudeM?: number;
  altitudeDatum?: 'ellipsoid' | 'msl' | 'barometric' | 'ground' | 'sea-surface' | 'orbit';
  /** Horizontal accuracy in metres when the source reports it. */
  accuracyM?: number;
}

export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type WorldGeometry =
  | { type: 'Point'; coordinates: [number, number] | [number, number, number] }
  | { type: 'MultiPoint'; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: 'LineString'; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: 'MultiLineString'; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | { type: 'Polygon'; coordinates: Array<Array<[number, number] | [number, number, number]>> }
  | { type: 'MultiPolygon'; coordinates: Array<Array<Array<[number, number] | [number, number, number]>>> };

export type GeoRegion =
  | { kind: 'bounds'; bounds: GeoBounds }
  | { kind: 'circle'; center: GeoPosition; radiusM: number }
  | { kind: 'polygon'; polygon: Array<[number, number]> }
  | {
      kind: 'admin';
      /** Stable admin id such as `iso3166-1:US` or `iso3166-2:US-HI` */ regionId: string;
      bounds?: GeoBounds;
    };

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function normalizeLongitude(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

export function isValidLatLon(lat: unknown, lon: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

export function isValidBounds(b: GeoBounds): boolean {
  return (
    Number.isFinite(b.west) &&
    Number.isFinite(b.east) &&
    Number.isFinite(b.south) &&
    Number.isFinite(b.north) &&
    b.south <= b.north &&
    Math.abs(b.south) <= 90 &&
    Math.abs(b.north) <= 90 &&
    Math.abs(b.west) <= 180 &&
    Math.abs(b.east) <= 180
  );
}

/** Great-circle distance in metres (haversine). */
export function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.latitude * DEG) * Math.cos(b.latitude * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearingDegrees(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const φ1 = a.latitude * DEG,
    φ2 = b.latitude * DEG,
    Δλ = (b.longitude - a.longitude) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Pull a viewport rectangle back inside the contract's limits.
 *
 * A renderer's own idea of what it can see routinely lands a hair outside the world:
 * Cesium's `computeViewRectangle` is radians, and ±π converted to degrees is
 * ±180.00000000000003, while MapLibre reports an unwrapped longitude once the map has
 * been dragged past the antimeridian. Either is enough for the IPC validator to reject
 * the whole `world.viewport` call — which it did, silently, for every view wide enough to
 * see the globe, so the backend never learned what the operator was actually looking at.
 * Clamping at the edge of the world is right here rather than merely convenient: the
 * caller is describing a region of the Earth, and the Earth stops at 180.
 */
export function clampBounds(b: GeoBounds): GeoBounds {
  const lat = (v: number) => (Number.isFinite(v) ? Math.max(-90, Math.min(90, v)) : v);
  const lon = (v: number) => (Number.isFinite(v) ? Math.max(-180, Math.min(180, v)) : v);
  return { west: lon(b.west), south: lat(b.south), east: lon(b.east), north: lat(b.north) };
}

/** The middle of bounds; across the antimeridian (west > east) it is on the 180° side. */
export function boundsCenter(b: GeoBounds): { latitude: number; longitude: number } {
  const east = b.west > b.east ? b.east + 360 : b.east;
  return { latitude: (b.north + b.south) / 2, longitude: normalizeLongitude((b.west + east) / 2) };
}

/** Bounds may cross the antimeridian (west > east). */
export function boundsContain(b: GeoBounds, p: { latitude: number; longitude: number }): boolean {
  if (p.latitude < b.south || p.latitude > b.north) return false;
  if (b.west <= b.east) return p.longitude >= b.west && p.longitude <= b.east;
  return p.longitude >= b.west || p.longitude <= b.east;
}

export function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
  if (a.north < b.south || a.south > b.north) return false;
  const aSplit = a.west > a.east,
    bSplit = b.west > b.east;
  if (!aSplit && !bSplit) return !(a.east < b.west || a.west > b.east);
  if (aSplit && bSplit) return true;
  const [s, n] = aSplit ? [a, b] : [b, a];
  return n.east >= s.west || n.west <= s.east;
}

/** Bounding box of a circle (clamped at the poles; may cross the antimeridian). */
export function circleBounds(center: GeoPosition, radiusM: number): GeoBounds {
  const dLat = radiusM / EARTH_RADIUS_M / DEG;
  const south = Math.max(-90, center.latitude - dLat);
  const north = Math.min(90, center.latitude + dLat);
  // A circle that reaches a pole takes in every longitude round it.
  if (dLat >= 90 - Math.abs(center.latitude)) return { west: -180, south, east: 180, north };
  // The widest longitude on the sphere, asin(sin r / cos φ). radius / cos φ fell short of it as
  // circles grew (±40° instead of ±43.2° at 60°N for 20°), so a corner of the circle lay outside
  // its own bounds and a bounds lookup missed what was there.
  const sinR = Math.sin(dLat * DEG);
  const cosLat = Math.cos(center.latitude * DEG);
  const dLon = Math.asin(Math.min(1, sinR / cosLat)) / DEG;
  if (dLon >= 180) return { west: -180, south, east: 180, north };
  return {
    west: normalizeLongitude(center.longitude - dLon),
    south,
    east: normalizeLongitude(center.longitude + dLon),
    north,
  };
}

/**
 * A ring with its longitudes made continuous from its first point, when it crosses the
 * antimeridian (a step of more than 180°); undefined when it does not.
 */
function unwrappedRing(ring: ReadonlyArray<readonly [number, number]>): Array<[number, number]> | undefined {
  if (!ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1]![0]) > 180)) return undefined;
  const out: Array<[number, number]> = [[ring[0]![0], ring[0]![1]]];
  for (let i = 1; i < ring.length; i++) {
    let x = ring[i]![0];
    const prev = out[i - 1]![0];
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    out.push([x, ring[i]![1]]);
  }
  return out;
}

const wrapLon = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;

/**
 * The bounds of a ring. One that crosses the antimeridian (a watch zone or alert area round the
 * Aleutians) has west > east, the form `boundsContain` reads across 180°; until 2026-11-11 its
 * bounds were the whole world but that sliver.
 */
export function polygonBounds(ring: Array<[number, number]>): GeoBounds {
  const r = unwrappedRing(ring) ?? ring;
  let west = Infinity,
    east = -Infinity,
    south = 90,
    north = -90;
  for (const [lon, lat] of r) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!r.length) return { west: 180, south, east: -180, north };
  if (east - west >= 360) return { west: -180, south, east: 180, north };
  if (r !== ring || west < -180 || east > 180) return { west: wrapLon(west), south, east: wrapLon(east), north };
  return { west, south, east, north };
}

/**
 * Ray-casting point-in-polygon on lon/lat (planar; adequate for regional polygons). A ring that
 * crosses the antimeridian is unwrapped and the point taken the short way round from it: until
 * 2026-11-11 such a ring held everywhere but itself.
 */
export function pointInPolygon(p: { latitude: number; longitude: number }, ring: Array<[number, number]>): boolean {
  const r = unwrappedRing(ring) ?? ring;
  if (!r.length) return false;
  // The point the short way round from the ring's first vertex: a ring written past 180° (182
  // for −178), or unwrapped above, is met in its own longitudes.
  let x = p.longitude;
  const ref = r[0]![0];
  while (x - ref > 180) x -= 360;
  while (x - ref < -180) x += 360;
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = r[i]!;
    const [xj, yj] = r[j]!;
    const intersect = yi > p.latitude !== yj > p.latitude && x < ((xj - xi) * (p.latitude - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function regionBounds(region: GeoRegion): GeoBounds | undefined {
  switch (region.kind) {
    case 'bounds':
      return region.bounds;
    case 'circle':
      return circleBounds(region.center, region.radiusM);
    case 'polygon':
      return polygonBounds(region.polygon);
    case 'admin':
      return region.bounds;
  }
}

/** Exact membership test used as the final filter after a coarse spatial-index lookup. */
export function regionContains(region: GeoRegion, p: { latitude: number; longitude: number }): boolean {
  switch (region.kind) {
    case 'bounds':
      return boundsContain(region.bounds, p);
    case 'circle':
      return haversineMeters(region.center, p) <= region.radiusM;
    case 'polygon':
      return pointInPolygon(p, region.polygon);
    case 'admin':
      return region.bounds ? boundsContain(region.bounds, p) : false;
  }
}

export function geometryCentroid(g: WorldGeometry): GeoPosition | undefined {
  const pts: Array<[number, number] | [number, number, number]> = [];
  switch (g.type) {
    case 'Point':
      pts.push(g.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      pts.push(...g.coordinates);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const r of g.coordinates) pts.push(...r);
      break;
    case 'MultiPolygon':
      for (const poly of g.coordinates) for (const r of poly) pts.push(...r);
      break;
  }
  if (pts.length === 0) return undefined;
  // Longitudes are averaged the short way round from the first point, then brought back to
  // −180…180: a shape over the antimeridian (an alert area round the Aleutians, given as 179°
  // and −179°, or split into two parts there) has its centre at 180°, not at 0° — where until
  // 2026-11-11 its marker, label and fly-to went, on the other side of the world.
  const ref = pts[0]![0];
  let lat = 0,
    lon = 0;
  for (const p of pts) {
    let x = p[0];
    while (x - ref > 180) x -= 360;
    while (x - ref < -180) x += 360;
    lon += x;
    lat += p[1];
  }
  let mean = lon / pts.length;
  while (mean >= 180) mean -= 360;
  while (mean < -180) mean += 360;
  return { latitude: lat / pts.length, longitude: mean };
}

export function positionToGeometry(p: GeoPosition): WorldGeometry {
  return p.altitudeM !== undefined
    ? { type: 'Point', coordinates: [p.longitude, p.latitude, p.altitudeM] }
    : { type: 'Point', coordinates: [p.longitude, p.latitude] };
}

type Coord = [number, number] | [number, number, number];

/**
 * Douglas–Peucker simplification of one closed ring, in degrees (planar, like the rest of
 * this module's polygon helpers). Every vertex within `toleranceDeg` of the simplified
 * outline is dropped; the first and last (closing) vertices always stay. A ring that would
 * fall below a triangle is returned unchanged rather than collapsed — a small island is
 * still land.
 *
 * Coordinates are rounded to `decimals` places (5 is ~1 m), which on its own roughly halves
 * the JSON a polygon takes.
 */
export function simplifyRing<C extends Coord>(ring: readonly C[], toleranceDeg: number, decimals = 5): C[] {
  const round = (c: C): C => {
    const f = 10 ** decimals;
    return c.map((v, i) => (i < 2 ? Math.round(v * f) / f : v)) as C;
  };
  if (ring.length <= 4 || !(toleranceDeg > 0)) return ring.map(round);
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const tol2 = toleranceDeg * toleranceDeg;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = a + 1; i < b; i++) {
      const d2 = segmentDistance2(ring[i]!, ring[a]!, ring[b]!);
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out: C[] = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(round(ring[i]!));
  return out.length >= 4 ? out : ring.map(round);
}

/** Squared distance from `p` to segment `a`–`b` (to `a` itself when the segment is a point, as a closed ring's is). */
function segmentDistance2(p: Coord, a: Coord, b: Coord): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}
