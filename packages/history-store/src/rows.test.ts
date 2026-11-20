import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultIdentityResolver } from '@opcb/identity';
import {
  HISTORY_ROW_COLUMNS,
  PartitionIndex,
  compactRow,
  errorMessage,
  isHistoryRow,
  isValidPartitionKey,
  lineToRow,
  metaToJson,
  normalizeIso,
  observationToRow,
  partitionId,
  reconcileIndex,
  rowToLine,
  rowToObservation,
  rowToWorldObject,
  stripRawHash,
  type HistoryRow,
  type PartitionKey,
} from './index.js';
import { pruneEmptyDirs, walkFiles } from './ndjson-backend.js';
import { aircraftObs, quakeObs, tempDir } from '../test/helpers/fixtures.js';

const T = '2026-09-21T08:00:00.000Z';

test('normalizeIso: any readable time becomes millisecond UTC, an unreadable one throws', () => {
  assert.equal(normalizeIso('2026-09-21T08:00:00Z'), T);
  assert.equal(normalizeIso('2026-09-21T08:00:00.5Z'), '2026-09-21T08:00:00.500Z');
  assert.equal(normalizeIso('2026-09-20T22:00:00-10:00'), T);
  assert.equal(normalizeIso(T), T);
  assert.throws(() => normalizeIso('yesterday'), /invalid timestamp "yesterday"/);
  assert.throws(() => normalizeIso(''), /invalid timestamp/);
});

test('observationToRow: every column from the observation, the raw hash only when allowed', () => {
  const obs = aircraftObs('abc123', '2026-09-21T08:00:00Z', 21.3, -157.9);
  const row = observationToRow(obs, 'aircraft:icao24:abc123', { includeRawHash: true });
  assert.equal(row.observedAt, T);
  assert.equal(row.receivedAt, T);
  assert.deepEqual([row.lat, row.lon, row.altitudeM], [21.3, -157.9, 10_000]);
  assert.equal(row.externalId, 'abc123');
  assert.equal(row.sourceQuality, 'crowdsourced');
  assert.equal(row.origin, 'live');
  assert.equal(row.rawPayloadHash, obs.rawPayloadHash);
  assert.deepEqual(JSON.parse(row.payloadJson), obs.payload);
  assert.ok(isHistoryRow(row));
  assert.equal(observationToRow(obs, 'aircraft:icao24:abc123', { includeRawHash: false }).rawPayloadHash, undefined);
  for (const key of Object.keys(row)) assert.ok((HISTORY_ROW_COLUMNS as readonly string[]).includes(key), key);
});

test('observationToRow: a geometry gives the row its centre; an impossible position gives it none', () => {
  const quake = quakeObs('us1', T, 10, 20, 5.1);
  const { position: _position, ...unplaced } = quake;
  const withGeometry = {
    ...unplaced,
    geometry: { type: 'LineString' as const, coordinates: [[0, 0] as [number, number], [2, 2] as [number, number]] },
  };
  const row = observationToRow(withGeometry, 'earthquake:x', { includeRawHash: false });
  assert.ok(row.lat !== undefined && Math.abs(row.lat - 1) < 0.01);
  assert.ok(row.lon !== undefined && Math.abs(row.lon - 1) < 0.01);
  assert.deepEqual(JSON.parse(row.geometryJson!), withGeometry.geometry);
  const off = observationToRow({ ...quake, position: { latitude: 95, longitude: 20 } }, 'earthquake:x', {
    includeRawHash: false,
  });
  assert.equal(off.lat, undefined);
  assert.equal(off.lon, undefined);
  assert.ok(isHistoryRow(off));
});

test('a row survives the line it is written as, and gives back the observation it came from', () => {
  const obs = aircraftObs('abc123', T, 21.3, -157.9, { note: 'line\nbreak "quoted"  ' });
  const row = observationToRow(obs, 'aircraft:icao24:abc123', { includeRawHash: true });
  const line = rowToLine(row);
  assert.ok(!line.includes('\n'));
  assert.deepEqual(lineToRow(line), row);
  assert.deepEqual(lineToRow(`  ${line}\r`), row);
  const back = rowToObservation(row, { sourceName: 'OpenSky Network' });
  assert.equal(back.id, obs.id);
  assert.deepEqual(back.payload, obs.payload);
  assert.deepEqual(back.position, obs.position);
  assert.equal(back.provenance.origin, 'historical');
  assert.equal(back.provenance.sourceName, 'OpenSky Network');
  assert.equal(back.rawPayloadHash, obs.rawPayloadHash);
});

test('isHistoryRow and lineToRow: what is not a row is refused, never thrown on', () => {
  const good = observationToRow(aircraftObs('abc123', T, 1, 2), 'aircraft:icao24:abc123', { includeRawHash: true });
  const bad: Array<Record<string, unknown>> = [
    { ...good, observationId: '' },
    { ...good, objectId: 5 },
    { ...good, observedAt: '2026-09-21 08:00:00' },
    { ...good, receivedAt: undefined },
    { ...good, payloadJson: {} },
    { ...good, origin: 'invented' },
    { ...good, lat: 91 },
    { ...good, lon: undefined },
    { ...good, altitudeM: Number.NaN },
    { ...good, altitudeM: '10' },
    { ...good, sourceQuality: 'excellent' },
    { ...good, seq: -1 },
    { ...good, seq: 1.5 },
    { ...good, rawPayloadHash: 5 },
    { ...good, geometryJson: {} },
  ];
  for (const v of bad) assert.equal(isHistoryRow(v), false, JSON.stringify(v));
  for (const v of [null, undefined, [], 'row', 5, [good]]) assert.equal(isHistoryRow(v), false);
  for (const line of ['', '   ', '{', 'null', '[]', '"text"', '{"a":1}', `${rowToLine(good)}{`])
    assert.equal(lineToRow(line), undefined, line);
  // A payload that is not an object reads as an empty one.
  assert.deepEqual(rowToObservation({ ...good, payloadJson: '[1,2]' }).payload, {});
  assert.deepEqual(rowToObservation({ ...good, payloadJson: 'not json' }).payload, {});
  assert.equal(rowToObservation({ ...good, geometryJson: 'not json' }).geometry, undefined);
});

test('compactRow: drops nulls and columns that are not the row, and turns a bigint into a number', () => {
  const good = observationToRow(aircraftObs('abc123', T, 1, 2), 'aircraft:icao24:abc123', { includeRawHash: false });
  const fromSql = { ...good, rawPayloadHash: null, geometryJson: null, seq: 3n, extra: 'x', altitudeM: null };
  const row = compactRow(fromSql as Record<string, unknown>);
  assert.ok(row);
  assert.equal(row.seq, 3);
  assert.equal('extra' in row, false);
  assert.equal('rawPayloadHash' in row, false);
  assert.equal('altitudeM' in row, false);
  assert.equal(compactRow({ ...good, observedAt: null } as Record<string, unknown>), undefined);
});

test('stripRawHash: removes the hash in place and says how many rows had one', () => {
  const a = observationToRow(aircraftObs('aaa111', T, 1, 2), 'aircraft:a', { includeRawHash: true });
  const b = observationToRow(aircraftObs('bbb222', T, 1, 2), 'aircraft:b', { includeRawHash: false });
  const rows = [a, b];
  assert.equal(stripRawHash(rows), 1);
  assert.equal('rawPayloadHash' in a, false);
  assert.equal(stripRawHash(rows), 0);
  assert.equal(stripRawHash([]), 0);
});

test('rowToWorldObject: the id, labels and motion the live state would give', () => {
  const obs = aircraftObs('abc123', T, 21.3, -157.9, {
    callsign: ' HAL‮25 \n',
    headingDegrees: 114.8,
    verticalSpeedMps: -3,
  });
  const row = observationToRow(obs, 'ignored', { includeRawHash: false });
  const object = rowToWorldObject(row, defaultIdentityResolver, () => ({ sourceName: 'OpenSky', attribution: 'OSN' }));
  assert.equal(object.id, defaultIdentityResolver.resolve(obs).objectId);
  assert.equal(object.freshness, 'HISTORICAL');
  assert.equal(object.provenance.origin, 'historical');
  assert.equal(object.provenance.attribution, 'OSN');
  // No direction-override character or line break in a label, and no float noise in a heading.
  assert.equal(object.labels['callsign'], 'HAL 25');
  assert.deepEqual(object.motion, { speedMps: 230, headingDegrees: 114.8, verticalSpeedMps: -3 });
  assert.deepEqual(object.position, obs.position);
  assert.deepEqual(object.sourceRefs, [{ observationId: obs.id, providerId: obs.providerId, observedAt: T }]);
  const still = rowToWorldObject(
    observationToRow(quakeObs('us1', T, 10, 20, 5.1), 'x', { includeRawHash: false }),
    defaultIdentityResolver,
  );
  assert.equal(still.motion, undefined);
  assert.equal(
    rowToWorldObject(
      observationToRow(aircraftObs('abc123', T, 1, 2, { headingDegrees: -90 }), 'x', { includeRawHash: false }),
      defaultIdentityResolver,
    ).motion!.headingDegrees,
    270,
  );
});

test('errorMessage and metaToJson', () => {
  assert.equal(errorMessage(new Error('disk full')), 'disk full');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(undefined), 'undefined');
  const meta = {
    objectType: 'aircraft',
    providerId: 'p',
    day: '2026-09-21',
    slot: '0800',
    id: 'aircraft/2026-09-21/p-0800',
    minObservedAt: T,
    maxObservedAt: T,
    rows: 1,
    originalRows: 1,
    bytes: 10,
    updatedAt: T,
  };
  const json = metaToJson(meta);
  assert.deepEqual(json, meta);
  assert.notEqual(json, meta);
});

test('isValidPartitionKey: only names that stay inside the history folder', () => {
  const key = { objectType: 'aircraft', providerId: 'adsb-remote', day: '2026-09-21', slot: '0800' };
  assert.equal(isValidPartitionKey(key), true);
  for (const bad of [
    { ...key, objectType: '../x' },
    { ...key, objectType: 'a/b' },
    { ...key, objectType: '' },
    { ...key, objectType: 'Aircraft' },
    { ...key, providerId: '.hidden' },
    { ...key, providerId: 'a\\b' },
    { ...key, day: '2026-9-21' },
    { ...key, day: '2026-09-21/..' },
    { ...key, slot: '800' },
    { ...key, slot: '08:00' },
  ])
    assert.equal(isValidPartitionKey(bad), false, JSON.stringify(bad));
});

test('the partition index skips an entry whose key is not a partition, and reports it', async () => {
  const root = await tempDir();
  const key: PartitionKey = { objectType: 'aircraft', providerId: 'p', day: '2026-09-21', slot: '0800' };
  const entry = {
    ...key,
    id: partitionId(key),
    minObservedAt: T,
    maxObservedAt: T,
    rows: 1,
    originalRows: 1,
    bytes: 10,
    updatedAt: T,
  };
  await fs.writeFile(
    path.join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      backend: 'ndjson',
      partitions: [
        entry,
        { ...entry, objectType: '../../outside', id: '../../outside/2026-09-21/p-0800' },
        { ...entry, id: 'aircraft/2026-09-22/p-0800' },
        { ...entry, rows: 'many' },
        null,
      ],
    }),
  );
  const index = new PartitionIndex(root, 'ndjson');
  const { loaded, issues } = await index.load();
  assert.equal(loaded, true);
  assert.equal(index.size(), 1);
  assert.equal(index.get(entry.id)!.rows, 1);
  assert.equal(issues.length, 4);
});

test('reconcileIndex: adds what is on disk, drops what is gone, re-reads what changed size', async () => {
  const root = await tempDir();
  const index = new PartitionIndex(root, 'ndjson', { debounceMs: 0 });
  await index.load();
  const key = (slot: string): PartitionKey => ({ objectType: 'aircraft', providerId: 'p', day: '2026-09-21', slot });
  const rowsOf: Record<string, Array<{ observedAt: string }>> = {
    '0800': [{ observedAt: '2026-09-21T08:30:00.000Z' }, { observedAt: '2026-09-21T08:10:00.000Z' }],
    '0900': [{ observedAt: '2026-09-21T09:05:00.000Z' }],
    '1000': [],
  };
  const files = (sizes: Record<string, number>) =>
    Object.entries(sizes).map(([slot, bytes]) => ({
      key: key(slot),
      rel: `aircraft/2026/09/21/p-${slot}.ndjson`,
      bytes,
    }));
  let reads = 0;
  const read = (k: PartitionKey) => {
    reads++;
    return Promise.resolve(rowsOf[k.slot] ?? []);
  };
  const first = await reconcileIndex(index, files({ '0800': 200, '0900': 100, '1000': 0 }), read, T);
  // An empty file with no entry is not a partition yet.
  assert.deepEqual(first, { added: 2, updated: 0, removed: 0 });
  const eight = index.get(partitionId(key('0800')))!;
  assert.equal(eight.minObservedAt, '2026-09-21T08:10:00.000Z');
  assert.equal(eight.maxObservedAt, '2026-09-21T08:30:00.000Z');
  assert.deepEqual([eight.rows, eight.originalRows, eight.bytes], [2, 2, 200]);

  reads = 0;
  assert.deepEqual(await reconcileIndex(index, files({ '0800': 200, '0900': 100 }), read, T), {
    added: 0,
    updated: 0,
    removed: 0,
  });
  assert.equal(reads, 0, 'a partition whose size has not changed is not read again');

  rowsOf['0800'] = [{ observedAt: '2026-09-21T08:10:00.000Z' }];
  const third = await reconcileIndex(index, files({ '0800': 100 }), read, T);
  assert.deepEqual(third, { added: 0, updated: 1, removed: 1 });
  const after = index.get(partitionId(key('0800')))!;
  // Rows removed by downsampling stay counted in originalRows.
  assert.deepEqual([after.rows, after.originalRows, after.bytes], [1, 2, 100]);
  assert.equal(index.has(partitionId(key('0900'))), false);
  await index.flush?.();
});

test('walkFiles: every file under a folder, sorted, with forward slashes; a missing folder is empty', async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'b', 'c'), { recursive: true });
  await fs.writeFile(path.join(root, 'b', 'c', 'two.ndjson'), '');
  await fs.writeFile(path.join(root, 'b', 'one.ndjson'), '');
  await fs.writeFile(path.join(root, 'a.json'), '');
  assert.deepEqual(await walkFiles(root), ['a.json', 'b/c/two.ndjson', 'b/one.ndjson']);
  assert.deepEqual(await walkFiles(path.join(root, 'missing')), []);
});

test('pruneEmptyDirs: removes empty folders up to the root, and nothing outside it', async () => {
  const base = await tempDir();
  const root = path.join(base, 'history');
  const leaf = path.join(root, 'aircraft', '2026', '09', '21');
  await fs.mkdir(leaf, { recursive: true });
  await fs.mkdir(path.join(root, 'aircraft', '2026', '10'), { recursive: true });
  await fs.writeFile(path.join(root, 'aircraft', '2026', '10', 'keep.ndjson'), 'x');
  await pruneEmptyDirs(leaf, root);
  assert.deepEqual(await fs.readdir(path.join(root, 'aircraft', '2026')), ['10']);
  // The root itself stays, empty or not.
  await fs.rm(path.join(root, 'aircraft'), { recursive: true });
  await pruneEmptyDirs(root, root);
  assert.deepEqual(await fs.readdir(base), ['history']);
  // A folder whose name only starts like the root's is not inside it.
  const sibling = path.join(base, 'history2', 'empty');
  await fs.mkdir(sibling, { recursive: true });
  await pruneEmptyDirs(sibling, root);
  assert.deepEqual((await fs.readdir(base)).sort(), ['history', 'history2']);
  assert.deepEqual(await fs.readdir(path.join(base, 'history2')), ['empty']);
});
