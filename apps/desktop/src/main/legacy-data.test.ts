import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_MARKER_FILE, LEGACY_PORTABLE_DIR_NAME, migrateLegacyData, type LegacyFs } from './legacy-data.js';
import { hasMarker } from './data-location.js';

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'opcb-legacy-'));
}

async function oldData(appData: string): Promise<string> {
  const dir = path.join(appData, '@worldview', 'desktop');
  await fsp.mkdir(path.join(dir, 'history'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":8}');
  await fsp.writeFile(path.join(dir, 'history', 'h.duckdb'), 'x');
  return dir;
}

test('legacy data: the old usual folder is moved whole to <appData>/OP-CB, and the empty @worldview goes', async () => {
  const appData = await tmp();
  const exeDir = await tmp();
  await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  const r = migrateLegacyData({ appData, newUsual, exeDir, dev: false, platform: 'win32' });
  assert.equal(r.busy, undefined);
  assert.deepEqual(r.problems, []);
  assert.equal(await fsp.readFile(path.join(newUsual, 'settings.json'), 'utf8'), '{"schemaVersion":8}');
  assert.equal(await fsp.readFile(path.join(newUsual, 'history', 'h.duckdb'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(appData, '@worldview')), false);
  // A second start finds nothing to do.
  assert.deepEqual(migrateLegacyData({ appData, newUsual, exeDir, dev: false, platform: 'win32' }).moved, []);
});

test('legacy data: a new folder Electron already made (crash reporter only) takes the old contents', async () => {
  const appData = await tmp();
  await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  await fsp.mkdir(path.join(newUsual, 'Crashpad'), { recursive: true });
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), dev: false, platform: 'win32' });
  assert.equal(r.moved.length, 1);
  assert.ok(fs.existsSync(path.join(newUsual, 'settings.json')));
  assert.ok(fs.existsSync(path.join(newUsual, 'Crashpad')));
});

test('legacy data: never overwrites OP-CB data that already exists', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  await fsp.mkdir(newUsual, { recursive: true });
  await fsp.writeFile(path.join(newUsual, 'settings.json'), '{"new":true}');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), dev: false, platform: 'win32' });
  assert.deepEqual(r.moved, []);
  assert.equal(await fsp.readFile(path.join(newUsual, 'settings.json'), 'utf8'), '{"new":true}');
  assert.ok(fs.existsSync(path.join(old, 'settings.json')), 'the old data is left as it is');
});

test('legacy data: when the old program has the folder open nothing moves and the start is told', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const busyFs: LegacyFs = {
    ...fs,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === old) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    },
  };
  const newUsual = path.join(appData, 'OP-CB');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), dev: false, platform: 'win32', f: busyFs });
  assert.equal(r.busy, old);
  assert.ok(fs.existsSync(path.join(old, 'settings.json')));
  assert.equal(fs.existsSync(newUsual), false);
});

test('legacy data: Linux — a live SingletonLock in the old folder means the old program runs', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  await fsp.symlink('host-4242', path.join(old, 'SingletonLock'));
  const newUsual = path.join(appData, 'OP-CB');
  const running = migrateLegacyData({
    appData,
    newUsual,
    exeDir: await tmp(),
    dev: false,
    platform: 'linux',
    alive: () => true,
  });
  assert.equal(running.busy, old);
  const stale = migrateLegacyData({
    appData,
    newUsual,
    exeDir: await tmp(),
    dev: false,
    platform: 'linux',
    alive: () => false,
  });
  assert.equal(stale.busy, undefined);
  assert.ok(fs.existsSync(path.join(newUsual, 'settings.json')));
});

test('legacy data: WorldView-data beside the executable becomes OP-CB-data (not in development)', async () => {
  const appData = await tmp();
  const exeDir = await tmp();
  await fsp.mkdir(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME));
  await fsp.writeFile(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME, 'settings.json'), '{}');
  migrateLegacyData({ appData, newUsual: path.join(appData, 'OP-CB'), exeDir, dev: true });
  assert.ok(fs.existsSync(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME)), 'development leaves it alone');
  const r = migrateLegacyData({ appData, newUsual: path.join(appData, 'OP-CB'), exeDir, dev: false });
  assert.equal(r.moved.length, 1);
  assert.ok(fs.existsSync(path.join(exeDir, 'OP-CB-data', 'settings.json')));
});

test('legacy data: the marker of a folder the data was moved to is renamed, and either name is accepted', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const drive = await tmp();
  await fsp.writeFile(path.join(drive, LEGACY_MARKER_FILE), '{"kind":"worldview-data"}');
  assert.ok(hasMarker(fs, drive), 'the old marker counts');
  await fsp.writeFile(path.join(old, 'data-location.json'), JSON.stringify({ path: drive }));
  const newUsual = path.join(appData, 'OP-CB');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), dev: false, platform: 'win32' });
  assert.equal(r.moved.length, 2);
  assert.ok(fs.existsSync(path.join(drive, 'opcb-data.json')));
  assert.equal(fs.existsSync(path.join(drive, LEGACY_MARKER_FILE)), false);
  assert.ok(hasMarker(fs, drive), 'still the same folder after the rename');
});
