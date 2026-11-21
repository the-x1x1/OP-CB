import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGpx, readKml } from '@opcb/connector-runtime';
import { lineGeodata } from './collection-geodata.js';

/**
 * The measured line exported and read back: GPX and KML give back its points (a closed shape
 * back to its start), to seven decimals; GeoJSON gives a line no segment of which runs more
 * than half way round the world, cut at 180° where it crosses and nowhere else, and whose
 * points, less the ones added on the cut, are the line's own.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const near = (a: number, b: number) => Math.abs(a - b) <= 5e-8;
/** A longitude as the files write it: −180 for 180. */
const lonOut = (v: number) => (v >= 180 ? v - 360 : v);

test('measured line: GPX, KML and GeoJSON written and read back give the line', () => {
  const next = rng(77);
  for (let round = 0; round < 300; round++) {
    // Lines that wander, often across 180°, now and then onto it.
    let lon = -180 + next() * 360;
    let lat = -80 + next() * 160;
    const points = Array.from({ length: 2 + Math.floor(next() * 8) }, () => {
      const p = { latitude: lat, longitude: lon };
      lon += (next() - 0.5) * 60;
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      if (next() < 0.05) lon = 180;
      lat = Math.max(-85, Math.min(85, lat + (next() - 0.5) * 20));
      return p;
    });
    const closed = points.length >= 3 && next() < 0.3;
    const ring = closed ? [...points, points[0]!] : points;
    const where = `round ${round}`;

    const gpx = readGpx(lineGeodata('gpx', 'Line', points, closed, 'x'));
    assert.ok(!('malformed' in gpx), where);
    const route = gpx.features[0]!.geometry as { type: string; coordinates: number[][] };
    assert.equal(route.type, 'LineString', where);
    assert.equal(route.coordinates.length, ring.length, `${where}: gpx points`);
    route.coordinates.forEach(([x, y], i) => {
      assert.ok(near(x!, lonOut(ring[i]!.longitude)) && near(y!, ring[i]!.latitude), `${where}: gpx point ${i}`);
    });

    const kml = readKml(lineGeodata('kml', 'Line', points, closed, 'x'));
    assert.ok(!('malformed' in kml), where);
    const g = kml.features[0]!.geometry as { type: string; coordinates: unknown };
    assert.equal(g.type, closed ? 'Polygon' : 'LineString', where);
    const kmlPoints = (closed ? (g.coordinates as number[][][])[0]! : (g.coordinates as number[][])) ?? [];
    assert.equal(kmlPoints.length, ring.length, `${where}: kml points`);
    kmlPoints.forEach(([x, y], i) => {
      assert.ok(near(x!, lonOut(ring[i]!.longitude)) && near(y!, ring[i]!.latitude), `${where}: kml point ${i}`);
    });

    const gj = JSON.parse(lineGeodata('geojson', 'Line', points, closed, 'x')) as {
      features: Array<{ geometry: { type: string; coordinates: unknown } }>;
    };
    const geometry = gj.features[0]!.geometry;
    if (closed) {
      assert.equal(geometry.type, 'Polygon', where);
      continue;
    }
    const pieces =
      geometry.type === 'MultiLineString'
        ? (geometry.coordinates as number[][][])
        : [geometry.coordinates as number[][]];
    for (const piece of pieces)
      for (let i = 1; i < piece.length; i++)
        assert.ok(
          Math.abs(piece[i]![0]! - piece[i - 1]![0]!) <= 180,
          `${where}: a segment runs the long way round ${JSON.stringify(piece)}`,
        );
    // Where it is cut, one piece ends on 180° and the next starts on the other side of it, at
    // the same latitude.
    for (let k = 1; k < pieces.length; k++) {
      const end = pieces[k - 1]!.at(-1)!;
      const start = pieces[k]![0]!;
      assert.equal(Math.abs(end[0]!), 180, `${where}: cut at 180°`);
      assert.equal(start[0], -end[0]!, `${where}: the next piece starts on the other side`);
      assert.ok(near(start[1]!, end[1]!), `${where}: at the same latitude`);
    }
    // Less the added points, the line's own points in order.
    const own = pieces.flatMap((piece, k) =>
      piece.filter((_, i) => !((k > 0 && i === 0) || (k < pieces.length - 1 && i === piece.length - 1))),
    );
    assert.equal(own.length, ring.length, `${where}: geojson points`);
    own.forEach(([x, y], i) => {
      const want = ring[i]!.longitude;
      assert.ok(
        near(Math.abs(x!) === 180 ? Math.abs(want) : x!, Math.abs(x!) === 180 ? 180 : want) &&
          near(y!, ring[i]!.latitude),
        `${where}: geojson point ${i}`,
      );
    });
  }
});
