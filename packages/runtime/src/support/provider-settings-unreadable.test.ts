import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderSettingsStore } from './provider-storage.js';

/**
 * provider-settings.json holds each source's own settings (a Home Assistant address and the
 * sources picked from it, a receiver's host, the local camera list). Read as empty when it was
 * there but did not read, the first source setting saved wrote over every other source's; a
 * damaged one was written over without being kept.
 */
test('provider settings: a file that cannot be read is not written over, and is read once it can be', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-psettings-'));
  try {
    const file = path.join(dir, 'provider-settings.json');
    await fs.mkdir(file);
    const store = new ProviderSettingsStore(file);
    await store.load();
    assert.deepEqual(store.get('home-assistant'), {});
    await assert.rejects(store.set('nws-alerts', { zone: 'HIZ005' }), (err: unknown) => {
      assert.equal((err as { ipcCode?: string }).ipcCode, 'UNAVAILABLE');
      assert.match((err as Error).message, /provider-settings\.json could not be read/);
      return true;
    });
    await fs.rm(file, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, providers: { 'home-assistant': { host: 'ha.local' } } }));
    await store.set('nws-alerts', { zone: 'HIZ005' });
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { providers: Record<string, unknown> };
    assert.deepEqual(onDisk.providers, { 'home-assistant': { host: 'ha.local' }, 'nws-alerts': { zone: 'HIZ005' } });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('provider settings: a damaged file is kept beside, not written over', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-psettings-'));
  try {
    const file = path.join(dir, 'provider-settings.json');
    await fs.writeFile(file, '{"version":1,"providers":{"home-assistant":{"host":"ha.lo');
    const store = new ProviderSettingsStore(file);
    await store.load();
    await store.set('nws-alerts', { zone: 'HIZ005' });
    const kept = (await fs.readdir(dir)).filter((n) => n.startsWith('provider-settings.json.corrupt-'));
    assert.equal(kept.length, 1, 'the damaged file is kept beside');
    assert.match(await fs.readFile(path.join(dir, kept[0]!), 'utf8'), /ha\.lo/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('provider settings: a write that does not reach the disk says so', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-psettings-'));
  try {
    const file = path.join(dir, 'provider-settings.json');
    const store = new ProviderSettingsStore(file);
    await store.load();
    await fs.mkdir(file);
    await assert.rejects(store.set('nws-alerts', { zone: 'HIZ005' }), /provider-settings\.json could not be written/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
