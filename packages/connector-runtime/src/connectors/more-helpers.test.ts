import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@opcb/provider-sdk';
import type { ConnectorProviderDefinition, MappingSpec } from '@opcb/connector-sdk';
import type { Observation } from '@opcb/world-model';
import { propertyName } from './arcgis/layer-info.js';
import { formatOf, isFileFormat } from './files/formats.js';
import { FILE_TIME_FLAG, datedByFile } from './files/provider.js';
import { MAX_TOPOLOGY_POSITIONS, readTopoJson, readTopologyDocument } from './files/topojson.js';
import { placedMapping } from './mqtt/mqtt.js';
import { overlayIdFor, overlayName, overlayRole } from './ogc/overlay-provider.js';
import { frameBefore } from './ogc/wmts.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS,
  datetimeSpec,
  firstRequest,
  parseWindow,
  requestKey,
  searchBody,
  searchParameters,
} from './stac/search.js';
import { stacDocKind, walkStaticCatalog } from './stac/static.js';

const def = (endpoint: unknown): ConnectorProviderDefinition =>
  ({ id: 'd', endpoint }) as unknown as ConnectorProviderDefinition;

// ---- STAC search -----------------------------------------------------------------------

test('STAC search: the definition’s body, its time window, and the parameters one search sends', () => {
  const body = { collections: ['sentinel-2-l2a'], limit: 50 };
  const d = def({ url: 'https://stac.example/search', body });
  assert.deepEqual(searchBody(d), body);
  assert.notEqual(searchBody(d), body, 'a copy: adding to it does not write to the definition');
  for (const none of [def(undefined), def({}), def({ body: 'text' }), def({ body: [1] }), def({ body: null })])
    assert.deepEqual(searchBody(none), {});

  assert.equal(parseWindow('P7D'), 7 * 86_400_000);
  assert.equal(parseWindow('PT12H'), 12 * 3_600_000);
  assert.equal(parseWindow('P1DT6H'), 30 * 3_600_000);
  for (const bad of ['P', 'PT', '7D', 'P7', 'P1W', 'PT30M', 'P1.5D', 'p7d', ' P7D', 'P7D '])
    assert.equal(parseWindow(bad), undefined, bad);

  const spec = (datetime: unknown) => datetimeSpec(def({ body: { datetime } }));
  assert.deepEqual(datetimeSpec(def({})), { rolling: DEFAULT_WINDOW_MS });
  assert.deepEqual(spec(null), { rolling: DEFAULT_WINDOW_MS });
  assert.deepEqual(spec('P30D'), { rolling: 30 * 86_400_000 });
  assert.deepEqual(spec('PT1H'), { rolling: 3_600_000 });
  assert.deepEqual(spec('P366D'), { rolling: 366 * 86_400_000 });
  for (const fixed of [
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z/2026-02-01T00:00:00Z',
    '../2026-02-01T00:00:00+10:00',
    '2026-01-01T00:00:00.5Z/',
    '2026-01-01T00:00:00Z/..',
  ])
    assert.deepEqual(spec(fixed), { fixed }, fixed);
  for (const bad of [
    5,
    'PT0H',
    'P367D',
    'P999DT9999H',
    'last week',
    '2026-01-01',
    '../..',
    '/',
    'a/b/c',
    '2026-01-01T00:00:00Z/tomorrow',
    '2026-01-01T00:00:00',
  ])
    assert.ok('error' in spec(bad), String(bad));
  const long = spec('x'.repeat(500));
  assert.ok('error' in long && long.error.length < 200, 'a long wrong value is cut in the message');

  assert.deepEqual(searchParameters(body, { box: [-158, 21, -157, 22], datetime: 'a/b' }), {
    ...body,
    bbox: [-158, 21, -157, 22],
    datetime: 'a/b',
  });
  assert.deepEqual(
    searchParameters({ datetime: 'P7D', limit: null }, {}),
    { limit: DEFAULT_LIMIT },
    'the window is never sent as written',
  );
  assert.deepEqual(searchParameters({ limit: 0 }, {}), { limit: 0 });
  assert.deepEqual(body, { collections: ['sentinel-2-l2a'], limit: 50 });
});

test('STAC first request: POST carries the JSON, GET the same parameters as a query', () => {
  const params = {
    collections: ['a', 'b'],
    bbox: [-158, 21, -157, 22],
    limit: 10,
    sortby: [{ field: 'properties.datetime', direction: 'DESC' }, { field: 'id' }],
    fields: { include: ['id', 'geometry'], exclude: ['links'] },
    query: { 'eo:cloud_cover': { lt: 20 } },
    nothing: null,
    flag: true,
  };
  const post = firstRequest('https://stac.example/search?fixed=1', { key: 'k v', n: 2 }, params, 'POST');
  assert.equal(post.method, 'POST');
  assert.equal(post.url, 'https://stac.example/search?fixed=1&key=k+v&n=2');
  assert.equal(post.body, params);
  const get = firstRequest('https://stac.example/search?limit=999', undefined, params, 'GET');
  assert.equal(get.body, undefined);
  const q = new URL(get.url).searchParams;
  assert.deepEqual([...q.keys()].sort(), ['bbox', 'collections', 'fields', 'flag', 'limit', 'query', 'sortby']);
  assert.equal(q.get('collections'), 'a,b');
  assert.equal(q.get('bbox'), '-158,21,-157,22');
  assert.equal(q.get('limit'), '10', 'the search’s own value replaces one written in the address');
  assert.equal(q.get('sortby'), '-properties.datetime,+id');
  assert.equal(q.get('fields'), 'id,geometry,-links');
  assert.equal(q.get('query'), '{"eo:cloud_cover":{"lt":20}}');
  assert.equal(q.get('flag'), 'true');

  const a = { method: 'POST' as const, url: 'https://stac.example/search', body: { token: 'p2' } };
  assert.equal(requestKey(a), requestKey({ ...a, body: { token: 'p2' } }));
  assert.notEqual(requestKey(a), requestKey({ ...a, body: { token: 'p3' } }));
  assert.notEqual(requestKey(a), requestKey({ ...a, method: 'GET' }));
  assert.notEqual(
    requestKey({ method: 'GET', url: 'https://stac.example/search?token=1' }),
    requestKey({ method: 'GET', url: 'https://stac.example/search?token=2' }),
  );
});

// ---- STAC static catalogue -------------------------------------------------------------

test('stacDocKind', () => {
  assert.equal(stacDocKind({ type: 'Feature' }), 'item');
  assert.equal(stacDocKind({ type: 'FeatureCollection', features: [] }), 'item-collection');
  assert.equal(stacDocKind({ type: 'FeatureCollection' }), 'unknown');
  assert.equal(stacDocKind({ type: 'Catalog' }), 'catalog');
  assert.equal(stacDocKind({ type: 'Collection' }), 'catalog');
  assert.equal(stacDocKind({ stac_version: '0.9.0', links: [] }), 'catalog', 'before 1.0 a catalogue had no type');
  for (const other of [
    null,
    [],
    'Catalog',
    {},
    { stac_version: '0.9.0' },
    { type: 'Topology' },
    { type: null, stac_version: '1.0.0', links: [] },
  ])
    assert.equal(stacDocKind(other), 'unknown', JSON.stringify(other));
});

test('walkStaticCatalog: depth first, items before folders, each address once, and every link not followed counted', async () => {
  const root = 'https://data.example/stac/catalog.json';
  const item = (id: string) => ({ type: 'Feature', id });
  const docs: Record<string, unknown> = {
    [root]: {
      type: 'Catalog',
      links: [
        { rel: 'self', href: root },
        { rel: 'child', href: 'a/collection.json' },
        { rel: 'item', href: 'top.json#frag' },
        { rel: 'child', href: 'https://elsewhere.example/catalog.json' },
        { rel: 'child', href: 'https://user:pw@data.example/stac/private.json' },
        { rel: 'child', href: 'broken/catalog.json' },
        { rel: 'child', href: 'notstac.json' },
        { rel: 'item', href: 5 },
        'junk',
      ],
    },
    'https://data.example/stac/top.json': item('top'),
    'https://data.example/stac/a/collection.json': {
      type: 'Collection',
      links: [
        { rel: 'item', href: 'one.json' },
        { rel: 'item', href: '../top.json' },
        { rel: 'items', href: 'items?page=1' },
        { rel: 'child', href: 'deep/catalog.json' },
        { rel: 'parent', href: '../catalog.json' },
      ],
    },
    'https://data.example/stac/a/one.json': item('one'),
    'https://data.example/stac/a/items?page=1': {
      type: 'FeatureCollection',
      features: [item('p1a'), item('p1b')],
      links: [{ rel: 'next', href: 'items?page=2' }],
    },
    'https://data.example/stac/a/items?page=2': {
      type: 'FeatureCollection',
      features: [item('p2')],
      links: [{ rel: 'next', href: 'items?page=1' }],
    },
    'https://data.example/stac/a/deep/catalog.json': {
      type: 'Catalog',
      links: [{ rel: 'item', href: 'too-deep.json' }],
    },
    'https://data.example/stac/notstac.json': { hello: 'world' },
  };
  const fetched: string[] = [];
  const fetchJson = async (url: string) => {
    fetched.push(url);
    if (url.includes('/broken/')) throw new ProviderError('HTTP_4XX', 'status 404', { retryable: false });
    if (!(url in docs)) throw new ProviderError('MALFORMED', `no ${url}`, { retryable: false });
    return docs[url];
  };
  const signal = new AbortController().signal;
  const walk = await walkStaticCatalog({ root, maxDepth: 2, maxDocuments: 100, signal, fetchJson });
  assert.deepEqual(
    walk.items.map((i) => (i.item as { id: string }).id),
    ['top', 'one', 'p1a', 'p1b', 'p2'],
  );
  assert.deepEqual(
    walk.items.map((i) => i.own === true),
    [true, true, false, false, false],
  );
  assert.equal(walk.items[2]!.base, 'https://data.example/stac/a/items?page=1');
  assert.equal(new Set(fetched).size, fetched.length, 'no address is fetched twice');
  assert.equal(walk.documents, fetched.length);
  assert.deepEqual(walk.notFollowed, { depth: 1, budget: 0, offOrigin: 2 });
  assert.deepEqual(walk.skipped.map((s) => s.url.replace('https://data.example/stac/', '')).sort(), [
    'broken/catalog.json',
    'notstac.json',
  ]);
  assert.ok(walk.skipped.every((s) => s.reason.length <= 160));

  const tight = await walkStaticCatalog({ root, maxDepth: 2, maxDocuments: 3, signal, fetchJson });
  assert.equal(tight.documents, 3);
  assert.ok(tight.notFollowed.budget >= 1);
  assert.ok(tight.items.length >= 1, 'a budget spent part-way still yields items');

  // The root failing, or not being STAC, is the source failing.
  await assert.rejects(
    walkStaticCatalog({
      root: 'https://data.example/stac/notstac.json',
      maxDepth: 2,
      maxDocuments: 10,
      signal,
      fetchJson,
    }),
    (e: unknown) => e instanceof ProviderError && e.code === 'MALFORMED',
  );
  await assert.rejects(
    walkStaticCatalog({
      root: 'https://data.example/stac/broken/catalog.json',
      maxDepth: 2,
      maxDocuments: 10,
      signal,
      fetchJson,
    }),
    (e: unknown) => e instanceof ProviderError && e.code === 'HTTP_4XX',
  );
  // A failure that means the source cannot be reached ends the walk wherever it happens.
  const offline = async (url: string) => {
    if (url !== root) throw new ProviderError('NETWORK', 'down');
    return docs[url];
  };
  await assert.rejects(
    walkStaticCatalog({ root, maxDepth: 2, maxDocuments: 10, signal, fetchJson: offline }),
    (e: unknown) => e instanceof ProviderError && e.code === 'NETWORK',
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    walkStaticCatalog({ root, maxDepth: 2, maxDocuments: 10, signal: aborted.signal, fetchJson }),
    (e: unknown) => e instanceof ProviderError && e.code === 'CANCELLED',
  );
});

// ---- OGC overlays ----------------------------------------------------------------------

test('frameBefore: the day before a date; for an instant, the one before it in the layer’s own steps', () => {
  assert.equal(frameBefore('2026-03-01', []), '2026-02-28');
  assert.equal(frameBefore('2024-03-01', []), '2024-02-29');
  assert.equal(frameBefore('2026-01-01', []), '2025-12-31');
  assert.equal(frameBefore('2026-13-01', []), undefined);
  const domain = ['2026-11-19T00:00:00Z/2026-11-19T12:00:00Z/PT10M'];
  assert.equal(frameBefore('2026-11-19T12:00:00Z', domain), '2026-11-19T11:50:00Z');
  assert.equal(frameBefore('2026-11-19T00:00:00Z', domain), undefined, 'nothing before the first');
  assert.equal(frameBefore('2026-11-19T11:55:00Z', domain), undefined, 'not one of its steps');
  assert.equal(frameBefore('2026-11-20T00:00:00Z', domain), undefined);
  assert.equal(
    frameBefore('2026-11-19T12:00:00Z', [
      undefined,
      'junk',
      '2026-11-19T00:00:00Z/2026-11-19T12:00:00Z/PT0M',
      ...domain,
    ]),
    '2026-11-19T11:50:00Z',
  );
  assert.equal(frameBefore('not a time', domain), undefined);
});

test('overlay names, ids and roles', () => {
  assert.equal(overlayName('  Radar  ', 'fallback'), 'Radar');
  assert.equal(overlayName('   ', 'fallback'), 'fallback');
  assert.equal(overlayName(undefined, 'fallback'), 'fallback');
  assert.equal(overlayName('x'.repeat(200), 'f').length, 200);
  const cut = overlayName('x'.repeat(198) + '\u{1F30B}\u{1F30B}', 'f');
  assert.ok(cut.length <= 200 && cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), 'no half of a pair is left at the cut');

  assert.equal(
    overlayIdFor('gibs', 'MODIS_Terra_CorrectedReflectance_TrueColor'),
    'gibs:modis_terra_correctedreflectance_truecolor',
  );
  assert.equal(overlayIdFor('d', '  Radar (base) / 1km  '), 'd:radar-base-1km');
  assert.equal(overlayIdFor('d', '--a--b--'), 'd:a--b');
  assert.equal(overlayIdFor('d', '雨雲'), 'd:layer');
  assert.equal(overlayIdFor('d', ''), 'd:layer');
  assert.equal(overlayIdFor('d', '---'), 'd:layer');
  assert.equal(overlayIdFor('d', 'x'.repeat(500)).length, 128);
  const started = Date.now();
  assert.equal(overlayIdFor('d', `a${'-'.repeat(200_000)}b`).length, 128);
  assert.equal(overlayIdFor('d', `${'-'.repeat(200_000)}b${'-'.repeat(200_000)}`), 'd:b');
  assert.ok(Date.now() - started < 500, 'a long run of hyphens costs nothing');

  assert.equal(overlayRole(def({ query: { role: 'basemap' } })), 'basemap');
  assert.equal(overlayRole(def({ query: { role: 'overlay' } })), 'overlay');
  for (const other of [def({ query: { role: 'Basemap' } }), def({ query: {} }), def({}), def(undefined)])
    assert.equal(overlayRole(other), undefined);
});

// ---- mappings --------------------------------------------------------------------------

test('propertyName and placedMapping', () => {
  assert.equal(propertyName('properties.name'), 'name');
  assert.equal(propertyName({ path: 'properties.OBJECTID' } as Parameters<typeof propertyName>[0]), 'OBJECTID');
  assert.equal(propertyName('properties["Site Name"]'), 'Site Name');
  for (const other of [
    undefined,
    '',
    'name',
    'properties',
    'properties.a.b',
    'geometry.type',
    'properties[0]',
    'properties.[',
    'attributes.name',
  ])
    assert.equal(propertyName(other as Parameters<typeof propertyName>[0]), undefined, String(other));

  const mapping = {
    externalId: 'id',
    geometry: 'geometry',
    position: { lat: 'lat', lon: 'lon' },
    labels: { name: 'name' },
  } as unknown as MappingSpec;
  const placed = placedMapping(mapping);
  assert.deepEqual(placed.position, { lat: '_position.lat', lon: '_position.lon' });
  assert.ok(!('geometry' in placed));
  assert.deepEqual([placed.externalId, placed.labels], [mapping.externalId, mapping.labels]);
  assert.ok('geometry' in mapping, 'the mapping given is not written to');
});

// ---- files -----------------------------------------------------------------------------

test('formatOf: what the definition names, else what the extension implies, and no format from a name every object has', () => {
  assert.equal(formatOf({ path: 'x' }, 'tracks/day.GPX'), 'gpx');
  assert.equal(formatOf({ path: 'x' }, 'a.geojson'), 'geojson');
  assert.equal(formatOf({ path: 'x' }, 'a.json'), 'json');
  assert.equal(formatOf({ path: 'x' }, 'a.tsv'), 'csv');
  assert.equal(formatOf({ path: 'x' }, 'a.txt'), 'csv');
  assert.equal(formatOf({ path: 'x', format: 'kml' }, 'a.txt'), 'kml');
  for (const path of ['a.constructor', 'a.toString', 'a.__proto__', 'a.hasOwnProperty', 'a.shp', 'noextension', 'a.'])
    assert.equal(formatOf({ path: 'x' }, path), undefined, path);
  for (const f of ['geojson', 'csv', 'gpx', 'kml', 'topojson']) assert.equal(isFileFormat(f), true, f);
  for (const f of ['json', 'GPX', '', 'constructor', 5, null, undefined])
    assert.equal(isFileFormat(f), false, String(f));
});

test('datedByFile: an observation timed by when it was fetched is timed by its file instead', () => {
  const mtime = Date.parse('2026-11-01T08:00:00Z');
  const fetched = {
    id: 'p:x:2026-11-19T10:00:00.000Z',
    providerId: 'p',
    externalId: 'x',
    observedAt: '2026-11-19T10:00:00.000Z',
    quality: { flags: ['fetch-time', 'other'] },
  };
  const own = {
    id: 'p:y:2026-10-01T00:00:00.000Z',
    providerId: 'p',
    externalId: 'y',
    observedAt: '2026-10-01T00:00:00.000Z',
    quality: { flags: ['other'] },
  };
  const bare = { id: 'p:z:t', providerId: 'p', externalId: 'z', observedAt: 't', quality: {} };
  const out = datedByFile([fetched, own, bare] as unknown as Observation[], mtime);
  assert.equal(out[0]!.observedAt, '2026-11-01T08:00:00.000Z');
  assert.equal(out[0]!.id, 'p:x:2026-11-01T08:00:00.000Z');
  assert.deepEqual(out[0]!.quality.flags, [FILE_TIME_FLAG, 'other']);
  assert.equal(out[1], own);
  assert.equal(out[2], bare);
  assert.deepEqual(fetched.quality.flags, ['fetch-time', 'other'], 'the observation given is not written to');
});

test('TopoJSON: arcs joined and reversed, quantized arcs decoded, and what is wrong said', () => {
  const topology = {
    type: 'Topology',
    arcs: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      [
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
    objects: {
      shapes: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', id: 'square', arcs: [[0, 1]], properties: { name: 'Square' } },
          { type: 'LineString', arcs: [~1, ~0] },
          { type: 'Point', coordinates: [5, 6] },
          {
            type: 'MultiPoint',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
          { type: null },
          { type: 'LineString', arcs: [9] },
          { type: 'Polygon', arcs: [[0]] },
          { type: 'Circle' },
        ],
      },
      other: { type: 'Point', coordinates: [7, 8] },
    },
  };
  const read = readTopologyDocument(topology);
  assert.ok(!('malformed' in read));
  if ('malformed' in read) return;
  assert.deepEqual(
    read.features.map((f) => [f.id, f.kind, f.geometry?.type]),
    [
      ['square', 'shapes', 'Polygon'],
      ['shapes-2', 'shapes', 'LineString'],
      ['shapes-3', 'shapes', 'Point'],
      ['shapes-4', 'shapes', 'MultiPoint'],
      ['other-1', 'other', 'Point'],
    ],
  );
  assert.deepEqual((read.features[0]!.geometry as { coordinates: number[][][] }).coordinates, [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ]);
  assert.deepEqual(
    (read.features[1]!.geometry as { coordinates: number[][] }).coordinates,
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ],
    'the same ring walked the other way',
  );
  assert.deepEqual(read.features[0]!.properties, { name: 'Square' });
  assert.deepEqual(
    read.skipped.map((s) => s.reason.replace(/"/g, '')),
    [
      'the geometry is null',
      'arc 9 does not exist',
      'a ring has fewer than four positions',
      'unsupported geometry type Circle',
    ],
  );

  const only = readTopologyDocument(topology, { layers: ['other'] });
  assert.ok(!('malformed' in only) && only.features.length === 1 && only.features[0]!.id === 'other-1');
  const missing = readTopologyDocument(topology, { layers: ['nope', 'constructor'] });
  assert.ok(
    'malformed' in missing && /no object named nope, constructor \(it has shapes, other\)/.test(missing.malformed),
  );

  // Quantized: arc positions are deltas, points are not.
  const quantized = readTopologyDocument({
    type: 'Topology',
    transform: { scale: [0.5, 0.25], translate: [-158, 21] },
    arcs: [
      [
        [0, 0],
        [2, 4],
        [2, 0],
      ],
    ],
    objects: { l: { type: 'LineString', arcs: [0] }, p: { type: 'Point', coordinates: [4, 4] } },
  });
  assert.ok(!('malformed' in quantized));
  if ('malformed' in quantized) return;
  assert.deepEqual((quantized.features[0]!.geometry as { coordinates: number[][] }).coordinates, [
    [-158, 21],
    [-157, 22],
    [-156, 22],
  ]);
  assert.deepEqual((quantized.features[1]!.geometry as { coordinates: number[] }).coordinates, [-156, 22]);

  const projected = readTopologyDocument({
    type: 'Topology',
    arcs: [
      [
        [500_000, 4_000_000],
        [500_100, 4_000_100],
      ],
    ],
    objects: { l: { type: 'LineString', arcs: [0] } },
  });
  assert.ok(
    !('malformed' in projected) &&
      projected.features.length === 0 &&
      /projected topology/.test(projected.skipped[0]!.reason),
  );

  for (const [doc, why] of [
    [null, /no "type": "Topology"/],
    [{ type: 'FeatureCollection' }, /no "type": "Topology"/],
    [{ type: 'Topology' }, /"objects" is not an object/],
    [{ type: 'Topology', objects: {}, arcs: 5 }, /"arcs" is not an array/],
    [{ type: 'Topology', objects: {}, transform: { scale: [1], translate: [0, 0] } }, /transform/],
    [{ type: 'Topology', objects: {}, arcs: [[[1, 'a']]] }, /arc 0 position 0/],
    [{ type: 'Topology', objects: {}, arcs: ['x'] }, /arc 0 is not an array/],
  ] as Array<[unknown, RegExp]>) {
    const bad = readTopologyDocument(doc);
    assert.ok('malformed' in bad && why.test(bad.malformed), JSON.stringify(doc));
  }
  const nested = (depth: number): unknown =>
    depth ? { type: 'GeometryCollection', geometries: [nested(depth - 1)] } : { type: 'Point', coordinates: [0, 0] };
  assert.ok(!('malformed' in readTopologyDocument({ type: 'Topology', objects: { n: nested(8) } })));
  assert.ok('malformed' in readTopologyDocument({ type: 'Topology', objects: { n: nested(12) } }));
  assert.ok('malformed' in readTopoJson('{ not json'));
  assert.ok(!('malformed' in readTopoJson('\uFEFF{"type":"Topology","objects":{}}')));
});

test('TopoJSON: a small file whose shapes all name one long arc is refused, not written out', () => {
  const arc = Array.from({ length: 50_000 }, (_, i) => [(i % 360) - 180, ((i * 7) % 180) - 90]);
  const geometries = Array.from({ length: 20_000 }, () => ({ type: 'LineString', arcs: [0] }));
  const text = JSON.stringify({
    type: 'Topology',
    arcs: [arc],
    objects: { all: { type: 'GeometryCollection', geometries } },
  });
  assert.ok(text.length < 2_000_000, 'under two megabytes of file');
  const started = Date.now();
  const read = readTopoJson(text);
  const took = Date.now() - started;
  assert.ok(
    'malformed' in read && read.malformed.includes(String(MAX_TOPOLOGY_POSITIONS)),
    JSON.stringify(read).slice(0, 200),
  );
  assert.ok(took < 5000, `${took} ms`);
  // A topology of honest size is read whole.
  const honest = readTopologyDocument({
    type: 'Topology',
    arcs: [arc],
    objects: { all: { type: 'GeometryCollection', geometries: geometries.slice(0, 30) } },
  });
  assert.ok(!('malformed' in honest) && honest.features.length === 30);
});
