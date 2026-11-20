import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, coordinate, isoTime, lengthMetres, lineGeometry, MAX_DESCRIPTION_CHARS } from './files/features.js';
import { parseKmlCoordinates } from './files/kml.js';
import * as fileXml from './files/xml.js';
import {
  KvpParams,
  clipExtent,
  hostOf,
  isTimeValue,
  joinUrl,
  latestTime,
  newestInstant,
  numberSetting,
  originOf,
  parseExtent,
  parseFadeBelow,
  parseOpacity,
  previousInstant,
  readFeatureCollection,
  refuseAdvertisedUrl,
  splitEndpoint,
  stringSetting,
} from './ogc/common.js';
import * as ogcXml from './ogc/xml.js';

// ---- file features ---------------------------------------------------------------------

test('clip: text over the limit ends in an ellipsis within the limit, never through half a character', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip('exactly10!', 10), 'exactly10!');
  assert.equal(clip('eleven chars', 10), 'eleven ch…');
  assert.equal(clip(undefined), undefined);
  assert.equal(clip('x'.repeat(MAX_DESCRIPTION_CHARS + 5))!.length, MAX_DESCRIPTION_CHARS);
  // An emoji is two units: cut before it, not through it.
  const cut = clip(`abc\u{1F30B}def`, 5)!;
  assert.equal(cut, 'abc…');
  assert.ok(!/[\ud800-\udbff]$/.test(cut.slice(0, -1)));
  assert.equal(clip(`ab\u{1F30B}def`, 5), 'ab\u{1F30B}…');
  assert.equal(clip('abc', 1), '…');
});

test('coordinate: a longitude and latitude on the Earth, with an altitude only when it is a sane number', () => {
  assert.deepEqual(coordinate(-157.8, 21.3), [-157.8, 21.3]);
  assert.deepEqual(coordinate(180, -90, 0), [180, -90, 0]);
  assert.deepEqual(coordinate(0, 0, 8848.9), [0, 0, 8848.9]);
  assert.deepEqual(coordinate(0, 0, Number.NaN), [0, 0]);
  assert.deepEqual(coordinate(0, 0, 1e9), [0, 0], 'an absurd altitude is dropped, the point kept');
  for (const [lon, lat] of [
    [180.0001, 0],
    [-181, 0],
    [0, 90.0001],
    [0, -91],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ] as const)
    assert.equal(coordinate(lon, lat), undefined, `${lon},${lat}`);
});

test('isoTime: a file time as UTC unless it says otherwise; a date alone is midnight; what is not a time is nothing', () => {
  const cases: Array<[string, string | undefined]> = [
    ['2026-09-23T10:00:00Z', '2026-09-23T10:00:00.000Z'],
    ['2026-09-23T10:00:00', '2026-09-23T10:00:00.000Z'],
    ['2026-09-23 10:00', '2026-09-23T10:00:00.000Z'],
    ['2026-09-23T10:00:00.123456789Z', '2026-09-23T10:00:00.123Z'],
    ['2026-09-23T10:00:00+02:00', '2026-09-23T08:00:00.000Z'],
    ['2026-09-23T10:00:00-1000', '2026-09-23T20:00:00.000Z'],
    ['  2026-09-23  ', '2026-09-23T00:00:00.000Z'],
    ['2026-09', '2026-09-01T00:00:00.000Z'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2026-02-29', undefined],
    ['2026-02-30T10:00:00Z', undefined],
    ['2026-04-31', undefined],
    ['2026-13-01', undefined],
    ['2026-00-10', undefined],
    ['2026-09-23T25:00:00Z', undefined],
    ['23/09/2026', undefined],
    ['September 23, 2026', undefined],
    ['1758621600', undefined],
    ['', undefined],
  ];
  for (const [text, want] of cases) assert.equal(isoTime(text), want, text);
  assert.equal(isoTime(undefined), undefined);
});

test('lengthMetres and lineGeometry', () => {
  assert.equal(lengthMetres([]), 0);
  assert.equal(lengthMetres([[0, 0]]), 0);
  const degree = lengthMetres([
    [0, 0],
    [1, 0],
  ]);
  assert.ok(Math.abs(degree - 111_195) < 5, `one degree of the equator is ${degree}`);
  assert.ok(
    Math.abs(
      lengthMetres([
        [0, 0],
        [0, 1],
        [0, 2],
      ]) -
        2 * degree,
    ) < 1,
  );
  assert.ok(
    Math.abs(
      lengthMetres([
        [179.5, 0],
        [-179.5, 0],
      ]) - degree,
    ) < 5,
    'across 180°, the short way',
  );
  assert.ok(
    Math.abs(
      lengthMetres([
        [0, 0],
        [180, 0],
      ]) -
        Math.PI * 6_371_008.8,
    ) < 1,
    'half way round',
  );
  const a: [number, number] = [0, 0];
  const b: [number, number] = [1, 1];
  assert.deepEqual(lineGeometry([[a, b]]), { type: 'LineString', coordinates: [a, b] });
  assert.deepEqual(
    lineGeometry([
      [a, b],
      [b, a],
    ]),
    {
      type: 'MultiLineString',
      coordinates: [
        [a, b],
        [b, a],
      ],
    },
  );
  assert.deepEqual(
    lineGeometry([[a], [a, b]]),
    { type: 'LineString', coordinates: [a, b] },
    'a lone point beside a line is left out',
  );
  assert.deepEqual(lineGeometry([[a]]), { type: 'Point', coordinates: a });
  assert.equal(lineGeometry([]), undefined);
  assert.equal(lineGeometry([[]]), undefined);
});

// ---- the two XML readers ---------------------------------------------------------------

test('file XML: prefixes dropped, entities and CDATA read, sloppy markup tolerated, a DOCTYPE never interpreted', () => {
  const doc = fileXml.parseXml(
    '﻿<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<gpx xmlns:gx="urn:x" version=1.1><!-- note --><wpt lat="21.3" LON=\'-157.8\'><name>Hale &amp; &xxe; <![CDATA[<b>Kai</b>]]></name>' +
      '<gx:Track id="t&#49;"/><desc>  </desc></wpt><trk><name>One</name><trkseg><trkpt lat="1" lon="2"></trkseg></trk></stray></gpx><second/>',
  );
  assert.ok('root' in doc);
  if (!('root' in doc)) return;
  const { root } = doc;
  assert.equal(root.name, 'gpx');
  assert.equal(root.attrs['version'], '1.1');
  assert.equal('gx' in root.attrs, false, 'namespace declarations are not attributes');
  const wpt = fileXml.child(root, 'WPT')!;
  assert.deepEqual([wpt.attrs['lat'], wpt.attrs['LON']], ['21.3', '-157.8']);
  assert.equal(
    fileXml.childText(wpt, 'name'),
    'Hale & &xxe; <b>Kai</b>',
    'an entity the file declares is left as written',
  );
  assert.equal(fileXml.childText(wpt, 'desc'), undefined, 'blank text is no text');
  assert.equal(fileXml.childText(wpt, 'missing'), undefined);
  const track = fileXml.child(wpt, 'track')!;
  assert.deepEqual([track.name, track.qname, track.attrs['id']], ['Track', 'gx:Track', 't1']);
  assert.equal(fileXml.childrenNamed(root, 'trk').length, 1);
  assert.deepEqual(
    fileXml.descendants(root, 'name').map((n) => n.text.trim()),
    ['Hale & &xxe; <b>Kai</b>', 'One'],
  );
  assert.equal(fileXml.descendants(root, 'trkpt').length, 1, 'an element left open is closed by its parent');
  assert.equal(fileXml.descendants(root, 'second').length, 0, 'a second root is ignored');
});

test('file XML: what cannot be read safely is malformed, with the reason, and the limits hold', () => {
  const why = (text: string, opts?: fileXml.XmlOptions) => {
    const r = fileXml.parseXml(text, opts);
    return 'malformed' in r ? r.malformed : 'ok';
  };
  assert.match(why(''), /no root element/);
  assert.match(why('just text'), /no root element/);
  assert.match(why('<a><!-- never'), /comment never closes/);
  assert.match(why('<a><![CDATA[ never'), /CDATA section never closes/);
  assert.match(why('<?xml never'), /processing instruction never closes/);
  assert.match(why('<!DOCTYPE a [ never'), /declaration never closes/);
  assert.match(why('<a></a'), /end tag never closes/);
  assert.match(why('<a b="never'), /never closes/);
  assert.match(why('<a>'.repeat(10), { maxDepth: 5 }), /nested deeper than 5/);
  assert.match(why(`<r>${'<a/>'.repeat(10)}</r>`, { maxElements: 5 }), /more than 5 elements/);
  assert.equal(why('<a>'.repeat(5), { maxDepth: 5 }), 'ok');
  assert.equal(why('<r/>'), 'ok');
});

test('declaredEncoding: what the XML declaration names, lower case', () => {
  assert.equal(fileXml.declaredEncoding('<?xml version="1.0" encoding="ISO-8859-1"?><a/>'), 'iso-8859-1');
  assert.equal(fileXml.declaredEncoding("  <?xml version='1.0' encoding = 'UTF-8' ?>"), 'utf-8');
  assert.equal(fileXml.declaredEncoding('<?xml version="1.0"?>'), undefined);
  assert.equal(fileXml.declaredEncoding('<a encoding="x"/>'), undefined);
  assert.equal(fileXml.declaredEncoding('<?xml encoding="bad name!"?>'), undefined);
  assert.equal(fileXml.declaredEncoding(''), undefined);
});

test('OGC XML: names with their prefix apart, the tree readers, numbers, links and exception reports', () => {
  const doc = ogcXml.scanXml(
    '﻿  <?xml version="1.0"?><wms:WMS_Capabilities xmlns:wms="urn:x" version="1.3.0"><wms:Capability>' +
      '<wms:Request><wms:GetMap><wms:Format>image/png</wms:Format><wms:DCPType><wms:HTTP><wms:Get>' +
      '<wms:OnlineResource xlink:href=" https://maps.example/wms? "/></wms:Get></wms:HTTP></wms:DCPType></wms:GetMap></wms:Request>' +
      '<wms:Layer><wms:Title> Outer &amp; all </wms:Title><wms:Layer><wms:Name>inner</wms:Name><wms:Layer><wms:Name>deepest</wms:Name></wms:Layer></wms:Layer></wms:Layer>' +
      '</wms:Capability></wms:WMS_Capabilities>',
  );
  assert.ok('root' in doc);
  if (!('root' in doc)) return;
  const { root } = doc;
  assert.deepEqual([root.name, root.prefix, root.attrs['version']], ['WMS_Capabilities', 'wms', '1.3.0']);
  const getMap = ogcXml.at(root, 'Capability', 'Request', 'GetMap');
  assert.equal(ogcXml.childText(getMap, 'Format'), 'image/png');
  assert.equal(ogcXml.hrefIn(getMap), 'https://maps.example/wms?');
  assert.equal(ogcXml.at(root, 'Capability', 'Missing', 'GetMap'), undefined);
  assert.equal(ogcXml.child(root, 'capability'), undefined, 'names are case-sensitive, as XML is');
  const layers = ogcXml.descendants(root, 'Layer');
  assert.equal(layers.length, 3, 'nested layers are all found');
  assert.equal(ogcXml.textOf(ogcXml.child(layers[0], 'Title')), 'Outer & all');
  assert.equal(ogcXml.childrenNamed(layers[0], 'Layer').length, 1);
  assert.deepEqual(ogcXml.childrenNamed(undefined, 'Layer'), []);
  assert.deepEqual(ogcXml.descendants(undefined, 'Layer'), []);
  assert.equal(ogcXml.textOf(undefined), undefined);
  assert.equal(ogcXml.hrefIn(undefined), undefined);
  assert.equal(ogcXml.exceptionMessage(root), undefined);

  assert.equal(ogcXml.numberOf(' 12.5 '), 12.5);
  assert.equal(ogcXml.numberOf('-0'), -0);
  assert.equal(ogcXml.numberOf('1e3'), 1000);
  for (const bad of [undefined, 'abc', '12px', 'Infinity', 'NaN'])
    assert.equal(ogcXml.numberOf(bad), undefined, String(bad));

  const report = ogcXml.scanXml(
    '<ServiceExceptionReport><ServiceException code="LayerNotDefined"> no such\n layer </ServiceException><ServiceException code="Other"/></ServiceExceptionReport>',
  );
  assert.ok('root' in report && /LayerNotDefined: no such layer/.test(ogcXml.exceptionMessage(report.root) ?? ''));
  const ows = ogcXml.scanXml(
    '<ows:ExceptionReport><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>bad bbox</ows:ExceptionText></ows:Exception></ows:ExceptionReport>',
  );
  assert.ok('root' in ows && /bad bbox/.test(ogcXml.exceptionMessage(ows.root) ?? ''));

  const why = (text: string) => {
    const r = ogcXml.scanXml(text);
    return 'malformed' in r ? r.malformed : 'ok';
  };
  assert.match(why(''), /empty/);
  assert.match(why('   \n'), /empty/);
  assert.match(why('{"type":"FeatureCollection"}'), /not XML/);
  assert.match(why('<!-- only a comment -->'), /no XML element/);
  assert.match(why('<a>'.repeat(5000)), /nested deeper/);
  assert.equal(why('<a><b></a>'), 'ok');
});

// ---- OGC request helpers ---------------------------------------------------------------

test('splitEndpoint, joinUrl and KvpParams: the base kept as written, parameter names matched in any case', () => {
  const { base, params } = splitEndpoint('https://Maps.Example/{TOKEN}/wms?SERVICE=WMS&map=a%20b&x=1&X=2#frag');
  assert.equal(base, 'https://Maps.Example/{TOKEN}/wms');
  assert.equal(params.get('service'), 'WMS');
  assert.equal(params.get('MAP'), 'a b');
  assert.equal(params.get('x'), '2', 'the later spelling of a name replaces the earlier');
  assert.deepEqual(params.keys(), ['SERVICE', 'map', 'X']);
  assert.equal(params.has('Map'), true);
  assert.equal(params.has('missing'), false);
  const copy = params.clone().delete('x').set('layers', 'a,b');
  assert.equal(params.has('x'), true, 'a clone is its own');
  const url = joinUrl(base, copy);
  assert.ok(url.startsWith('https://Maps.Example/{TOKEN}/wms?SERVICE=WMS&'));
  assert.ok(url.includes('layers=a,b'), url);
  assert.equal(joinUrl('https://h/x', new KvpParams()), 'https://h/x');
  assert.deepEqual(splitEndpoint('https://h/x#frag').base, 'https://h/x');
  assert.deepEqual(splitEndpoint('https://h/x').params.keys(), []);
  assert.equal(KvpParams.from({ a: 1, b: true, c: 'x' }).get('B'), 'true');
  assert.deepEqual(KvpParams.from(undefined).keys(), []);
});

test('hostOf and originOf: of a URL with a {TOKEN} in its path; nothing for what is not a URL', () => {
  assert.equal(hostOf('https://Maps.Example:8443/{TOKEN}/wms'), 'maps.example');
  assert.equal(originOf('https://Maps.Example:8443/{TOKEN}/wms'), 'https://maps.example:8443');
  assert.equal(originOf('https://maps.example:443/x'), 'https://maps.example');
  assert.equal(hostOf('not a url'), undefined);
  assert.equal(originOf(''), undefined);
});

test('refuseAdvertisedUrl: only https on the host the definition names, with nothing in the host that could change it', () => {
  const host = 'maps.example';
  for (const ok of [
    'https://maps.example/tiles/{TileMatrix}/{TileRow}/{TileCol}.png',
    'https://MAPS.example/wms?',
    'https://maps.example:8443/x',
    'https://maps.example',
  ])
    assert.equal(refuseAdvertisedUrl(ok, host), undefined, ok);
  const refused: Array<[string, RegExp]> = [
    ['http://maps.example/x', /not https/],
    ['HTTPS://maps.example/x', /not https/],
    ['//maps.example/x', /not https/],
    ['https://evil.example/x', /is on evil\.example/],
    ['https://maps.example.evil.example/x', /is on maps\.example\.evil\.example/],
    ['https://sub.maps.example/x', /is on sub\.maps\.example/],
    ['https://maps.example@evil.example/x', /user or password/],
    ['https://user:pw@maps.example/x', /user or password/],
    ['https://{s}.maps.example/x', /placeholder in its host/],
    ['https://maps.example:{TileMatrix}/x', /placeholder in its host/],
    ['https://a{z}.maps.example/x', /placeholder in its host/],
    ['https://maps%2eexample/x', /percent-encoded host/],
    ['https://evil.example\\@maps.example/x', /user or password/],
    ['https:// maps.example/x', /not a URL|is on/],
    ['https://[::1]/x', /is on/],
  ];
  for (const [url, why] of refused) assert.match(refuseAdvertisedUrl(url, host) ?? 'accepted', why, url);
});

test('readFeatureCollection: a GeoJSON collection with its counts, or why the answer is not one', () => {
  const res = (body: string) => ({ text: () => body }) as never;
  const page = readFeatureCollection(
    res(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [{ type: 'Feature' }],
        numberMatched: 10,
        numberReturned: 1,
        totalFeatures: 10,
        links: [{ rel: 'next', href: 'x' }],
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
      }),
    ),
  );
  assert.ok(!('malformed' in page));
  if ('malformed' in page) return;
  assert.deepEqual([page.features.length, page.numberMatched, page.numberReturned, page.totalFeatures], [1, 10, 1, 10]);
  assert.equal(page.crsName, 'urn:ogc:def:crs:EPSG::3857');
  assert.ok(Array.isArray(page.links));
  const loose = readFeatureCollection(
    res(
      '  {"type":"FeatureCollection","features":[],"numberMatched":"unknown","numberReturned":-1,"totalFeatures":1.5,"crs":"x"}',
    ),
  );
  assert.deepEqual(loose, { features: [] }, 'counts that are not whole numbers are left out');
  const why = (body: string) => {
    const r = readFeatureCollection(res(body));
    return 'malformed' in r ? r.malformed : 'ok';
  };
  assert.match(why(''), /empty/);
  assert.match(
    why('<ServiceExceptionReport><ServiceException>No such layer</ServiceException></ServiceExceptionReport>'),
    /exception: No such layer/,
  );
  assert.match(why('<html><body>Login</body></html>'), /XML, not GeoJSON/);
  assert.match(why('{"type":'), /not valid JSON/);
  assert.match(why('[]'), /not a GeoJSON object/);
  assert.match(why('null'), /not a GeoJSON object/);
  assert.match(why('{"type":"Feature"}'), /not a GeoJSON FeatureCollection/);
  assert.match(why('{"type":"FeatureCollection","features":{}}'), /not a GeoJSON FeatureCollection/);
});

test('stringSetting and numberSetting: the operator’s value when it is of that kind', () => {
  const settings = { layer: '  radar  ', blank: '   ', n: 5, text: '7', bad: Number.NaN, flag: true };
  assert.equal(stringSetting(settings, 'layer'), 'radar');
  assert.equal(stringSetting(settings, 'blank'), undefined);
  assert.equal(stringSetting(settings, 'n'), undefined);
  assert.equal(stringSetting(settings, 'missing'), undefined);
  assert.equal(numberSetting(settings, 'n'), 5);
  assert.equal(numberSetting(settings, 'bad'), undefined);
  assert.equal(numberSetting(settings, 'flag'), undefined);
  assert.equal(numberSetting(settings, 'missing'), undefined);
});

test('parseExtent and clipExtent', () => {
  assert.equal(parseExtent(undefined), undefined);
  assert.deepEqual(parseExtent(' -125, 24 ,-66,50 '), { bounds: { west: -125, south: 24, east: -66, north: 50 } });
  assert.deepEqual(parseExtent('-180,-90,180,90'), { bounds: { west: -180, south: -90, east: 180, north: 90 } });
  for (const bad of [
    '',
    '1,2,3',
    '1,2,3,4,5',
    'a,b,c,d',
    '10,0,5,10',
    '0,10,10,5',
    '-181,0,0,10',
    '0,0,10,91',
    '0,0,0,10',
    '170,-10,-170,10',
  ])
    assert.ok('error' in (parseExtent(bad) ?? {}), bad);
  const usa = { west: -125, south: 24, east: -66, north: 50 };
  const world = { west: -180, south: -90, east: 180, north: 90 };
  assert.equal(clipExtent(undefined, world), world);
  assert.equal(clipExtent(usa, undefined), usa);
  assert.equal(clipExtent(undefined, undefined), undefined);
  assert.deepEqual(clipExtent(usa, world), usa);
  assert.deepEqual(clipExtent(world, usa), usa);
  assert.deepEqual(clipExtent(usa, { west: -100, south: 0, east: 0, north: 40 }), {
    west: -100,
    south: 24,
    east: -66,
    north: 40,
  });
  const europe = { west: 0, south: 40, east: 20, north: 60 };
  assert.equal(clipExtent(usa, europe), usa, 'no overlap: the definition is believed');
});

test('latestTime, newestInstant and previousInstant: the newest frame a time dimension names, as the service wrote it', () => {
  assert.equal(latestTime(undefined), undefined);
  assert.equal(
    latestTime({ default: '2026-09-28T12:00:00Z', extent: '2026-09-28T13:00:00Z' }),
    '2026-09-28T12:00:00Z',
    'an instant default wins',
  );
  assert.equal(
    latestTime({ default: 'current', extent: '2026-09-28T10:00:00Z,2026-09-28T12:00:00Z,2026-09-28T11:00:00Z' }),
    '2026-09-28T12:00:00Z',
  );
  assert.equal(
    latestTime({ extent: '2026-09-27T00:00:00Z/2026-09-28T12:10:00Z/PT10M' }),
    '2026-09-28T12:10:00Z',
    'an interval counts by its end',
  );
  assert.equal(
    latestTime({ extent: '2026-09-28T12:00:00+02:00, 2026-09-28T11:30:00Z' }),
    '2026-09-28T11:30:00Z',
    'compared as instants, not as text',
  );
  assert.equal(latestTime({ default: 'current', extent: '2026-09-27T00:00:00Z/..' }), undefined);
  assert.equal(latestTime({ default: '2026-09-28', extent: '' }), undefined, 'a date alone is not an instant here');
  assert.equal(latestTime({}), undefined);

  assert.equal(newestInstant([]), undefined);
  assert.equal(newestInstant([undefined, 'current', '']), undefined);
  assert.equal(
    newestInstant(['2026-08-18', '2022-01-14/2026-08-18/P1D', '2026-09-28']),
    '2026-09-28',
    'a daily layer: dates, written back as dates',
  );
  assert.equal(
    newestInstant(['2026-09-28T12:00:00Z', '2026-09-27T00:00:00Z/2026-09-28T12:10:00Z/PT10M']),
    '2026-09-28T12:10:00Z',
  );
  assert.equal(newestInstant(['2026-09-28', '2026-09-28T06:00:00Z']), '2026-09-28T06:00:00Z');
  assert.equal(newestInstant(['2026-02-30T00:00:00Q', 'soon', '2026-13-40']), undefined);

  const domain = ['2026-09-28T00:00:00Z/2026-09-28T12:00:00Z/PT10M'];
  assert.equal(previousInstant(domain, '2026-09-28T12:00:00Z'), '2026-09-28T11:50:00Z');
  assert.equal(previousInstant(domain, '2026-09-28T00:10:00Z'), '2026-09-28T00:00:00Z');
  assert.equal(previousInstant(domain, '2026-09-28T00:00:00Z'), undefined, 'nothing before the first frame');
  assert.equal(previousInstant(domain, '2026-09-28T12:05:00Z'), undefined, 'not on the period');
  assert.equal(previousInstant(domain, '2026-09-28T13:00:00Z'), undefined, 'outside the interval');
  assert.equal(previousInstant(domain, 'soon'), undefined);
  assert.equal(
    previousInstant(['2022-01-14/2026-08-18/P1D'], '2026-08-18'),
    '2026-08-17',
    'a daily layer steps a day, written as a date',
  );
  assert.equal(
    previousInstant(['2026-09-28T00:00:00Z/2026-09-28T12:00:00Z/PT1H30M'], '2026-09-28T03:00:00Z'),
    '2026-09-28T01:30:00Z',
  );
  for (const period of ['P1M', 'PT30S', 'PT0M', 'P', '10M', ''])
    assert.equal(
      previousInstant([`2026-09-28T00:00:00Z/2026-09-28T12:00:00Z/${period}`], '2026-09-28T12:00:00Z'),
      undefined,
      period,
    );
  assert.equal(previousInstant(['2026-09-28T12:00:00Z', undefined, 'current'], '2026-09-28T12:00:00Z'), undefined);
});

test('parseOpacity, parseFadeBelow and isTimeValue', () => {
  assert.equal(parseOpacity(undefined), undefined);
  assert.equal(parseOpacity('0'), 0);
  assert.equal(parseOpacity('1'), 1);
  assert.equal(parseOpacity(' 0.65 '), 0.65);
  for (const bad of ['', ' ', '-0.1', '1.01', 'half', '50%', 'NaN'])
    assert.equal(typeof parseOpacity(bad), 'string', bad);

  assert.equal(parseFadeBelow(undefined), undefined);
  assert.deepEqual(parseFadeBelow('40,120'), { from: 40, to: 120 });
  assert.deepEqual(parseFadeBelow(' 0 , 255 '), { from: 0, to: 255 });
  for (const bad of ['', '40', '120,40', '40,40', '40,256', '-1,40', '40,120,200', 'a,b', '40;120', '4.5,9'])
    assert.equal(typeof parseFadeBelow(bad), 'string', bad);

  for (const ok of [
    'current',
    '2026',
    '2026-09',
    '2026-09-28',
    '2026-09-28T12',
    '2026-09-28T12:00',
    '2026-09-28T12:00:00Z',
    '2026-09-28T12:00:00.5+02:00',
    '2026-09-27/2026-09-28',
    '../2026-09-28',
    '2026-09-27/..',
  ])
    assert.equal(isTimeValue(ok), true, ok);
  for (const bad of [
    'latest',
    'now',
    '28-09-2026',
    '2026-9-28',
    '2026-09-28 12:00',
    '2026-09-28T12:00:00Z&x=1',
    `${'2026-09-28T12:00:00Z/'.repeat(4)}2026`,
    'current/2026',
  ])
    assert.equal(isTimeValue(bad), false, bad);
});

test('KML coordinates: tuples separated by white space, spaces round the commas tolerated, read in one pass', () => {
  const read = (text: string) => {
    const r = parseKmlCoordinates(text);
    return 'list' in r ? r.list : r.reason;
  };
  assert.deepEqual(read('-157.8,21.3,10 -157.9,21.4'), [
    [-157.8, 21.3, 10],
    [-157.9, 21.4],
  ]);
  assert.deepEqual(read('\n  -157.8 , 21.3 ,10\n\t-157.9,\n21.4  \n'), [
    [-157.8, 21.3, 10],
    [-157.9, 21.4],
  ]);
  assert.deepEqual(read(''), []);
  assert.deepEqual(read('   \n '), []);
  assert.match(String(read('-157.8')), /not lon,lat/);
  assert.match(String(read('1,2,3,4')), /not lon,lat/);
  assert.equal(typeof read('a,b'), 'string');
  assert.equal(typeof read('1,,2'), 'string');
  const started = Date.now();
  assert.deepEqual(read(`1,2${' \n'.repeat(500_000)}3,4`), [
    [1, 2],
    [3, 4],
  ]);
  assert.ok(Array.isArray(read(`${' '.repeat(1_000_000)}`)));
  assert.equal(typeof read(`1${' '.repeat(500_000)},${'\n'.repeat(500_000)}2 3`), 'string');
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});
