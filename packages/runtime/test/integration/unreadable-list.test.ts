import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../helpers/harness.js';

/**
 * A list file there at start but not readable shows empty, and nothing is written over it.
 * The window is told why the first time it asks for that list, not only when a change to it is
 * refused: otherwise the operator sees their places gone and nothing says they are safe.
 */
test('integration: a list that did not read is shown empty with a notice saying why, once', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-unreadable-'));
  try {
    // collections.json there, but not a file that reads (as a held file is, on Windows).
    await fs.mkdir(path.join(dataDir, 'collections.json'));
    await fs.mkdir(path.join(dataDir, 'cameras.json'));
    const h = await startRuntime({ dataDir, providerInstances: [] });
    try {
      const notices: Array<{ title: string; body: string; severity: string }> = [];
      h.runtime.on('notification', (n) => notices.push(n));
      assert.deepEqual(await h.client.request('collections.list', undefined), []);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!.title, /Places could not be read/);
      assert.match(notices[0]!.body, /collections\.json could not be read/);
      assert.match(notices[0]!.body, /nothing is written over it/i);
      await h.client.request('collections.list', undefined);
      assert.equal(notices.length, 1, 'once, not at every ask');
      // A list that read is not mentioned.
      await h.client.request('watchzones.list', undefined);
      assert.equal(notices.length, 1);
      // The camera list, whose file is read at start into the gateways.
      assert.deepEqual(await h.client.request('camera.list', undefined), []);
      assert.equal(notices.length, 2);
      assert.match(notices[1]!.body, /cameras\.json could not be read/);
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
