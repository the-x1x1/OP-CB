import type { JsonValue } from '@opcb/world-model';
import { readPath, type WindSpec } from '@opcb/connector-sdk';

/**
 * Records from a gridded wind field (`response.wind`, ADR-013 amendment 2026-11-11): a table
 * of grid points with the wind's eastward (u) and northward (v) components in m/s — ERDDAP's
 * griddap JSON, `{ table: { columnNames: [...], rows: [[time, latitude, longitude, u, v], …] } }`,
 * read live from NOAA CoastWatch on 2026-11-11 (docs/providers/LIVE-CHECKS.md). The columns are
 * found by name, so their order does not matter. Each record is one grid point:
 *
 *   { time, lat, lon, u, v, speedMps, towardDeg, fromDeg, source }
 *
 * `lon` is brought to −180…180 (ERDDAP's GFS runs 0…359.5); `towardDeg` is where the wind
 * blows to, clockwise from north (the arrow's heading); `fromDeg` where it blows from, as a
 * forecast says it ("a westerly": 270). A calm point has no direction. Rows without a finite
 * u and v, or off the globe, are skipped; a table of none is an empty answer. `source` is the body's top-level scalars.
 */
export const MAX_WIND_POINTS = 100_000;

export interface WindRecord {
  time?: string;
  lat: number;
  lon: number;
  u: number;
  v: number;
  speedMps: number;
  towardDeg?: number;
  fromDeg?: number;
  source: Record<string, JsonValue>;
}

/** Below this the direction is noise: a calm. */
const CALM_MPS = 0.05;

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export function windRecords(body: unknown, spec: WindSpec): { records: WindRecord[] } | { malformed: string } {
  const tablePath = spec.tablePath ?? 'table';
  const table = readPath(body, tablePath);
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { malformed: `${tablePath} is not a table` };
  const names = (table as Record<string, unknown>)['columnNames'];
  const rows = (table as Record<string, unknown>)['rows'];
  if (!Array.isArray(names) || !Array.isArray(rows)) return { malformed: `${tablePath} has no columnNames and rows` };
  if (rows.length > MAX_WIND_POINTS) return { malformed: `more than ${MAX_WIND_POINTS} grid points` };
  const col = (name: string) => names.indexOf(name);
  const want = { lat: spec.lat ?? 'latitude', lon: spec.lon ?? 'longitude', u: spec.u, v: spec.v };
  const at = { lat: col(want.lat), lon: col(want.lon), u: col(want.u), v: col(want.v) };
  const missing = (Object.keys(at) as Array<keyof typeof at>).filter((k) => at[k] < 0).map((k) => want[k]);
  if (missing.length) return { malformed: `no column ${missing.join(', ')}` };
  const timeAt = col(spec.time ?? 'time');

  const source: Record<string, JsonValue> = {};
  if (body && typeof body === 'object' && !Array.isArray(body))
    for (const [k, v] of Object.entries(body as Record<string, unknown>))
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') source[k] = v;

  const records: WindRecord[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const lat = row[at.lat],
      lon = row[at.lon],
      u = row[at.u],
      v = row[at.v];
    if (![lat, lon, u, v].every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const [la, lo, uu, vv] = [lat, lon, u, v] as number[];
    if (la! < -90 || la! > 90) continue;
    const speed = Math.hypot(uu!, vv!);
    const rec: WindRecord = {
      lat: la!,
      lon: ((((lo! + 180) % 360) + 360) % 360) - 180,
      u: uu!,
      v: vv!,
      speedMps: round(speed, 2),
      source,
    };
    const t = timeAt >= 0 ? row[timeAt] : undefined;
    if (typeof t === 'string') rec.time = t;
    if (speed >= CALM_MPS) {
      // atan2(east, north): 0 is north, 90 east.
      const toward = ((((Math.atan2(uu!, vv!) * 180) / Math.PI) % 360) + 360) % 360;
      rec.towardDeg = round(toward, 1) % 360;
      rec.fromDeg = round((toward + 180) % 360, 1) % 360;
    }
    records.push(rec);
  }
  // A table of no rows is an empty answer; rows of which none holds a wind are not.
  if (rows.length && !records.length) return { malformed: 'no grid point with a wind' };
  return { records };
}
