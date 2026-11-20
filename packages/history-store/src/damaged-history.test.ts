import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NdjsonBackend, walkFiles } from './ndjson-backend.js';
import { isHistoryRow } from './row.js';
import { aircraftObs, iso, quakeObs, rowsFor, tempDir } from '../test/helpers/fixtures.js';
import type { HistoryRow, PartitionKey } from './index.js';

/**
 * The history folder after something has been at it: a file cut short by a full disk or a
 * power cut, a line changed, a file emptied, the index edited or gone. The app opens that
 * folder at every start. It must open, say what it could not read, and answer every question
 * with rows that are rows; history that is damaged is history lost, never an app that will
 * not start. Damage is generated from a fixed seed.
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

const DAY = '2026-09-20T08:00:00.000Z';
const BITS = [
  '',
  '\n',
  '{',
  '}',
  '"',
  ',',
  'null',
  'NaN',
  '1e999',
  '[',
  '\u0000',
  '{"objectId":5}',
  '\n\n',
  'x'.repeat(200),
];

async function seed(dataDir: string): Promise<void> {
  const backend = new NdjsonBackend({ dataDir });
  await backend.open();
  const observations = [];
  for (let i = 0; i < 60; i++) {
    observations.push(
      aircraftObs(`a${(i % 6).toString(16).padStart(5, '0')}`, iso(DAY, i * 120), 21 + i * 0.01, -157 - i * 0.01),
    );
    if (i % 10 === 0) observations.push(quakeObs(`q${i}`, iso(DAY, i * 120), 19 + i * 0.01, -155, 2 + (i % 5)));
  }
  const groups = new Map<string, { key: PartitionKey; rows: HistoryRow[] }>();
  for (const { key, row } of rowsFor(observations)) {
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, { key, rows: [] });
    groups.get(id)!.rows.push(row);
  }
  for (const g of groups.values()) await backend.append(g.key, g.rows);
  await backend.close();
}

test('a damaged history folder opens, and every question is answered with rows that are rows', async () => {
  const pristine = await tempDir();
  await seed(pristine);
  const root = path.join(pristine, 'history');
  const files = (await walkFiles(root)).map((f) => path.resolve(root, f)).concat(path.join(root, 'index.json'));
  const good = new Map<string, Buffer>();
  for (const file of new Set(files)) good.set(path.relative(pristine, file), await fs.readFile(file));
  assert.ok(good.size >= 4, `${good.size} files seeded`);
  const next = rng(2026);
  let answered = 0;
  let rowsSeen = 0;
  try {
    for (let round = 0; round < 150; round++) {
      const dataDir = await tempDir();
      try {
        for (const [relative, bytes] of good) {
          let text = bytes.toString('utf8');
          const roll = next();
          if (roll < 0.45) {
            const times = 1 + Math.floor(next() * 3);
            for (let k = 0; k < times; k++) {
              const at = Math.floor(next() * text.length);
              const len = Math.floor(next() * 40);
              const how = next();
              text =
                how < 0.3
                  ? text.slice(0, at)
                  : how < 0.5
                    ? text.slice(0, at) + text.slice(at + len)
                    : text.slice(0, at) +
                      BITS[Math.floor(next() * BITS.length)]! +
                      text.slice(at + (next() < 0.5 ? 0 : len));
            }
          } else if (roll < 0.5) text = '';
          else if (roll < 0.55) continue; // the file is gone
          const file = path.join(dataDir, relative);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, text);
        }
        if (next() < 0.1)
          await fs.writeFile(path.join(dataDir, 'history', 'stray.ndjson'), 'not a row\n').catch(() => undefined);

        const backend = new NdjsonBackend({ dataDir });
        await backend.open();
        const range = { start: iso(DAY, -3600), end: iso(DAY, 4 * 3600) };
        const check = (rows: HistoryRow[], what: string) => {
          for (const row of rows) assert.ok(isHistoryRow(row), `${what} gave ${JSON.stringify(row).slice(0, 200)}`);
          rowsSeen += rows.length;
          answered++;
        };
        const partitions = await backend.listPartitions();
        for (const p of partitions.slice(0, 4)) check((await backend.readPartition(p)).rows, 'readPartition');
        check(await backend.objectsAt(iso(DAY, 3600), { lookbackSeconds: 7200 }), 'objectsAt');
        check(
          await backend.objectsAt(iso(DAY, 3600), { lookbackSeconds: 7200, objectTypes: ['aircraft'], limit: 3 }),
          'objectsAt',
        );
        check(await backend.track('aircraft:opensky:a00001', range), 'track');
        check(await backend.observationsInRange({ range }), 'observationsInRange');
        check(
          await backend.observationsInRange({
            range,
            region: { kind: 'bounds', bounds: { west: -160, south: 18, east: -154, north: 23 } },
            limit: 10,
          }),
          'observationsInRange in a region',
        );
        for (const a of await backend.availability())
          for (const r of a.ranges)
            assert.ok(Number.isFinite(Date.parse(r.start)) && Number.isFinite(Date.parse(r.end)), JSON.stringify(a));
        for (const c of await backend.counts({ range })) assert.ok(JSON.stringify(c).length > 0);
        const diagnostics = await backend.diagnostics();
        JSON.stringify(diagnostics, (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`diagnostics hold ${value}`);
          return value;
        });
        await backend.reconcile();
        // And it still takes new history after all that.
        const fresh = rowsFor([aircraftObs('abcdef', iso(DAY, 5 * 3600), 21, -157)])[0]!;
        await backend.append(fresh.key, [fresh.row]);
        check(
          await backend.track(fresh.row.objectId, { start: iso(DAY, 4 * 3600), end: iso(DAY, 6 * 3600) }),
          'track of new',
        );
        await backend.close();
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(pristine, { recursive: true, force: true });
  }
  assert.ok(answered > 1000 && rowsSeen > 5000, `${answered} answers, ${rowsSeen} rows`);
});

test('an index that is valid JSON of the wrong kind is reported and rebuilt, not thrown on', async () => {
  for (const content of [
    'null',
    '5',
    '"index"',
    '[]',
    'true',
    '{"version":1,"partitions":null}',
    '{"version":1,"partitions":[null,5,"x",[]]}',
  ]) {
    const dataDir = await tempDir();
    try {
      await seed(dataDir);
      await fs.writeFile(path.join(dataDir, 'history', 'index.json'), content);
      const backend = new NdjsonBackend({ dataDir });
      await backend.open();
      await backend.reconcile();
      assert.ok((await backend.listPartitions()).length >= 2, `${content}: the files on disk are found again`);
      assert.ok(
        (await backend.observationsInRange({ range: { start: iso(DAY, -60), end: iso(DAY, 7200) } })).length > 50,
        content,
      );
      await backend.close();
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});
