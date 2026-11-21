import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchZone } from '@opcb/ipc-contract';
import { zonesFromGeodata, zonesToGeodata } from './zone-geodata.js';

/**
 * Watch zones exported as KML or GeoJSON and read back by the app's own importer: as many
 * zones, in order, with their names; a polygon comes back with the same corners (to seven
 * decimals), a circle as the same circle (its centre to seven decimals, its radius to the metre
 * in KML), a box as its four corners. Names hold markup, entities, quotes, odd spacing and
 * emoji; outlines cross 180° and reach the poles.
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

const PIECES = ['Zone', ' ', '\t', '\n', '&', '<b>', '"', "'", '&amp;', ']]>', 'é', '東京', '😀', '#1', '/', ',', '  '];
const at = '2026-11-21T00:00:00.000Z';

for (const format of ['kml', 'geojson'] as const) {
  test(`watch-zone round trip: ${format} written and read back gives the same zones`, () => {
    const next = rng(format.length * 131);
    const coord = (lo: number, hi: number) => {
      const r = next();
      return r < 0.08 ? lo : r < 0.16 ? hi : lo + next() * (hi - lo);
    };
    const text = () =>
      Array.from({ length: Math.floor(next() * 8) }, () => PIECES[Math.floor(next() * PIECES.length)]).join('');
    for (let round = 0; round < 150; round++) {
      const zones: WatchZone[] = Array.from({ length: 1 + Math.floor(next() * 5) }, (_, i) => {
        const kind = Math.floor(next() * 3);
        const geometry: WatchZone['geometry'] =
          kind === 0
            ? {
                kind: 'polygon',
                polygon: Array.from({ length: 3 + Math.floor(next() * 8) }, () => [coord(-180, 180), coord(-90, 90)]),
              }
            : kind === 1
              ? {
                  kind: 'circle',
                  center: { latitude: coord(-90, 90), longitude: coord(-180, 180) },
                  radiusM: 1 + Math.floor(next() * 3_000_000),
                }
              : {
                  kind: 'bounds',
                  bounds: (() => {
                    const s = coord(-90, 80);
                    return { west: coord(-180, 180), east: coord(-180, 180), south: s, north: s + next() * 10 };
                  })(),
                };
        return {
          id: `z${i}`,
          name: text(),
          geometry,
          eventTypes: ['earthquake'],
          notifications: { inApp: true, desktop: false },
          enabled: next() < 0.8,
          createdAt: at,
        };
      });
      const out = zonesToGeodata(format, zones, at);
      assert.equal(out.written, zones.length);
      const back = zonesFromGeodata(format, out.text);
      assert.ok(!('malformed' in back), `round ${round}`);
      assert.deepEqual(back.issues, [], `round ${round}: nothing left out`);
      assert.equal(back.zones.length, zones.length, `round ${round}: as many zones`);
      const near = (a: number, b: number) => Math.abs(a - b) <= 5e-8;
      zones.forEach((z, i) => {
        const got = back.zones[i]!;
        const where = `round ${round} zone ${i} ${JSON.stringify(z.name)} ${z.geometry.kind}`;
        assert.equal(got.name, (z.name.trim() || `Zone ${i + 1}`).slice(0, 200), `${where}: name`);
        if (z.geometry.kind === 'circle') {
          assert.equal(got.geometry.kind, 'circle', where);
          if (got.geometry.kind !== 'circle') return;
          assert.ok(near(got.geometry.center.latitude, z.geometry.center.latitude), `${where}: centre`);
          assert.ok(near(got.geometry.center.longitude, z.geometry.center.longitude), `${where}: centre`);
          assert.equal(got.geometry.radiusM, z.geometry.radiusM, `${where}: radius`);
          return;
        }
        const corners =
          z.geometry.kind === 'polygon'
            ? z.geometry.polygon
            : z.geometry.kind === 'bounds'
              ? [
                  [z.geometry.bounds.west, z.geometry.bounds.south],
                  [z.geometry.bounds.east, z.geometry.bounds.south],
                  [z.geometry.bounds.east, z.geometry.bounds.north],
                  [z.geometry.bounds.west, z.geometry.bounds.north],
                ]
              : [];
        assert.equal(got.geometry.kind, 'polygon', where);
        if (got.geometry.kind !== 'polygon') return;
        // A ring written open whose last corner is its first is read as closed: one corner fewer.
        const open =
          corners.length > 3 && corners[0]![0] === corners.at(-1)![0] && corners[0]![1] === corners.at(-1)![1]
            ? corners.slice(0, -1)
            : corners;
        assert.equal(got.geometry.polygon.length, open.length, `${where}: corners`);
        open.forEach(([lon, lat], k) => {
          assert.ok(
            near(got.geometry.kind === 'polygon' ? got.geometry.polygon[k]![0] : 0, lon!),
            `${where}: corner ${k}`,
          );
          assert.ok(
            near(got.geometry.kind === 'polygon' ? got.geometry.polygon[k]![1] : 0, lat!),
            `${where}: corner ${k}`,
          );
        });
      });
    }
  });
}
