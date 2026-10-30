import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  PmCompression,
  buildPmDirectories,
  encodePmHeader,
  readPmHeader,
  readPmTile,
  zxyToTileId,
  type PmEntry,
} from '@worldview/offline';
import type { MapDownloadStatus, WorldClient } from '@worldview/ipc-contract';
import { startRuntime } from '../helpers/harness.js';

/*
 * The build list's shape is the live one read on 2026-10-30 (build-metadata.protomaps.dev,
 * builds.json); the archive is synthetic, built here, every tile invented.
 */
function synthetic(maxZoom: number): Buffer {
  const entries: PmEntry[] = [];
  const blobs: Buffer[] = [];
  let off = 0;
  const ids: Array<[number, number, number, number]> = [];
  for (let z = 0; z <= maxZoom; z++)
    for (let x = 0; x < 1 << z; x++) for (let y = 0; y < 1 << z; y++) ids.push([zxyToTileId(z, x, y), z, x, y]);
  ids.sort((a, b) => a[0] - b[0]);
  for (const [id, z, x, y] of ids) {
    const data = Buffer.from(`tile ${z}/${x}/${y}`);
    entries.push({ tileId: id, offset: off, length: data.length, runLength: 1 });
    blobs.push(data);
    off += data.length;
  }
  const dirs = buildPmDirectories(entries, PmCompression.Gzip);
  const meta = gzipSync(Buffer.from(JSON.stringify({ vector_layers: [{ id: 'earth' }, { id: 'water' }] })));
  const head = encodePmHeader({
    rootDirectoryOffset: 127,
    rootDirectoryLength: dirs.root.length,
    metadataOffset: 127 + dirs.root.length,
    metadataLength: meta.length,
    leafDirectoryOffset: 127 + dirs.root.length + meta.length,
    leafDirectoryLength: dirs.leaves.length,
    tileDataOffset: 127 + dirs.root.length + meta.length + dirs.leaves.length,
    tileDataLength: off,
    numAddressedTiles: entries.length,
    numTileEntries: entries.length,
    numTileContents: entries.length,
    clustered: true,
    internalCompression: PmCompression.Gzip,
    tileCompression: PmCompression.None,
    tileType: 1,
    minZoom: 0,
    maxZoom,
    minLon: -180,
    minLat: -85,
    maxLon: 180,
    maxLat: 85,
    centerZoom: 0,
    centerLon: 0,
    centerLat: 0,
  });
  return Buffer.concat([head, dirs.root, meta, dirs.leaves, ...blobs]);
}

function fakeProtomaps(archive: Buffer, opts: { md5?: string } = {}) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const range = new Headers(init?.headers).get('range');
    asked.push(`${url}${range ? ` ${range}` : ''}`);
    if (url === 'https://build-metadata.protomaps.dev/builds.json')
      return Response.json([
        { key: '20261028.pmtiles', size: archive.length, uploaded: '2026-10-28T08:54:55.754Z', version: '4.15.2' },
        {
          key: '20261029.pmtiles',
          size: archive.length,
          md5sum: opts.md5 ?? createHash('md5').update(archive).digest('base64'),
          uploaded: '2026-10-29T09:03:31.773Z',
          version: '4.15.2',
        },
      ]);
    if (url === 'https://build.protomaps.com/20261029.pmtiles') {
      if (!range) return new Response(new Uint8Array(archive), { status: 200 });
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)!;
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), archive.length - 1) : archive.length - 1;
      return new Response(new Uint8Array(archive.subarray(start, end + 1)), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${archive.length}` },
      });
    }
    throw new TypeError(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

async function until(client: WorldClient, phases: MapDownloadStatus['phase'][]): Promise<MapDownloadStatus> {
  for (let i = 0; i < 400; i++) {
    const st = await client.request('maps.download.status', undefined);
    if (phases.includes(st.phase)) return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out at ${JSON.stringify(await client.request('maps.download.status', undefined))}`);
}

test('map download: the world to a zoom, sized exactly before downloading, then a live world pack', async () => {
  const archive = synthetic(6);
  const { fetchImpl, asked } = fakeProtomaps(archive);
  const h = await startRuntime({ fetchImpl });
  try {
    await h.client.request('maps.download.plan', { kind: 'extract', worldMaxZoom: 4, maxZoom: 4 });
    const planned = await until(h.client, ['planned', 'failed']);
    assert.equal(planned.phase, 'planned', planned.message ?? '');
    assert.equal(planned.build?.key, '20261029.pmtiles', 'the newest build');
    assert.equal(planned.tiles, (4 ** 5 - 1) / 3);
    assert.ok(planned.sizeBytes! > 0 && planned.sizeBytes! < archive.length);
    assert.ok(
      asked.every((a) => !a.endsWith('20261029.pmtiles')),
      'only byte ranges were asked of the build',
    );
    await h.client.request('maps.download.start', undefined);
    const done = await until(h.client, ['done', 'failed']);
    assert.equal(done.phase, 'done', done.message ?? '');
    assert.deepEqual(done.installed, { id: 'map-world-z4', name: 'World map — detail to zoom 4' });
    const status = await h.client.request('offline.status', undefined);
    const pack = status.packs.find((p) => p.id === 'map-world-z4')!;
    assert.equal(pack.status, 'active');
    assert.equal(status.capabilities.localMap, true);
    const file = path.join(h.dataDir, 'worldpacks', 'map-world-z4', 'maps', 'basemap.pmtiles');
    const out = await fs.readFile(file);
    assert.equal(out.length, planned.sizeBytes);
    const oh = readPmHeader(out);
    assert.equal(oh.maxZoom, 4);
    const read = (b: Buffer) => async (o: number, l: number) => b.subarray(o, o + l);
    assert.deepEqual(
      Buffer.from((await readPmTile(read(out), oh, 4, 7, 9))!).toString(),
      'tile 4/7/9',
      'a tile reads back',
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(path.dirname(path.dirname(file)), 'manifest.json'), 'utf8'),
    );
    assert.equal(manifest.checksums['maps/basemap.pmtiles'], createHash('sha256').update(out).digest('hex'));
    assert.equal(manifest.sourcePolicies[0].attribution, 'Protomaps · © OpenStreetMap contributors (ODbL)');
    assert.equal(manifest.version, '2026.10.29');
    const notices = await fs.readFile(path.join(path.dirname(path.dirname(file)), 'licenses', 'NOTICES.md'), 'utf8');
    assert.match(notices, /OpenStreetMap contributors/);
  } finally {
    await h.dispose();
  }
});

test('map download: an area adds detail; the whole planet is checked against its MD5; a bad one is never installed', async () => {
  const archive = synthetic(5);
  const good = fakeProtomaps(archive);
  const h = await startRuntime({ fetchImpl: good.fetchImpl });
  try {
    await h.client.request('maps.download.plan', {
      kind: 'extract',
      worldMaxZoom: 2,
      maxZoom: 5,
      bounds: { west: 0, south: 0, east: 30, north: 30 },
      name: "O'ahu test",
    });
    assert.equal((await until(h.client, ['planned', 'failed'])).phase, 'planned');
    await h.client.request('maps.download.start', undefined);
    const done = await until(h.client, ['done', 'failed']);
    assert.equal(done.installed?.id, 'map-o-ahu-test-z5');

    await h.client.request('maps.download.plan', { kind: 'planet', worldMaxZoom: 0, maxZoom: 15 });
    const planet = await until(h.client, ['planned', 'failed']);
    assert.equal(planet.sizeBytes, archive.length);
    await h.client.request('maps.download.start', undefined);
    assert.equal((await until(h.client, ['done', 'failed'])).installed?.id, 'map-planet');
    const whole = await fs.readFile(path.join(h.dataDir, 'worldpacks', 'map-planet', 'maps', 'basemap.pmtiles'));
    assert.ok(whole.equals(archive));
  } finally {
    await h.dispose();
  }
  const bad = fakeProtomaps(archive, { md5: 'AAAAAAAAAAAAAAAAAAAAAA==' });
  const h2 = await startRuntime({ fetchImpl: bad.fetchImpl });
  try {
    await h2.client.request('maps.download.plan', { kind: 'planet', worldMaxZoom: 0, maxZoom: 15 });
    await until(h2.client, ['planned']);
    await h2.client.request('maps.download.start', undefined);
    const failed = await until(h2.client, ['done', 'failed']);
    assert.equal(failed.phase, 'failed');
    assert.match(failed.message ?? '', /MD5/);
    assert.equal((await h2.client.request('offline.status', undefined)).packs.length, 0, 'nothing installed');
  } finally {
    await h2.dispose();
  }
});

test('map download: offline it asks nothing and says so; a cancel installs nothing; a bad request is refused', async () => {
  const offline = (async () => {
    throw Object.assign(new Error('working offline: build-metadata.protomaps.dev not asked'), {
      name: 'WorkingOfflineError',
    });
  }) as typeof fetch;
  const h = await startRuntime({ fetchImpl: offline });
  try {
    await h.client.request('maps.download.plan', { kind: 'extract', worldMaxZoom: 3, maxZoom: 3 });
    const st = await until(h.client, ['failed', 'planned']);
    assert.match(st.message ?? '', /Offline mode: switch to Online/);
    await assert.rejects(h.client.request('maps.download.plan', { kind: 'extract', worldMaxZoom: 3, maxZoom: 16 }));
    const tooBig = await h.client.request('maps.download.plan', {
      kind: 'extract',
      worldMaxZoom: 4,
      maxZoom: 15,
      bounds: { west: -10, south: 35, east: 60, north: 70 },
    });
    assert.match(tooBig.message ?? '', /too many tiles/);
  } finally {
    await h.dispose();
  }
  const archive = synthetic(6);
  const { fetchImpl } = fakeProtomaps(archive);
  const h2 = await startRuntime({ fetchImpl });
  try {
    await h2.client.request('maps.download.plan', { kind: 'extract', worldMaxZoom: 5, maxZoom: 5 });
    await until(h2.client, ['planned']);
    await h2.client.request('maps.download.start', undefined);
    await h2.client.request('maps.download.cancel', undefined);
    const st = await until(h2.client, ['cancelled', 'done', 'failed']);
    assert.equal(st.phase, 'cancelled');
    assert.equal((await h2.client.request('offline.status', undefined)).packs.length, 0);
    assert.deepEqual(await fs.readdir(path.join(h2.dataDir, 'worldpacks', '.downloads')), []);
  } finally {
    await h2.dispose();
  }
});

test('map download: a stopped whole-planet download is kept and, after a restart, carries on from where it was', async () => {
  const archive = synthetic(6);
  const half = Math.floor(archive.length / 2);
  // First run: the server sends half the file, then nothing more until the download is stopped.
  const stalling = fakeProtomaps(archive);
  const stallFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://build.protomaps.com/20261029.pmtiles') return stalling.fetchImpl(input, init);
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(archive.subarray(0, half)));
        signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const dataDir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'worldview-planet-'));
  try {
    const h = await startRuntime({ fetchImpl: stallFetch, dataDir });
    try {
      await h.client.request('maps.download.plan', { kind: 'planet', worldMaxZoom: 0, maxZoom: 15 });
      await until(h.client, ['planned']);
      await h.client.request('maps.download.start', undefined);
      for (let i = 0; i < 400; i++) {
        const st = await h.client.request('maps.download.status', undefined);
        if ((st.progress?.bytesDone ?? 0) >= half) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await h.client.request('maps.download.cancel', undefined);
      const stopped = await until(h.client, ['cancelled', 'failed', 'done']);
      assert.equal(stopped.phase, 'cancelled');
      assert.match(stopped.message ?? '', /kept, and the next download of this build carries on/);
      assert.equal((await h.client.request('offline.status', undefined)).packs.length, 0);
    } finally {
      await h.dispose();
    }
    // Second run, a fresh start of the app: the plan says what is there; the download asks
    // only for the rest, and the result is the whole file, MD5 and all.
    const good = fakeProtomaps(archive);
    const h2 = await startRuntime({ fetchImpl: good.fetchImpl, dataDir });
    try {
      await h2.client.request('maps.download.plan', { kind: 'planet', worldMaxZoom: 0, maxZoom: 15 });
      const planned = await until(h2.client, ['planned', 'failed']);
      assert.equal(planned.resumedFrom, half);
      await h2.client.request('maps.download.start', undefined);
      const done = await until(h2.client, ['done', 'failed']);
      assert.equal(done.phase, 'done', done.message ?? '');
      assert.ok(good.asked.includes(`https://build.protomaps.com/20261029.pmtiles bytes=${half}-`));
      assert.ok(!good.asked.includes('https://build.protomaps.com/20261029.pmtiles'), 'not from the start');
      const whole = await fs.readFile(path.join(dataDir, 'worldpacks', 'map-planet', 'maps', 'basemap.pmtiles'));
      assert.ok(whole.equals(archive));
      // Nothing of the unfinished download is left in the pack (no partial.json).
      assert.deepEqual(await fs.readdir(path.join(dataDir, 'worldpacks', 'map-planet')).then((x) => x.sort()), [
        'licenses',
        'manifest.json',
        'maps',
      ]);
    } finally {
      await h2.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
