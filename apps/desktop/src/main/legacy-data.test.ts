import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEGACY_MARKER_FILE,
  LEGACY_PORTABLE_DIR_NAME,
  STAGING_SUFFIX,
  migrateLegacyData,
  type LegacyFs,
} from './legacy-data.js';
import { hasMarker } from './data-location.js';

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'opcb-legacy-'));
}

async function oldData(appData: string): Promise<string> {
  const dir = path.join(appData, '@worldview', 'desktop');
  await fsp.mkdir(path.join(dir, 'history'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":8}');
  await fsp.writeFile(path.join(dir, 'Local State'), 'old key');
  await fsp.writeFile(path.join(dir, 'history', 'h.duckdb'), 'x');
  return dir;
}

const win = { dev: false, platform: 'win32' as const };

test('legacy data: the old usual folder is moved whole to <appData>/OP-CB, and the empty @worldview goes', async () => {
  const appData = await tmp();
  const exeDir = await tmp();
  await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  const r = migrateLegacyData({ appData, newUsual, exeDir, ...win });
  assert.equal(r.busy, undefined);
  assert.deepEqual(r.problems, []);
  assert.equal(await fsp.readFile(path.join(newUsual, 'settings.json'), 'utf8'), '{"schemaVersion":8}');
  assert.equal(await fsp.readFile(path.join(newUsual, 'history', 'h.duckdb'), 'utf8'), 'x');
  assert.equal(fs.existsSync(path.join(appData, '@worldview')), false);
  assert.deepEqual(
    migrateLegacyData({ appData, newUsual, exeDir, ...win }).moved,
    [],
    'a second start has nothing to do',
  );
});

test('legacy data: Chromium files already in the new folder (an earlier start) are replaced by the old ones', async () => {
  const appData = await tmp();
  await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  await fsp.mkdir(path.join(newUsual, 'GPUCache'), { recursive: true });
  await fsp.writeFile(path.join(newUsual, 'Local State'), 'new key');
  await fsp.writeFile(path.join(newUsual, 'Preferences'), '{}');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), ...win });
  assert.equal(r.moved.length, 1);
  assert.ok(fs.existsSync(path.join(newUsual, 'settings.json')));
  assert.equal(await fsp.readFile(path.join(newUsual, 'Local State'), 'utf8'), 'old key', 'the old key file wins');
  assert.ok(fs.existsSync(path.join(newUsual, 'Preferences')), 'what the old folder did not have stays');
});

test('legacy data: never overwrites OP-CB data that already exists', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const newUsual = path.join(appData, 'OP-CB');
  await fsp.mkdir(newUsual, { recursive: true });
  await fsp.writeFile(path.join(newUsual, 'settings.json'), '{"new":true}');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), ...win });
  assert.deepEqual(r.moved, []);
  assert.match(r.problems.join(' '), /already holds OP-CB data/);
  assert.equal(await fsp.readFile(path.join(newUsual, 'settings.json'), 'utf8'), '{"new":true}');
  assert.ok(fs.existsSync(path.join(old, 'settings.json')), 'the old data is left as it is');
});

test('legacy data: while the old program has the folder open nothing moves; the next start moves it', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  let locked = true;
  const lockingFs: LegacyFs = {
    ...fs,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (locked && String(from) === old) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    },
  };
  const newUsual = path.join(appData, 'OP-CB');
  const exeDir = await tmp();
  const r = migrateLegacyData({ appData, newUsual, exeDir, ...win, f: lockingFs });
  assert.equal(r.busy, old);
  assert.ok(fs.existsSync(path.join(old, 'settings.json')));
  // Chromium may still have made a profile in the new folder; the next start is not put off by it.
  await fsp.mkdir(path.join(newUsual, 'Crashpad'), { recursive: true });
  locked = false;
  const next = migrateLegacyData({ appData, newUsual, exeDir, ...win, f: lockingFs });
  assert.equal(next.busy, undefined);
  assert.ok(fs.existsSync(path.join(newUsual, 'settings.json')));
});

test('legacy data: a move interrupted after the first rename is finished at the next start', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  await fsp.rename(old, `${old}${STAGING_SUFFIX}`);
  const newUsual = path.join(appData, 'OP-CB');
  await fsp.mkdir(newUsual, { recursive: true });
  await fsp.writeFile(path.join(newUsual, 'SingletonLock'), '');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), ...win });
  assert.deepEqual(r.problems, []);
  assert.ok(fs.existsSync(path.join(newUsual, 'history', 'h.duckdb')));
  assert.equal(fs.existsSync(`${old}${STAGING_SUFFIX}`), false);
});

test('legacy data: Linux — the old program runs only when the lock names this host and a WorldView pid', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  await fsp.symlink('deck-4242', path.join(old, 'SingletonLock'));
  const newUsual = path.join(appData, 'OP-CB');
  const base = { appData, newUsual, exeDir: await tmp(), dev: false, platform: 'linux' as const, hostname: 'deck' };
  const running = migrateLegacyData({ ...base, cmdline: () => '/opt/WorldView/worldview --type=browser' });
  assert.equal(running.busy, old);
  const reused = migrateLegacyData({ ...base, cmdline: () => '/usr/bin/bash' });
  assert.equal(reused.busy, undefined, 'a stale lock whose pid another program now has');
  assert.ok(fs.existsSync(path.join(newUsual, 'settings.json')));
});

test('legacy data: WorldView-data beside the executable becomes OP-CB-data, and the computer’s data is left alone', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const exeDir = await tmp();
  await fsp.mkdir(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME));
  await fsp.writeFile(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME, 'settings.json'), '{}');
  const newUsual = path.join(appData, 'OP-CB');
  migrateLegacyData({ appData: await tmp(), newUsual: path.join(await tmp(), 'OP-CB'), exeDir, dev: true });
  assert.ok(fs.existsSync(path.join(exeDir, LEGACY_PORTABLE_DIR_NAME)), 'development leaves it alone');
  const r = migrateLegacyData({ appData, newUsual, exeDir, dev: false });
  assert.equal(r.moved.length, 1);
  assert.ok(fs.existsSync(path.join(exeDir, 'OP-CB-data', 'settings.json')));
  assert.ok(fs.existsSync(path.join(old, 'settings.json')), 'a portable copy does not take the installed data');
  assert.equal(fs.existsSync(newUsual), false);
});

test('legacy data: the marker of a folder the data was moved to is renamed, and either name is accepted', async () => {
  const appData = await tmp();
  const old = await oldData(appData);
  const drive = await tmp();
  await fsp.writeFile(path.join(drive, LEGACY_MARKER_FILE), '{"kind":"worldview-data"}');
  assert.ok(hasMarker(fs, drive), 'the old marker counts');
  await fsp.writeFile(path.join(old, 'data-location.json'), JSON.stringify({ path: drive }));
  const newUsual = path.join(appData, 'OP-CB');
  const r = migrateLegacyData({ appData, newUsual, exeDir: await tmp(), ...win });
  assert.equal(r.moved.length, 2);
  assert.ok(fs.existsSync(path.join(drive, 'opcb-data.json')));
  assert.equal(fs.existsSync(path.join(drive, LEGACY_MARKER_FILE)), false);
  assert.ok(hasMarker(fs, drive), 'still the same folder after the rename');
});
