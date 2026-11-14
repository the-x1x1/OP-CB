import { readPath } from '@opcb/connector-sdk';

/**
 * Records from a table of named columns (`response.table`, ADR-013 amendment 2026-11-11):
 * `{ columnNames: [...], rows: [[...], ...] }` at `path` (default `table`) — ERDDAP's JSON for
 * tabledap and griddap, read live from NOAA CoastWatch on 2026-11-11. Each row becomes a
 * record keyed by column name, so the mapping names fields as for any JSON (`latitude`,
 * `time`, `station`). Rows that are not arrays are skipped; a row shorter than the header
 * leaves the missing columns out. A table of no rows is an empty answer.
 */
export const MAX_TABLE_ROWS = 100_000;

export function tableRecords(
  body: unknown,
  spec: { path?: string },
): { records: Array<Record<string, unknown>> } | { malformed: string } {
  const at = spec.path ?? 'table';
  const table = readPath(body, at);
  if (!table || typeof table !== 'object' || Array.isArray(table)) return { malformed: `${at} is not a table` };
  const names = (table as Record<string, unknown>)['columnNames'];
  const rows = (table as Record<string, unknown>)['rows'];
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string') || !Array.isArray(rows))
    return { malformed: `${at} has no columnNames and rows` };
  if (rows.length > MAX_TABLE_ROWS) return { malformed: `more than ${MAX_TABLE_ROWS} rows` };
  const records: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const rec: Record<string, unknown> = {};
    for (let i = 0; i < names.length && i < row.length; i++) rec[names[i] as string] = row[i];
    records.push(rec);
  }
  if (rows.length && !records.length) return { malformed: 'no row is an array of values' };
  return { records };
}

/**
 * The wind components among a table's columns, by the names models and ERDDAP give them:
 * NCEP's `ugrd10m`/`vgrd10m`, CF's `eastward_wind`/`northward_wind`, ERA5's `u10`/`v10`,
 * NCEP reanalysis `uwnd`/`vwnd`, and plain `u_wind`/`v_wind`. For the drafter.
 */
export function windColumns(names: readonly string[]): { u: string; v: string } | undefined {
  const partner = (u: string): string | undefined => {
    if (/^eastward_wind$/i.test(u)) return 'northward_wind';
    if (/^wind_u$/i.test(u)) return 'wind_v';
    // ugrd10m, u10, u100, u, uwnd, u_wind, uwind: the same name with v for u.
    if (/^(ugrd\d*m?|u(10|100)?|uwnd|u_?wind)$/i.test(u)) return 'v' + u.slice(1);
    return undefined;
  };
  for (const u of names) {
    const want = partner(u)?.toLowerCase();
    const v = want ? names.find((x) => x.toLowerCase() === want) : undefined;
    if (v) return { u, v };
  }
  return undefined;
}
