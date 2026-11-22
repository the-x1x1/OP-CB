import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../helpers/harness.js';

/**
 * A settings change that could not be written reaches the window as that, not as a refused
 * patch carrying the system's own text (with the data folder's path in it).
 */
test('integration: a settings write that fails is said as unavailable, and the change is kept', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-settings-fail-'));
  try {
    const h = await startRuntime({ dataDir, providerInstances: [] });
    try {
      await h.client.request('settings.set', { renderMode: '3D' });
      const file = path.join(dataDir, 'settings.json');
      await fs.rm(file);
      await fs.mkdir(file);
      const told: string[] = [];
      h.runtime.on('settings.changed', (st) => told.push(st.renderMode));
      await assert.rejects(h.client.request('settings.set', { renderMode: '2D' }), (err: unknown) => {
        assert.equal((err as { ipcCode?: string }).ipcCode, 'UNAVAILABLE');
        assert.match((err as Error).message, /the settings could not be saved/);
        assert.ok(!(err as Error).message.includes(dataDir));
        return true;
      });
      assert.equal((await h.client.request('settings.get', undefined)).renderMode, '2D', 'in use');
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(told, ['2D'], 'the window is told of the change in use, not left showing the one before');
      // A patch that is wrong is still refused as such.
      await assert.rejects(h.client.request('settings.set', { renderMode: 'XR' } as never), (err: unknown) => {
        assert.equal((err as { ipcCode?: string }).ipcCode, 'INVALID_REQUEST');
        return true;
      });
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
