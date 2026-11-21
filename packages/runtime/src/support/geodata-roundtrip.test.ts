import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionFromGeodata, collectionGeodata, type GeoPlace } from './collection-geodata.js';

/**
 * A collection exported as GPX, KML or GeoJSON and read back by the app's own importer is the
 * same collection: as many places, in the same order, each with its name, note, position
 * (to seven decimals), height (to a tenth of a metre) and time — whatever the names hold
 * (markup, entities, CDATA, quotes, every kind of space and line end, emoji). The one change:
 * the characters XML cannot carry at all (most control characters) are left out of GPX and
 * KML.
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

const PIECES = [
  'a',
  'Z',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '\r',
  '&',
  '<',
  '>',
  '"',
  "'",
  '&amp;',
  '&#65;',
  '<b>bold</b>',
  '<![CDATA[x]]>',
  ']]>',
  '<!-- c -->',
  'é',
  '東京',
  '😀',
  '\u200b',
  '\u00a0',
  '\u0001',
  '\u001f',
  '\u007f',
  String.fromCharCode(0xfffe),
  '#',
  '%20',
  '/',
  '\\',
  '{"a":1}',
  'Tags: x',
  ',',
  '0,0',
];
const XML_FORBIDDEN = new RegExp(`[${String.fromCharCode(0)}-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]`, 'g');

for (const format of ['gpx', 'kml', 'geojson'] as const) {
  test(`geodata round trip: ${format} written and read back is the same collection`, () => {
    const next = rng(format.length * 97);
    const text = (n: number) =>
      Array.from({ length: Math.floor(next() * n) }, () => PIECES[Math.floor(next() * PIECES.length)]).join('');
    const edge = (lo: number, hi: number) => {
      const r = next();
      return r < 0.1 ? lo : r < 0.2 ? hi : r < 0.25 ? 0 : lo + next() * (hi - lo);
    };
    for (let round = 0; round < 200; round++) {
      const places: GeoPlace[] = Array.from({ length: 1 + Math.floor(next() * 6) }, () => ({
        title: text(10),
        latitude: edge(-90, 90),
        longitude: edge(-180, 180),
        createdAt: new Date(Date.parse('2020-01-01T00:00:00.000Z') + Math.floor(next() * 2e11)).toISOString(),
        kind: 'location' as const,
        ...(next() < 0.5 ? { note: text(12) } : {}),
        ...(next() < 0.4 ? { altitudeM: Math.round((next() * 9000 - 500) * 1000) / 1000 } : {}),
      }));
      const at = '2026-11-21T00:00:00.000Z';
      const written = collectionGeodata(format, { name: 'Places' }, places, { exportedAt: at, attribution: ['A & B'] });
      const read = collectionFromGeodata(format, written, { name: 'Places', nowIso: at, fileTime: at });
      assert.ok(!('malformed' in read), `round ${round}: ${'malformed' in read ? read.malformed : ''}`);
      assert.equal(read.skipped, 0, `round ${round}: nothing skipped`);
      const items = read.collection.items;
      assert.equal(items.length, places.length, `round ${round}: as many places`);
      const clean = (s: string) => (format === 'geojson' ? s : s.replace(XML_FORBIDDEN, ''));
      places.forEach((p, i) => {
        const it = items[i]!;
        const where = `round ${round} place ${i} ${JSON.stringify(p.title)}`;
        assert.equal(it.title, (clean(p.title).trim() || `Place ${i + 1}`).slice(0, 200), `${where}: name`);
        assert.equal(it.note, (p.note === undefined ? '' : clean(p.note).trim()) || undefined, `${where}: note`);
        assert.ok(Math.abs(it.position!.latitude - p.latitude) <= 5e-8, `${where}: latitude ${it.position!.latitude}`);
        const lon = p.longitude >= 180 ? p.longitude - 360 : p.longitude;
        assert.ok(Math.abs(it.position!.longitude - lon) <= 5e-8, `${where}: longitude ${it.position!.longitude}`);
        if (p.altitudeM === undefined) assert.equal(it.position!.altitudeM, undefined, `${where}: no height`);
        else assert.ok(Math.abs(it.position!.altitudeM! - p.altitudeM) <= 0.05 + 1e-9, `${where}: height`);
        assert.equal(it.createdAt, p.createdAt, `${where}: time`);
      });
    }
  });
}
