import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@opcb/provider-sdk';
import { HistoryStore, NdjsonBackend, type HistoryRow, type PartitionMeta } from './index.js';
import { DEFAULT_RETENTION_POLICIES, INDEFINITE } from './retention.js';
import { CLOCK_AHEAD_HOLD_MS } from './store.js';
import {
  AIRCRAFT_PROVIDER,
  OPEN_POLICY,
  QUAKE_PROVIDER,
  aircraftObs,
  batch,
  makeLogger,
  policies,
  quakeObs,
  tempDir,
} from '../test/helpers/fixtures.js';

/**
 * The retention sweep over generated history, run again and again as the clock moves on by
 * minutes and by days. After every sweep, for every partition there was:
 *
 * - it is gone exactly when its newest row is older than its type's retention (aircraft 30 d,
 *   earthquakes never), and never otherwise;
 * - a partition kept holds only rows it held before, keeps each object's first and last row,
 *   and the thinning tier it reports never goes down;
 * - its raw hashes are gone once it is older than a day, and kept before;
 * - its partition metadata still counts the rows first written.
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

const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/**
 * A source still running as the clock moves on: an earthquake (kept forever) just before each
 * sweep, in partitions of its own. Without data near the clock's time the sweep holds off
 * (`CLOCK_AHEAD_HOLD_MS`; tested on its own below).
 */
const HEARTBEAT = 'heartbeat-quakes';

for (const seed of [51, 52, 53]) {
  test(`history retention: generated sweeps keep the promises of the policy (seed ${seed})`, async () => {
    const next = rng(seed);
    const dataDir = await tempDir();
    const clock = new testing.VirtualClock(T0 + 40 * DAY);
    const { hub } = makeLogger();
    const backend = new NdjsonBackend({ dataDir, logger: hub.logger('history'), clock });
    const store = new HistoryStore({
      dataDir,
      backend,
      clock,
      logger: hub.logger('history'),
      policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY, [QUAKE_PROVIDER]: OPEN_POLICY, [HEARTBEAT]: OPEN_POLICY }),
    });
    await store.open();
    try {
      // Aircraft tracks in bursts across forty days, and earthquakes now and then.
      for (let burst = 0; burst < 25; burst++) {
        const start = T0 + Math.floor(next() * 40 * DAY);
        const points = 3 + Math.floor(next() * 40);
        const step = 1000 * (1 + Math.floor(next() * 30));
        const obs = [];
        for (const icao of ['a1', 'b2', 'c3'].slice(0, 1 + Math.floor(next() * 3)))
          for (let i = 0; i < points; i++)
            obs.push(aircraftObs(icao, iso(start + i * step), 20 + next(), -150 + next()));
        store.writeBatch(batch(AIRCRAFT_PROVIDER, obs));
        if (next() < 0.4)
          store.writeBatch(batch(QUAKE_PROVIDER, [quakeObs(`q${burst}`, iso(start), 19.4, -155.3, 3 + next() * 3)]));
      }
      await store.flush();

      const read = async () => {
        const out = new Map<string, { meta: PartitionMeta; rows: HistoryRow[] }>();
        for (const meta of await backend.listPartitions())
          out.set(meta.id, { meta, rows: (await backend.readPartition(meta)).rows });
        return out;
      };
      const first = await read();
      const originalRows = new Map([...first].map(([id, p]) => [id, p.rows.length]));
      let before = first;
      // The clock moves on: within minutes of the newest data, then by hours and days.
      const newest = Math.max(...[...first.values()].map((p) => Date.parse(p.meta.maxObservedAt)));
      let now = newest;
      for (let sweep = 0; sweep < 14; sweep++) {
        now += [2 * MIN, 10 * MIN, 40 * MIN, 6 * HOUR, 25 * HOUR, 5 * DAY, 9 * DAY][Math.floor(next() * 7)]!;
        store.writeBatch(batch(HEARTBEAT, [quakeObs(`beat${sweep}`, iso(now - MIN), 0, 0, 1, HEARTBEAT)]));
        await store.flush();
        await store.sweepRetention(now);
        const after = await read();
        for (const [id, was] of before) {
          if (!first.has(id)) continue; // the heartbeat's own
          const retain = DEFAULT_RETENTION_POLICIES[was.meta.objectType]!.retainSeconds;
          const ageS = (now - Date.parse(was.meta.maxObservedAt)) / 1000;
          const expired = retain !== INDEFINITE && ageS > retain;
          const kept = after.get(id);
          assert.equal(!kept, expired, `sweep ${sweep} ${id}: age ${Math.round(ageS / 3600)} h, kept ${!!kept}`);
          if (!kept) continue;
          const ids = new Set(was.rows.map((r) => r.observationId));
          assert.ok(
            kept.rows.every((r) => ids.has(r.observationId)),
            `sweep ${sweep} ${id}: a row that was not there`,
          );
          // Each object's first and last row are kept.
          const ends = new Map<string, { first: HistoryRow; last: HistoryRow }>();
          for (const r of was.rows) {
            const e = ends.get(r.objectId);
            if (!e) ends.set(r.objectId, { first: r, last: r });
            else {
              if (r.observedAt < e.first.observedAt) e.first = r;
              if (r.observedAt >= e.last.observedAt) e.last = r;
            }
          }
          const keptIds = new Set(kept.rows.map((r) => r.observationId));
          for (const [objectId, e] of ends) {
            assert.ok(keptIds.has(e.first.observationId), `sweep ${sweep} ${id}: ${objectId} lost its first row`);
            assert.ok(keptIds.has(e.last.observationId), `sweep ${sweep} ${id}: ${objectId} lost its last row`);
          }
          assert.ok(
            (kept.meta.downsampleTier ?? 0) >= (was.meta.downsampleTier ?? 0),
            `sweep ${sweep} ${id}: tier went down`,
          );
          assert.equal(kept.meta.rows, kept.rows.length, `sweep ${sweep} ${id}: rows counted`);
          assert.equal(
            kept.meta.originalRows ?? kept.rows.length,
            originalRows.get(id),
            `sweep ${sweep} ${id}: the rows first written are still counted`,
          );
          const rawSeconds = DEFAULT_RETENTION_POLICIES[was.meta.objectType]!.rawSeconds;
          if (rawSeconds !== undefined && ageS > rawSeconds)
            assert.ok(
              kept.rows.every((r) => r.rawPayloadHash === undefined),
              `sweep ${sweep} ${id}: raw kept past a day`,
            );
          if (rawSeconds !== undefined && ageS <= rawSeconds && was.rows.every((r) => r.rawPayloadHash !== undefined))
            assert.ok(
              kept.rows.every((r) => r.rawPayloadHash !== undefined),
              `sweep ${sweep} ${id}: raw stripped inside a day`,
            );
        }
        before = after;
      }
      // Past every limit, only the earthquakes remain.
      const last = Math.max(now, newest) + 31 * DAY;
      store.writeBatch(batch(HEARTBEAT, [quakeObs('beat-last', iso(last - MIN), 0, 0, 1, HEARTBEAT)]));
      await store.flush();
      await store.sweepRetention(last);
      before = await read();
      assert.deepEqual(
        [...before.values()].map((p) => p.meta.objectType).filter((t) => t !== 'earthquake'),
        [],
      );
      assert.ok([...before.entries()].every(([id, p]) => first.has(id) || p.meta.providerId === HEARTBEAT));
    } finally {
      await store.close();
    }
  });
}

test('history retention: a clock far ahead of the newest history deletes nothing until data comes in near it', async () => {
  const dataDir = await tempDir();
  const clock = new testing.VirtualClock(T0 + DAY);
  const { hub } = makeLogger();
  const backend = new NdjsonBackend({ dataDir, logger: hub.logger('history'), clock });
  const store = new HistoryStore({
    dataDir,
    backend,
    clock,
    logger: hub.logger('history'),
    policies: policies({ [AIRCRAFT_PROVIDER]: OPEN_POLICY, [QUAKE_PROVIDER]: OPEN_POLICY }),
  });
  await store.open();
  try {
    store.writeBatch(
      batch(AIRCRAFT_PROVIDER, [aircraftObs('a1', iso(T0), 20, -150), aircraftObs('a1', iso(T0 + MIN), 20, -150)]),
    );
    await store.flush();
    const before = (await backend.listPartitions()).length;
    // The clock jumps ten years ahead (a flat motherboard battery, a bad time sync).
    const far = T0 + 3650 * DAY;
    const held = await store.sweepRetention(far);
    assert.equal(held.deleted.length, 0, 'nothing deleted');
    assert.equal(held.rewritten.length, 0, 'nothing thinned');
    assert.match(held.held ?? '', /days past the newest history/);
    assert.equal((await backend.listPartitions()).length, before);
    // Nor at a week and a day past it, the edge.
    assert.equal((await store.sweepRetention(T0 + MIN + CLOCK_AHEAD_HOLD_MS + DAY)).deleted.length, 0);
    // Under a week past it, the sweep is not held (and nothing here is old enough to delete).
    assert.equal((await store.sweepRetention(T0 + MIN + CLOCK_AHEAD_HOLD_MS - HOUR)).held, undefined);
    // Data comes in at the clock's time: the clock is right after all, and the old track goes.
    store.writeBatch(batch(QUAKE_PROVIDER, [quakeObs('q-now', iso(far - MIN), 19.4, -155.3, 4)]));
    await store.flush();
    const swept = await store.sweepRetention(far);
    assert.equal(swept.held, undefined);
    assert.deepEqual(
      swept.deleted.map((m) => m.objectType),
      ['aircraft'],
    );
  } finally {
    await store.close();
  }
});
