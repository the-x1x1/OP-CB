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
