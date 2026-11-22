import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Collection } from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';

const T = '2026-11-22T00:00:00.000Z';
const place = (id: string, latitude: number) => ({
  id,
  kind: 'location' as const,
  title: id,
  createdAt: T,
  updatedAt: T,
  position: { latitude, longitude: -157 },
});

/**
 * Imports asked for together, each of a different file over a collection of the same id that
 * is already kept: each is kept beside it under a name of its own. The free name is chosen and
 * saved with no wait between them; a wait there would let two imports take the same name, and
 * the second write over the first.
 */
test('integration: imports together each keep a copy of their own', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-import-order-'));
  try {
    const h = await startRuntime({ dataDir, providerInstances: [] });
    try {
      const kept: Collection = { id: 'trip', name: 'Trip', createdAt: T, updatedAt: T, items: [place('home', 21)] };
      await h.client.request('collections.save', kept);
      const files: string[] = [];
      for (let n = 0; n < 4; n++) {
        const file = path.join(dataDir, `trip-${n}.json`);
        await fs.writeFile(file, JSON.stringify({ collection: { ...kept, items: [place(`p${n}`, 20 + n)] } }));
        files.push(file);
        h.host.openQueue.push(file);
      }
      const answers = await Promise.all(files.map(() => h.client.request('collections.import', undefined)));
      const ids = answers.map((a) => a.imported?.id);
      assert.equal(new Set(ids).size, 4, `each import its own copy: ${ids.join(', ')}`);

      const list = await h.client.request('collections.list', undefined);
      assert.equal(list.length, 5, list.map((c) => c.id).join(', '));
      assert.deepEqual(
        list.find((c) => c.id === 'trip')?.items.map((i) => i.id),
        ['home'],
        'the kept one untouched',
      );
      const titles = list
        .filter((c) => c.id !== 'trip')
        .flatMap((c) => c.items.map((i) => i.id))
        .sort();
      assert.deepEqual(titles, ['p0', 'p1', 'p2', 'p3'], 'no import written over another');
      for (const a of answers) assert.deepEqual(a.issues, []);

      // The same files again: nothing more is added.
      for (const file of files) h.host.openQueue.push(file);
      await Promise.all(files.map(() => h.client.request('collections.import', undefined)));
      assert.equal((await h.client.request('collections.list', undefined)).length, 5);
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
