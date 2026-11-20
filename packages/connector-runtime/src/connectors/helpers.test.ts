import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@opcb/provider-sdk';
import {
  arcgisError,
  dateFields,
  describeArcGisError,
  esriGeometryToGeoJson,
  geoJsonCrsProblem,
  isEsriFeatureSet,
  normalizeDates,
  parseEsriFields,
  readFeatureSet,
  spatialReferenceProblem,
} from './arcgis/esri-json.js';
import {
  attributePosition,
  domainOf,
  isPersonEntity,
  matchesAny as entityMatchesAny,
  parseSelectors,
  readState,
  sameState,
} from './home-assistant/entities.js';
import { isTopicName, matchesAny as topicMatchesAny, sampleTopic, topicLevels, topicMatches } from './mqtt/topics.js';
import { epsgCode } from './ogc/crs.js';
import { assertWgs84, newPageState, notDegrees, repeatedPage, swapFeatureAxes } from './ogc/features.js';
import { substitute, substituteNow } from './rest-json.js';
import { httpsHref, isRecord, linkOf, thumbnailHref } from './stac/items.js';
import { parseCsvRows, parseWhitespaceRows } from '../csv.js';

// ---- MQTT topics -----------------------------------------------------------------------

test('MQTT topics: + is one level, # the rest including none, and neither reaches the broker’s own $ topics', () => {
  const cases: Array<[string, string, boolean]> = [
    ['a/b', 'a/b', true],
    ['a/b', 'a/B', false],
    ['a/+', 'a/b', true],
    ['a/+', 'a', false],
    ['a/+', 'a/b/c', false],
    ['a/+/c', 'a//c', true],
    ['a/#', 'a', true],
    ['a/#', 'a/b/c', true],
    ['a/#', 'ab', false],
    ['#', 'anything/at/all', true],
    ['+', 'one', true],
    ['+', 'one/two', false],
    ['+/+', '/x', true],
    ['#', '$SYS/broker/uptime', false],
    ['+/broker', '$SYS/broker', false],
    ['$SYS/#', '$SYS/broker/uptime', true],
    ['a/b', 'a/b/', false],
    ['rtl_433/+/events', 'rtl_433/pi/events', true],
  ];
  for (const [filter, topic, want] of cases) assert.equal(topicMatches(filter, topic), want, `${filter} vs ${topic}`);
  // A delivered topic is a name: one with a wildcard in it matches nothing.
  assert.equal(topicMatches('#', 'a/+/b'), false);
  assert.equal(topicMatches('#', ''), false);
  assert.equal(isTopicName('a/b'), true);
  for (const bad of ['', 'a/+', '#', 'a/#']) assert.equal(isTopicName(bad), false, bad);
  assert.deepEqual(topicLevels('a//b/'), ['a', '', 'b', '']);
  assert.equal(topicMatchesAny(['x/#', 'a/+'], 'a/b'), true);
  assert.equal(topicMatchesAny(['x/#'], 'a/b'), false);
  assert.equal(topicMatchesAny([], 'a/b'), false);
  for (const filter of ['a/+/c/#', '#', '+', 'plain/topic', '+/+/#'])
    assert.equal(topicMatches(filter, sampleTopic(filter)), true, filter);
});

// ---- Home Assistant entities -----------------------------------------------------------

test('Home Assistant: domains, people, entity patterns, and a position only from real coordinates', () => {
  assert.equal(domainOf('sensor.outdoor_temp'), 'sensor');
  assert.equal(domainOf('nodot'), '');
  assert.equal(domainOf(''), '');
  assert.equal(isPersonEntity('person.alex'), true);
  assert.equal(isPersonEntity('device_tracker.phone'), true);
  assert.equal(isPersonEntity('sensor.person_count'), false);
  assert.equal(isPersonEntity('persona'), false, 'an id with no dot has no domain');

  const selectors = parseSelectors('sensor.outdoor_*, weather.* ; ZONE.home\nlight.**kitchen**');
  assert.deepEqual(
    selectors.items.map((s) => s.source),
    ['sensor.outdoor_*', 'weather.*', 'zone.home', 'light.*kitchen*'],
  );
  assert.deepEqual(selectors.problems, []);
  const yes = [
    'sensor.outdoor_temp',
    'sensor.outdoor_',
    'weather.home',
    'zone.home',
    'light.kitchen',
    'light.big_kitchen_lamp',
  ];
  const no = [
    'sensor.indoor_temp',
    'sensor.outdoor',
    'zone.home2',
    'zone.work',
    'light.hall',
    'weather',
    'weather.a.b',
    '',
  ];
  for (const id of yes) assert.equal(entityMatchesAny(id, selectors.items), true, id);
  for (const id of no) assert.equal(entityMatchesAny(id, selectors.items), false, id);
  assert.equal(entityMatchesAny('sensor.x', []), false);
  const odd = parseSelectors('sensor, has space.x, UPPER.OK, bad/char.x, *.*');
  assert.deepEqual(
    odd.items.map((s) => s.source),
    ['space.x', 'upper.ok', '*.*'],
    'white space separates entries too',
  );
  assert.ok(odd.problems.length >= 2);
  // Many stars against a long id: no blow-up.
  const started = Date.now();
  const stars = parseSelectors(`sensor.${'*a'.repeat(90)}`).items;
  assert.equal(entityMatchesAny(`sensor.${'a'.repeat(190)}b`, stars), false);
  assert.ok(Date.now() - started < 500);

  const state = (attributes: Record<string, unknown>, value = 'on') =>
    readState({ entity_id: 'sensor.x', state: value, attributes });
  const at = (attributes: Record<string, unknown>) => {
    const s = state(attributes);
    return typeof s === 'string' ? s : attributePosition(s);
  };
  assert.deepEqual(at({ latitude: 21.3, longitude: -157.8 }), [21.3, -157.8]);
  assert.equal(at({ latitude: 0, longitude: 0 }), undefined, 'null island is an unset position');
  assert.deepEqual(at({ latitude: 0, longitude: 10 }), [0, 10]);
  for (const attributes of [
    { latitude: 91, longitude: 0 },
    { latitude: 1, longitude: 181 },
    { latitude: '21.3', longitude: -157.8 },
    { latitude: 21.3 },
    {},
  ])
    assert.equal(at(attributes), undefined, JSON.stringify(attributes));
  assert.equal(attributePosition(undefined), undefined);

  const a = state({ unit: 'C', value: 1 });
  const b = state({ unit: 'C', value: 1 });
  const c = state({ unit: 'C', value: 2 });
  assert.ok(typeof a !== 'string' && typeof b !== 'string' && typeof c !== 'string');
  if (typeof a === 'string' || typeof b === 'string' || typeof c === 'string') return;
  assert.equal(sameState(a, { ...b, last_updated: '2026-11-19T00:00:00Z' }), true, 'update times aside');
  assert.equal(sameState(a, c), false);
  assert.equal(sameState(a, { ...b, state: 'off' }), false);
});

test('Home Assistant: a state that is not one says why, without naming a person', () => {
  assert.equal(readState(null), 'not an object');
  assert.equal(readState([]), 'not an object');
  assert.match(String(readState({ state: 'on' })), /entity_id/);
  assert.match(String(readState({ entity_id: 'NOT an id', state: 'on' })), /entity_id/);
  assert.match(String(readState({ entity_id: 'sensor.x', state: 5 })), /sensor\.x: state is not a string/);
  const person = String(readState({ entity_id: 'person.alex_smith', state: 5 }));
  assert.ok(!person.includes('alex'), person);
  assert.match(String(readState({ entity_id: 'sensor.x', state: 'on', attributes: [] })), /attributes/);
  const ok = readState({ entity_id: 'sensor.x', state: 'on' });
  assert.ok(typeof ok !== 'string' && Object.keys(ok.attributes).length === 0);
});

// ---- OGC features ----------------------------------------------------------------------

test('epsgCode: the number in each way a CRS is named', () => {
  for (const [crs, code] of [
    ['EPSG:4326', '4326'],
    [' epsg:3857 ', '3857'],
    ['urn:ogc:def:crs:EPSG::4326', '4326'],
    ['urn:ogc:def:crs:EPSG:6.9:4269', '4269'],
    ['urn:x-ogc:def:crs:EPSG:4326', '4326'],
    ['http://www.opengis.net/def/crs/EPSG/0/3857', '3857'],
    ['https://www.opengis.net/def/crs/EPSG/9.6.2/4326', '4326'],
    ['http://www.opengis.net/gml/srs/epsg.xml#4326', '4326'],
  ] as const)
    assert.equal(epsgCode(crs), code, crs);
  for (const crs of [
    '',
    'CRS:84',
    'urn:ogc:def:crs:OGC:1.3:CRS84',
    'EPSG:',
    'EPSG:43x6',
    'EPSG:4326 ; drop',
    'http://evil.example/def/crs/EPSG/0/4326',
  ])
    assert.equal(epsgCode(crs), undefined, crs);
});

test('notDegrees, swapFeatureAxes, assertWgs84, repeatedPage', () => {
  assert.equal(notDegrees([]), false);
  assert.equal(
    notDegrees([
      [10, 20],
      [-170, 80],
    ]),
    false,
  );
  assert.equal(
    notDegrees([
      [500_000, 4_000_000],
      [10, 20],
      [600_000, 4_100_000],
    ]),
    true,
  );
  assert.equal(
    notDegrees([
      [500_000, 4_000_000],
      [10, 20],
    ]),
    false,
    'half is not most',
  );
  assert.equal(notDegrees([[10, 181]]), true);

  const feature = {
    type: 'Feature',
    id: 7,
    geometry: {
      type: 'LineString',
      coordinates: [
        [21.3, -157.8, 5],
        [21.4, -157.9],
      ],
    },
    properties: { a: 1 },
  };
  const swapped = swapFeatureAxes(feature) as typeof feature;
  assert.deepEqual(swapped.geometry.coordinates, [
    [-157.8, 21.3, 5],
    [-157.9, 21.4],
  ]);
  assert.deepEqual(feature.geometry.coordinates[0], [21.3, -157.8, 5], 'the original is untouched');
  assert.deepEqual([swapped.id, swapped.properties], [7, { a: 1 }]);
  const polygon = {
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [1, 2],
            [3, 4],
            [5, 6],
            [1, 2],
          ],
        ],
      ],
    },
  };
  assert.deepEqual((swapFeatureAxes(polygon) as typeof polygon).geometry.coordinates, [
    [
      [
        [2, 1],
        [4, 3],
        [6, 5],
        [2, 1],
      ],
    ],
  ]);
  for (const odd of [null, 5, {}, { geometry: null }, { geometry: { type: 'Point' } }])
    assert.equal(swapFeatureAxes(odd), odd);

  assert.doesNotThrow(() => assertWgs84({}, [[10, 20]], 'src'));
  assert.doesNotThrow(() => assertWgs84({ crsName: 'urn:ogc:def:crs:OGC:1.3:CRS84' }, [[10, 20]], 'src'));
  assert.doesNotThrow(() => assertWgs84({ crsName: 'EPSG:4326' }, [], 'src'));
  for (const crsName of ['EPSG:3857', 'EPSG:26915', 'something else'])
    assert.throws(
      () => assertWgs84({ crsName }, [[10, 20]], 'src'),
      (e: unknown) =>
        e instanceof ProviderError && e.code === 'MALFORMED' && !e.retryable && e.message.includes(crsName),
    );
  assert.throws(() => assertWgs84({}, [[500_000, 4_000_000]], 'src'), /not longitude\/latitude degrees/);

  assert.equal(repeatedPage(0, { added: 0, repeated: 5 }), false, 'the first page cannot repeat');
  assert.equal(repeatedPage(1, { added: 0, repeated: 5 }), true);
  assert.equal(repeatedPage(1, { added: 1, repeated: 5 }), false);
  assert.equal(repeatedPage(1, { added: 0, repeated: 0 }), false, 'an empty page is the end, not a repeat');
  const state = newPageState();
  assert.deepEqual(
    [state.observations, state.seen.size, state.total, state.filtered, state.rejected],
    [[], 0, 0, 0, 0],
  );
  assert.notEqual(newPageState().seen, state.seen);
});

// ---- REST placeholders -----------------------------------------------------------------

test('substitute and substituteNow: view placeholders and the request time, each where it is written', () => {
  const view = {
    south: '21',
    west: '-158',
    north: '22',
    east: '-157',
    lat: '21.5',
    lon: '-157.5',
    radiusKm: '50',
    radiusNm: '27',
    radiusM: '50000',
  };
  assert.equal(substitute('bbox={west},{south},{east},{north}', view), 'bbox=-158,21,-157,22');
  assert.equal(substitute('{lat}/{lon}/{radiusNm}?again={lat}', view), '21.5/-157.5/27?again=21.5');
  assert.equal(substitute('{LAT} {unknown} {lat', view), '{LAT} {unknown} {lat', 'only the exact names');
  assert.equal(substitute('no placeholders', view), 'no placeholders');
  assert.equal(substitute('{lat}', undefined), '{lat}');
  const now = Date.parse('2026-11-19T12:34:56.789Z');
  assert.equal(substituteNow('t={now}', now), 't=2026-11-19T12:34:56Z');
  assert.equal(substituteNow('[({now-90m})]', now), '[(2026-11-19T11:04:56Z)]');
  assert.equal(substituteNow('{now-3h}/{now}', now), '2026-11-19T09:34:56Z/2026-11-19T12:34:56Z');
  assert.equal(substituteNow('{now-0m}', now), '2026-11-19T12:34:56Z');
  for (const untouched of ['{now+1h}', '{now-1d}', '{now-12345m}', '{NOW}', '{now -1h}', 'now'])
    assert.equal(substituteNow(untouched, now), untouched, untouched);
});

// ---- STAC links ------------------------------------------------------------------------

test('STAC hrefs: resolved against where they were read, kept only as https with no credentials', () => {
  const base = 'https://stac.example/collections/c/items/i.json';
  assert.equal(httpsHref('thumb.png', base), 'https://stac.example/collections/c/items/thumb.png');
  assert.equal(httpsHref('/abs/t.png', base), 'https://stac.example/abs/t.png');
  assert.equal(httpsHref('https://cdn.example/t.png', base), 'https://cdn.example/t.png');
  for (const bad of [
    'http://cdn.example/t.png',
    'https://u:p@cdn.example/t.png',
    's3://bucket/key',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '',
    5,
    null,
    undefined,
    `https://cdn.example/${'x'.repeat(5000)}`,
  ])
    assert.equal(httpsHref(bad, base), undefined, String(bad).slice(0, 40));
  assert.equal(httpsHref('t.png', 'not a base'), undefined);

  assert.equal(
    thumbnailHref(
      { assets: { thumbnail: { href: 'a.png' }, other: { href: 'b.png', roles: ['thumbnail'] } } },
      base,
    )!.endsWith('/a.png'),
    true,
  );
  assert.equal(
    thumbnailHref({ assets: { preview: { href: 'b.png', roles: ['overview', 'thumbnail'] } } }, base)!.endsWith(
      '/b.png',
    ),
    true,
  );
  assert.equal(
    thumbnailHref(
      { assets: { thumbnail: { href: 'http://plain/a.png' } }, links: [{ rel: 'thumbnail', href: 'c.png' }] },
      base,
    )!.endsWith('/c.png'),
    true,
  );
  assert.equal(thumbnailHref({ assets: { data: { href: 'd.tif', roles: ['data'] } } }, base), undefined);
  assert.equal(thumbnailHref({}, base), undefined);
  assert.equal(thumbnailHref({ assets: [], links: 'x' }, base), undefined);

  const doc = {
    links: [
      { rel: 'self', href: 'a' },
      'junk',
      { rel: 'next', href: 5 },
      { rel: 'next', href: 'b', method: 'POST' },
      { rel: 'next', href: 'c' },
    ],
  };
  assert.deepEqual(linkOf(doc, 'next'), { rel: 'next', href: 'b', method: 'POST' });
  assert.equal(linkOf(doc, 'prev'), undefined);
  assert.equal(linkOf({}, 'next'), undefined);
  assert.equal(isRecord({}), true);
  for (const v of [null, [], 'x', 5, undefined]) assert.equal(isRecord(v), false);
});

// ---- esriJSON --------------------------------------------------------------------------

test('esriJSON: the error envelope, spatial references and date fields', () => {
  assert.equal(arcgisError({ features: [] }), undefined);
  assert.equal(arcgisError(null), undefined);
  const e = arcgisError({
    error: { code: '400', message: ' Invalid query ', details: ['Invalid query', 'where clause', 5, '', 'a', 'b'] },
  })!;
  assert.deepEqual(e, { code: 400, message: 'Invalid query', details: ['Invalid query', 'where clause', 'a'] });
  assert.equal(describeArcGisError(e), 'ArcGIS error 400: Invalid query (where clause; a)');
  assert.equal(describeArcGisError(arcgisError({ error: {} })!), 'ArcGIS error: no message');

  for (const ok of [undefined, null, { wkid: 4326 }, { wkid: 102100, latestWkid: 4326 }, { wkid: 4269 }, {}])
    assert.equal(spatialReferenceProblem(ok), undefined, JSON.stringify(ok));
  assert.match(spatialReferenceProblem({ wkid: 102100, latestWkid: 3857 }) ?? '', /wkid 3857 is not 4326/);
  assert.match(spatialReferenceProblem({ wkt: 'PROJCS[...]' }) ?? '', /WKT/);
  assert.match(spatialReferenceProblem('4326') ?? '', /not an object/);
  for (const name of ['urn:ogc:def:crs:OGC:1.3:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4269'])
    assert.equal(geoJsonCrsProblem({ type: 'name', properties: { name } }), undefined, name);
  assert.equal(geoJsonCrsProblem(undefined), undefined);
  assert.match(geoJsonCrsProblem({ properties: { name: 'EPSG:3857' } }) ?? '', /not WGS 84/);
  assert.match(geoJsonCrsProblem({ properties: { name: 'EPSG:14326' } }) ?? '', /not WGS 84/, '14326 is not 4326');
  assert.match(geoJsonCrsProblem({}) ?? '', /no name/);

  const fields = parseEsriFields([
    { name: 'OBJECTID', type: 'esriFieldTypeOID' },
    { name: 'when', type: 'esriFieldTypeDate', alias: 'When' },
    { name: 5 },
    null,
    'x',
  ]);
  assert.deepEqual(
    fields.map((f) => f.name),
    ['OBJECTID', 'when'],
  );
  assert.deepEqual(parseEsriFields('nope'), []);
  const dates = dateFields(fields);
  assert.deepEqual([...dates], ['when']);
  assert.equal(dateFields(undefined).size, 0);
  const props = { when: 1_758_621_600_000, other: 1_758_621_600_000, text: 'x' };
  normalizeDates(props, dates);
  assert.deepEqual(props, { when: '2025-09-23T10:00:00.000Z', other: 1_758_621_600_000, text: 'x' });
  const odd = { when: 9e15 as number | string | null };
  normalizeDates(odd, dates);
  assert.equal(odd.when, 9e15, 'past the range of dates: left as it is');
  for (const value of ['2026-01-01', null]) {
    const kept = { when: value };
    normalizeDates(kept, dates);
    assert.equal(kept.when, value);
  }
});

test('esriJSON geometry: each kind as its GeoJSON kind, rings grouped into polygons with their holes', () => {
  assert.deepEqual(esriGeometryToGeoJson({ x: -157.8, y: 21.3 }), { type: 'Point', coordinates: [-157.8, 21.3] });
  assert.deepEqual(esriGeometryToGeoJson({ x: 1, y: 2, z: 30 }), { type: 'Point', coordinates: [1, 2, 30] });
  assert.deepEqual(esriGeometryToGeoJson({ x: 1, y: 2, z: 30, hasZ: false }), { type: 'Point', coordinates: [1, 2] });
  for (const empty of [
    undefined,
    null,
    {},
    { x: null },
    { x: 'NaN', y: 'NaN' },
    { points: [] },
    { paths: [] },
    { rings: [] },
    { paths: [[[1, 2]]] },
  ])
    assert.equal(esriGeometryToGeoJson(empty), null, JSON.stringify(empty));
  assert.deepEqual(
    esriGeometryToGeoJson({
      points: [
        [1, 2],
        [3, 4, 5],
      ],
    }),
    {
      type: 'MultiPoint',
      coordinates: [
        [1, 2],
        [3, 4, 5],
      ],
    },
  );
  assert.deepEqual(
    esriGeometryToGeoJson({ hasM: true, points: [[1, 2, 99]] }),
    { type: 'MultiPoint', coordinates: [[1, 2]] },
    'with M and no Z the third value is a measure',
  );
  assert.deepEqual(esriGeometryToGeoJson({ hasZ: true, hasM: true, points: [[1, 2, 3, 99]] }), {
    type: 'MultiPoint',
    coordinates: [[1, 2, 3]],
  });
  assert.deepEqual(
    esriGeometryToGeoJson({
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
  );
  assert.equal(
    (
      esriGeometryToGeoJson({
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [5, 5],
            [6, 6],
          ],
        ],
      }) as { type: string }
    ).type,
    'MultiLineString',
  );
  assert.deepEqual(esriGeometryToGeoJson({ xmin: 0, ymin: 1, xmax: 2, ymax: 3 }), {
    type: 'Polygon',
    coordinates: [
      [
        [0, 1],
        [2, 1],
        [2, 3],
        [0, 3],
        [0, 1],
      ],
    ],
  });
  for (const bad of [
    'text',
    { x: 'a', y: 1 },
    { points: [[1]] },
    { paths: 'x' },
    { paths: [[[1, 'b']]] },
    {
      rings: [
        [
          [1, 2],
          ['a', 2],
        ],
      ],
    },
    { curveRings: [] },
    { unknown: 1 },
  ])
    assert.equal(typeof esriGeometryToGeoJson(bad), 'string', JSON.stringify(bad));

  // esriJSON: exteriors clockwise, holes counter-clockwise. GeoJSON: the other way round.
  const outer = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
    [0, 0],
  ];
  const hole = [
    [2, 2],
    [4, 2],
    [4, 4],
    [2, 4],
    [2, 2],
  ];
  const island = [
    [20, 0],
    [20, 5],
    [25, 5],
    [25, 0],
    [20, 0],
  ];
  const area2 = (ring: number[][]) =>
    ring.slice(0, -1).reduce((sum, p, i) => sum + (ring[i + 1]![0]! - p[0]!) * (ring[i + 1]![1]! + p[1]!), 0);
  const one = esriGeometryToGeoJson({ rings: [outer, hole] }) as { type: string; coordinates: number[][][] };
  assert.equal(one.type, 'Polygon');
  assert.equal(one.coordinates.length, 2);
  assert.ok(area2(one.coordinates[0]!) < 0, 'exterior counter-clockwise');
  assert.ok(area2(one.coordinates[1]!) > 0, 'hole clockwise');
  const two = esriGeometryToGeoJson({ rings: [island, hole, outer] }) as { type: string; coordinates: number[][][][] };
  assert.equal(two.type, 'MultiPolygon');
  assert.deepEqual(
    two.coordinates.map((p) => p.length).sort(),
    [1, 2],
    'the hole goes to the exterior that contains it',
  );
  // A hole no exterior contains is an exterior drawn the other way.
  const stray = esriGeometryToGeoJson({ rings: [hole] }) as { type: string; coordinates: number[][][] };
  assert.equal(stray.type, 'Polygon');
  assert.ok(area2(stray.coordinates[0]!) < 0);
  // An unclosed ring is closed; a ring with no area is dropped.
  const open = esriGeometryToGeoJson({
    rings: [
      outer.slice(0, -1),
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [0, 0],
      ],
    ],
  }) as { coordinates: number[][][] };
  assert.equal(open.coordinates.length, 1);
  assert.deepEqual(open.coordinates[0]![0], open.coordinates[0]![open.coordinates[0]!.length - 1]);
});

test('esriJSON: a feature set either way, and a multi-megabyte polygon of thousands of rings in a moment', () => {
  assert.equal(isEsriFeatureSet({ features: [] }), true);
  assert.equal(isEsriFeatureSet({ type: 'FeatureCollection', features: [] }), false);
  assert.equal(isEsriFeatureSet({ features: {} }), false);
  assert.equal(isEsriFeatureSet(null), false);
  assert.ok('malformed' in readFeatureSet({ nothing: true }));
  assert.ok('malformed' in readFeatureSet('text'));
  const esri = readFeatureSet({
    fields: [{ name: 'when', type: 'esriFieldTypeDate' }],
    spatialReference: { wkid: 4326 },
    exceededTransferLimit: true,
    features: [
      { attributes: { OBJECTID: 1, when: 0 }, geometry: { x: 1, y: 2 } },
      { attributes: { OBJECTID: 2 }, geometry: { x: 'bad', y: 1 } },
    ],
  });
  assert.ok(!('malformed' in esri));
  if ('malformed' in esri) return;
  assert.equal(esri.format, 'esrijson');
  assert.equal(esri.exceededTransferLimit, true);
  assert.deepEqual(esri.features[0]!.geometry, { type: 'Point', coordinates: [1, 2] });
  assert.equal(esri.features[0]!.properties['when'], '1970-01-01T00:00:00.000Z');
  assert.equal(esri.features[1]!.geometry, null, 'a geometry that cannot be read leaves the feature without one');
  assert.equal(esri.problems.length, 1);
  const geo = readFeatureSet({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { a: 1 } }],
  });
  assert.ok(!('malformed' in geo) && geo.format === 'geojson' && geo.features.length === 1);

  // 4,000 exteriors each with a hole, in a grid.
  const rings: number[][][] = [];
  for (let i = 0; i < 4000; i++) {
    const x = (i % 80) * 2;
    const y = Math.floor(i / 80) * 2;
    rings.push([
      [x, y],
      [x, y + 1],
      [x + 1, y + 1],
      [x + 1, y],
      [x, y],
    ]);
    rings.push([
      [x + 0.2, y + 0.2],
      [x + 0.8, y + 0.2],
      [x + 0.8, y + 0.8],
      [x + 0.2, y + 0.8],
      [x + 0.2, y + 0.2],
    ]);
  }
  const started = Date.now();
  const many = esriGeometryToGeoJson({ rings }) as { type: string; coordinates: number[][][][] };
  const took = Date.now() - started;
  assert.equal(many.type, 'MultiPolygon');
  assert.equal(many.coordinates.length, 4000);
  assert.ok(
    many.coordinates.every((p) => p.length === 2),
    'every exterior has its own hole',
  );
  assert.ok(took < 1500, `${took} ms`);
});

// ---- delimited text --------------------------------------------------------------------

test('parseCsvRows and parseWhitespaceRows', () => {
  assert.deepEqual(parseCsvRows('a,b\r\n1,"x, ""y"""\n2,\n'), [
    ['a', 'b'],
    ['1', 'x, "y"'],
    ['2', ''],
  ]);
  assert.deepEqual(parseCsvRows('a;b\n1;2', ';'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(parseCsvRows('"line\nbreak",2'), [['line\nbreak', '2']]);
  assert.deepEqual(parseCsvRows(''), []);
  assert.deepEqual(parseCsvRows('one'), [['one']]);
  assert.throws(() => parseCsvRows('a,"never closed'), /unterminated quoted field/);
  assert.deepEqual(parseWhitespaceRows('  a   b\tc \n\n 1 2   3\r\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
  assert.deepEqual(parseWhitespaceRows(''), []);
  assert.deepEqual(parseWhitespaceRows(' \n\t\n'), []);
});
