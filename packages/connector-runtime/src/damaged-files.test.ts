import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geometrySchema } from '@opcb/world-model';
import { parseCsv } from './csv.js';
import { decodeGtfsRealtime, GtfsRealtimeError } from './gtfs-realtime.js';
import type { FeatureReadResult } from './connectors/files/features.js';
import { readGpx } from './connectors/files/gpx.js';
import { readKml } from './connectors/files/kml.js';
import { readTopoJson } from './connectors/files/topojson.js';
import { parseXml } from './connectors/files/xml.js';

/**
 * Every reader of a file or a feed, given the fixtures damaged a few thousand ways: cut
 * short, a stretch doubled, a stretch taken out, characters changed, awkward text put in.
 * A reader may say the file is malformed, or read what is left of it; it may not throw
 * anything else, take seconds, or hand on a shape the world model refuses or a number that
 * is not one. Damage is generated from a fixed seed.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'connectors');
const text = (name: string) => readFileSync(path.join(root, 'files', name), 'utf8');
const bytes = (name: string) => new Uint8Array(readFileSync(path.join(root, 'gtfs-rt', name)));

const AWKWARD = [
  '<',
  '>',
  '</',
  '<![CDATA[',
  ']]>',
  '<!--',
  '-->',
  '&',
  '&#x0;',
  '&#99999999;',
  '&amp;',
  '"',
  "'",
  '\n',
  '\r\n',
  '\u0000',
  '\ufeff',
  '\ud83d',
  ',',
  ',,,',
  ' ',
  'NaN',
  'Infinity',
  '-1e999',
  '1e999',
  '999',
  '-999',
  '0x10',
  '[',
  ']',
  '{',
  '}',
  '[[[[[[[[',
  'null',
  '"__proto__"',
  'constructor',
  '-',
  '.',
  '9999999999999999999999',
];

function damageText(source: string, next: () => number): string {
  let s = source;
  const times = 1 + Math.floor(next() * 3);
  for (let i = 0; i < times; i++) {
    const at = Math.floor(next() * s.length);
    const len = Math.floor(next() * (next() < 0.2 ? s.length / 3 : 40));
    const roll = next();
    if (roll < 0.2) s = s.slice(0, at);
    else if (roll < 0.4) s = s.slice(0, at) + s.slice(at + len);
    else if (roll < 0.55) s = s.slice(0, at) + s.slice(at, at + len) + s.slice(at);
    else if (roll < 0.9)
      s = s.slice(0, at) + AWKWARD[Math.floor(next() * AWKWARD.length)]! + s.slice(at + (next() < 0.5 ? 0 : len));
    else s = s.slice(0, at) + String.fromCharCode(Math.floor(next() * 0x3000)) + s.slice(at + 1);
  }
  return s;
}

/** Why what a reader gave back is not fit to hand on; undefined when it is. */
function unfit(result: FeatureReadResult | { malformed: string }): string | undefined {
  if ('malformed' in result)
    return typeof result.malformed === 'string' && result.malformed ? undefined : 'no reason given';
  for (const f of result.features) {
    if (typeof f.id !== 'string' || !f.id) return 'a feature with no id';
    if (f.geometry) {
      const parsed = geometrySchema.parse(f.geometry);
      if (!parsed.ok) return `geometry of ${f.id} refused: ${JSON.stringify(f.geometry).slice(0, 160)}`;
    }
    if (f.point) {
      const parsed = geometrySchema.parse(f.point);
      if (!parsed.ok) return `point of ${f.id} refused: ${JSON.stringify(f.point)}`;
    }
    if (f.time !== undefined && new Date(f.time).toISOString() !== f.time) return `time of ${f.id}: ${f.time}`;
  }
  // Nothing that JSON turns into something else on the way to the page (NaN, a function).
  const sent = JSON.stringify(result, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`a number that is not one: ${value}`);
    if (value === undefined || typeof value === 'function') throw new Error('a value JSON drops');
    return value;
  });
  return sent ? undefined : 'nothing to send';
}

function fuzzReader(
  name: string,
  read: (text: string) => FeatureReadResult | { malformed: string },
  source: string,
  seed: number,
  count: number,
): { read: number; malformed: number } {
  const next = rng(seed);
  let okay = 0;
  let malformed = 0;
  for (let i = 0; i < count; i++) {
    const damaged = damageText(source, next);
    const started = performance.now();
    let result: FeatureReadResult | { malformed: string };
    try {
      result = read(damaged);
    } catch (error) {
      assert.fail(`${name} threw ${String(error)} on ${JSON.stringify(damaged.slice(0, 300))}`);
    }
    const took = performance.now() - started;
    assert.ok(took < 2000, `${name} took ${Math.round(took)} ms on ${damaged.length} characters`);
    let why: string | undefined;
    try {
      why = unfit(result);
    } catch (error) {
      why = String(error);
    }
    assert.equal(why, undefined, `${name}: ${why}`);
    if ('malformed' in result) malformed++;
    else okay++;
  }
  return { read: okay, malformed };
}

test('a damaged GPX, KML or TopoJSON file is called malformed or read; never anything else', () => {
  for (const [name, read, file] of [
    ['gpx', readGpx, 'diamond-head-walk.gpx'],
    ['kml', readKml, 'reef-survey.kml'],
    ['topojson', (t: string) => readTopoJson(t), 'districts.topojson'],
  ] as const) {
    const source = text(file);
    assert.ok(!('malformed' in read(source)), `${file} itself reads`);
    const tally = fuzzReader(name, read, source, 2026, 2500);
    // Both outcomes happened: damage that only ever gave one would test half of this.
    assert.ok(tally.read > 100 && tally.malformed > 100, `${name}: ${JSON.stringify(tally)}`);
  }
});

test('damaged XML is parsed or called malformed', () => {
  const next = rng(7);
  for (const file of ['diamond-head-walk.gpx', 'reef-survey.kml']) {
    const source = text(file);
    for (let i = 0; i < 2500; i++) {
      const damaged = damageText(source, next);
      const result = parseXml(damaged);
      assert.ok('root' in result || typeof result.malformed === 'string');
    }
  }
});

test('a damaged CSV file gives rows of text and a count, whatever is in it', () => {
  const source = text('rain-gauges.csv');
  const next = rng(11);
  for (let i = 0; i < 3000; i++) {
    const damaged = damageText(source, next);
    const options =
      next() < 0.3
        ? { delimiter: next() < 0.5 ? ';' : 'whitespace' }
        : next() < 0.2
          ? { comment: '#', maxRows: 3 }
          : {};
    const result = parseCsv(damaged, options);
    assert.ok(Array.isArray(result.records) && Number.isInteger(result.dropped) && result.dropped >= 0);
    assert.equal(new Set(result.columns).size, result.columns.length, `a column named twice: ${result.columns.join()}`);
    for (const record of result.records)
      for (const [key, value] of Object.entries(record)) {
        assert.equal(typeof value, 'string');
        // A cell beyond the header's columns is kept under its position.
        assert.ok(result.columns.includes(key) || /^_\d+$/.test(key), `${key} is not a column`);
      }
  }
});

test('a damaged transit feed is decoded or refused as a feed, and its numbers are numbers', () => {
  const next = rng(19);
  let decoded = 0;
  let refused = 0;
  for (const file of ['vehicles.pb', 'trip-updates-only.pb', 'empty.pb']) {
    const source = bytes(file);
    decodeGtfsRealtime(source);
    for (let i = 0; i < 4000; i++) {
      let b = source.slice();
      const times = 1 + Math.floor(next() * 3);
      for (let k = 0; k < times; k++) {
        const at = Math.floor(next() * b.length);
        const roll = next();
        if (roll < 0.25) b = b.slice(0, at);
        else if (roll < 0.6 && b.length) b[at] = Math.floor(next() * 256);
        else if (roll < 0.8 && b.length) b[at] = pickByte(next);
        else {
          const extra = new Uint8Array(1 + Math.floor(next() * 12)).map(() => pickByte(next));
          const joined = new Uint8Array(b.length + extra.length);
          joined.set(b.subarray(0, at));
          joined.set(extra, at);
          joined.set(b.subarray(at), at + extra.length);
          b = joined;
        }
      }
      const started = performance.now();
      try {
        const feed = decodeGtfsRealtime(b);
        decoded++;
        assert.ok(Number.isInteger(feed.entities) && feed.entities >= 0);
        JSON.stringify(feed, (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`not a number: ${value}`);
          if (typeof value === 'bigint') throw new Error('a bigint, which JSON refuses');
          return value;
        });
      } catch (error) {
        assert.ok(
          error instanceof GtfsRealtimeError,
          `threw ${String(error)} on ${Buffer.from(b).toString('hex').slice(0, 200)}`,
        );
        refused++;
      }
      assert.ok(performance.now() - started < 2000);
    }
  }
  assert.ok(decoded > 500 && refused > 500, `${decoded} decoded, ${refused} refused`);
});

/** Bytes a length-prefixed format is most easily led astray by. */
function pickByte(next: () => number): number {
  const list = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x08, 0x0a, 0x12, 0x1a, 0x0d, 0x09, 0x0b, 0x0c, 0x0f];
  return list[Math.floor(next() * list.length)]!;
}
