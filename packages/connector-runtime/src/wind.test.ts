import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windRecords, type WindRecord } from './wind.js';
import { substituteNow } from './connectors/rest-json.js';
import { defaultConnectorRegistry } from './registry.js';
import type { RestJsonProvider } from './connectors/rest-json.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const spec = { u: 'ugrd10m', v: 'vgrd10m' };
const table = (columnNames: string[], rows: unknown[][]) => ({ table: { columnNames, rows } });
const read = (body: unknown): WindRecord[] => {
  const r = windRecords(body, spec);
  assert.ok('records' in r, 'malformed' in r ? r.malformed : '');
  return r.records;
};

test('wind: the four compass points, by the meteorological convention', () => {
  const cols = ['time', 'latitude', 'longitude', 'ugrd10m', 'vgrd10m'];
  const [north, east, south, west, calm] = read(
    table(cols, [
      ['2026-09-23T18:00:00Z', 0, 0, 0, 5], // blowing to the north: a southerly
      ['2026-09-23T18:00:00Z', 0, 10, 5, 0], // to the east: a westerly
      ['2026-09-23T18:00:00Z', 0, 20, 0, -5],
      ['2026-09-23T18:00:00Z', 0, 30, -5, 0],
      ['2026-09-23T18:00:00Z', 0, 40, 0, 0],
    ]),
  );
  assert.deepEqual([north!.towardDeg, north!.fromDeg], [0, 180]);
  assert.deepEqual([east!.towardDeg, east!.fromDeg], [90, 270]);
  assert.deepEqual([south!.towardDeg, south!.fromDeg], [180, 0]);
  assert.deepEqual([west!.towardDeg, west!.fromDeg], [270, 90]);
  assert.equal(north!.speedMps, 5);
  assert.equal(calm!.speedMps, 0);
  assert.equal(calm!.towardDeg, undefined, 'a calm has no direction');
  assert.equal(north!.time, '2026-09-23T18:00:00Z');
});

test('wind: columns found by name in any order; longitudes to −180…180; bad rows skipped', () => {
  const rs = read(
    table(
      ['vgrd10m', 'longitude', 'ugrd10m', 'latitude'],
      [[3, 359.5, 4, 45], [3, 180, 4, 45], [null, 10, 4, 45], [3, 10, 4, 95], 'not a row' as unknown as unknown[]],
    ),
  );
  assert.deepEqual(
    rs.map((r) => [r.lat, r.lon, r.speedMps]),
    [
      [45, -0.5, 5],
      [45, -180, 5],
    ],
  );
  assert.equal(rs[0]!.time, undefined, 'no time column: no time');
});

test('wind: what is not a wind table', () => {
  assert.match((windRecords({}, spec) as { malformed: string }).malformed, /not a table/);
  assert.match((windRecords({ table: { rows: [] } }, spec) as { malformed: string }).malformed, /columnNames/);
  assert.match(
    (windRecords(table(['latitude', 'longitude', 'ugrd10m'], []), spec) as { malformed: string }).malformed,
    /no column vgrd10m/,
  );
  assert.deepEqual(read(table(['latitude', 'longitude', 'ugrd10m', 'vgrd10m'], [])), [], 'no rows: empty, not broken');
  assert.match(
    (
      windRecords(table(['latitude', 'longitude', 'ugrd10m', 'vgrd10m'], [[0, 0, null, null]]), spec) as {
        malformed: string;
      }
    ).malformed,
    /no grid point/,
  );
});

test('wind: the grid read live from NOAA ERDDAP on 2026-11-11 (fixture, 20° by 40°)', () => {
  const body = JSON.parse(readFileSync(path.join(root, 'fixtures/connectors/wind/gfs-wind-10deg.json'), 'utf8'));
  const rs = read(body);
  assert.equal(rs.length, 90);
  const p = rs.find((r) => r.lat === -50 && r.lon === 80)!;
  // u 16.635384, v -8.019697: the roaring forties, from the west-north-west.
  assert.equal(p.speedMps, 18.47);
  assert.equal(p.fromDeg, 295.7);
});

test('{now} placeholders: the request time, or that much earlier, to the second', () => {
  const t = Date.parse('2026-11-11T03:34:54.301Z');
  assert.equal(substituteNow('a[({now})]', t), 'a[(2026-11-11T03:34:54Z)]');
  assert.equal(substituteNow('{now-90m}|{now-3h}', t), '2026-11-11T02:04:54Z|2026-11-11T00:34:54Z');
  assert.equal(substituteNow('{nowhere}', t), '{nowhere}', 'only the placeholder');
});

test('the wind definition asks ERDDAP for the step at or before now, brackets as written', async () => {
  const doc = JSON.parse(readFileSync(path.join(root, 'connectors/examples/weather/noaa-gfs-wind.json'), 'utf8'));
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  const provider = defaultConnectorRegistry.createProvider(v.definition!) as RestJsonProvider;
  const now = Date.parse('2026-11-11T03:34:54Z');
  (provider as unknown as { context: unknown }).context = { clock: { now: () => now } };
  const req = provider.buildRequest({ query: {} });
  const url = req.url;
  // 90 minutes back: ERDDAP's nearest 3-hourly step is then never after now (it rounds).
  assert.equal(
    url,
    'https://coastwatch.pfeg.noaa.gov/erddap/griddap/NCEP_Global_Best.json?ugrd10m[(2026-11-11T02:04:54Z)][(80):20:(-80)][(0):20:(359.5)],vgrd10m[(2026-11-11T02:04:54Z)][(80):20:(-80)][(0):20:(359.5)]',
  );
  // Every poll a new URL, but one cache entry: keyed with the placeholder as written, so the
  // last good grid is there to fall back on and other sources' entries are not pushed out.
  assert.match(req.cacheKey!, /ugrd10m\[\(\{now-90m\}\)\]/);
  (provider as unknown as { context: unknown }).context = { clock: { now: () => now + 3_600_000 } };
  const later = provider.buildRequest({ query: {} });
  assert.notEqual(later.url, url);
  assert.equal(later.cacheKey, req.cacheKey);
  // A source that does not ask for the time keeps the default key (its URL).
  const other = defaultConnectorRegistry.createProvider(
    defaultConnectorRegistry.validate({ ...doc, endpoint: { url: 'https://example.org/a.json' } }).definition!,
  ) as RestJsonProvider;
  assert.equal(other.buildRequest({ query: {} }).cacheKey, undefined);
});

test('wind: each point is named as a chart names it, safe as an object id', async () => {
  const { windPointId } = await import('./wind.js');
  const { makeObjectId } = await import('@opcb/world-model');
  assert.equal(windPointId(50, -160), '50N160W');
  assert.equal(windPointId(-12.5, 0), '12.5S0E');
  assert.equal(windPointId(0, 179.5), '0N179.5E');
  for (const [la, lo] of [
    [-90, -180],
    [12.5, -0.5],
  ] as const)
    assert.doesNotThrow(() => makeObjectId('wind', 'noaa-gfs-wind', windPointId(la, lo)));
  const [r] = read(table(['latitude', 'longitude', 'ugrd10m', 'vgrd10m'], [[-50, 200, 1, 1]]));
  assert.equal(r!.id, '50S160W', 'named after the longitude is folded');
  assert.equal(r!.name, 'Wind at 50°S 160°W');
  const { windPointName } = await import('./wind.js');
  assert.equal(windPointName(0, 0), 'Wind at 0° 0°');
  assert.equal(windPointName(12.5, 179.5), 'Wind at 12.5°N 179.5°E');
});
