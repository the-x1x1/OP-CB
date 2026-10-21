import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { GEODATA_MAX_FEATURES, geodataFormatOf, kmlInKmz, readGeodata } from './geodata-import.js';

const enc = (s: string) => new TextEncoder().encode(s);

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <NetworkLink><name>Remote</name><Link><href>https://example.org/more.kml</href></Link></NetworkLink>
  <Placemark><name>Hilo</name><description><![CDATA[<img src="https://example.org/x.png">]]></description>
    <Point><coordinates>-155.09,19.72,0</coordinates></Point></Placemark>
  <Placemark><name>Saddle Road</name><LineString><coordinates>-155.09,19.72 -155.47,19.70 -155.83,19.83</coordinates></LineString></Placemark>
  <Placemark><name>No shape</name></Placemark>
</Document></kml>`;

/** A zip with one entry per file, deflated (method 8) unless `stored`. */
function zip(files: Array<{ name: string; text: string; stored?: boolean }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = enc(f.text);
    const data = f.stored ? raw : new Uint8Array(deflateRawSync(raw));
    const name = enc(f.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, f.stored ? 0 : 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, f.stored ? 0 : 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, data);
    central.push(c);
    offset += local.length + data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test('the format is the file name’s', () => {
  assert.equal(geodataFormatOf('track.GPX'), 'gpx');
  assert.equal(geodataFormatOf('areas.json'), 'json');
  assert.equal(geodataFormatOf('a.kmz'), 'kmz');
  assert.equal(geodataFormatOf('notes.txt'), undefined);
  assert.match(readGeodata('notes.txt', enc('x')).issues[0]!, /not a GeoJSON/);
});

test('KML: shapes and names only; a network link is reported, never followed; a placemark without a shape is counted', () => {
  const r = readGeodata('places.kml', enc(KML));
  assert.equal(r.format, 'kml');
  assert.deepEqual(
    r.features.map((f) => [f.name, f.geometry.type]),
    [
      ['Hilo', 'Point'],
      ['Saddle Road', 'LineString'],
    ],
  );
  assert.ok(
    r.issues.some((i) => /NetworkLink/i.test(i)),
    r.issues.join(' | '),
  );
  assert.ok(r.issues.includes('1 element(s) could not be read'), r.issues.join(' | '));
});

test('KMZ: doc.kml read from the zip, deflated or stored; not a zip, or no KML in it, is said', () => {
  const kmz = zip([
    { name: 'images/a.png', text: 'PNG' },
    { name: 'doc.kml', text: KML },
  ]);
  const r = readGeodata('places.kmz', kmz);
  assert.equal(r.format, 'kmz');
  assert.equal(r.features.length, 2);
  const stored = kmlInKmz(zip([{ name: 'other.kml', text: KML, stored: true }]));
  assert.ok('text' in stored && stored.text.includes('Saddle Road'));
  assert.deepEqual(kmlInKmz(enc('not a zip at all, just text that is long enough')), {
    error: 'not a KMZ (no zip directory)',
  });
  assert.deepEqual(kmlInKmz(zip([{ name: 'a.png', text: 'PNG' }])), { error: 'no KML in the KMZ' });
});

test('GeoJSON: a FeatureCollection, a Feature or a bare geometry; names from name/title; another CRS refused', () => {
  const fc = readGeodata(
    'zones.geojson',
    enc(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Box' },
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          },
          { type: 'Feature', properties: { title: 'Pin' }, geometry: { type: 'Point', coordinates: [10, 20] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [200, 95] } },
        ],
      }),
    ),
  );
  assert.deepEqual(
    fc.features.map((f) => f.name),
    ['Box', 'Pin'],
  );
  assert.ok(
    fc.issues.some((i) => /1 feature\(s\) without a usable shape/.test(i)),
    'out-of-range coordinates',
  );
  const bare = readGeodata('p.json', enc(JSON.stringify({ type: 'Point', coordinates: [1, 2] })));
  assert.equal(bare.features.length, 1);
  const crs = readGeodata(
    'x.geojson',
    enc(JSON.stringify({ type: 'FeatureCollection', crs: { properties: { name: 'EPSG:3857' } }, features: [] })),
  );
  assert.match(crs.issues[0]!, /not longitude\/latitude/);
  assert.deepEqual(readGeodata('x.geojson', enc('{')).issues, ['not valid JSON']);
});

test('GPX: a track and a waypoint', () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">
    <wpt lat="21.30" lon="-157.86"><name>Start</name></wpt>
    <trk><name>Walk</name><trkseg><trkpt lat="21.30" lon="-157.86"/><trkpt lat="21.31" lon="-157.85"/></trkseg></trk></gpx>`;
  const r = readGeodata('walk.gpx', enc(gpx));
  assert.deepEqual(r.features.map((f) => f.name).sort(), ['Start', 'Walk']);
});

test('too many shapes: the first are kept and the rest counted', () => {
  const features = Array.from({ length: GEODATA_MAX_FEATURES + 3 }, (_, i) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [i % 180, 0] },
  }));
  const r = readGeodata('many.geojson', enc(JSON.stringify({ type: 'FeatureCollection', features })));
  assert.equal(r.features.length, GEODATA_MAX_FEATURES);
  assert.ok(r.issues.some((i) => /^3 feature\(s\) past the limit/.test(i)));
});

test('a TopoJSON file keeps the names in its properties', () => {
  const topo = {
    type: 'Topology',
    arcs: [
      [
        [0, 0],
        [1, 1],
      ],
    ],
    objects: {
      things: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'LineString', arcs: [0], properties: { name: 'tp' } },
          { type: 'Point', coordinates: [2, 2], properties: { NAME: 'tpt' } },
        ],
      },
    },
  };
  const read = readGeodata('t.topojson', new TextEncoder().encode(JSON.stringify(topo)));
  assert.deepEqual(read.features.map((f) => f.name).sort(), ['tp', 'tpt']);
});
