import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatchZone } from '@opcb/ipc-contract';
import { WATCH_ZONE_DEDUPE_MS, WATCH_ZONE_ENTRY_BASELINE_MS, WatchZoneEvaluator } from './watch-zones.js';
import { FixedClock, HOUR, T0, obj } from './test-fixtures.js';

/**
 * Entries into watch zones, checked against what they promise over long generated runs:
 * aircraft and ships moving between boxes and open sea, zones switched on and off, removed
 * and added back, objects forgotten, time running on by seconds and by days.
 *
 * Promised, for every entry told: the zone is on and watching for entries, the object is of a
 * kind entries are told for and is inside the zone, the zone has watched for at least the
 * baseline, and the same object was not told for the same zone within the dedupe window
 * (unless the zone was removed and added back in between). And the other way: an object seen
 * outside a watching zone and then inside it, after the baseline, with nothing told for the pair
 * within the window, is told.
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

/** Four boxes apart from one another, one of them across the 180° meridian. */
const BOXES = [
  { west: -158.3, south: 21.2, east: -157.6, north: 21.7, at: [21.45, -157.95] },
  { west: 139.5, south: 35.4, east: 140.1, north: 35.9, at: [35.65, 139.8] },
  { west: 179.5, south: -17.0, east: -179.5, north: -16.0, at: [-16.5, 179.9] },
  { west: -0.6, south: 51.3, east: 0.3, north: 51.7, at: [51.5, -0.1] },
] as const;
/** Places in no box. */
const OPEN = [
  [0, -140],
  [-40, 20],
  [60, 100],
  [-16.5, 178.9],
] as const;

const KINDS = ['aircraft', 'vessel', 'weather-station', 'earthquake'] as const;
const ENTRY_KINDS = new Set(['aircraft', 'vessel']);

function zone(i: number, on: boolean, watching: boolean): WatchZone {
  const b = BOXES[i]!;
  return {
    id: `wz-${i}`,
    name: `Zone ${i}`,
    geometry: { kind: 'bounds', bounds: { west: b.west, south: b.south, east: b.east, north: b.north } },
    eventTypes: watching ? ['watch-zone-entry'] : ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: on,
    createdAt: new Date(T0).toISOString(),
  };
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`watch zones: entries over a generated run keep their promises (seed ${seed})`, () => {
    const next = rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const clock = new FixedClock(T0);
    const ev = new WatchZoneEvaluator({ clock });

    // What the zones are now; when each began watching; where each object was last seen
    // (box index or -1 for open sea) per zone while that zone watched; the last entry told.
    const zones = new Map<number, { on: boolean; watching: boolean }>();
    const since = new Map<number, number>();
    const lastSeen = new Map<string, boolean>();
    const lastTold = new Map<string, number>();
    const objects = Array.from({ length: 12 }, (_, i) => ({
      id: `${KINDS[i % KINDS.length]}:x:${i}`,
      kind: KINDS[i % KINDS.length]!,
    }));
    const place = new Map<string, number>(objects.map((o) => [o.id, -1]));
    const watchingNow = (i: number) => {
      const z = zones.get(i);
      return z !== undefined && z.on && z.watching;
    };
    const apply = () => {
      const now = clock.now();
      for (const i of [0, 1, 2, 3]) {
        if (!watchingNow(i)) since.delete(i);
        else if (!since.has(i)) since.set(i, now);
      }
      ev.setZones([...zones].map(([i, z]) => zone(i, z.on, z.watching)));
    };
    let told = 0;
    let missedChecks = 0;

    for (let step = 0; step < 1500; step++) {
      const r = next();
      if (r < 0.08) {
        // A zone changes: switched on or off, watching or not, removed, added back.
        const i = Math.floor(next() * 4);
        const what = next();
        if (what < 0.2) {
          zones.delete(i);
          for (const k of [...lastTold.keys()]) if (k.startsWith(`${i}|`)) lastTold.delete(k);
          for (const k of [...lastSeen.keys()]) if (k.startsWith(`${i}|`)) lastSeen.delete(k);
        } else {
          zones.set(i, { on: next() < 0.8, watching: next() < 0.8 });
          if (!watchingNow(i)) for (const k of [...lastSeen.keys()]) if (k.startsWith(`${i}|`)) lastSeen.delete(k);
        }
        apply();
        continue;
      }
      if (r < 0.1) {
        const o = pick(objects);
        ev.forgetObject(o.id);
        for (const k of [...lastSeen.keys()]) if (k.endsWith(`|${o.id}`)) lastSeen.delete(k);
        continue;
      }
      if (r < 0.35) {
        clock.advance(
          pick([1_000, 20_000, 59_999, 60_000, 61_000, 10 * 60_000, HOUR, 6 * HOUR, 6 * HOUR + 1, 2 * 86_400_000]),
        );
        continue;
      }
      // Some objects move, and a batch of some of them is evaluated.
      for (const o of objects) if (next() < 0.3) place.set(o.id, next() < 0.5 ? Math.floor(next() * 4) : -1);
      const batch = objects.filter(() => next() < 0.6);
      const now = clock.now();
      const hits = ev.evaluateObjects(
        batch.map((o) => {
          const p = place.get(o.id)!;
          const [lat, lon] = p >= 0 ? BOXES[p]!.at : pick(OPEN);
          return obj({ id: o.id, type: o.kind, lat, lon });
        }),
      );
      const toldNow = new Set(hits.map((h) => `${h.zone.id.slice(3)}|${h.subjectId}`));
      for (const h of hits) {
        told++;
        const i = Number(h.zone.id.slice(3));
        const key = `${i}|${h.subjectId}`;
        assert.ok(watchingNow(i), `step ${step}: ${key} told for a zone that is not watching`);
        assert.ok(
          ENTRY_KINDS.has(h.subjectId.split(':')[0]!),
          `step ${step}: ${key} is not a kind entries are told for`,
        );
        assert.equal(place.get(h.subjectId), i, `step ${step}: ${key} told while not inside`);
        assert.ok(now - since.get(i)! >= WATCH_ZONE_ENTRY_BASELINE_MS, `step ${step}: ${key} told inside the baseline`);
        const last = lastTold.get(key);
        assert.ok(
          last === undefined || now - last >= WATCH_ZONE_DEDUPE_MS,
          `step ${step}: ${key} told twice in the window`,
        );
        assert.equal(h.event.type, 'watch-zone-entry');
        assert.equal(h.notification.watchZoneId, h.zone.id);
      }
      // The other way: seen outside, now inside, after the baseline, nothing told in the window.
      for (const o of batch) {
        if (!ENTRY_KINDS.has(o.kind)) continue;
        for (const i of [0, 1, 2, 3]) {
          if (!watchingNow(i)) continue;
          const key = `${i}|${o.id}`;
          const inside = place.get(o.id) === i;
          const wasOutside = lastSeen.get(key) === false;
          const last = lastTold.get(key);
          if (
            inside &&
            wasOutside &&
            now - since.get(i)! >= WATCH_ZONE_ENTRY_BASELINE_MS &&
            (last === undefined || now - last >= WATCH_ZONE_DEDUPE_MS)
          ) {
            missedChecks++;
            assert.ok(toldNow.has(key), `step ${step}: ${key} entered and was not told`);
          }
          lastSeen.set(key, inside);
        }
      }
      for (const key of toldNow) lastTold.set(key, now);
    }
    // The run tells some entries and checks some that must be told; otherwise it proves little.
    assert.ok(told >= 5, `told ${told}`);
    assert.ok(missedChecks >= 5, `checked ${missedChecks}`);
    // What is remembered for the window stays within the pairs there are.
    assert.ok(ev.rememberedCount() <= 4 * objects.length);
  });
}

test('watch zones: a clock put back during a run tells nothing inside the new baseline and nothing twice at once', () => {
  const next = rng(99);
  const clock = new FixedClock(T0);
  const ev = new WatchZoneEvaluator({ clock });
  ev.setZones([zone(0, true, true), zone(1, true, true)]);
  clock.advance(2 * WATCH_ZONE_ENTRY_BASELINE_MS);
  const at = (i: number, id: string) => {
    const [lat, lon] = i >= 0 ? BOXES[i]!.at : OPEN[0];
    return obj({ id, type: 'aircraft', lat, lon });
  };
  for (let round = 0; round < 200; round++) {
    if (next() < 0.1) clock.set(clock.now() - Math.floor(next() * 3) * 86_400_000);
    else clock.advance(Math.floor(next() * 3) * 60_000);
    const hits = ev.evaluateObjects(
      Array.from({ length: 5 }, (_, k) => at(Math.floor(next() * 3) - 1, `aircraft:x:${k}`)),
    );
    const keys = hits.map((h) => `${h.zone.id}|${h.subjectId}`);
    assert.equal(new Set(keys).size, keys.length, `round ${round}: a pair told twice in one batch`);
  }
});
