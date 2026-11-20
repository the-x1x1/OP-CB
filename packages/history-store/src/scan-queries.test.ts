import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore, NdjsonBackend, type HistoryRow, type PartitionMeta } from './index.js';
import {
  availabilityFromMetas,
  countsToList,
  inRange,
  isNewer,
  lineMayBeLatest,
  lineWithin,
  lookbackRange,
  normalRange,
  peekRowString,
  rangeFilter,
  reduceCounts,
  reduceLatestPerObject,
  rowInBounds,
  rowInRegion,
  rowMatchesRange,
  sortByObjectId,
  sortByObservedAt,
} from './scan-queries.js';
import { mergeAvailability, parsePartitionId, partitionId, partitionMatches } from './partition.js';
import { rowFingerprint } from './dedupe.js';
import { rowToLine } from './row.js';
import { testing } from '@opcb/provider-sdk';
import { AIRCRAFT_PROVIDER, OPEN_POLICY, aircraftObs, batch, policies, tempDir } from '../test/helpers/fixtures.js';

const T0 = '2026-09-21T08:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

function row(objectId: string, observedAt: string, extra: Partial<HistoryRow> = {}): HistoryRow {
  return {
    observationId: `${objectId}@${observedAt}`,
    objectId,
    providerId: 'p',
    objectType: objectId.split(':')[0]!,
    observedAt,
    receivedAt: observedAt,
    payloadJson: '{}',
    origin: 'live',
    ...extra,
  };
}

test('normalRange: bounds take the stored form, and a range already in it is returned as it is', () => {
  const stored = { start: T0, end: at(60) };
  assert.equal(normalRange(stored), stored);
  assert.deepEqual(normalRange({ start: '2026-09-21T08:00:00Z', end: '2026-09-21T08:01:00.5Z' }), {
    start: '2026-09-21T08:00:00.000Z',
    end: '2026-09-21T08:01:00.500Z',
  });
  // An unreadable bound is left alone rather than thrown on.
  assert.deepEqual(normalRange({ start: 'soon', end: at(1) }), { start: 'soon', end: at(1) });
});

test('inRange: both ends belong to the range', () => {
  const range = { start: T0, end: at(60) };
  assert.equal(inRange(row('aircraft:a', T0), range), true);
  assert.equal(inRange(row('aircraft:a', at(60)), range), true);
  assert.equal(inRange(row('aircraft:a', at(-0.001)), range), false);
  assert.equal(inRange(row('aircraft:a', at(60.001)), range), false);
});

test('a range written without milliseconds reads the same rows as one written with them', async () => {
  const dataDir = await tempDir();
  const clock = new testing.VirtualClock(Date.parse(at(3600)));
  const backend = new NdjsonBackend({ dataDir, clock });
  const store = new HistoryStore({ dataDir, backend, clock, policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY }) });
  await store.open();
  const seconds = [-0.5, 0, 30, 60, 60.5];
  await store.writeBatch(
    batch(
      AIRCRAFT_PROVIDER,
      seconds.map((s, i) => aircraftObs('abc123', at(s), 10 + i, 20)),
    ),
  );
  await store.flush();
  const objectId = (await store.objectsAt(at(120), { lookbackSeconds: 600 }))[0]!.objectId;
  const exact = { start: T0, end: at(60) };
  const short = { start: '2026-09-21T08:00:00Z', end: '2026-09-21T08:01:00Z' };
  const want = [T0, at(30), at(60)];
  assert.deepEqual(
    (await store.track(objectId, exact)).map((p) => p.observedAt),
    want,
  );
  assert.deepEqual(
    (await store.track(objectId, short)).map((p) => p.observedAt),
    want,
  );
  assert.deepEqual(await backend.counts({ range: short }), await backend.counts({ range: exact }));
  assert.equal((await backend.counts({ range: short }))[0]!.rows, 3);
  assert.deepEqual(
    (await backend.observationsInRange({ range: short })).map((r) => r.observedAt),
    want,
  );
  await store.close();
});

test('lookbackRange: ends at the cursor and never starts after it', () => {
  assert.deepEqual(lookbackRange(at(600), 600), { start: T0, end: at(600) });
  assert.deepEqual(lookbackRange('2026-09-21T08:00:00Z', 0), { start: T0, end: T0 });
  assert.deepEqual(lookbackRange(T0, -5), { start: T0, end: T0 });
});

test('rowInBounds and rowInRegion: no filter passes every row, a filter needs a position', () => {
  const bounds = { west: 170, south: -10, east: -170, north: 10 };
  const placed = row('aircraft:a', T0, { lat: 0, lon: 179 });
  const across = row('aircraft:b', T0, { lat: 0, lon: -179 });
  const outside = row('aircraft:c', T0, { lat: 0, lon: 0 });
  const unplaced = row('aircraft:d', T0);
  assert.equal(rowInBounds(unplaced, undefined), true);
  assert.equal(rowInBounds(unplaced, bounds), false);
  assert.deepEqual(
    [placed, across, outside].map((r) => rowInBounds(r, bounds)),
    [true, true, false],
  );
  const circle = { kind: 'circle' as const, center: { latitude: 0, longitude: 180 }, radiusM: 200_000 };
  assert.equal(rowInRegion(unplaced, undefined), true);
  assert.equal(rowInRegion(unplaced, circle), false);
  assert.deepEqual(
    [placed, across, outside].map((r) => rowInRegion(r, circle)),
    [true, true, false],
  );
  assert.equal(rowMatchesRange(placed, { range: { start: T0, end: T0 }, region: circle }), true);
  assert.equal(rowMatchesRange(outside, { range: { start: T0, end: T0 }, region: circle }), false);
  assert.equal(rowMatchesRange(placed, { range: { start: at(1), end: at(2) }, region: circle }), false);
});

test('isNewer: observed time, then received time, then observation id; never both ways', () => {
  const a = row('aircraft:a', T0);
  assert.equal(isNewer(row('aircraft:a', at(1)), a), true);
  assert.equal(isNewer(a, row('aircraft:a', at(1))), false);
  assert.equal(isNewer({ ...a, receivedAt: at(5) }, a), true);
  assert.equal(isNewer({ ...a, observationId: 'z' }, { ...a, observationId: 'y' }), true);
  assert.equal(isNewer(a, a), false);
  const rows = [a, { ...a, receivedAt: at(5) }, { ...a, observationId: 'z' }, row('aircraft:a', at(1))];
  for (const x of rows) for (const y of rows) assert.ok(!(isNewer(x, y) && isNewer(y, x)));
});

test('reduceLatestPerObject: the answer does not depend on the order rows arrive in', () => {
  const rows = [
    row('aircraft:a', T0),
    row('aircraft:a', at(10)),
    row('aircraft:a', at(10), { receivedAt: at(11) }),
    row('aircraft:b', at(3)),
    row('vessel:c', at(-4)),
  ];
  const forwards = reduceLatestPerObject(rows);
  const backwards = reduceLatestPerObject([...rows].reverse());
  assert.equal(forwards.size, 3);
  assert.equal(forwards.get('aircraft:a')!.receivedAt, at(11));
  for (const [id, r] of forwards) assert.deepEqual(backwards.get(id), r);
  // Filling an existing map keeps what is newer in it.
  const into = new Map([['aircraft:b', row('aircraft:b', at(99))]]);
  assert.equal(reduceLatestPerObject(rows, into), into);
  assert.equal(into.get('aircraft:b')!.observedAt, at(99));
});

test('sortByObjectId and sortByObservedAt: in place, and ties on time go by observation id', () => {
  const rows = [row('b:2', at(2)), row('a:1', at(2)), row('c:3', at(1))];
  assert.equal(sortByObjectId(rows), rows);
  assert.deepEqual(
    rows.map((r) => r.objectId),
    ['a:1', 'b:2', 'c:3'],
  );
  sortByObservedAt(rows);
  assert.deepEqual(
    rows.map((r) => r.objectId),
    ['c:3', 'a:1', 'b:2'],
  );
});

test('peekRowString: reads a plain top-level string, and declines anything it would have to parse', () => {
  const tricky = row('aircraft:a', T0, {
    payloadJson: JSON.stringify({ objectId: 'aircraft:decoy', observedAt: '1999-01-01T00:00:00.000Z' }),
    geometryJson: '{"observedAt":"1999"}',
  });
  // Put the payload first, so a decoy inside it comes before the real fields on the line.
  const { payloadJson, geometryJson, ...rest } = tricky;
  const line = JSON.stringify({ payloadJson, geometryJson, ...rest });
  assert.equal(peekRowString(line, 'objectId'), 'aircraft:a');
  assert.equal(peekRowString(line, 'observedAt'), T0);
  assert.equal(peekRowString(line, 'missing'), undefined);
  assert.equal(peekRowString(JSON.stringify(row('aircraft:a\\"x', T0)), 'objectId'), undefined);
  assert.equal(peekRowString(JSON.stringify(row('aircraft:é', T0)), 'objectId'), 'aircraft:é');
  assert.equal(peekRowString('{"objectId":"cut off', 'objectId'), undefined);
  assert.equal(peekRowString(rowToLine(tricky), 'objectId'), 'aircraft:a');
});

test('lineWithin and lineMayBeLatest never skip a line the parsed row would have passed', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const ids = ['aircraft:a', 'aircraft:b"q', 'aircraft:\\c', 'vessel:d'];
  const range = { start: at(100), end: at(200) };
  const latest = new Map<string, HistoryRow>();
  const keepLatest = lineMayBeLatest(range, latest);
  const reference = new Map<string, HistoryRow>();
  for (let i = 0; i < 3_000; i++) {
    const id = ids[Math.floor(random() * ids.length)]!;
    const r = row(id, at(Math.floor(random() * 300)), { payloadJson: JSON.stringify({ observedAt: at(150), n: i }) });
    const line = rowToLine(r);
    assert.ok(!inRange(r, range) || lineWithin(range)(line));
    assert.ok(!(inRange(r, range) && r.objectId === id) || lineWithin(range, id)(line));
    if (r.objectId !== 'vessel:d') assert.equal(lineWithin(range, 'vessel:d')(line) && !line.includes('\\'), false);
    if (keepLatest(line) && inRange(r, range)) reduceLatestPerObject([r], latest);
    if (inRange(r, range)) reduceLatestPerObject([r], reference);
  }
  assert.equal(latest.size, ids.length);
  for (const [id, r] of reference) assert.deepEqual(latest.get(id), r);
  // A line with no readable time is handed to the parser.
  assert.equal(lineWithin(range)('not json'), true);
  assert.equal(keepLatest('{"observedAt":"yesterday"}'), true);
});

const meta = (objectType: string, min: string, max: string, rows = 1, providerId = 'p'): PartitionMeta => ({
  objectType,
  providerId,
  day: min.slice(0, 10),
  slot: `${min.slice(11, 13)}00`,
  id: partitionId({ objectType, providerId, day: min.slice(0, 10), slot: `${min.slice(11, 13)}00` }),
  minObservedAt: min,
  maxObservedAt: max,
  rows,
  originalRows: rows,
  bytes: 1,
  updatedAt: max,
});

test('mergeAvailability: joins partitions within the gap tolerance, skips empty ones, any order', () => {
  const metas = [
    meta('aircraft', at(7200), at(7300)),
    meta('aircraft', at(0), at(100)),
    meta('aircraft', at(160), at(400)),
    meta('aircraft', at(200), at(300)),
    meta('aircraft', at(500), at(600), 0),
  ];
  assert.deepEqual(mergeAvailability(metas, 60_000), [
    { start: at(0), end: at(400) },
    { start: at(7200), end: at(7300) },
  ]);
  assert.deepEqual(mergeAvailability(metas, 59_999).length, 3);
  assert.deepEqual(mergeAvailability([], 60_000), []);
  // The inputs are not changed.
  assert.equal(metas[1]!.maxObservedAt, at(100));
});

test('availabilityFromMetas: one entry per type asked for, in name order, empty when nothing is stored', () => {
  const metas = [meta('vessel', at(0), at(10)), meta('aircraft', at(0), at(10)), meta('earthquake', at(5), at(6))];
  assert.deepEqual(
    availabilityFromMetas(metas, undefined, 0).map((a) => a.objectType),
    ['aircraft', 'earthquake', 'vessel'],
  );
  assert.deepEqual(availabilityFromMetas(metas, ['vessel', 'satellite'], 0), [
    { objectType: 'satellite', ranges: [] },
    { objectType: 'vessel', ranges: [{ start: at(0), end: at(10) }] },
  ]);
});

test('partitionMatches and rangeFilter: type, provider and overlap, touching ends included', () => {
  const m = meta('aircraft', at(0), at(100));
  assert.equal(partitionMatches(m, undefined), true);
  assert.equal(partitionMatches(m, { objectTypes: ['vessel'] }), false);
  assert.equal(partitionMatches(m, { providerIds: ['p'] }), true);
  assert.equal(partitionMatches(m, { providerIds: ['q'] }), false);
  assert.equal(partitionMatches(m, { overlapping: { start: at(100), end: at(200) } }), true);
  assert.equal(partitionMatches(m, { overlapping: { start: at(-50), end: at(0) } }), true);
  assert.equal(partitionMatches(m, { overlapping: { start: at(100.001), end: at(200) } }), false);
  assert.equal(partitionMatches(m, { overlapping: { start: at(-50), end: at(-0.001) } }), false);
  const range = { start: at(0), end: at(1) };
  assert.deepEqual(rangeFilter({ range }), { overlapping: range });
  assert.deepEqual(rangeFilter({ range, objectTypes: ['a'], providerIds: ['p'] }), {
    overlapping: range,
    objectTypes: ['a'],
    providerIds: ['p'],
  });
});

test('parsePartitionId: the inverse of partitionId, hyphens in a provider id included', () => {
  for (const key of [
    { objectType: 'aircraft', providerId: 'adsb-remote', day: '2026-09-21', slot: '0800' },
    { objectType: 'weather.alert', providerId: 'x-1234', day: '2026-01-01', slot: '0000' },
  ])
    assert.deepEqual(parsePartitionId(partitionId(key)), key);
  for (const bad of [
    '',
    'aircraft/2026-09-21/p',
    'aircraft/2026-9-21/p-0800',
    '../2026-09-21/p-0800',
    'a/2026-09-21/P-0800',
  ])
    assert.equal(parsePartitionId(bad), undefined);
});

test('reduceCounts and countsToList: rows and distinct objects per type, zero for a type with none', () => {
  const counts = reduceCounts([
    row('aircraft:a', T0),
    row('aircraft:a', at(1)),
    row('aircraft:b', T0),
    row('vessel:c', T0),
  ]);
  assert.deepEqual(countsToList(counts, undefined), [
    { objectType: 'aircraft', objects: 2, rows: 3 },
    { objectType: 'vessel', objects: 1, rows: 1 },
  ]);
  assert.deepEqual(countsToList(counts, ['vessel', 'satellite']), [
    { objectType: 'vessel', objects: 1, rows: 1 },
    { objectType: 'satellite', objects: 0, rows: 0 },
  ]);
  assert.equal(reduceCounts([row('vessel:d', T0)], counts), counts);
  assert.equal(counts.get('vessel')!.rows, 2);
});

test('rowFingerprint: the source hash decides when there is one, the content when there is not', () => {
  const a = row('satellite:1', T0, { lat: 1, lon: 2, rawPayloadHash: 'h1' });
  assert.equal(rowFingerprint({ ...a, lat: 50, lon: 60 }), rowFingerprint(a));
  assert.notEqual(rowFingerprint({ ...a, rawPayloadHash: 'h2' }), rowFingerprint(a));
  const plain = row('aircraft:a', T0, { lat: 1, lon: 2 });
  assert.equal(rowFingerprint({ ...plain }), rowFingerprint(plain));
  assert.notEqual(rowFingerprint({ ...plain, lat: 1.0001 }), rowFingerprint(plain));
  assert.notEqual(rowFingerprint({ ...plain, payloadJson: '{"a":1}' }), rowFingerprint(plain));
  assert.notEqual(rowFingerprint({ ...plain, observationId: 'other' }), rowFingerprint(plain));
  assert.ok(Number.isSafeInteger(rowFingerprint(plain)));
});
