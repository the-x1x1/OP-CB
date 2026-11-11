import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableRecords, windColumns } from './table.js';
import { draftDefinition } from './draft.js';
import { defaultConnectorRegistry } from './registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A tabledap answer in ERDDAP's layout (columns and rows as it serves them; values made up). */
const BUOYS = {
  table: {
    columnNames: ['station', 'longitude', 'latitude', 'time', 'wspd', 'atmp'],
    columnTypes: ['String', 'float', 'float', 'String', 'float', 'float'],
    columnUnits: [null, 'degrees_east', 'degrees_north', 'UTC', 'm s-1', 'degree_C'],
    rows: [
      ['51201', -158.117, 21.671, '2026-09-23T19:30:00Z', 6.2, 25.1],
      ['51202', -157.668, 21.417, '2026-09-23T19:40:00Z', 7.4, 25.6],
      ['51203', -157.01, 20.79, '2026-09-23T19:30:00Z'],
    ],
  },
};

test('table: rows keyed by column name; short rows leave columns out; what is not a table', () => {
  const r = tableRecords(BUOYS, {});
  assert.ok('records' in r);
  assert.deepEqual(r.records[0], {
    station: '51201',
    longitude: -158.117,
    latitude: 21.671,
    time: '2026-09-23T19:30:00Z',
    wspd: 6.2,
    atmp: 25.1,
  });
  assert.equal('wspd' in r.records[2]!, false);
  assert.deepEqual(tableRecords({ table: { columnNames: ['a'], rows: [] } }, {}), { records: [] });
  assert.match((tableRecords({}, {}) as { malformed: string }).malformed, /not a table/);
  assert.match(
    (tableRecords({ t: { columnNames: [1], rows: [] } }, { path: 't' }) as { malformed: string }).malformed,
    /no columnNames/,
  );
  assert.match(
    (tableRecords({ table: { columnNames: ['a'], rows: ['x'] } }, {}) as { malformed: string }).malformed,
    /no row/,
  );
});

test('table: wind components by the names models give them', () => {
  assert.deepEqual(windColumns(['time', 'latitude', 'longitude', 'ugrd10m', 'vgrd10m']), {
    u: 'ugrd10m',
    v: 'vgrd10m',
  });
  assert.deepEqual(windColumns(['eastward_wind', 'northward_wind']), { u: 'eastward_wind', v: 'northward_wind' });
  assert.deepEqual(windColumns(['u10', 'v10', 'lat', 'lon']), { u: 'u10', v: 'v10' });
  assert.deepEqual(windColumns(['UWND', 'VWND']), { u: 'UWND', v: 'VWND' });
  assert.deepEqual(windColumns(['wind_u', 'wind_v']), { u: 'wind_u', v: 'wind_v' });
  assert.equal(windColumns(['ugrd10m', 'vgrd80m']), undefined, 'a pair at one height only');
  assert.equal(windColumns(['station', 'wspd', 'wdir']), undefined, 'speed and direction are not components');
});

test('the drafter: an ERDDAP wind grid becomes a wind source; (last) is flagged', () => {
  const text = readFileSync(path.join(root, 'fixtures/connectors/wind/gfs-wind-10deg.json'), 'utf8');
  const url =
    'https://coastwatch.pfeg.noaa.gov/erddap/griddap/NCEP_Global_Best.json?ugrd10m[(last)][(80):20:(-80)][(0):20:(359.5)],vgrd10m[(last)][(80):20:(-80)][(0):20:(359.5)]';
  const d = draftDefinition({ url, text });
  assert.equal(d.definition['objectType'], 'wind');
  assert.deepEqual((d.definition['response'] as Record<string, unknown>)['wind'], { u: 'ugrd10m', v: 'vgrd10m' });
  assert.ok(defaultConnectorRegistry.validate(d.definition).ok, 'validates as drafted');
  assert.ok(d.todo.some((t) => t.includes('({now-90m})')));
  const example = JSON.parse(readFileSync(path.join(root, 'connectors/examples/weather/noaa-gfs-wind.json'), 'utf8'));
  const { model: _m, ...exampleProps } = example.mapping.properties;
  assert.deepEqual(
    (d.definition['mapping'] as { properties: unknown }).properties,
    exampleProps,
    'mapped as the example',
  );
});

test('the drafter: an ERDDAP station table is read by column name', () => {
  const d = draftDefinition({
    url: 'https://erddap.example.org/erddap/tabledap/buoys.json?station,longitude,latitude,time,wspd,atmp',
    text: JSON.stringify(BUOYS),
  });
  assert.deepEqual(d.definition['response'], { table: {} });
  const m = d.definition['mapping'] as Record<string, unknown>;
  assert.deepEqual(m['position'], { lat: 'latitude', lon: 'longitude' });
  assert.ok(String(JSON.stringify(m['observedAt'] ?? '')).includes('time'));
  assert.match(d.notes.join(' '), /3 row\(s\) by 6 named column\(s\)/);
});

test('rest-json with response.table: the rows poll as records by column name', async () => {
  const { testing } = await import('@opcb/provider-sdk');
  const doc = {
    schema: 'oneview.connector.v1',
    id: 'buoys-test',
    name: 'Buoys',
    connector: 'rest-json',
    objectType: 'sensor',
    categories: ['weather'],
    endpoint: { url: 'https://erddap.example.org/erddap/tabledap/buoys.json', intervalSeconds: 600 },
    response: { table: {} },
    mapping: {
      externalId: 'station',
      observedAt: { path: 'time', transform: 'isoTimestamp' },
      position: { lat: 'latitude', lon: 'longitude' },
      properties: { windSpeedMps: 'wspd', airTempC: 'atmp' },
    },
    attribution: { text: 'test' },
    review: 'user-configured',
    enabled: false,
  };
  const v = defaultConnectorRegistry.validate(doc);
  assert.ok(v.ok, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition!);
  await provider.initialize(
    testing.createFixtureContext({
      providerId: doc.id,
      clock: new testing.VirtualClock(Date.parse('2026-09-23T20:00:00Z')),
      responder: () => ({ status: 200, body: JSON.stringify(BUOYS) }),
    }),
  );
  await provider.start();
  const obs = await provider.query!({ signal: new AbortController().signal, background: true });
  assert.equal(obs.length, 3);
  const b = obs.find((o) => o.externalId === '51202')!;
  assert.deepEqual([b.position?.latitude, b.position?.longitude], [21.417, -157.668]);
  assert.equal(b.payload['windSpeedMps'], 7.4);
  assert.equal(
    defaultConnectorRegistry.validate({ ...doc, response: { table: {}, wind: { u: 'u', v: 'v' } } }).ok,
    false,
    'not with wind',
  );
});

test('the drafter: NDBC buoy rows as ERDDAP served them (2026-11-11) — keyed by station, a time series noted', () => {
  // Header and two rows of cwwcNDBCMet as read live from NOAA CoastWatch; nulls as served.
  const live = {
    table: {
      columnNames: ['station', 'longitude', 'latitude', 'time', 'WSPD', 'WD', 'ATMP'],
      columnTypes: ['String', 'float', 'float', 'String', 'float', 'short', 'float'],
      columnUnits: [null, 'degrees_east', 'degrees_north', 'UTC', 'm s-1', 'degrees_true', 'degree_C'],
      rows: [
        ['51201', -158.116, 21.673, '2026-11-11T00:26:00Z', null, null, null],
        ['51201', -158.116, 21.673, '2026-11-11T00:56:00Z', null, null, null],
      ],
    },
  };
  const d = draftDefinition({
    url: 'https://coastwatch.pfeg.noaa.gov/erddap/tabledap/cwwcNDBCMet.json?station,longitude,latitude,time,WSPD,WD,ATMP',
    text: JSON.stringify(live),
  });
  assert.equal((d.definition['mapping'] as Record<string, unknown>)['externalId'], 'station');
  assert.ok(defaultConnectorRegistry.validate(d.definition).ok);
  assert.match(d.notes.join(' '), /2 rows for 1 station value\(s\).*orderByMax\("station,time"\)/);
  assert.equal(windColumns(live.table.columnNames), undefined, "a buoy's speed and direction are not a grid's u and v");
});
