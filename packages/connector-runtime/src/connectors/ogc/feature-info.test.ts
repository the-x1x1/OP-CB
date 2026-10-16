import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing, type ProviderHttpRequest } from '@worldview/provider-sdk';
import { defaultConnectorRegistry } from '../../registry.js';
import { featureInfoUrl, parseFeatureInfo, pickFeatureInfoFormat, queryBox } from './feature-info.js';
import { parseWmsCapabilities } from './capabilities.js';
import type { WmsProvider } from './wms.js';

/**
 * WMS GetFeatureInfo for What's here (feature-info.ts, WmsProvider.overlayValue). The answers
 * under fixtures/connectors/hazards/nowcoast-radar-getfeatureinfo* were recorded from nowCOAST
 * by the built-in browser on the operator's laptop (see that folder's README).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const RADAR = JSON.parse(read('connectors/enabled/nowcoast-radar.json')) as Record<string, unknown>;
const CAPS = read('fixtures/connectors/hazards/nowcoast-radar-wms130-capabilities.xml');
const ANSWER = read('fixtures/connectors/hazards/nowcoast-radar-getfeatureinfo.json');
const EMPTY = read('fixtures/connectors/hazards/nowcoast-radar-getfeatureinfo-empty.json');
const PLAIN = read('fixtures/connectors/hazards/nowcoast-radar-getfeatureinfo.txt');
const NOW = Date.parse('2026-09-27T21:38:00.000Z');
const HONOLULU = { latitude: 21.3069, longitude: -157.8583 };
const OKLAHOMA_CITY = { latitude: 35.4676, longitude: -97.5164 };

const params = (url: string) => {
  const u = new URL(url);
  const out: Record<string, string> = {};
  for (const [k, v] of u.searchParams) out[k.toUpperCase()] = v;
  return out;
};

test('the capabilities give the GetFeatureInfo formats', () => {
  const caps = parseWmsCapabilities(CAPS);
  assert.ok('layers' in caps);
  assert.deepEqual(caps.getFeatureInfoFormats, ['text/plain', 'application/json', 'text/html']);
});

test('the format asked for is JSON first, then plain text, never HTML or GML', () => {
  assert.equal(pickFeatureInfoFormat(['text/html', 'text/plain', 'application/json']), 'application/json');
  assert.equal(pickFeatureInfoFormat(['text/html', 'application/geo+json']), 'application/geo+json');
  assert.equal(pickFeatureInfoFormat(['TEXT/PLAIN; charset=UTF-8', 'text/html']), 'text/plain');
  assert.equal(pickFeatureInfoFormat(['text/html', 'application/vnd.ogc.gml']), undefined);
  assert.equal(pickFeatureInfoFormat([]), undefined);
});

test('the query box is centred on the point, in the axis order each CRS and version uses', () => {
  const p = { latitude: 20, longitude: -155 };
  assert.deepEqual(queryBox('1.3.0', ['EPSG:4326', 'CRS:84'], p), {
    crs: 'CRS:84',
    bbox: [-155.005, 19.995, -154.995, 20.005],
  });
  // 1.3.0's EPSG:4326 is latitude first.
  assert.deepEqual(queryBox('1.3.0', ['EPSG:4326'], p), {
    crs: 'EPSG:4326',
    bbox: [19.995, -155.005, 20.005, -154.995],
  });
  // 1.1.1's is longitude first.
  assert.deepEqual(queryBox('1.1.1', ['EPSG:4326'], p), {
    crs: 'EPSG:4326',
    bbox: [-155.005, 19.995, -154.995, 20.005],
  });
  const mercator = queryBox('1.3.0', ['EPSG:3857'], { latitude: 0, longitude: 0 });
  assert.equal(mercator?.crs, 'EPSG:3857');
  assert.deepEqual(
    mercator?.bbox.map((n) => Math.round(n)),
    [-550, -550, 550, 550],
  );
  assert.equal(queryBox('1.3.0', ['EPSG:3857'], { latitude: 88, longitude: 0 }), undefined, 'beyond Web Mercator');
  assert.equal(queryBox('1.3.0', ['EPSG:32604'], p), undefined, 'a CRS the box cannot be written in');
  // At the antimeridian the box stays inside ±180, so the point stays its middle pixel's side.
  const edge = queryBox('1.3.0', ['CRS:84'], { latitude: 0, longitude: 180 });
  assert.ok(edge && edge.bbox[2] <= 180);
});

test('the GetFeatureInfo URL carries the layer, the middle pixel, the format, TIME and vendor parameters', () => {
  const url = featureInfoUrl({
    base: 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms',
    version: '1.3.0',
    layers: ['conus_base_reflectivity_mosaic'],
    styles: ['weather_radar_base_reflectivity'],
    crs: ['EPSG:4326', 'CRS:84'],
    format: 'application/json',
    parameters: { TIME: '2026-09-27T21:36:00Z', dim_band: '1' },
    position: OKLAHOMA_CITY,
  });
  assert.ok(url);
  assert.ok(url.startsWith('https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms?'));
  const q = params(url);
  assert.equal(q['REQUEST'], 'GetFeatureInfo');
  assert.equal(q['LAYERS'], 'conus_base_reflectivity_mosaic');
  assert.equal(q['QUERY_LAYERS'], 'conus_base_reflectivity_mosaic');
  assert.equal(q['STYLES'], 'weather_radar_base_reflectivity');
  assert.equal(q['CRS'], 'CRS:84');
  assert.equal(q['I'], '50');
  assert.equal(q['J'], '50');
  assert.equal(q['WIDTH'], '101');
  assert.equal(q['INFO_FORMAT'], 'application/json');
  assert.equal(q['FEATURE_COUNT'], '1');
  assert.equal(q['TIME'], '2026-09-27T21:36:00Z');
  assert.equal(q['DIM_BAND'], '1');
  const [w, s, e, n] = q['BBOX']!.split(',').map(Number);
  assert.ok(Math.abs((w! + e!) / 2 - OKLAHOMA_CITY.longitude) < 1e-6);
  assert.ok(Math.abs((s! + n!) / 2 - OKLAHOMA_CITY.latitude) < 1e-6);
  const v111 = params(
    featureInfoUrl({
      base: 'https://example.org/wms',
      version: '1.1.1',
      layers: ['a', 'b'],
      crs: ['EPSG:4326'],
      format: 'text/plain',
      parameters: {},
      position: OKLAHOMA_CITY,
    })!,
  );
  assert.equal(v111['SRS'], 'EPSG:4326');
  assert.equal(v111['X'], '50');
  assert.equal(v111['Y'], '50');
  assert.equal(v111['QUERY_LAYERS'], 'a,b');
});

test('a GeoJSON answer gives the first feature’s scalar properties in order; NaN, null and nesting are left out', () => {
  assert.deepEqual(parseFeatureInfo(ANSWER, 'application/json'), [{ name: 'Band1', value: 35 }]);
  assert.deepEqual(parseFeatureInfo(EMPTY, 'application/json'), []);
  const mixed = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { band: 'NaN', name: 'Cell 4', flag: true, empty: '', none: null, nested: { a: 1 }, list: [1] },
      },
      { type: 'Feature', properties: { second: 1 } },
    ],
  });
  assert.deepEqual(parseFeatureInfo(mixed, 'application/geo+json'), [
    { name: 'name', value: 'Cell 4' },
    { name: 'flag', value: 'true' },
  ]);
  assert.deepEqual(parseFeatureInfo('not json', 'application/json'), []);
  assert.deepEqual(
    parseFeatureInfo('<?xml version="1.0"?><ServiceExceptionReport/>', 'application/json'),
    [],
    'an exception',
  );
});

test('a plain-text answer gives the first feature’s name = value lines; numbers stay numbers', () => {
  assert.deepEqual(parseFeatureInfo(PLAIN, 'text/plain'), [{ name: 'Band1', value: 35 }]);
  const two = [
    "Results for FeatureType 'x':",
    '----',
    'GRAY_INDEX = NaN',
    'label = 1 Main St',
    'code = 07A',
    '----',
    'GRAY_INDEX = 4',
    '----',
  ].join('\n');
  assert.deepEqual(parseFeatureInfo(two, 'text/plain'), [
    { name: 'label', value: '1 Main St' },
    { name: 'code', value: '07A' },
  ]);
  assert.deepEqual(parseFeatureInfo('no features were found', 'text/plain'), []);
});

async function radar(responder: testing.FixtureResponder) {
  const v = defaultConnectorRegistry.validate(RADAR);
  assert.ok(v.ok && v.definition, v.errors.join('; '));
  const provider = defaultConnectorRegistry.createProvider(v.definition!) as WmsProvider;
  const ctx = testing.createFixtureContext({
    providerId: v.definition!.id,
    clock: new testing.VirtualClock(NOW),
    responder,
  });
  await provider.initialize(ctx);
  await provider.start();
  return { provider, ctx };
}

const isCaps = (req: ProviderHttpRequest) => /REQUEST=GetCapabilities/i.test(req.url);

test('the shipped radar answers What’s here with one GetFeatureInfo for the frame it draws', async () => {
  const { provider, ctx } = await radar((req) =>
    isCaps(req) ? { status: 200, body: CAPS } : { status: 200, body: ANSWER },
  );
  const [overlay] = await provider.overlays();
  assert.ok(overlay && overlay.kind === 'wms');
  const answer = await provider.overlayValue({
    overlayId: overlay.id,
    position: OKLAHOMA_CITY,
    signal: new AbortController().signal,
  });
  assert.ok(answer);
  assert.equal(answer.label, overlay.name);
  // The service says Band1; the definition says what it is (valueNames, valueUnits).
  assert.deepEqual(answer.values, [{ name: 'Reflectivity', value: 35, unit: 'dBZ' }]);
  assert.equal(answer.attribution, 'Radar: NOAA nowCOAST, NWS/OAR MRMS');
  assert.equal(answer.frame, overlay.frame);
  const asked = ctx.http.requests.filter((r) => !isCaps(r));
  assert.equal(asked.length, 1);
  const q = params(asked[0]!.url);
  assert.equal(asked[0]!.url.split('?')[0], 'https://nowcoast.noaa.gov/geoserver/observations/weather_radar/wms');
  assert.equal(q['INFO_FORMAT'], 'application/json');
  assert.equal(q['TIME'], overlay.frame, 'the frame being drawn');
  assert.equal(q['STYLES'], 'weather_radar_base_reflectivity');
  assert.ok((asked[0]!.maxBytes ?? Infinity) <= 64 * 1024);
  assert.equal(q['VALUENAMES'], undefined, "the names are the definition's, never sent");
  assert.ok(!/valuenames|valueunits/i.test(JSON.stringify(overlay)), 'nor put in the tile requests');
});

test('nothing there, an error status (a throw), or a service that offers no format it reads: no answer', async () => {
  const empty = await radar((req) => (isCaps(req) ? { status: 200, body: CAPS } : { status: 200, body: EMPTY }));
  const [o] = await empty.provider.overlays();
  const ask = (p: WmsProvider) =>
    p.overlayValue({ overlayId: o!.id, position: HONOLULU, signal: new AbortController().signal });
  assert.equal(await ask(empty.provider), undefined);

  // An error status throws, as the SDK allows: the host logs it and answers nothing.
  const failing = await radar((req) => (isCaps(req) ? { status: 200, body: CAPS } : { status: 400, body: '' }));
  await failing.provider.overlays();
  await assert.rejects(ask(failing.provider), /HTTP 400/);

  const htmlOnly = CAPS.replace(/<GetFeatureInfo>[\s\S]*?<\/GetFeatureInfo>/, (block) =>
    block.replace(/<Format>(?:text\/plain|application\/json)<\/Format>\s*/g, ''),
  );
  assert.notEqual(htmlOnly, CAPS);
  const html = await radar((req) => (isCaps(req) ? { status: 200, body: htmlOnly } : { status: 200, body: ANSWER }));
  await html.provider.overlays();
  assert.equal(await ask(html.provider), undefined);
  assert.equal(html.ctx.http.requests.filter((r) => !isCaps(r)).length, 0, 'not asked at all');

  const unqueryable = await radar((req) =>
    isCaps(req)
      ? { status: 200, body: CAPS.replace(/queryable="1"/g, 'queryable="0"') }
      : { status: 200, body: ANSWER },
  );
  await unqueryable.provider.overlays();
  assert.equal(await ask(unqueryable.provider), undefined);
  assert.equal(unqueryable.ctx.http.requests.filter((r) => !isCaps(r)).length, 0);
});

test('before the capabilities are read there is nothing to ask', async () => {
  const { provider, ctx } = await radar(() => ({ status: 200, body: ANSWER }));
  const answer = await provider.overlayValue({
    overlayId: 'nowcoast-radar:x',
    position: HONOLULU,
    signal: new AbortController().signal,
  });
  assert.equal(answer, undefined);
  assert.equal(ctx.http.requests.length, 0);
});

test('valueNames and valueUnits: name=text pairs, checked', () => {
  const with_ = (query: Record<string, unknown>) =>
    defaultConnectorRegistry.validate({ ...RADAR, endpoint: { ...(RADAR['endpoint'] as object), query } });
  const base = (RADAR['endpoint'] as { query: Record<string, unknown> }).query;
  assert.ok(with_({ ...base, valueNames: 'Band1=Reflectivity,Band2=Echo top' }).ok);
  const bad = with_({ ...base, valueUnits: 'dBZ' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /valueUnits "dBZ" is not name=text pairs/);
  assert.ok(with_(base).ok);
});
