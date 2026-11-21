import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NdjsonBackend } from './ndjson-backend.js';
import { partitionId, partitionKeyFor, type PartitionKey } from './partition.js';
import type { HistoryRow } from './row.js';

/**
 * The history backend's queries against a plain reading of the same rows. Rows for a few
 * objects of two types from two sources, at times that fall on and either side of slot and day
 * boundaries, written in batches in a generated order; then generated questions — what each
 * object was at a time, one object's track, counts, rows in a range — asked with ranges written
 * with and without milliseconds, and each answer compared with filtering the rows by hand.
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

const DAY0 = Date.parse('2026-09-19T00:00:00.000Z');
const HOUR = 3_600_000;
const TYPES = ['aircraft', 'vessel'] as const;
const PROVIDERS = ['src-a', 'src-b'] as const;
const OBJECTS = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'] as const;

/** A time in the three days, often on or a millisecond either side of an hour or a day. */
function timeFrom(next: () => number): number {
  const hour = DAY0 + Math.floor(next() * 72) * HOUR;
  const r = next();
  if (r < 0.15) return hour;
  if (r < 0.25) return hour - 1;
  if (r < 0.35) return hour + 1;
  if (r < 0.45) return hour + 999;
  return hour + Math.floor(next() * HOUR);
}
const iso = (ms: number) => new Date(ms).toISOString();
/** The same instant as a query may write it: with milliseconds, or without when it has none. */
const asWritten = (ms: number, next: () => number) =>
  ms % 1000 === 0 && next() < 0.5 ? iso(ms).replace('.000Z', 'Z') : iso(ms);

const byTime = (a: HistoryRow, b: HistoryRow) =>
  a.observedAt < b.observedAt
    ? -1
    : a.observedAt > b.observedAt
      ? 1
      : a.observationId < b.observationId
        ? -1
        : a.observationId > b.observationId
          ? 1
          : 0;
const newer = (a: HistoryRow, b: HistoryRow) =>
  a.observedAt !== b.observedAt
    ? a.observedAt > b.observedAt
    : a.receivedAt !== b.receivedAt
      ? a.receivedAt > b.receivedAt
      : a.observationId > b.observationId;

for (const seed of [41, 42, 43, 44]) {
  test(`history queries answer as a plain reading of the rows does (seed ${seed})`, async () => {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-hq-'));
    const backend = new NdjsonBackend({ dataDir });
    await backend.open();
    try {
      // Each object keeps its type; any source may report it.
      const typeOf = new Map(OBJECTS.map((o, i) => [o, TYPES[i % 2]!] as const));
      const rows: HistoryRow[] = [];
      for (let i = 0; i < 400; i++) {
        const objectId = `${typeOf.get(OBJECTS[i % OBJECTS.length]!)!}:x:${OBJECTS[i % OBJECTS.length]!}`;
        const at = timeFrom(next);
        rows.push({
          observationId: `obs-${String(i).padStart(4, '0')}`,
          objectId,
          providerId: pick(PROVIDERS),
          objectType: objectId.split(':')[0]!,
          observedAt: iso(at),
          receivedAt: iso(at + Math.floor(next() * 5000)),
          lat: -60 + next() * 120,
          lon: -180 + next() * 360,
          payloadJson: '{}',
          origin: 'live',
        });
      }
      // Written per partition, in batches, in a generated order.
      const groups = new Map<string, { key: PartitionKey; rows: HistoryRow[] }>();
      for (const r of rows) {
        const key = partitionKeyFor(r.objectType, r.providerId, r.observedAt);
        const g = groups.get(partitionId(key)) ?? { key, rows: [] };
        g.rows.push(r);
        groups.set(partitionId(key), g);
      }
      const batches: Array<{ key: PartitionKey; rows: HistoryRow[] }> = [];
      for (const g of groups.values())
        for (let i = 0; i < g.rows.length; i += 3) batches.push({ key: g.key, rows: g.rows.slice(i, i + 3) });
      batches.sort(() => next() - 0.5);
      for (const b of batches) await backend.append(b.key, b.rows);
      await backend.flush();

      const ids = (list: HistoryRow[]) => list.map((r) => r.observationId);
      for (let q = 0; q < 60; q++) {
        const types = next() < 0.5 ? undefined : [pick(TYPES)];
        const providers = next() < 0.6 ? undefined : [pick(PROVIDERS)];
        const keep = (r: HistoryRow) =>
          (!types || types.includes(r.objectType as (typeof TYPES)[number])) &&
          (!providers || providers.includes(r.providerId as (typeof PROVIDERS)[number]));

        // What each object was at a time.
        const cursorMs = timeFrom(next);
        const lookbackSeconds = pick([0, 1, 59, 3600, 6 * 3600, 86_400, 3 * 86_400]);
        const from = iso(cursorMs - lookbackSeconds * 1000);
        const latest = new Map<string, HistoryRow>();
        for (const r of rows)
          if (keep(r) && r.observedAt >= from && r.observedAt <= iso(cursorMs)) {
            const cur = latest.get(r.objectId);
            if (!cur || newer(r, cur)) latest.set(r.objectId, r);
          }
        const expectedAt = [...latest.values()].sort((a, b) => (a.objectId < b.objectId ? -1 : 1));
        const gotAt = await backend.objectsAt(asWritten(cursorMs, next), {
          lookbackSeconds,
          ...(types ? { objectTypes: types } : {}),
          ...(providers ? { providerIds: providers } : {}),
        });
        assert.deepEqual(ids(gotAt), ids(expectedAt), `objectsAt ${iso(cursorMs)} lookback ${lookbackSeconds}s`);

        // A range, written as a query may write it.
        const a = timeFrom(next);
        const b = timeFrom(next);
        const [startMs, endMs] = a <= b ? [a, b] : [b, a];
        const range = { start: asWritten(startMs, next), end: asWritten(endMs, next) };
        const inRange = (r: HistoryRow) => r.observedAt >= iso(startMs) && r.observedAt <= iso(endMs);

        const objectId = rows[Math.floor(next() * rows.length)]!.objectId;
        const expectedTrack = rows.filter((r) => r.objectId === objectId && inRange(r)).sort(byTime);
        const gotTrack = await backend.track(objectId, range);
        assert.deepEqual(ids(gotTrack), ids(expectedTrack), `track ${objectId} ${range.start}..${range.end}`);

        const limit = next() < 0.3 ? 1 + Math.floor(next() * 20) : undefined;
        const query = {
          range,
          ...(types ? { objectTypes: types } : {}),
          ...(providers ? { providerIds: providers } : {}),
          ...(limit !== undefined ? { limit } : {}),
        };
        const matching = rows.filter((r) => keep(r) && inRange(r)).sort(byTime);
        const gotRows = await backend.observationsInRange(query);
        assert.deepEqual(
          ids(gotRows),
          ids(limit !== undefined ? matching.slice(0, limit) : matching),
          `observationsInRange ${range.start}..${range.end} limit ${limit}`,
        );

        const { limit: _ignored, ...countQuery } = query;
        const expectedCounts = new Map<string, { objects: Set<string>; rows: number }>();
        for (const r of matching) {
          const c = expectedCounts.get(r.objectType) ?? { objects: new Set(), rows: 0 };
          c.objects.add(r.objectId);
          c.rows++;
          expectedCounts.set(r.objectType, c);
        }
        const gotCounts = (await backend.counts(countQuery))
          .filter((c) => c.rows > 0)
          .map((c) => `${c.objectType}:${c.objects}:${c.rows}`)
          .sort();
        assert.deepEqual(
          gotCounts,
          [...expectedCounts].map(([t, c]) => `${t}:${c.objects.size}:${c.rows}`).sort(),
          `counts ${range.start}..${range.end}`,
        );
      }
    } finally {
      await backend.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}
