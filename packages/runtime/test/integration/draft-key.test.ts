import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settle, startRuntime } from '../helpers/harness.js';

/**
 * End to end, as the window does it: an address with a key is drafted, the draft saved,
 * the source switched on and polled. The key is in no answer the window is given and in no
 * file in the data folder but the key store's, and the source's request carries it.
 */
test('integration: a drafted address key is kept in the key store and sent with each poll', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-draft-key-'));
  const asked: string[] = [];
  const body = JSON.stringify({
    items: [
      { id: 'p1', name: 'One', lat: 21.3, lon: -157.8 },
      { id: 'p2', name: 'Two', lat: 21.4, lon: -157.9 },
    ],
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.example.org/')) {
      asked.push(url);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not here', { status: 503 });
  }) as typeof fetch;
  try {
    const h = await startRuntime({ dataDir, fetchImpl });
    try {
      const address = 'https://api.example.org/v1/points?units=metric&appid=S3CRET-K3Y';
      const draft = await h.client.request('sources.definitions.draft', { url: address });
      assert.ok(!JSON.stringify(draft).includes('S3CRET-K3Y'), 'the draft the window is given holds no key');
      assert.equal(draft.validation.ok, true, draft.validation.errors.join('; '));
      const saved = await h.client.request('sources.definitions.save', {
        id: 'key-points',
        definition: draft.definition,
      });
      assert.ok(!JSON.stringify(saved).includes('S3CRET-K3Y'));
      await h.client.request('sources.definitions.setEnabled', { file: saved.file, enabled: true });
      await settle(6);
      asked.length = 0;
      await h.client.request('sources.refresh', { providerId: 'key-points' });
      await settle(6);
      assert.ok(asked.length > 0, 'the source asked');
      for (const url of asked) {
        const u = new URL(url);
        assert.equal(u.searchParams.get('appid'), 'S3CRET-K3Y', 'the key goes with the request');
        assert.equal(u.searchParams.get('units'), 'metric', 'the rest of the address as typed');
      }
      // On disk, nowhere but the key store (which the in-memory store of the harness is not).
      const walk = async (dir: string): Promise<string[]> => {
        const out: string[] = [];
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(p)));
          else out.push(p);
        }
        return out;
      };
      for (const file of await walk(dataDir)) {
        if (/\.(json|ndjson|log|txt)$/.test(file))
          assert.ok(
            !(await fs.readFile(file, 'utf8')).includes('S3CRET-K3Y'),
            `${path.relative(dataDir, file)} holds the key`,
          );
      }
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
