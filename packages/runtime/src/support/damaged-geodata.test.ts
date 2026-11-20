import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import type { WatchZone } from '@opcb/ipc-contract';
import { validateCollection, validateRegion } from '../validate.js';
import { collectionFromGeodata, collectionGeodata, type GeoPlace } from './collection-geodata.js';
import { kmlInKmz, readGeodata } from './geodata-import.js';
import { zonesFromGeodata, zonesToGeodata } from './zone-geodata.js';

/**
 * Files the operator opens to bring places and zones in (GPX, KML, KMZ, GeoJSON), damaged:
 * the app's own exports cut, spliced and given other values, and a KMZ with its bytes
 * changed. A reader says the file is malformed or reads what is left; what it reads is a
 * collection or a zone the app's own rules accept. Damage is generated from a fixed seed.
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

const BITS = [
  '',
  '<',
  '>',
  '</',
  '&',
  '"',
  ',',
  ' ',
  '\n',
  '999',
  '-999',
  'NaN',
  '1e999',
  'null',
  '[',
  ']',
  '{',
  '}',
  '<![CDATA[',
  ']]>',
  '0,0,0 ',
];
function damage(good: string, next: () => number): string {
  let s = good;
  const times = 1 + Math.floor(next() * 3);
  for (let k = 0; k < times; k++) {
    const at = Math.floor(next() * s.length);
    const len = Math.floor(next() * 40);
    const roll = next();
    if (roll < 0.15) s = s.slice(0, at);
    else if (roll < 0.3) s = s.slice(0, at) + s.slice(at + len);
    else if (roll < 0.4) s = s.slice(0, at) + s.slice(at, at + len) + s.slice(at);
    else s = s.slice(0, at) + BITS[Math.floor(next() * BITS.length)]! + s.slice(at + (next() < 0.5 ? 0 : len));
  }
  return s;
}

const at = '2026-09-21T00:00:00.000Z';
const places: GeoPlace[] = Array.from({ length: 8 }, (_, i) => ({
  title: ['Harbour', 'a & b', '<gate>', 'line\nbreak', '北駅', 'x'.repeat(120), '"quoted"', ']]>'][i]!,
  latitude: [21.3, -89.9, 0, 45, 89.9, -45, 10, -10][i]!,
  longitude: [-157.8, 179.99, -179.99, 0, 10, 120, -60, 60][i]!,
  ...(i % 3 === 0 ? { altitudeM: 12 * i } : {}),
  createdAt: at,
  kind: 'location' as const,
  ...(i % 2 ? { note: `note ${i} & more` } : {}),
  ...(i % 4 === 0 ? { tags: ['one', 'two'] } : {}),
}));

test('a damaged file of places is malformed or a collection the app accepts', () => {
  const next = rng(2026);
  for (const format of ['gpx', 'kml', 'geojson'] as const) {
    const good = collectionGeodata(format, { name: 'Places' }, places, { exportedAt: at, attribution: ['Example'] });
    const whole = collectionFromGeodata(format, good, { name: 'Places', nowIso: at, fileTime: at });
    assert.ok(
      'collection' in whole && whole.collection.items.length === places.length,
      `${format} reads its own export`,
    );
    let read = 0;
    let malformed = 0;
    for (let i = 0; i < 2500; i++) {
      const result = collectionFromGeodata(format, damage(good, next), { name: 'Places', nowIso: at, fileTime: at });
      if ('malformed' in result) {
        assert.ok(result.malformed.length > 0);
        malformed++;
        continue;
      }
      read++;
      assert.ok(Number.isInteger(result.skipped) && result.skipped >= 0);
      const checked = validateCollection(JSON.parse(JSON.stringify(result.collection)));
      assert.ok(checked, `${format}: not a collection: ${JSON.stringify(result.collection).slice(0, 300)}`);
      assert.equal(
        checked.items.length,
        result.collection.items.length,
        `${format}: an item the app's own reader drops`,
      );
      assert.equal(new Set(checked.items.map((item) => item.id)).size, checked.items.length, `${format}: an id twice`);
    }
    // Most damage to JSON leaves no JSON; what is left to read is fewer files than for XML.
    assert.ok(read > 150 && malformed > 100, `${format}: ${read} read, ${malformed} malformed`);
  }
});

test('a damaged file of shapes is malformed or zones the app accepts', () => {
  const next = rng(7);
  const zones: WatchZone[] = [
    { kind: 'circle' as const, center: { latitude: 21, longitude: 179.9 }, radiusM: 50_000 },
    { kind: 'bounds' as const, bounds: { west: 179, south: -1, east: -179, north: 1 } },
    {
      kind: 'polygon' as const,
      polygon: [
        [-158, 21],
        [-157, 21],
        [-157, 22],
        [-158, 22],
      ] as Array<[number, number]>,
    },
    { kind: 'circle' as const, center: { latitude: 89.5, longitude: 0 }, radiusM: 200_000 },
  ].map((geometry, i) => ({
    id: `z${i}`,
    name: ['Harbour', 'a & <b>', 'line\nbreak', ']]>'][i]!,
    geometry,
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: true,
    createdAt: at,
  }));
  for (const format of ['kml', 'geojson'] as const) {
    const good = zonesToGeodata(format, zones, at);
    assert.equal(good.written, zones.length);
    const whole = zonesFromGeodata(format, good.text);
    assert.ok('zones' in whole && whole.zones.length === zones.length, `${format} reads its own export`);
    let read = 0;
    let made = 0;
    for (let i = 0; i < 2500; i++) {
      const result = zonesFromGeodata(format, damage(good.text, next));
      if ('malformed' in result) continue;
      read++;
      for (const issue of result.issues) assert.equal(typeof issue, 'string');
      for (const zone of result.zones) {
        assert.ok(
          typeof zone.name === 'string' && zone.name.length > 0 && zone.name.length <= 200,
          JSON.stringify(zone.name),
        );
        const region = validateRegion(JSON.parse(JSON.stringify(zone.geometry)));
        assert.ok(region, `${format}: not a region: ${JSON.stringify(zone.geometry).slice(0, 300)}`);
        assert.deepEqual(region, zone.geometry, `${format}: a region the app's reader changes`);
        made++;
      }
    }
    assert.ok(read > 100 && made > 400, `${format}: ${read} read, ${made} zones`);
  }
});

/** A zip with one entry, written by hand (stored or deflated). */
function zipOf(name: string, text: string, deflate: boolean): Uint8Array {
  const raw = Buffer.from(text, 'utf8');
  const data = deflate ? deflateRawSync(raw) : raw;
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nameBytes.length, 12);
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, end]));
}

test('a damaged KMZ gives its KML or a reason, and never more memory than its limit', () => {
  const next = rng(11);
  const kml = collectionGeodata('kml', { name: 'Places' }, places, { exportedAt: at, attribution: [] });
  let texts = 0;
  let reasons = 0;
  for (const deflate of [false, true]) {
    const good = zipOf('doc.kml', kml, deflate);
    const whole = kmlInKmz(good);
    assert.ok('text' in whole && whole.text === kml, 'the undamaged KMZ gives its KML');
    assert.ok(!('error' in readGeodata('places.kmz', good)), 'and reads as geodata');
    for (let i = 0; i < 4000; i++) {
      let b = new Uint8Array(good);
      const times = 1 + Math.floor(next() * 3);
      for (let k = 0; k < times; k++) {
        // The directory and the end record are the last hundred bytes; lean on them.
        const pos =
          next() < 0.6 ? b.length - 1 - Math.floor(next() * Math.min(b.length, 100)) : Math.floor(next() * b.length);
        if (next() < 0.1) b = new Uint8Array(b.subarray(0, Math.max(1, pos)));
        else
          b[pos] =
            next() < 0.5 ? [0x00, 0xff, 0x7f, 0x80, 0x50, 0x4b][Math.floor(next() * 6)]! : Math.floor(next() * 256);
      }
      const before = process.memoryUsage().arrayBuffers;
      const result = kmlInKmz(b);
      if ('text' in result) texts++;
      else {
        assert.ok(result.error.length > 0);
        reasons++;
      }
      const grew = process.memoryUsage().arrayBuffers - before;
      assert.ok(grew < 80 * 1024 * 1024, `held ${Math.round(grew / 1e6)} MB for a ${b.length}-byte file`);
      // And through the reader a file dialog hands it to: an answer, never a throw.
      readGeodata('places.kmz', b);
    }
  }
  assert.ok(texts > 500 && reasons > 500, `${texts} texts, ${reasons} reasons`);
});
