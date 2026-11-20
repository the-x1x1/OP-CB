import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Observation } from '@opcb/world-model';
import { WorldState, type StateChange } from './index.js';

/**
 * A model of what a window does with the state engine: it holds the set of object ids it was
 * told about, and applies each change it is sent. Whatever is ingested, withdrawn, expired or
 * removed, in whatever order and however many times between two changes, that set must be the
 * engine's own set after every change — a window is never left showing an object that is gone
 * or missing one that is there. Operations are generated from a fixed seed.
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

const PROVIDERS = ['adsb-lol', 'opensky', 'usgs-earthquakes'] as const;
const TYPE_OF: Record<string, string> = {
  'adsb-lol': 'aircraft',
  opensky: 'aircraft',
  'usgs-earthquakes': 'earthquake',
};

function observation(providerId: string, externalId: string, observedMs: number, next: () => number): Observation {
  const observedAt = new Date(observedMs).toISOString();
  return {
    id: `${providerId}:${externalId}:${observedAt}`,
    providerId,
    externalId,
    objectType: TYPE_OF[providerId]!,
    observedAt,
    receivedAt: observedAt,
    payload: { callsign: `C${externalId}`, speedMps: next() * 250, headingDegrees: next() * 360 },
    position: { latitude: (next() * 2 - 1) * 90, longitude: (next() * 2 - 1) * 180, altitudeM: next() * 11_000 },
    quality: { complete: true, sourceQuality: 'crowdsourced' },
    provenance: { providerId, sourceName: providerId, origin: 'live', attribution: 'x', receivedAt: observedAt },
  } as Observation;
}

function run(seed: number, steps: number): { problems: string[]; changes: number; peak: number } {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  let now = Date.parse('2026-11-20T00:00:00Z');
  const engine = new WorldState({ clock: { now: () => now } as never, flushDelayMs: 0 });
  const shown = new Set<string>();
  const problems: string[] = [];
  let changes = 0;
  let peak = 0;
  const apply = (change: StateChange | undefined, step: string) => {
    if (!change) return;
    changes++;
    const sets = [change.added, change.updated, change.removed];
    const all = sets.flat();
    if (new Set(all).size !== all.length) problems.push(`${step}: an id in two of added, updated and removed`);
    for (const id of change.added) {
      if (shown.has(id)) problems.push(`${step}: ${id} added while already shown`);
      shown.add(id);
    }
    for (const id of change.updated) if (!shown.has(id)) problems.push(`${step}: ${id} updated but never added`);
    for (const id of change.removed) {
      if (!shown.has(id)) problems.push(`${step}: ${id} removed but never added`);
      shown.delete(id);
    }
    for (const id of change.refreshed) if (!shown.has(id)) problems.push(`${step}: ${id} refreshed but not shown`);
    for (const id of change.withdrawn ?? [])
      if (!change.removed.includes(id)) problems.push(`${step}: ${id} withdrawn but not removed`);
    if (change.objectCount !== engine.size)
      problems.push(`${step}: objectCount ${change.objectCount}, size ${engine.size}`);
  };
  const check = (step: string) => {
    const ids = [...engine.ids()];
    if (new Set(ids).size !== ids.length) problems.push(`${step}: an id twice in the engine`);
    if (ids.length !== engine.size) problems.push(`${step}: size ${engine.size} for ${ids.length} ids`);
    if (ids.length !== shown.size || ids.some((id) => !shown.has(id)))
      problems.push(`${step}: the window shows ${shown.size}, the engine holds ${ids.length}`);
    const byType = Object.values(engine.countsByType()).reduce((a, b) => a + b, 0);
    if (byType !== engine.size) problems.push(`${step}: counts by type come to ${byType}, size ${engine.size}`);
    for (const o of engine.all()) {
      if (engine.get(o.id) !== o) problems.push(`${step}: get(${o.id}) is another object`);
      if (o.position && !(Math.abs(o.position.latitude) <= 90 && Math.abs(o.position.longitude) <= 180))
        problems.push(`${step}: ${o.id} off the globe`);
      if (!Number.isFinite(Date.parse(o.observedAt))) problems.push(`${step}: ${o.id} observed at ${o.observedAt}`);
      if (!(o.confidence >= 0 && o.confidence <= 1)) problems.push(`${step}: ${o.id} confidence ${o.confidence}`);
      if (o.sourceRefs.length === 0) problems.push(`${step}: ${o.id} has no source`);
    }
    peak = Math.max(peak, engine.size);
  };
  for (let i = 0; i < steps && problems.length < 10; i++) {
    const roll = next();
    let step: string;
    if (roll < 0.6) {
      const providerId = pick(PROVIDERS);
      const snapshot = next() < 0.5;
      const count = Math.floor(next() * 12);
      const batch: Observation[] = [];
      for (let k = 0; k < count; k++) {
        // A few ids, so the same object comes round again; times now, a little back, or ahead.
        const externalId = `x${Math.floor(next() * 25)}`;
        batch.push(
          observation(providerId, externalId, now - Math.floor(next() * 120_000) + (next() < 0.05 ? 30_000 : 0), next),
        );
      }
      if (next() < 0.1 && batch[0]) batch.push(batch[0]);
      step = `#${i} ingest ${count} from ${providerId}${snapshot ? ' (snapshot)' : ''}`;
      const result = engine.ingest(batch, {
        providerId,
        snapshot,
        ...(snapshot && next() < 0.5 ? { withdraws: true } : {}),
      });
      if (result.accepted + result.rejected.length !== batch.length)
        problems.push(`${step}: ${result.accepted} accepted + ${result.rejected.length} rejected of ${batch.length}`);
    } else if (roll < 0.8) {
      now += Math.floor(next() * 20 * 60_000);
      step = `#${i} sweep at +${Math.round((now - Date.parse('2026-11-20T00:00:00Z')) / 60_000)} min`;
      engine.sweep();
    } else if (roll < 0.87) {
      const providerId = pick(PROVIDERS);
      step = `#${i} remove ${providerId}`;
      engine.removeProvider(providerId);
    } else if (roll < 0.9) {
      step = `#${i} clear`;
      engine.clear();
    } else {
      step = `#${i} nothing`;
    }
    // Sometimes several operations go by before the window hears of any of them.
    if (next() < 0.6) {
      apply(engine.flush(), step);
      check(step);
    }
  }
  apply(engine.flush(), 'end');
  check('end');
  engine.dispose();
  return { problems, changes, peak };
}

test('state engine: a window that applies every change it is sent always shows exactly what the engine holds', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { problems, changes, peak } = run(seed, 1500);
    assert.deepEqual(problems.slice(0, 8), [], `seed ${seed}: ${problems.length} problems`);
    assert.ok(changes > 200 && peak >= 10, `seed ${seed}: ${changes} changes, at most ${peak} objects at once`);
  }
});
