import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { testing } from '@opcb/provider-sdk';
import { WorldPackRegistry } from './registry.js';
import { writeTestPack } from '../test/helpers/pack.js';
import { tempDir } from '../test/helpers/raw-zip.js';

const { VirtualClock } = testing;

function registry(
  dataDir: string,
  flags = { history: false, collections: true, localAircraft: false },
): WorldPackRegistry {
  return new WorldPackRegistry({
    dataDir,
    appVersion: '0.1.0',
    clock: new VirtualClock(Date.parse('2026-09-21T12:00:00Z')),
    flags: () => flags,
  });
}

test('registry: install → list → capabilities → search → disable → remove', async () => {
  const dir = await tempDir();
  const dataDir = path.join(dir, 'data');
  const file = path.join(dir, 'hawaii.worldpack');
  await writeTestPack(file);
  const reg = registry(dataDir);
  const events: number[] = [];
  reg.on('changed', (e) => events.push(e.packs.length));
  await reg.refresh();
  assert.deepEqual(reg.summaries(), []);
  assert.equal(reg.capabilities().localSearch, false);

  const r = await reg.install(file);
  assert.ok(r.installed, r.issues.join('; '));
  assert.equal(r.installed?.id, 'hawaii-test');
  assert.equal(r.installed?.status, 'active');
  assert.deepEqual(r.installed?.contents, ['data/places.geojson', 'search/index.json', 'licenses/NOTICES.md']);
  assert.equal(r.installed?.installedAt, '2026-09-21T12:00:00.000Z');
  assert.ok((await fs.stat(path.join(dataDir, 'worldpacks', 'hawaii-test', 'manifest.json'))).isFile());
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'worldpacks', '.staging')).catch(() => []),
    [],
    'staging is cleaned',
  );

  const caps = reg.capabilities();
  assert.equal(caps.localSearch, true);
  assert.equal(caps.localMap, false, 'no PMTiles in this pack');
  assert.equal(caps.collections, true);
  assert.equal(reg.placeIndex().search('Honolulu')[0]?.entry.name, 'Honolulu');
  assert.equal(reg.placeIndex().search('HNL')[0]?.entry.iata, 'HNL');
  assert.deepEqual(reg.pmtilesPaths(), []);
  assert.equal(reg.pmtilesAttribution(), undefined, 'no basemap in the pack: no credit');
  assert.equal(reg.dataFiles('geojson', 'place').length, 1);
  const status = reg.status({
    state: 'OFFLINE',
    networkOnline: false,
    remoteLive: 0,
    remoteTotal: 3,
    localLive: 0,
    at: '2026-09-21T12:00:00.000Z',
  });
  assert.equal(status.packs.length, 1);
  assert.equal(status.capabilities.localSearch, true);

  await reg.setEnabled('hawaii-test', false);
  assert.equal(reg.get('hawaii-test')?.summary.status, 'disabled');
  assert.equal(reg.capabilities().localSearch, false);
  assert.equal(reg.placeIndex().size, 0);
  await reg.setEnabled('hawaii-test', true);
  assert.equal(reg.capabilities().localSearch, true);

  // A fresh registry over the same dataDir sees the same state.
  const reg2 = registry(dataDir);
  await reg2.refresh();
  assert.equal(reg2.get('hawaii-test')?.summary.status, 'active');
  assert.equal((await reg2.verifyInstalled('hawaii-test')).ok, true);

  assert.equal(await reg.remove('hawaii-test'), true);
  assert.equal(await reg.remove('hawaii-test'), false);
  assert.deepEqual(reg.summaries(), []);
  await assert.rejects(fs.stat(path.join(dataDir, 'worldpacks', 'hawaii-test')), /ENOENT/);
  assert.deepEqual(events, [1, 1, 1, 0]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('registry: a tampered pack is refused and leaves nothing behind; reinstall replaces atomically', async () => {
  const dir = await tempDir();
  const dataDir = path.join(dir, 'data');
  const reg = registry(dataDir);
  const bad = path.join(dir, 'bad.worldpack');
  await writeTestPack(bad, {
    mutateManifest: (m) => {
      m.checksums['data/places.geojson'] = 'ef'.repeat(32);
      m.contents[0]!.sha256 = 'ef'.repeat(32);
    },
  });
  const r = await reg.install(bad);
  assert.equal(r.installed, null);
  assert.match(r.issues.join('\n'), /SHA-256 mismatch/);
  assert.deepEqual(
    (await fs.readdir(path.join(dataDir, 'worldpacks'))).filter((f) => !f.startsWith('.') && f !== 'state.json'),
    [],
  );

  const slip = path.join(dir, 'slip.worldpack');
  await writeTestPack(slip, { extraEntries: [{ name: '../escape.geojson', data: Buffer.from('{}') }] });
  const s = await reg.install(slip);
  assert.equal(s.installed, null);
  assert.match(s.issues.join('\n'), /traversal/);
  await assert.rejects(fs.stat(path.join(dataDir, 'escape.geojson')), /ENOENT/);

  const good = path.join(dir, 'good.worldpack');
  await writeTestPack(good, { name: 'First' });
  assert.equal((await reg.install(good)).installed?.name, 'First');
  await writeTestPack(good, { name: 'Second' });
  assert.equal((await reg.install(good)).installed?.name, 'Second');
  assert.equal(reg.summaries().length, 1);
  assert.equal(reg.get('hawaii-test')?.summary.name, 'Second');

  const newer = path.join(dir, 'newer.worldpack');
  await writeTestPack(newer, { id: 'future-pack', minimumAppVersion: '9.9.9' });
  const n = await reg.install(newer);
  assert.equal(n.installed, null);
  assert.match(n.issues.join('\n'), /requires app version/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('registry: invalid installed directories are listed with a message, never silently dropped', async () => {
  const dir = await tempDir();
  const dataDir = path.join(dir, 'data');
  const packsDir = path.join(dataDir, 'worldpacks');
  await fs.mkdir(path.join(packsDir, 'no-manifest'), { recursive: true });
  await fs.mkdir(path.join(packsDir, 'wrong-id'), { recursive: true });
  const good = path.join(dir, 'good.worldpack');
  await writeTestPack(good);
  const reg = registry(dataDir);
  await reg.install(good);
  await fs.copyFile(
    path.join(packsDir, 'hawaii-test', 'manifest.json'),
    path.join(packsDir, 'wrong-id', 'manifest.json'),
  );
  await fs.writeFile(
    path.join(packsDir, 'hawaii-test', 'data', 'places.geojson'),
    '{"type":"FeatureCollection","features":[]}',
  );
  await reg.refresh();
  const byId = Object.fromEntries(reg.summaries().map((s) => [s.id, s]));
  assert.equal(byId['no-manifest']?.status, 'invalid');
  assert.match(byId['no-manifest']?.message ?? '', /manifest\.json missing/);
  assert.equal(byId['hawaii-test']?.status, 'invalid');
  assert.match(byId['hawaii-test']?.message ?? '', /size .* differs/);
  const wrong = reg.summaries().find((s) => s.message?.includes('does not match manifest id'));
  assert.ok(wrong, 'directory/manifest id mismatch is reported');
  assert.equal(reg.capabilities().localSearch, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('registry: trust changes asked for at the same moment are all kept', async () => {
  const dataDir = await tempDir();
  try {
    const reg = registry(dataDir);
    await reg.refresh();
    const keys = Array.from({ length: 6 }, (_, i) => Buffer.alloc(32, i + 1).toString('base64'));
    // Six publishers and the policy, none waiting for another's answer.
    await Promise.all([...keys.map((key, i) => reg.addPublisher(`Publisher ${i}`, key)), reg.setRequireTrusted(true)]);
    const trust = reg.trustState();
    assert.equal(trust.requireTrusted, true, 'the policy was not lost to a publisher written after it');
    assert.deepEqual(trust.publishers.map((p) => p.publicKey).sort(), [...keys].sort());
    // And on disk, for the next start.
    const again = registry(dataDir);
    await again.refresh();
    assert.equal(again.trustState().requireTrusted, true);
    assert.equal(again.trustState().publishers.length, 6);
    // Removing three while renaming the others.
    const ids = again.trustState().publishers.map((p) => p.keyId);
    await Promise.all([
      ...ids.slice(0, 3).map((id) => again.removePublisher(id)),
      ...keys.map((key, i) => again.addPublisher(`Renamed ${i}`, key).catch(() => undefined)),
      again.setRequireTrusted(false),
    ]);
    assert.equal(again.trustState().requireTrusted, false);
    assert.ok(again.trustState().publishers.every((p) => p.name.startsWith('Renamed ')));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('registry: a trust file that does not read is not written over by the next trust change', async () => {
  const dataDir = await tempDir();
  try {
    const reg = registry(dataDir);
    await reg.refresh();
    const key = Buffer.alloc(32, 7).toString('base64');
    await reg.addPublisher('Kept', key);
    await reg.setRequireTrusted(true);
    const trustFile = path.join(dataDir, 'worldpacks', 'trust.json');
    const good = await fs.readFile(trustFile, 'utf8');
    // Damaged on disk (a half-written copy from another tool, a sync conflict): the next change
    // read it as no publishers and the switch off, and wrote that back with itself.
    await fs.writeFile(trustFile, good.slice(0, 20));
    await assert.rejects(reg.addPublisher('Other', Buffer.alloc(32, 8).toString('base64')), /trust\.json/);
    await assert.rejects(reg.setRequireTrusted(false), /trust\.json/);
    assert.equal(await fs.readFile(trustFile, 'utf8'), good.slice(0, 20), 'nothing was written over it');
    // Mended, changes go on as before.
    await fs.writeFile(trustFile, good);
    await reg.addPublisher('Other', Buffer.alloc(32, 8).toString('base64'));
    assert.equal(reg.trustState().publishers.length, 2);
    assert.equal(reg.trustState().requireTrusted, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
