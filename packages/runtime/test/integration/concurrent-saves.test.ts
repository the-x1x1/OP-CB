import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settle, startRuntime } from '../helpers/harness.js';

/**
 * Two windows, and one window twice, can ask for saves at the same moment: nothing waits for
 * the last answer before sending the next request. Every save that was answered is in the
 * list, in the file, and there after a restart; none is lost to another's write of the same
 * file, and the file is never left half written.
 */
const at = '2026-09-21T00:00:00.000Z';
const collection = (i: number) => ({ id: `c${i}`, name: `Collection ${i}`, createdAt: at, updatedAt: at, items: [] });
const zone = (i: number) => ({
  id: `z${i}`,
  name: `Zone ${i}`,
  geometry: { kind: 'circle' as const, center: { latitude: 21 + i * 0.01, longitude: -157.8 }, radiusM: 50_000 },
  eventTypes: ['earthquake'],
  notifications: { inApp: true, desktop: false },
  enabled: true,
  createdAt: at,
});
const lens = (i: number) => ({
  id: `user-${i}`,
  name: `Lens ${i}`,
  objectTypes: ['earthquake'],
  eventTypes: [],
  renderingRules: [],
  visiblePanels: ['selection'],
});

test('integration: saves asked for at the same moment are all kept, and survive a restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-concurrent-'));
  try {
    const h = await startRuntime({ dataDir, providerInstances: [] });
    const N = 40;
    try {
      const work: Array<Promise<unknown>> = [];
      for (let i = 0; i < N; i++) {
        work.push(h.client.request('collections.save', collection(i)));
        work.push(h.client.request('watchzones.save', zone(i)));
        work.push(h.client.request('lenses.save', lens(i)));
        work.push(h.client.request('settings.set', { reducedMotion: i % 2 === 0 }));
        // Reads in among the writes see a whole list each time.
        work.push(h.client.request('collections.list', undefined).then((list) => assert.ok(Array.isArray(list))));
      }
      await Promise.all(work);
      // Then half of them deleted while the other half are saved again.
      const more: Array<Promise<unknown>> = [];
      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) {
          more.push(h.client.request('collections.delete', { id: `c${i}` }));
          more.push(h.client.request('watchzones.delete', { id: `z${i}` }));
          more.push(h.client.request('lenses.delete', { id: `user-${i}` }));
        } else {
          more.push(h.client.request('collections.save', { ...collection(i), name: `Renamed ${i}` }));
          more.push(h.client.request('watchzones.save', { ...zone(i), name: `Renamed ${i}` }));
          more.push(h.client.request('lenses.save', { ...lens(i), name: `Renamed ${i}` }));
        }
      }
      await Promise.all(more);
      await settle(6);
    } finally {
      await h.dispose();
    }

    const expectIds = (prefix: string) =>
      Array.from({ length: N }, (_, i) => i)
        .filter((i) => i % 2 === 1)
        .map((i) => `${prefix}${i}`)
        .sort();
    // Every file the runtime left is whole JSON.
    for (const name of await fs.readdir(dataDir))
      if (name.endsWith('.json')) JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
    assert.deepEqual(
      (await fs.readdir(dataDir)).filter((name) => /\.tmp|\.partial|~$/.test(name)),
      [],
      'no temporary file left behind',
    );

    const again = await startRuntime({ dataDir, providerInstances: [] });
    try {
      const collections = await again.client.request('collections.list', undefined);
      assert.deepEqual(collections.map((c) => c.id).sort(), expectIds('c'));
      assert.ok(collections.every((c) => c.name.startsWith('Renamed ')));
      const zones = await again.client.request('watchzones.list', undefined);
      assert.deepEqual(zones.map((z) => z.id).sort(), expectIds('z'));
      assert.ok(zones.every((z) => z.name.startsWith('Renamed ')));
      const lenses = (await again.client.request('lenses.list', undefined)).filter((l) => l.id.startsWith('user-'));
      assert.deepEqual(lenses.map((l) => l.id).sort(), expectIds('user-'));
      assert.ok(lenses.every((l) => l.name.startsWith('Renamed ')));
    } finally {
      await again.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

const prep = (i: number) => ({
  id: `p${i}`,
  kind: 'item' as const,
  category: 'water',
  name: `Water ${i}`,
  quantity: 10,
  updatedAt: at,
});

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

/**
 * Saves and deletions of the same few records, in a generated order, asked for without waiting:
 * the same record saved under three names and deleted and saved again before any answer comes.
 * What is kept — in the list, and after a restart — is what applying them in the order they
 * were asked gives.
 */
for (const seed of [31, 32, 33, 34]) {
  test(`integration: saves and deletions of the same records, asked for together, end as asked (seed ${seed})`, async () => {
    const next = rng(seed);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-concurrent-'));
    const kinds = [
      { save: 'collections.save', del: 'collections.delete', list: 'collections.list', make: collection, prefix: 'c' },
      { save: 'watchzones.save', del: 'watchzones.delete', list: 'watchzones.list', make: zone, prefix: 'z' },
      { save: 'lenses.save', del: 'lenses.delete', list: 'lenses.list', make: lens, prefix: 'user-' },
      { save: 'prep.save', del: 'prep.delete', list: 'prep.list', make: prep, prefix: 'p' },
    ] as const;
    // What applying the requests in order gives: id → name, per kind.
    const model = kinds.map(() => new Map<string, string>());
    try {
      const h = await startRuntime({ dataDir, providerInstances: [] });
      try {
        for (let round = 0; round < 4; round++) {
          const work: Array<Promise<unknown>> = [];
          for (let k = 0; k < 120; k++) {
            const which = Math.floor(next() * kinds.length);
            const kind = kinds[which]!;
            const i = Math.floor(next() * 6);
            const id = `${kind.prefix}${i}`;
            if (next() < 0.3) {
              model[which]!.delete(id);
              work.push(h.client.request(kind.del as 'collections.delete', { id }));
            } else {
              const name = `Name ${round}.${k}`;
              model[which]!.set(id, name);
              work.push(h.client.request(kind.save as 'collections.save', { ...kind.make(i), name } as never));
            }
          }
          await Promise.all(work);
          for (const [which, kind] of kinds.entries()) {
            const list = (await h.client.request(kind.list as 'collections.list', undefined)) as Array<{
              id: string;
              name: string;
            }>;
            const got = new Map(list.filter((x) => x.id.startsWith(kind.prefix)).map((x) => [x.id, x.name] as const));
            assert.deepEqual([...got].sort(), [...model[which]!].sort(), `${kind.list} after round ${round}`);
          }
        }
        await settle(6);
      } finally {
        await h.dispose();
      }
      const again = await startRuntime({ dataDir, providerInstances: [] });
      try {
        for (const [which, kind] of kinds.entries()) {
          const list = (await again.client.request(kind.list as 'collections.list', undefined)) as Array<{
            id: string;
            name: string;
          }>;
          const got = new Map(list.filter((x) => x.id.startsWith(kind.prefix)).map((x) => [x.id, x.name] as const));
          assert.deepEqual([...got].sort(), [...model[which]!].sort(), `${kind.list} after a restart`);
        }
      } finally {
        await again.dispose();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
}
