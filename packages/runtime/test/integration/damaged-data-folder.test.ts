import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider as createUsgs } from '@opcb/provider-usgs';
import { readFixture, repoRoot, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * The app's own data folder after something has been at it. Everything the runtime keeps
 * (settings, collections, watch zones, lenses, each source's settings and cached answer, the
 * history and its index) is a file, and a file can be cut short by a power cut, emptied by a
 * full disk, or edited by hand. Whatever is in the folder, the runtime starts, answers, and
 * goes on saving: what could not be read is lost, never the app. Damage is generated from a
 * fixed seed.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BITS = [
  '',
  '\n',
  '{',
  '}',
  '[',
  ']',
  '"',
  ',',
  ':',
  'null',
  'true',
  '0',
  '-1',
  '1e999',
  'NaN',
  '"__proto__":{"x":1},',
  '"constructor":5,',
  '[[[[',
  '\u0000',
];
const WHOLE = [
  '',
  ' ',
  'null',
  '[]',
  '{}',
  '0',
  '"text"',
  '[null]',
  '{"version":99}',
  '{"items":"nope"}',
  'not json',
  '\ufeff{}',
];

async function files(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await files(full, out);
    else out.push(full);
  }
  return out;
}

test('integration: the runtime starts and goes on saving whatever state its data folder is in', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const fetchTable = () =>
    tableFetch({
      'https://earthquake.usgs.gov/': () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
    }).impl;
  const zone = {
    id: 'z1',
    name: 'Oahu',
    geometry: { kind: 'circle' as const, center: { latitude: 21.3, longitude: -157.8 }, radiusM: 50_000 },
    eventTypes: ['earthquake'],
    notifications: { inApp: true, desktop: false },
    enabled: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  };
  const collection = {
    id: 'c1',
    name: 'Test',
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    items: [],
  };
  const lens = {
    id: 'user-test',
    name: 'Test lens',
    objectTypes: ['earthquake'],
    eventTypes: [],
    renderingRules: [],
    visiblePanels: ['selection'],
  };

  // A folder a running app has written everything into.
  const pristine = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-pristine-'));
  const first = await startRuntime({ dataDir: pristine, fetchImpl: fetchTable(), providerInstances: [createUsgs()] });
  await first.client.request('settings.set', { reducedMotion: true });
  await first.client.request('watchzones.save', zone);
  await first.client.request('collections.save', collection);
  await first.client.request('lenses.save', lens);
  await first.client.request('sources.settings.set', { providerId: 'usgs-earthquakes', settings: { feed: 'day' } });
  await first.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
  await settle(8);
  await first.dispose();
  const written = (await files(pristine)).map((f) => path.relative(pristine, f));
  assert.ok(written.length >= 5, `the folder holds ${written.join(', ')}`);

  const next = rng(2026);
  let started = 0;
  try {
    for (let round = 0; round < 40; round++) {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-damaged-'));
      try {
        const damaged: string[] = [];
        for (const relative of written) {
          let text = await fs.readFile(path.join(pristine, relative), 'utf8');
          const roll = next();
          if (roll < 0.35) {
            const times = 1 + Math.floor(next() * 3);
            for (let k = 0; k < times; k++) {
              const at = Math.floor(next() * text.length);
              const len = Math.floor(next() * 40);
              const how = next();
              text =
                how < 0.3
                  ? text.slice(0, at)
                  : how < 0.5
                    ? text.slice(0, at) + text.slice(at + len)
                    : text.slice(0, at) +
                      BITS[Math.floor(next() * BITS.length)]! +
                      text.slice(at + (next() < 0.5 ? 0 : len));
            }
            damaged.push(relative);
          } else if (roll < 0.5) {
            text = WHOLE[Math.floor(next() * WHOLE.length)]!;
            damaged.push(`${relative} (replaced)`);
          } else if (roll < 0.55) {
            damaged.push(`${relative} (gone)`);
            continue;
          }
          const file = path.join(dataDir, relative);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, text);
        }
        const where = `with ${damaged.join(', ') || 'nothing'} damaged`;
        let h;
        try {
          h = await startRuntime({ dataDir, fetchImpl: fetchTable(), providerInstances: [createUsgs()] });
        } catch (error) {
          assert.fail(`the runtime did not start ${where}: ${error instanceof Error ? error.stack : String(error)}`);
        }
        started++;
        try {
          const ask = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
            try {
              return await run();
            } catch (error) {
              assert.fail(`${what} failed ${where}: ${error instanceof Error ? error.stack : String(error)}`);
            }
          };
          await ask('settings.get', () => h.client.request('settings.get', undefined));
          const zones = await ask('watchzones.list', () => h.client.request('watchzones.list', undefined));
          const collections = await ask('collections.list', () => h.client.request('collections.list', undefined));
          const lenses = await ask('lenses.list', () => h.client.request('lenses.list', undefined));
          assert.ok(Array.isArray(zones) && Array.isArray(collections) && Array.isArray(lenses));
          await ask('sources.list', () => h.client.request('sources.list', undefined));
          await ask('sources.settings.get', () =>
            h.client.request('sources.settings.get', { providerId: 'usgs-earthquakes' }),
          );
          await ask('history.availability', () => h.client.request('history.availability', {}));
          await ask('diagnostics.get', () => h.client.request('diagnostics.get', undefined));
          await ask('feed.recent', () => h.client.request('feed.recent', {}));
          // It still polls, and still saves: each kind of document, over whatever was there.
          await ask('sources.refresh', () => h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' }));
          await settle(6);
          const found = await ask('world.query', () =>
            h.client.request('world.query', { objectTypes: ['earthquake'] }),
          );
          assert.ok(found.items.length > 0, `no earthquakes after a poll ${where}`);
          assert.ok(
            (await ask('watchzones.save', () => h.client.request('watchzones.save', zone))).some((z) => z.id === 'z1'),
          );
          assert.ok(
            (await ask('collections.save', () => h.client.request('collections.save', collection))).some(
              (c) => c.id === 'c1',
            ),
          );
          assert.ok(
            (await ask('lenses.save', () => h.client.request('lenses.save', lens))).some((l) => l.id === 'user-test'),
          );
          await ask('settings.set', () => h.client.request('settings.set', { reducedMotion: false }));
          await settle(4);
        } finally {
          await h.dispose();
        }
        // And what it saved is there for the next start.
        const again = await startRuntime({ dataDir, fetchImpl: fetchTable(), providerInstances: [createUsgs()] });
        try {
          assert.ok(
            (await again.client.request('watchzones.list', undefined)).some((z) => z.id === 'z1'),
            `zone lost ${where}`,
          );
          assert.ok(
            (await again.client.request('collections.list', undefined)).some((c) => c.id === 'c1'),
            `collection lost ${where}`,
          );
        } finally {
          await again.dispose();
        }
      } finally {
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(pristine, { recursive: true, force: true });
  }
  assert.equal(started, 40);
});

test('integration: damaged source definitions and a damaged camera list are reported, and the runtime starts', async () => {
  const examples = path.join(repoRoot, 'connectors', 'examples');
  const good: Record<string, string> = {};
  for (const name of ['citibike-stations-rest.json', 'usgs-earthquakes-geojson.json', 'usgs-earthquakes-csv.json'])
    good[path.join('connectors', name)] = await fs.readFile(path.join(examples, name), 'utf8');
  good['cameras.json'] = JSON.stringify({
    version: 1,
    items: [
      {
        id: '0123456789ab',
        cameraId: '0123456789ab',
        objectId: 'camera:cameras-local:0123456789ab',
        name: 'Gate',
        url: 'http://192.168.1.20/mjpg/video.mjpg',
        kind: 'mjpeg',
        registeredAt: '2026-09-21T00:00:00.000Z',
      },
    ],
  });
  const next = rng(31);
  // No source answers: this is about what is read from the folder at start.
  const noNetwork = () => tableFetch({}).impl;
  for (let round = 0; round < 25; round++) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-definitions-'));
    try {
      const damaged: string[] = [];
      for (const [relative, original] of Object.entries(good)) {
        let text = original;
        const roll = round === 0 ? 1 : next();
        if (roll < 0.5) {
          const times = 1 + Math.floor(next() * 3);
          for (let k = 0; k < times; k++) {
            const at = Math.floor(next() * text.length);
            const len = Math.floor(next() * 40);
            const how = next();
            text =
              how < 0.3
                ? text.slice(0, at)
                : how < 0.5
                  ? text.slice(0, at) + text.slice(at + len)
                  : text.slice(0, at) +
                    BITS[Math.floor(next() * BITS.length)]! +
                    text.slice(at + (next() < 0.5 ? 0 : len));
          }
          damaged.push(relative);
        } else if (roll < 0.7) {
          text = WHOLE[Math.floor(next() * WHOLE.length)]!;
          damaged.push(`${relative} (replaced)`);
        }
        const file = path.join(dataDir, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
      }
      const where = `with ${damaged.join(', ') || 'nothing'} damaged`;
      let h;
      try {
        h = await startRuntime({ dataDir, fetchImpl: noNetwork() });
      } catch (error) {
        assert.fail(`the runtime did not start ${where}: ${error instanceof Error ? error.stack : String(error)}`);
      }
      try {
        const listed = await h.client.request('sources.definitions.list', undefined);
        JSON.stringify(listed);
        if (round === 0)
          assert.ok(
            JSON.stringify(listed).includes('citibike'),
            `an undamaged folder lists its definitions: ${JSON.stringify(listed).slice(0, 300)}`,
          );
        await h.client.request('sources.definitions.reload', undefined);
        assert.ok((await h.client.request('sources.list', undefined)).length > 5, `sources ${where}`);
        const cameras = await h.client.request('camera.list', undefined);
        assert.ok(Array.isArray(cameras), `cameras ${where}`);
        if (round === 0) assert.equal(cameras.length, 1, 'an undamaged camera list is read');
      } catch (error) {
        assert.fail(`a question failed ${where}: ${error instanceof Error ? error.stack : String(error)}`);
      } finally {
        await h.dispose();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});
