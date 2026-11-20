import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldFilter, WorldGeometry } from '@opcb/world-model';
import { formatCoordinateLabel } from './coordinates.js';
import { applyObjectQuery } from './execute.js';
import {
  comparableKind,
  compareValues,
  resolveEventField,
  resolveObjectField,
  toNumber,
  type FieldValue,
} from './fields.js';
import { matchesAll } from './filters.js';
import { compareHits, type GazetteerHit } from './gazetteer.js';
import { geometryPoints, geometryRepresentativePoint, regionCenter, regionSamplePoints } from './geometry.js';
import { stableHash } from './hash.js';
import { collapseDuplicateHits } from './place-duplicates.js';
import {
  eventMatchesText,
  eventSearchStrings,
  externalIdOf,
  matchesTokens,
  objectMatchesText,
  objectSearchStrings,
  tokenize,
} from './text-match.js';
import { parseSearch } from './parse-search.js';
import { typeLabel } from './vocabulary.js';
import { T0, eventFrom, objectFrom } from './test-fixtures.js';

const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const baseSpec = { providerId: 'p', objectType: 'thing', externalId: 'x', lat: 0, lon: 0 };

const quake = objectFrom({
  providerId: 'usgs-earthquakes',
  objectType: 'earthquake',
  externalId: 'us1',
  lat: 36,
  lon: 140,
  observedAt: iso(-60_000),
  payload: {
    magnitude: 5.7,
    place: '20 km E of Tokyo',
    list: [7, { deep: 'x' }],
    nested: { a: { b: 2 } },
    type: 'hidden',
  },
});

test('resolveObjectField: top-level fields, sections, and a bare name as a property', () => {
  assert.equal(resolveObjectField(quake, 'type'), 'earthquake');
  assert.equal(resolveObjectField(quake, 'id'), quake.id);
  assert.equal(resolveObjectField(quake, 'providerId'), 'usgs-earthquakes');
  assert.equal(resolveObjectField(quake, 'observedAt'), iso(-60_000));
  assert.equal(resolveObjectField(quake, 'magnitude'), 5.7);
  assert.equal(resolveObjectField(quake, 'properties.magnitude'), 5.7);
  assert.equal(resolveObjectField(quake, 'properties.type'), 'hidden');
  assert.equal(resolveObjectField(quake, 'labels.place'), '20 km E of Tokyo');
  assert.equal(resolveObjectField(quake, 'position.latitude'), 36);
  assert.equal(resolveObjectField(quake, 'motion.speedMps'), undefined);
  assert.equal(resolveObjectField(quake, 'nested.a.b'), undefined, 'only a single bare name falls back to properties');
  assert.equal(resolveObjectField(quake, 'properties.nested.a.b'), 2);
  assert.equal(resolveObjectField(quake, 'properties.list.0'), 7);
  assert.equal(resolveObjectField(quake, 'properties.list.1.deep'), 'x');
  assert.equal(resolveObjectField(quake, ''), undefined);
  assert.equal(resolveObjectField(quake, 'validUntil'), undefined);
});

test('a field path reads what the source sent, never what every object has', () => {
  for (const path of [
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'properties.constructor',
    'properties.__proto__.constructor',
    'labels.constructor',
    'properties.nested.valueOf',
    'properties.list.length',
    'properties.list.',
    'properties.list.-1',
    'properties.list.1.5',
    'properties.list.0x0',
    'properties.magnitude.toFixed',
  ])
    assert.equal(resolveObjectField(quake, path), undefined, path);
  const event = eventFrom({ id: 'event:x', type: 'earthquake.significant', startAt: iso(0), properties: { n: 1 } });
  assert.equal(resolveEventField(event, 'constructor'), undefined);
  assert.equal(resolveEventField(event, 'properties.toString'), undefined);
  // So "exists" is false for them, and an own key of that name still reads.
  assert.equal(
    matchesAll((p) => resolveObjectField(quake, p), [{ field: 'constructor', op: 'exists' }]),
    false,
  );
  const own = objectFrom({ ...baseSpec, payload: { constructor: 'Acme' } });
  assert.equal(resolveObjectField(own, 'constructor'), 'Acme');
});

test('resolveEventField: its own fields, then properties', () => {
  const event = eventFrom({
    id: 'event:earthquake:usgs:us1',
    type: 'earthquake.significant',
    startAt: iso(0),
    endAt: iso(1000),
    title: 'M 5.7',
    summary: 'felt widely',
    severity: 'SEVERE',
    properties: { magnitude: 5.7, title: 'hidden' },
  });
  assert.equal(resolveEventField(event, 'type'), 'earthquake.significant');
  assert.equal(resolveEventField(event, 'title'), 'M 5.7');
  assert.equal(resolveEventField(event, 'summary'), 'felt widely');
  assert.equal(resolveEventField(event, 'severity'), 'SEVERE');
  assert.equal(resolveEventField(event, 'confidence'), 'HIGH');
  assert.equal(resolveEventField(event, 'startAt'), iso(0));
  assert.equal(resolveEventField(event, 'endAt'), iso(1000));
  assert.equal(resolveEventField(event, 'providerId'), 'worldview');
  assert.equal(resolveEventField(event, 'magnitude'), 5.7);
  assert.equal(resolveEventField(event, 'properties.title'), 'hidden');
  assert.equal(resolveEventField(event, 'missing'), undefined);
  assert.equal(resolveEventField(event, ''), undefined);
  const bare = eventFrom({ id: 'event:y', type: 't', startAt: iso(0) });
  assert.equal(resolveEventField(bare, 'magnitude'), undefined);
  assert.equal(resolveEventField(bare, 'properties.magnitude'), undefined);
});

test('comparableKind and toNumber', () => {
  const kinds: Array<[FieldValue, string]> = [
    [undefined, 'none'],
    [null, 'none'],
    [Number.NaN, 'none'],
    [Number.POSITIVE_INFINITY, 'none'],
    [0, 'number'],
    [-1.5, 'number'],
    [true, 'boolean'],
    ['', 'string'],
    ['abc', 'string'],
    ['12', 'string'],
    ['2026-09-21T12:00:00Z', 'date'],
    ['2026-09-21T12:00', 'date'],
    ['2026-09-21', 'string'],
    ['2026-99-99T99:99', 'string'],
    [[1], 'other'],
    [{ a: 1 }, 'other'],
  ];
  for (const [value, kind] of kinds) assert.equal(comparableKind(value), kind, JSON.stringify(value));
  assert.equal(toNumber(5), 5);
  assert.equal(toNumber('5.5'), 5.5);
  assert.equal(toNumber(' 7 '), 7);
  assert.equal(toNumber('1e3'), 1000);
  for (const v of ['', '   ', 'abc', '5 km', 'Infinity', Number.NaN, true, null, undefined, [5]])
    assert.equal(toNumber(v as FieldValue), undefined, JSON.stringify(v));
});

test('compareValues is an order: never both ways, and transitive across mixed kinds', () => {
  const values: FieldValue[] = [
    '10',
    '9',
    9.5,
    'abc',
    'ABC',
    '-x',
    3,
    '3',
    '007',
    7,
    '7',
    '5.0',
    5,
    true,
    false,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    '2025-06-01T00:00',
    null,
    undefined,
    [1],
    { a: 1 },
    '',
    ' ',
    '1e3',
    1000,
    -2,
    '-2.5',
    0,
  ];
  for (const a of values)
    for (const b of values) {
      const ab = compareValues(a, b);
      assert.equal(Math.sign(ab), -Math.sign(compareValues(b, a)) || 0, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
      for (const c of values) {
        const bc = compareValues(b, c);
        if (ab <= 0 && bc <= 0)
          assert.ok(compareValues(a, c) <= 0, `${JSON.stringify(a)} ≤ ${JSON.stringify(b)} ≤ ${JSON.stringify(c)}`);
      }
    }
  // So a column of numbers and numeric text sorts one way, whatever order it starts in.
  const column: FieldValue[] = ['10', '9', 9.5, 3, '100', 7];
  const want = [3, 7, '9', 9.5, '10', '100'];
  assert.deepEqual([...column].sort(compareValues), want);
  assert.deepEqual([...column].reverse().sort(compareValues), want);
});

test('compareValues: values of each kind, and kinds against each other', () => {
  assert.ok(compareValues(2, 10) < 0);
  assert.ok(compareValues('9', '10') < 0, 'numeric text compares as numbers');
  assert.equal(compareValues('5.0', 5), 0);
  assert.equal(compareValues('5.0', '5'), 0);
  assert.ok(compareValues('apple', 'Banana') < 0, 'text ignores case');
  assert.ok(compareValues('ABC', 'abc') < 0, 'then case decides, so equal text is the only tie');
  assert.equal(compareValues('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'), 0, 'one instant, two spellings');
  assert.ok(compareValues('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z') < 0);
  assert.ok(compareValues(false, true) < 0);
  assert.ok(compareValues(5, 'abc') < 0);
  assert.ok(compareValues('5', 'abc') < 0);
  assert.ok(compareValues(5, '2026-01-01T00:00:00Z') < 0);
  assert.ok(compareValues('2026-01-01T00:00:00Z', true) < 0);
  assert.ok(compareValues(true, 'abc') < 0);
  assert.ok(compareValues('abc', [1]) < 0);
  assert.ok(compareValues(undefined, 5) > 0);
  assert.ok(compareValues(5, null) < 0);
  assert.equal(compareValues(null, undefined), 0);
});

test('matchesAll: no filters pass; every filter must hold', () => {
  const resolve = (p: string) => resolveObjectField(quake, p);
  const big: WorldFilter = { field: 'magnitude', op: 'gte', value: 5 };
  const tokyo: WorldFilter = { field: 'place', op: 'contains', value: 'tokyo' };
  const small: WorldFilter = { field: 'magnitude', op: 'lt', value: 5 };
  assert.equal(matchesAll(resolve, undefined), true);
  assert.equal(matchesAll(resolve, []), true);
  assert.equal(matchesAll(resolve, [big, tokyo]), true);
  assert.equal(matchesAll(resolve, [big, small]), false);
  assert.equal(matchesAll(resolve, [{ field: 'magnitude', op: 'gt', value: '5' }]), true);
  assert.equal(
    matchesAll(resolve, [{ field: 'missing', op: 'lt', value: 5 }]),
    false,
    'a missing field satisfies no ordering',
  );
  assert.equal(matchesAll(resolve, [{ field: 'missing', op: 'exists', value: false }]), true);
});

test('applyObjectQuery: type, provider, region, time, filter and text together; limit after sort', () => {
  const things = [
    quake,
    objectFrom({
      ...baseSpec,
      objectType: 'earthquake',
      externalId: 'us2',
      lat: 19.4,
      lon: -155.3,
      observedAt: iso(-7_200_000),
      payload: { magnitude: 2.1, place: 'Kilauea' },
    }),
    objectFrom({
      ...baseSpec,
      objectType: 'earthquake',
      externalId: 'us3',
      lat: 35.5,
      lon: 139.5,
      observedAt: iso(-30_000),
      payload: { magnitude: 4.4, place: 'Yokohama' },
    }),
    objectFrom({
      ...baseSpec,
      objectType: 'aircraft',
      externalId: 'a1',
      lat: 35.6,
      lon: 139.7,
      observedAt: iso(0),
      payload: { callsign: 'JAL5' },
    }),
    objectFrom({
      ...baseSpec,
      objectType: 'earthquake',
      externalId: 'nowhere',
      lat: undefined as never,
      lon: undefined as never,
      payload: { magnitude: 9 },
    }),
  ];
  const japan = { kind: 'bounds' as const, bounds: { west: 130, south: 30, east: 145, north: 40 } };
  const all = applyObjectQuery(things, {}, 'live', T0);
  assert.equal(all.total, 5);
  assert.equal(all.basis, 'live');
  assert.equal(all.items[0]!.id, things[3]!.id, 'newest first when no sort is given');
  const quakes = applyObjectQuery(
    things,
    { objectTypes: ['earthquake'], region: japan, sort: { field: 'magnitude', direction: 'desc' } },
    'live',
    T0,
  );
  assert.deepEqual(
    quakes.items.map((o) => o.properties['magnitude']),
    [5.7, 4.4],
  );
  assert.equal(applyObjectQuery(things, { providerIds: ['usgs-earthquakes'] }, 'live', T0).total, 1);
  assert.equal(applyObjectQuery(things, { time: { start: iso(-90_000), end: iso(-10_000) } }, 'live', T0).total, 2);
  assert.equal(applyObjectQuery(things, { text: 'tokyo' }, 'live', T0).total, 1);
  assert.equal(applyObjectQuery(things, { text: 'jal5 aircraft' }, 'live', T0).total, 1);
  assert.equal(
    applyObjectQuery(things, { filters: [{ field: 'magnitude', op: 'gt', value: 4 }] }, 'live', T0).total,
    3,
  );
  const limited = applyObjectQuery(
    things,
    { objectTypes: ['earthquake'], sort: { field: 'magnitude', direction: 'asc' }, limit: 2 },
    'historical',
    T0,
  );
  assert.deepEqual(
    limited.items.map((o) => o.properties['magnitude']),
    [2.1, 4.4],
  );
  assert.equal(limited.total, 4);
  assert.equal(limited.basis, 'historical');
  assert.equal(applyObjectQuery([], { text: 'x' }, 'live', T0).total, 0);
  // An empty list of types or providers is no restriction, not "none of them".
  assert.equal(applyObjectQuery(things, { objectTypes: [], providerIds: [] }, 'live', T0).total, 5);
});

test('text matching: every token somewhere, case ignored, external ids included', () => {
  assert.deepEqual(tokenize('  UAL123, hnl;  Boeing\t737 '), ['ual123', 'hnl', 'boeing', '737']);
  assert.deepEqual(tokenize(' ,; '), []);
  assert.equal(externalIdOf('adsb:a1b2c3:2026-09-21T12:00:00.000Z', 'adsb'), 'a1b2c3');
  assert.equal(externalIdOf('adsb:mmsi:123:2026-09-21T12:00:00Z', 'adsb'), 'mmsi:123');
  assert.equal(externalIdOf('adsb:a1b2c3', 'adsb'), undefined, 'no time, not that form');
  assert.equal(externalIdOf('other:a1b2c3:2026-09-21T12:00:00Z', 'adsb'), undefined);
  assert.equal(externalIdOf('adsb::2026-09-21T12:00:00Z', 'adsb'), undefined);
  const plane = objectFrom({
    ...baseSpec,
    objectType: 'aircraft',
    providerId: 'adsb',
    externalId: 'a1b2c3',
    id: 'aircraft:icao24:a1b2c3',
    payload: { callsign: 'UAL123', registration: 'N12345' },
  });
  const strings = objectSearchStrings(plane);
  for (const s of ['aircraft:icao24:a1b2c3', 'a1b2c3', 'UAL123', 'N12345']) assert.ok(strings.includes(s), s);
  assert.equal(objectMatchesText(plane, 'ual n123'), true);
  assert.equal(objectMatchesText(plane, 'UAL delta'), false);
  assert.equal(objectMatchesText(plane, ''), true);
  assert.equal(objectMatchesText(plane, 'A1B2'), true);
  assert.equal(matchesTokens([], ['x']), false);
  assert.equal(matchesTokens([], []), true);
  const event = eventFrom({
    id: 'event:earthquake:usgs:us7000',
    type: 'earthquake',
    startAt: iso(0),
    title: 'M 6.1 near Hilo',
    objectIds: ['earthquake:usgs:us7000'],
  });
  assert.deepEqual(eventSearchStrings(event), [
    'event:earthquake:usgs:us7000',
    'M 6.1 near Hilo',
    'us7000',
    'earthquake:usgs:us7000',
  ]);
  assert.equal(eventMatchesText(event, 'hilo 6.1'), true);
  assert.equal(eventMatchesText(event, 'kona'), false);
});

test('geometry helpers: points of every geometry type, a representative point, region samples and centre', () => {
  const geometries: Array<[WorldGeometry, number]> = [
    [{ type: 'Point', coordinates: [1, 2, 300] }, 1],
    [
      {
        type: 'MultiPoint',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      2,
    ],
    [
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [2, 2],
          [4, 0],
        ],
      },
      3,
    ],
    [
      {
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
          [
            [5, 5],
            [6, 6],
          ],
        ],
      },
      4,
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
            [0, 0],
          ],
        ],
      },
      5,
    ],
    [
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [5, 5],
              [6, 5],
              [6, 6],
              [5, 5],
            ],
          ],
        ],
      },
      8,
    ],
  ];
  for (const [g, count] of geometries) {
    const points = geometryPoints(g);
    assert.equal(points.length, count, g.type);
    for (const p of points) assert.equal(p.length, 2);
    const at = geometryRepresentativePoint(g)!;
    assert.ok(Number.isFinite(at.latitude) && Number.isFinite(at.longitude), g.type);
  }
  assert.deepEqual(geometryRepresentativePoint({ type: 'Point', coordinates: [1, 2, 300] }), {
    latitude: 2,
    longitude: 1,
  });
  assert.deepEqual(geometryPoints({ type: 'LineString', coordinates: [] }), []);

  const center = { latitude: 10, longitude: 20 };
  assert.deepEqual(regionSamplePoints({ kind: 'circle', center, radiusM: 5 }), [center]);
  assert.equal(regionCenter({ kind: 'circle', center, radiusM: 5 }), center);
  const bounds = { west: 170, south: -10, east: -170, north: 10 };
  const samples = regionSamplePoints({ kind: 'bounds', bounds });
  assert.equal(samples.length, 5);
  assert.equal(Math.abs(samples[4]!.longitude), 180, 'the middle of a box across 180° is on 180°, not at 0°');
  assert.equal(Math.abs(regionCenter({ kind: 'bounds', bounds })!.longitude), 180);
  assert.deepEqual(regionCenter({ kind: 'bounds', bounds: { west: -10, south: 0, east: 30, north: 20 } }), {
    latitude: 10,
    longitude: 10,
  });
  assert.deepEqual(
    regionSamplePoints({
      kind: 'polygon',
      polygon: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    }),
    [
      { latitude: 2, longitude: 1 },
      { latitude: 4, longitude: 3 },
      { latitude: 6, longitude: 5 },
    ],
  );
  assert.deepEqual(regionSamplePoints({ kind: 'admin', regionId: 'iso3166-1:JP' }), []);
  assert.equal(regionCenter({ kind: 'admin', regionId: 'iso3166-1:JP' }), undefined);
  assert.equal(regionSamplePoints({ kind: 'admin', regionId: 'iso3166-1:JP', bounds }).length, 5);
});

test('stableHash: sixteen hex characters, the same for the same text, different for near text', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20_000; i++) {
    const h = stableHash(`query:${i}`);
    assert.match(h, /^[0-9a-f]{16}$/);
    seen.add(h);
  }
  assert.equal(seen.size, 20_000);
  assert.equal(stableHash('abc'), stableHash('abc'));
  assert.notEqual(stableHash('abc'), stableHash('abd'));
  assert.match(stableHash(''), /^[0-9a-f]{16}$/);
  assert.match(stableHash('\u{1F30B} 日本'), /^[0-9a-f]{16}$/);
});

const hit = (over: Partial<GazetteerHit> & { id: string; name: string }): GazetteerHit => ({
  kind: 'city',
  position: { latitude: 48.85, longitude: 2.35 },
  score: 1,
  ...over,
});

test('compareHits: score, then kind, then prominence, then name', () => {
  const france = hit({ id: 'c:fr', name: 'France', kind: 'country' });
  const paris = hit({ id: 'p:paris', name: 'Paris', importance: 0.9 });
  const parisTexas = hit({
    id: 'p:paris-tx',
    name: 'Paris',
    importance: 0.1,
    position: { latitude: 33.66, longitude: -95.55 },
  });
  const curated = hit({ id: 'p:curated', name: 'Aardvark' });
  const partial = hit({ id: 'p:partial', name: 'Aaa', kind: 'country', score: 0.5 });
  const sorted = [partial, parisTexas, paris, curated, france].sort(compareHits);
  assert.deepEqual(
    sorted.map((h) => h.id),
    ['c:fr', 'p:curated', 'p:paris', 'p:paris-tx', 'p:partial'],
  );
  assert.equal(compareHits(paris, { ...paris }), 0);
  assert.ok(compareHits(hit({ id: 'a', name: 'Alpha' }), hit({ id: 'b', name: 'Beta' })) < 0);
});

test('collapseDuplicateHits: a later copy of a kept place folds into it and fills what it lacks', () => {
  const paris = hit({ id: 'a:paris', name: 'Paris' });
  const copy = hit({
    id: 'b:paris',
    name: 'PARIS',
    position: { latitude: 48.86, longitude: 2.34 },
    countryCode: 'FR',
    region: 'Île-de-France',
    bounds: { west: 2.2, south: 48.8, east: 2.5, north: 48.9 },
  });
  const texas = hit({
    id: 'c:paris-tx',
    name: 'Paris',
    position: { latitude: 33.66, longitude: -95.55 },
    countryCode: 'US',
  });
  const region = hit({ id: 'd:paris-region', name: 'Paris', kind: 'region' });
  const out = collapseDuplicateHits([paris, copy, texas, region]);
  assert.deepEqual(
    out.map((h) => h.id),
    ['a:paris', 'c:paris-tx', 'd:paris-region'],
  );
  assert.equal(out[0]!.countryCode, 'FR');
  assert.equal(out[0]!.region, 'Île-de-France');
  assert.ok(out[0]!.bounds);
  assert.equal(paris.countryCode, undefined, 'the hit passed in is not changed');
  assert.deepEqual(collapseDuplicateHits([]), []);
  // Two typed coordinates are never one place.
  const point = hit({ id: 'x', name: '1, 2', kind: 'coordinate' });
  assert.equal(collapseDuplicateHits([point, { ...point, id: 'y' }]).length, 2);
});

test('typeLabel and formatCoordinateLabel', () => {
  assert.equal(typeLabel('aircraft'), 'Aircraft');
  assert.equal(typeLabel('not.a.known.type'), 'not.a.known.type');
  assert.equal(formatCoordinateLabel(21.3069, -157.8583), '21.3069° N, 157.8583° W');
  assert.equal(formatCoordinateLabel(-33.86882, 151.20929), '33.8688° S, 151.2093° E');
  assert.equal(formatCoordinateLabel(0, 0), '0.0000° N, 0.0000° E');
  assert.equal(formatCoordinateLabel(-0.00001, -0.00004), '0.0000° N, 0.0000° E');
  assert.equal(formatCoordinateLabel(-0.00005, -0.0001), '0.0001° S, 0.0001° W');
});

test('a search for a word every object has (constructor, __proto__) is a search for that word', () => {
  const ctx = { gazetteer: { search: () => [], lookup: () => [] } as never, now: () => T0, commands: [] };
  for (const word of ['constructor', '__proto__', 'tostring', 'valueof', 'hasownproperty']) {
    for (const text of [
      `last 5 ${word}`,
      `last ${word}`,
      `in the last ${word} ${word}`,
      `aircraft over 5 ${word}`,
      `aircraft faster than 300 ${word}`,
      `${word} 5`,
      `${word} ago`,
      word,
    ]) {
      const parsed = parseSearch(text, ctx);
      const json = JSON.stringify(parsed);
      assert.ok(!/NaN|null|undefined|native code/.test(json), `${text}: ${json}`);
      for (const intent of parsed.intents)
        if (intent.kind === 'query')
          for (const f of intent.query?.filters ?? []) assert.equal(typeof f.field, 'string', text);
    }
  }
  // The real units still read.
  const real = parseSearch('aircraft last 5 minutes', ctx).intents.find((i) => i.kind === 'query');
  assert.ok(real && real.kind === 'query' && real.query?.time, 'a time range');
});
