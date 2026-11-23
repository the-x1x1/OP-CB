import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationSchema, type Observation } from '@opcb/world-model';
import { ADSB_LOL_MANIFEST, normalizeAircraftRows, parseAdsbLolResponse } from '@opcb/provider-adsb-remote';
import { CircularOrbitPropagator, normalizeElements, parseOmmJson } from '@opcb/provider-celestrak';
import {
  AISSTREAM_MANIFEST,
  DIGITRAFFIC_AIS_MANIFEST,
  locationToDraft,
  normalizeAisEnvelope,
  parseLocations,
  parseVessels,
  vesselStatic,
  type VesselStatic,
} from '@opcb/provider-ais';
import { normalizeFirmsRows, parseFirmsCsv } from '@opcb/provider-firms';
import { SEED_AIRPORTS_MANIFEST, normalizeAirportCollection } from '@opcb/provider-infrastructure';
import { normalizeCurrentStorms } from '@opcb/provider-nhc';
import { PURPLEAIR_LOCAL_MANIFEST, normalizeSensorJson } from '@opcb/provider-purpleair-local';
import { buildObservation } from '@opcb/provider-sdk';
import { normalizeUsgsFeed } from '@opcb/provider-usgs';
import { normalizeNwsAlerts } from '@opcb/provider-weather';
import {
  WEATHERLINK_LOCAL_MANIFEST,
  normalizeConditions,
  parseCurrentConditions,
} from '@opcb/provider-weatherlink-local';

/**
 * Each built-in source's answer, as recorded, with parts of it changed: a value swapped for
 * another kind of value, a member taken out, a list emptied or doubled. A service can change
 * its answer on any day, and the reader must then do one of two things with each record:
 * admit an observation the world model accepts, or reject the record with a reason. It may
 * not throw and it may not admit anything else. Changes are generated from a fixed seed.
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

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');
const load = (...parts: string[]): unknown => JSON.parse(readFileSync(path.join(fixtures, ...parts), 'utf8'));

const AWKWARD: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  -1,
  1,
  90,
  -90,
  91,
  180,
  181,
  -181,
  1e308,
  -1e308,
  1e-320,
  0.1,
  999_999,
  1_795_000_000,
  1_795_000_000_000,
  Number.MAX_SAFE_INTEGER + 2,
  '',
  ' ',
  '0',
  '-1',
  '1e999',
  'NaN',
  'null',
  'x',
  'constructor',
  '__proto__',
  'x'.repeat(5000),
  '2026-11-20T00:00:00Z',
  '2026-13-45T99:99:99Z',
  '0000-00-00',
  'ground',
  [],
  [null],
  [1, 2],
  [-157.8, 21.3],
  [[]],
  {},
  { type: 'Point', coordinates: [500, 500] },
  { type: 'Polygon', coordinates: [] },
  { value: 5 },
];

type Path = Array<string | number>;

/** Every place in a JSON document a value sits, parents before children. */
function places(node: unknown, at: Path = [], out: Path[] = []): Path[] {
  out.push(at);
  if (Array.isArray(node)) node.forEach((child, i) => places(child, [...at, i], out));
  else if (node && typeof node === 'object')
    for (const [key, child] of Object.entries(node)) places(child, [...at, key], out);
  return out;
}

function changed(good: unknown, next: () => number): unknown {
  const doc = structuredClone(good);
  const all = places(doc).filter((p) => p.length > 0);
  const times = 1 + Math.floor(next() * 4);
  for (let k = 0; k < times; k++) {
    const at = all[Math.floor(next() * all.length)]!;
    let parent = doc as Record<string | number, unknown> | undefined;
    for (const step of at.slice(0, -1)) {
      const child: unknown = parent?.[step];
      parent = child && typeof child === 'object' ? (child as Record<string | number, unknown>) : undefined;
    }
    if (!parent) continue; // an earlier change took this place away
    const key = at[at.length - 1]!;
    const roll = next();
    if (roll < 0.15) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (roll < 0.25 && Array.isArray(parent[key])) {
      const list = parent[key] as unknown[];
      parent[key] = next() < 0.5 ? [...list, ...list] : [];
    } else if (roll < 0.35 && typeof parent[key] === 'number') {
      parent[key] = (parent[key] as number) * [-1, 0, 1e6, 1e-6, 1e300][Math.floor(next() * 5)]!;
    } else if (roll < 0.45 && typeof parent[key] === 'string') {
      const text = parent[key] as string;
      parent[key] = [
        text.toUpperCase(),
        ` ${text} `,
        text.slice(0, Math.floor(text.length / 2)),
        text + text,
        `${text}\u0000`,
      ][Math.floor(next() * 5)]!;
    } else parent[key] = structuredClone(AWKWARD[Math.floor(next() * AWKWARD.length)]);
  }
  return doc;
}

interface Read {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

function hold(name: string, good: unknown, read: (payload: unknown) => Read, seed: number, count: number): void {
  const whole = read(good);
  assert.ok(whole.observations.length > 0, `${name}: the recorded answer itself gives observations`);
  const next = rng(seed);
  let admitted = 0;
  let rejected = 0;
  for (let i = 0; i < count; i++) {
    const payload = changed(good, next);
    let result: Read;
    try {
      result = read(payload);
    } catch (error) {
      assert.fail(`${name} threw ${error instanceof Error ? error.stack : String(error)}`);
    }
    for (const observation of result.observations) {
      const parsed = observationSchema.parse(observation);
      assert.ok(
        parsed.ok,
        `${name} admitted what the world model refuses: ${JSON.stringify(parsed).slice(0, 300)} ${JSON.stringify(observation).slice(0, 400)}`,
      );
    }
    assert.equal(
      new Set(result.observations.map((o) => o.id)).size,
      result.observations.length,
      `${name}: an id twice`,
    );
    for (const r of result.rejected)
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${name}: no reason`);
    assert.ok(Number.isInteger(result.total) && result.total >= 0, `${name}: total ${result.total}`);
    admitted += result.observations.length;
    rejected += result.rejected.length;
  }
  // Both happened: changes that never spoiled a record, or spoiled them all, would test little.
  assert.ok(admitted > count / 4 && rejected > count / 20, `${name}: ${admitted} admitted, ${rejected} rejected`);
}

test('earthquakes: a changed answer is admitted record by record or rejected with a reason', () => {
  hold(
    'usgs',
    load('usgs', 'normal.geojson'),
    (p) => normalizeUsgsFeed(p, { receivedAt: '2026-09-21T08:05:00.000Z' }),
    1,
    3000,
  );
});

test('storms: a changed answer is admitted record by record or rejected with a reason', () => {
  const nowMs = Date.parse('2026-09-23T04:00:00Z');
  hold(
    'nhc',
    load('nhc', 'normal.json'),
    (p) => normalizeCurrentStorms(p, { receivedAt: new Date(nowMs).toISOString(), nowMs }),
    2,
    3000,
  );
});

test('weather alerts: a changed answer is admitted record by record or rejected with a reason', () => {
  const nowMs = Date.parse('2026-09-21T08:05:00Z');
  hold(
    'nws',
    load('weather', 'normal.geojson'),
    (p) => normalizeNwsAlerts(p, { receivedAt: new Date(nowMs).toISOString(), nowMs }),
    3,
    3000,
  );
});

test('aircraft: a changed answer is admitted record by record or rejected with a reason', () => {
  const nowMs = Date.parse('2026-09-21T08:00:00.000Z');
  hold(
    'adsb',
    load('adsb-lol', 'normal.json'),
    (p) => {
      const parsed = parseAdsbLolResponse(p);
      // An answer that is not one at all: the provider reports it and admits nothing.
      if (typeof parsed === 'string') return { observations: [], total: 0, rejected: [{ index: -1, reason: parsed }] };
      return normalizeAircraftRows(parsed.rows, ADSB_LOL_MANIFEST, {
        nowMs: parsed.nowMs,
        receivedAt: new Date(nowMs).toISOString(),
        sourceQuality: 'crowdsourced',
      });
    },
    4,
    3000,
  );
});

test('satellites: changed elements are admitted or rejected with a reason', () => {
  const good = load('celestrak', 'normal.json');
  const first = parseOmmJson(good).elements[0];
  assert.ok(first, 'the recorded catalogue has elements');
  const nowMs = Date.parse(first.epoch) + 3_600_000;
  // The circular propagator only: SGP4 comes from satellite.js, which the provider loads when
  // it is installed, and its handling of wild elements is that library's own.
  const propagator = new CircularOrbitPropagator();
  hold(
    'celestrak',
    good,
    (p) => {
      const parsed = parseOmmJson(p);
      const result = normalizeElements(parsed.elements, {
        receivedAt: new Date(nowMs).toISOString(),
        nowMs,
        propagator,
        group: 'stations',
      });
      return { ...result, rejected: [...parsed.rejected, ...result.rejected], total: parsed.total };
    },
    5,
    3000,
  );
});

test('airports: a changed dataset is admitted record by record or rejected with a reason', () => {
  hold(
    'airports',
    load('airports', 'seed-airports.geojson'),
    (p) => {
      const result = normalizeAirportCollection(p, SEED_AIRPORTS_MANIFEST, { receivedAt: '2026-09-21T08:00:00.000Z' });
      return typeof result === 'string'
        ? { observations: [], total: 0, rejected: [{ index: -1, reason: result }] }
        : result;
    },
    6,
    2000,
  );
});

test('an air sensor: a changed answer gives one observation or one reason', () => {
  const nowMs = Date.parse('2026-09-23T20:00:00.000Z');
  hold(
    'purpleair',
    load('purpleair-local', 'normal.json'),
    (p) => {
      const result = normalizeSensorJson(p, PURPLEAIR_LOCAL_MANIFEST, {
        receivedAt: new Date(nowMs).toISOString(),
        nowMs,
        name: 'Porch',
      });
      return 'error' in result
        ? { observations: [], total: 1, rejected: [{ index: 0, reason: result.error }] }
        : { observations: [result.observation], total: 1, rejected: [] };
    },
    7,
    4000,
  );
});

test('ships: a changed frame is an observation, ignored, an error or malformed with a reason', () => {
  const receivedAt = '2026-09-21T08:00:00.000Z';
  for (const frame of [
    '01-position-report.json',
    '02-position-heading-511.json',
    '03-position-anchored.json',
    '04-ship-static-data.json',
  ])
    hold(
      `ais ${frame}`,
      load('aisstream', 'frames', frame),
      (p) => {
        const result = normalizeAisEnvelope(p, { receivedAt });
        if (result.kind === 'observation')
          return {
            observations: [buildObservation(AISSTREAM_MANIFEST, receivedAt, result.draft)],
            total: 1,
            rejected: [],
          };
        const reason =
          result.kind === 'malformed' ? result.reason : result.kind === 'error' ? result.message || 'error' : 'ignored';
        return { observations: [], total: 1, rejected: [{ index: 0, reason }] };
      },
      8,
      2000,
    );
});

test('ships by request: changed locations and vessel details are admitted or rejected with a reason', () => {
  const nowMs = Date.parse('2026-09-28T10:00:00.000Z');
  const receivedAt = new Date(nowMs).toISOString();
  hold(
    'digitraffic',
    { locations: load('digitraffic-ais', 'locations.json'), vessels: load('digitraffic-ais', 'vessels.json') },
    (p) => {
      const both = (p && typeof p === 'object' ? p : {}) as { locations?: unknown; vessels?: unknown };
      const statics = new Map<string, VesselStatic>();
      const vessels = parseVessels(both.vessels);
      if (typeof vessels !== 'string')
        for (const row of vessels) {
          const one = vesselStatic(row);
          if (one) statics.set(one.mmsi, one.fields);
        }
      const locations = parseLocations(both.locations);
      if (typeof locations === 'string')
        return { observations: [], total: 0, rejected: [{ index: -1, reason: locations }] };
      const observations: Observation[] = [];
      const rejected: Array<{ index: number; reason: string }> = [];
      const seen = new Set<string>();
      locations.forEach((feature, index) => {
        const result = locationToDraft(feature, statics, { receivedAt, nowMs });
        if (result.kind === 'rejected') rejected.push({ index, reason: result.reason });
        else if (!seen.has(result.draft.externalId)) {
          // The provider keeps one report per ship; a doubled list is not two ships.
          seen.add(result.draft.externalId);
          observations.push(buildObservation(DIGITRAFFIC_AIS_MANIFEST, receivedAt, result.draft));
        }
      });
      return { observations, total: locations.length, rejected };
    },
    9,
    3000,
  );
});

test('fires: a changed table is admitted row by row or rejected with a reason', () => {
  const good = readFileSync(path.join(fixtures, 'firms', 'viirs-snpp.csv'), 'utf8');
  const next = rng(10);
  const bits = ['', ',', ',,', '\n', 'NaN', '-999', '999', '1e999', '0', '-', 'n', 'x', '2026-13-45', '9999', '"', ' '];
  let admitted = 0;
  let rejected = 0;
  for (let i = 0; i < 4000; i++) {
    let text = good;
    const times = 1 + Math.floor(next() * 3);
    for (let k = 0; k < times; k++) {
      const at = Math.floor(next() * text.length);
      const len = Math.floor(next() * 12);
      text = text.slice(0, at) + bits[Math.floor(next() * bits.length)]! + text.slice(at + (next() < 0.5 ? 0 : len));
    }
    const parsed = parseFirmsCsv(text);
    if (!parsed) {
      rejected++;
      continue;
    }
    const result = normalizeFirmsRows(parsed.rows, {
      receivedAt: '2026-09-21T08:00:00.000Z',
      source: 'VIIRS_SNPP_NRT',
    });
    for (const observation of result.observations) {
      const checked = observationSchema.parse(observation);
      assert.ok(checked.ok, `firms admitted what the world model refuses: ${JSON.stringify(checked).slice(0, 300)}`);
    }
    for (const r of [...parsed.rejected, ...result.rejected]) assert.ok(r.reason.length > 0);
    admitted += result.observations.length;
    rejected += parsed.rejected.length + result.rejected.length;
  }
  assert.ok(admitted > 1000 && rejected > 200, `${admitted} admitted, ${rejected} rejected`);
});

test('a weather station: a changed answer gives observations or a reason', () => {
  const nowMs = Date.parse('2026-09-23T20:00:00Z');
  for (const file of ['normal.json', 'two-transmitters.json'])
    hold(
      `weatherlink ${file}`,
      load('weatherlink-local', file),
      (p) => {
        const parsed = parseCurrentConditions(p);
        if (typeof parsed === 'string')
          return { observations: [], total: 0, rejected: [{ index: -1, reason: parsed }] };
        return normalizeConditions(parsed, WEATHERLINK_LOCAL_MANIFEST, {
          receivedAt: new Date(nowMs).toISOString(),
          nowMs,
          position: { latitude: 21.3069, longitude: -157.8583 },
          name: 'Roof',
        });
      },
      12,
      3000,
    );
});
