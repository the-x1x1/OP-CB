import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentLogger } from '@opcb/core';
import { readBuildList } from '@opcb/offline';
import type { WorldPackRegistry } from '@opcb/offline';
import type { MapDownloadStatus } from '@opcb/ipc-contract';
import { MAP_PROVIDER_ID, MapDownloads, PROTOMAPS_POLICY, packIdentity } from './map-download.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test("the downloaded map carries the licence register's own record for protomaps-builds", () => {
  const reg = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'providers.json'), 'utf8')) as unknown;
  const list = (Array.isArray(reg) ? reg : ((reg as { records?: unknown[] }).records ?? [])) as Array<{
    providerId: string;
    dataPolicy: Record<string, unknown>;
  }>;
  const rec = list.find((r) => r.providerId === MAP_PROVIDER_ID);
  assert.ok(rec, 'protomaps-builds is in the register');
  assert.equal(PROTOMAPS_POLICY.attribution, rec.dataPolicy['attributionText']);
  assert.equal(PROTOMAPS_POLICY.offlinePackAllowed, rec.dataPolicy['offlinePackAllowed']);
  assert.equal(PROTOMAPS_POLICY.redistributionAllowed, rec.dataPolicy['redistributionAllowed']);
  assert.equal(PROTOMAPS_POLICY.termsUrl, rec.dataPolicy['termsUrl']);
});

test('the build list: entries as read live on 2026-10-30, newest first; anything else skipped', () => {
  const builds = readBuildList([
    { key: '20230918.pmtiles', size: 114683195425, uploaded: '2023-09-18T11:02:48.409Z', version: '0.0.0' },
    {
      key: '20261029.pmtiles',
      size: 139191612225,
      md5sum: 'UlMMWorRPNJaab2SpWKcPA==',
      b3sum: '4c08fa256bc18104bf761eb7a8d4eeaed37d9e033b10e59e5efde6ffae321a28',
      uploaded: '2026-10-29T09:03:31.773Z',
      version: '4.15.2',
    },
    { key: '../etc/passwd', size: 1 },
    { key: '20261030.pmtiles', size: -1 },
  ]);
  assert.deepEqual(builds, [
    {
      key: '20261029.pmtiles',
      date: '2026-10-29',
      sizeBytes: 139191612225,
      version: '4.15.2',
      md5: 'UlMMWorRPNJaab2SpWKcPA==',
    },
    { key: '20230918.pmtiles', date: '2023-09-18', sizeBytes: 114683195425, version: '0.0.0' },
  ]);
  assert.throws(() => readBuildList({}));
});

test('pack names: one world map per detail level, one per named area, one planet', () => {
  assert.deepEqual(packIdentity({ kind: 'extract', worldMaxZoom: 7, maxZoom: 7 }), {
    id: 'map-world-z7',
    name: 'World map — detail to zoom 7',
  });
  assert.equal(
    packIdentity({
      kind: 'extract',
      worldMaxZoom: 6,
      maxZoom: 14,
      bounds: { west: -158, south: 21, east: -157, north: 22 },
      name: "O'ahu",
    }).id,
    'map-o-ahu-z14',
  );
  assert.equal(packIdentity({ kind: 'planet', worldMaxZoom: 15, maxZoom: 15 }).id, 'map-planet');
});

test('a download whose pack folder cannot be prepared ends as failed, not standing at "downloading"', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const seen: MapDownloadStatus[] = [];
  const downloads = new MapDownloads({
    fetchImpl: (async () =>
      new Response(JSON.stringify([{ key: '20261029.pmtiles', size: 1000, version: '4.15.2' }]), {
        status: 200,
      })) as typeof fetch,
    registry: () =>
      ({
        downloadDirFor: () => path.join(root, 'artifacts', 'no-such-folder'),
        prepareDownload: async () => {
          throw new Error('EPERM: the packs folder could not be written');
        },
      }) as unknown as WorldPackRegistry,
    vaultTarget: () => undefined,
    appPacksDir: root,
    now: () => Date.parse('2026-11-20T00:00:00Z'),
    log: silentLogger,
    onChange: (status) => seen.push(status),
    freeBytes: async () => 1e12,
  });
  const settled = async (phases: MapDownloadStatus['phase'][]) => {
    for (let i = 0; i < 200 && !phases.includes(downloads.current().phase); i++)
      await new Promise((r) => setTimeout(r, 5));
    return downloads.current();
  };
  downloads.startPlan({ kind: 'planet' } as never);
  assert.equal((await settled(['planned', 'failed'])).phase, 'planned');
  downloads.start();
  const end = await settled(['failed', 'done', 'cancelled']);
  assert.equal(end.phase, 'failed');
  assert.match(end.message ?? '', /could not be written/);
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  // And another can be planned: nothing is left "busy".
  downloads.startPlan({ kind: 'planet' } as never);
  assert.equal((await settled(['planned', 'failed'])).phase, 'planned');
});

test('download progress keeps being reported after the clock is put back', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opcb-mapdl-'));
  try {
    const SIZE = 64 * 1024;
    let t = Date.parse('2026-11-20T00:00:00Z');
    const seen: MapDownloadStatus[] = [];
    // The body arrives in chunks; between chunks the clock moves on a second, except once,
    // when it is put back an hour.
    const chunks = 16;
    const body = () =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 1));
          if (pulls === 4) t -= 3_600_000;
          else t += 1000;
          pulls++;
          if (pulls > chunks) controller.close();
          else controller.enqueue(new Uint8Array(SIZE / chunks));
        },
      });
    let pulls = 0;
    const downloads = new MapDownloads({
      fetchImpl: (async (url: string | URL | Request) =>
        String(url).endsWith('.pmtiles')
          ? new Response(body(), { status: 200, headers: { 'content-length': String(SIZE) } })
          : new Response(JSON.stringify([{ key: '20261029.pmtiles', size: SIZE, version: '4.15.2' }]), {
              status: 200,
            })) as typeof fetch,
      registry: () =>
        ({
          downloadDirFor: () => dir,
          prepareDownload: async () => ({ ok: true, dir }),
        }) as unknown as WorldPackRegistry,
      vaultTarget: () => undefined,
      appPacksDir: dir,
      now: () => t,
      log: silentLogger,
      onChange: (status) => seen.push(status),
      freeBytes: async () => 1e12,
    });
    const settled = async (phases: MapDownloadStatus['phase'][]) => {
      for (let i = 0; i < 400 && !phases.includes(downloads.current().phase); i++)
        await new Promise((r) => setTimeout(r, 5));
      return downloads.current();
    };
    downloads.startPlan({ kind: 'planet' } as never);
    assert.equal((await settled(['planned', 'failed'])).phase, 'planned');
    downloads.start();
    await settled(['verifying', 'failed', 'done', 'cancelled', 'installing']);
    const reported = seen
      .filter((s) => s.phase === 'downloading' && s.progress)
      .map((s) => s.progress!.bytesDone)
      .filter((n) => n > 0 && n < SIZE);
    // A report every chunk (each a second apart); after the hour back, not one until the end.
    const afterBack = reported.filter((n) => n > (4 * SIZE) / chunks);
    assert.ok(
      afterBack.length >= 5,
      `progress went on being reported after the clock went back (${reported.join(', ')})`,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
