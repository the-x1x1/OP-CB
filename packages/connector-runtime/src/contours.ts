import type { JsonValue } from '@worldview/world-model';
import { readPath, type ContourSpec } from '@worldview/connector-sdk';

/**
 * Records from a gridded field (`response.contour`, ADR-013 amendment 2026-10-16): a source
 * that answers a regular grid of values — NOAA SWPC's OVATION aurora forecast, a 1° global
 * grid of 65,160 `[longitude, latitude, probability]` points — becomes one record per level,
 * the area where the value is at least that level as a GeoJSON MultiPolygon. The records are
 * then mapped like any other, so the field draws as ordinary areas: no field overlay in the
 * render contract, no new object type, and an area can be picked and read.
 *
 * Marching squares over the grid, with linear interpolation along each cell edge and the
 * saddle cells settled by the cell's mean. The grid is padded with a border below every
 * level, so every ring closes; a global grid (longitudes covering the whole circle) wraps,
 * with the first column repeated at +360°, so longitudes stay within −180…180 and an area
 * across the antimeridian is two polygons meeting there. Rings are counter-clockwise round
 * an area and clockwise round a hole (RFC 7946), each hole put in the smallest area that
 * holds it.
 */
export const MAX_CONTOUR_POINTS = 2_000_000;
export const MAX_CONTOUR_DIMENSION = 4000;
/** Rings per level, at most; a field this broken up is not one to draw. */
export const MAX_CONTOUR_RINGS = 5000;

export interface ContourRecord {
  /** The level: the area is where the value is at least this. */
  level: number;
  /** The next level up, when there is one. */
  upTo?: number;
  /** 1 for the lowest level. */
  band: number;
  geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
  /** The body's own top-level values (strings, numbers, booleans): its times, its units. */
  source: Record<string, JsonValue>;
}

type Pt = [number, number];

export function contourRecords(body: unknown, spec: ContourSpec): { records: ContourRecord[] } | { malformed: string } {
  const points = readPath(body, spec.pointsPath);
  if (!Array.isArray(points)) return { malformed: `${spec.pointsPath} is not an array of grid points` };
  if (points.length > MAX_CONTOUR_POINTS) return { malformed: `more than ${MAX_CONTOUR_POINTS} grid points` };
  const lonPath = spec.lon ?? '$[0]';
  const latPath = spec.lat ?? '$[1]';
  const valuePath = spec.value ?? '$[2]';

  const triples: Array<[number, number, number]> = [];
  for (const p of points) {
    const lon = readPath(p, lonPath);
    const lat = readPath(p, latPath);
    const v = readPath(p, valuePath);
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lat < -90 || lat > 90) continue;
    const x = ((((lon + 180) % 360) + 360) % 360) - 180;
    triples.push([x, lat, typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN]);
  }
  if (triples.length < 4) return { malformed: 'too few grid points' };

  const lons = axis(triples.map((t) => t[0]));
  const lats = axis(triples.map((t) => t[1]));
  if ('malformed' in lons) return { malformed: `longitudes: ${lons.malformed}` };
  if ('malformed' in lats) return { malformed: `latitudes: ${lats.malformed}` };
  if (lons.values.length > MAX_CONTOUR_DIMENSION || lats.values.length > MAX_CONTOUR_DIMENSION)
    return { malformed: `a grid wider than ${MAX_CONTOUR_DIMENSION} points` };
  const wraps = Math.abs(lons.values.length * lons.step - 360) < 1e-6;

  const xs = wraps ? [...lons.values, lons.values[0]! + 360] : lons.values;
  const ys = lats.values;
  const nx = xs.length;
  const ny = ys.length;
  // The padded grid: one border cell all round, below every level.
  const W = nx + 2;
  const H = ny + 2;
  const grid = new Float64Array(W * H).fill(Number.NEGATIVE_INFINITY);
  const xIndex = new Map(lons.values.map((x, i) => [key(x), i]));
  const yIndex = new Map(ys.map((y, j) => [key(y), j]));
  for (const [x, y, v] of triples) {
    const i = xIndex.get(key(x));
    const j = yIndex.get(key(y));
    if (i === undefined || j === undefined || Number.isNaN(v)) continue;
    grid[(j + 1) * W + (i + 1)] = v;
    if (wraps && i === 0) grid[(j + 1) * W + nx] = v;
  }
  const gx = (i: number) => xs[Math.min(nx - 1, Math.max(0, i - 1))]!;
  const gy = (j: number) => ys[Math.min(ny - 1, Math.max(0, j - 1))]!;

  const source: Record<string, JsonValue> = {};
  if (body && typeof body === 'object' && !Array.isArray(body))
    for (const [k, v] of Object.entries(body as Record<string, unknown>))
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
        source[k] = v;

  const records: ContourRecord[] = [];
  for (const [n, level] of spec.levels.entries()) {
    const rings = traceLevel(grid, W, H, level, gx, gy);
    if ('malformed' in rings) return rings;
    const polygons = assemble(rings.rings);
    if (polygons.length === 0) continue;
    const upTo = spec.levels[n + 1];
    records.push({
      level,
      ...(upTo !== undefined ? { upTo } : {}),
      band: n + 1,
      geometry: { type: 'MultiPolygon', coordinates: polygons },
      source,
    });
  }
  return { records };
}

const key = (n: number) => n.toFixed(6);

/** The sorted distinct values of one axis and their spacing, which must be even. */
function axis(values: number[]): { values: number[]; step: number } | { malformed: string } {
  const distinct = [...new Set(values.map(key))].map(Number).sort((a, b) => a - b);
  if (distinct.length < 2) return { malformed: 'one value only' };
  const step = distinct[1]! - distinct[0]!;
  for (let i = 2; i < distinct.length; i++)
    if (Math.abs(distinct[i]! - distinct[i - 1]! - step) > 1e-6) return { malformed: 'not evenly spaced' };
  return { values: distinct, step };
}

/**
 * The rings round where the padded grid is at least `level`, each with that area on its left.
 * Crossings are keyed by the cell edge they lie on, so the segments of adjacent cells join
 * exactly.
 */
function traceLevel(
  grid: Float64Array,
  W: number,
  H: number,
  level: number,
  gx: (i: number) => number,
  gy: (j: number) => number,
): { rings: Pt[][] } | { malformed: string } {
  const at = (i: number, j: number) => grid[j * W + i]!;
  const inside = (i: number, j: number) => at(i, j) >= level;
  const points = new Map<string, Pt>();
  const crossing = (i0: number, j0: number, i1: number, j1: number): string => {
    const k = i0 === i1 ? `v${i0},${Math.min(j0, j1)}` : `h${Math.min(i0, i1)},${j0}`;
    if (!points.has(k)) {
      const a = at(i0, j0);
      const b = at(i1, j1);
      const t = Number.isFinite(a) && Number.isFinite(b) && a !== b ? (level - a) / (b - a) : 0.5;
      const x = gx(i0) + (gx(i1) - gx(i0)) * t;
      const y = gy(j0) + (gy(j1) - gy(j0)) * t;
      points.set(k, [round(x), round(y)]);
    }
    return k;
  };
  const next = new Map<string, string>();
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      // The corners counter-clockwise from the lower left, and the crossings met going round.
      const corners: Array<[number, number]> = [
        [i, j],
        [i + 1, j],
        [i + 1, j + 1],
        [i, j + 1],
      ];
      const ins = corners.map(([a, b]) => inside(a, b));
      if (ins.every(Boolean) || !ins.some(Boolean)) continue;
      const exits: string[] = [];
      const entries: string[] = [];
      const order: Array<{ kind: 'exit' | 'entry'; k: string }> = [];
      for (let c = 0; c < 4; c++) {
        const p = corners[c]!;
        const q = corners[(c + 1) % 4]!;
        if (ins[c] === ins[(c + 1) % 4]) continue;
        const k = crossing(p[0], p[1], q[0], q[1]);
        const kind = ins[c] ? 'exit' : 'entry';
        (kind === 'exit' ? exits : entries).push(k);
        order.push({ kind, k });
      }
      if (order.length === 2) {
        link(next, exits[0]!, entries[0]!);
        continue;
      }
      // A saddle: four crossings, exit and entry in turn. The cell's mean says whether the
      // middle is inside (cut each outside corner off) or outside (cut each inside corner off).
      const mean = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4;
      const start = order.findIndex((o) => o.kind === 'exit');
      const seq = [0, 1, 2, 3].map((d) => order[(start + d) % 4]!);
      // seq: exit, entry, exit, entry, counter-clockwise.
      if (mean >= level) {
        link(next, seq[0]!.k, seq[1]!.k);
        link(next, seq[2]!.k, seq[3]!.k);
      } else {
        link(next, seq[0]!.k, seq[3]!.k);
        link(next, seq[2]!.k, seq[1]!.k);
      }
    }

  const rings: Pt[][] = [];
  for (const startKey of next.keys()) {
    if (!next.has(startKey)) continue;
    const ring: Pt[] = [];
    let k: string | undefined = startKey;
    while (k !== undefined && next.has(k)) {
      const p = points.get(k)!;
      const last = ring[ring.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) ring.push(p);
      const n: string = next.get(k)!;
      next.delete(k);
      k = n;
    }
    if (ring.length >= 3) {
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
      if (ring.length >= 4 && Math.abs(signedArea(ring)) > 1e-9) rings.push(ring);
    }
    if (rings.length > MAX_CONTOUR_RINGS) return { malformed: `more than ${MAX_CONTOUR_RINGS} areas at ${level}` };
  }
  return { rings };
}

function link(next: Map<string, string>, from: string, to: string): void {
  next.set(from, to);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Shoelace: positive counter-clockwise. */
function signedArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
  return s / 2;
}

function contains(ring: readonly Pt[], p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Areas with their holes: each clockwise ring goes in the smallest counter-clockwise one round it. */
function assemble(rings: Pt[][]): number[][][][] {
  const outers = rings
    .filter((r) => signedArea(r) > 0)
    .map((r) => ({ ring: r, area: signedArea(r), holes: [] as Pt[][] }));
  for (const hole of rings.filter((r) => signedArea(r) < 0)) {
    const probe = hole[0]!;
    const holder = outers
      .filter((o) => o.area > -signedArea(hole) && contains(o.ring, probe))
      .sort((a, b) => a.area - b.area)[0];
    holder?.holes.push(hole);
  }
  return outers.map((o) => [o.ring, ...o.holes]);
}
