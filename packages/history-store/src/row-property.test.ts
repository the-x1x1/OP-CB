import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationSchema, type Observation } from '@opcb/world-model';
import { isHistoryRow, lineToRow, observationToRow, rowToLine, rowToObservation } from './row.js';
import { aircraftObs } from '../test/helpers/fixtures.js';

/**
 * A property of the history: any observation the world model accepts can be written as a row,
 * the row is one the reader accepts, a line of the file reads back as the same row, and the
 * observation rebuilt from it is again one the world model accepts, at the same time and place
 * with the same payload and shape. Observations are generated from a fixed seed.
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

const ring = [
  [-158, 21],
  [-157, 21],
  [-157, 22],
  [-158, 21],
];
const TIMES = [
  '2026-11-19T10:00:00Z',
  '2026-11-19T10:00:00.5Z',
  '2026-11-19T10:00:00.123Z',
  '1970-01-01T00:00:00Z',
  '2026-12-31T23:59:59.999Z',
  '2026-02-28T12:00:00.000Z',
];
const PAYLOADS: unknown[] = [
  'text',
  '',
  'line\nbreak',
  'quote " and \\ slash',
  'tab\there',
  '\u2028',
  'café 東京',
  'x'.repeat(3000),
  0,
  -0,
  1.5,
  -1e300,
  1e-300,
  9_007_199_254_740_991,
  true,
  false,
  null,
  [],
  [1, 'a', null, [2]],
  {},
  { nested: { deep: [1, { k: 'v' }] } },
  { __proto__x: 1, constructor: 'c', toString: 't' },
];
const GEOMETRIES: unknown[] = [
  undefined,
  undefined,
  { type: 'Point', coordinates: [-157.8, 21.3] },
  { type: 'Point', coordinates: [180, -90, 12] },
  { type: 'LineString', coordinates: ring },
  { type: 'Polygon', coordinates: [ring] },
  { type: 'MultiPolygon', coordinates: [[ring], [ring]] },
  { type: 'MultiPoint', coordinates: [] },
];

/** As JSON carries it: a file has no minus zero, so -0 is read back as 0. */
const asStored = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function candidate(next: () => number, i: number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const base = aircraftObs(`a${i}`, pick(TIMES), 0, 0) as unknown as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  for (let k = 0; k < Math.floor(next() * 8); k++)
    payload[pick(['name', 'speedMps', 'callsign', 'status', 'note', 'k1', 'k2', 'a b', 'é', 'constructor'])] =
      pick(PAYLOADS);
  const position =
    next() < 0.8
      ? {
          latitude: pick([0, -0, 90, -90, 21.3, (next() * 2 - 1) * 90]),
          longitude: pick([0, 180, -180, -157.8, (next() * 2 - 1) * 180]),
          ...(next() < 0.5 ? { altitudeM: pick([0, -400, 10_668, 35_786_000, next() * 12_000]) } : {}),
        }
      : undefined;
  const geometry = pick(GEOMETRIES);
  const out: Record<string, unknown> = { ...base, receivedAt: '2027-01-01T00:00:00.000Z', payload };
  delete out['position'];
  delete out['geometry'];
  delete out['rawPayloadHash'];
  if (position) out['position'] = position;
  if (geometry) out['geometry'] = geometry;
  if (next() < 0.2) delete out['externalId'];
  if (next() < 0.3) out['rawPayloadHash'] = 'ab'.repeat(32);
  return out;
}

test('history row property: every observation the world model accepts survives the round trip to a line and back', () => {
  const next = rng(1120);
  const problems: string[] = [];
  let checked = 0;
  let placed = 0;
  for (let i = 0; i < 3000; i++) {
    const parsed = observationSchema.parse(candidate(next, i), '');
    if (!parsed.ok) continue;
    const obs: Observation = parsed.value;
    checked++;
    const where = `#${i} ${JSON.stringify(obs).slice(0, 200)}`;
    const includeRawHash = next() < 0.5;
    let row;
    try {
      row = observationToRow(obs, `aircraft:icao24:a${i}`, { includeRawHash });
    } catch (err) {
      problems.push(`${where}: observationToRow threw ${String(err).slice(0, 80)}`);
      continue;
    }
    if (!isHistoryRow(row)) {
      problems.push(`${where}: its own row is not one the reader accepts`);
      continue;
    }
    const line = rowToLine(row);
    if (line.includes('\n')) problems.push(`${where}: a line with a line break in it`);
    const back = lineToRow(line);
    try {
      assert.deepEqual(back, asStored(row));
    } catch {
      problems.push(`${where}: the line reads back as another row`);
      continue;
    }
    const again = rowToObservation(back!, { sourceName: 'x' });
    const ok = observationSchema.parse(again, '');
    if (!ok.ok) {
      problems.push(
        `${where}: the rebuilt observation is refused: ${ok.issues
          .map((x) => `${x.path} ${x.message}`)
          .join('; ')
          .slice(0, 160)}`,
      );
      continue;
    }
    if (Date.parse(again.observedAt) !== Date.parse(obs.observedAt))
      problems.push(`${where}: observed at ${again.observedAt}`);
    try {
      assert.deepEqual(again.payload, asStored(obs.payload));
      assert.deepEqual(again.geometry, asStored(obs.geometry));
      if (obs.position) {
        placed++;
        assert.deepEqual(
          again.position,
          asStored({
            latitude: obs.position.latitude,
            longitude: obs.position.longitude,
            ...(obs.position.altitudeM !== undefined ? { altitudeM: obs.position.altitudeM } : {}),
          }),
        );
      }
      assert.equal(again.externalId, obs.externalId);
      assert.equal(again.rawPayloadHash, includeRawHash ? obs.rawPayloadHash : undefined);
    } catch (err) {
      problems.push(
        `${where}: ${String((err as Error).message)
          .split('\n')
          .slice(0, 6)
          .join(' | ')
          .slice(0, 300)}`,
      );
    }
  }
  assert.deepEqual(problems.slice(0, 8), [], `${problems.length} of ${checked}`);
  assert.ok(checked > 1500 && placed > 1000, `${checked} observations checked, ${placed} with a position`);
});
