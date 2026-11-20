import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import type { WorldChangedEvent } from '@opcb/ipc-contract';
import { repoRoot, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * The whole runtime under a source whose answer changes on every poll: stations come and go,
 * move across the 180th meridian and to the poles, and carry names and numbers at the edge of
 * what is allowed. A window that subscribed and applied every change it was sent must, after
 * each poll, hold exactly the objects a fresh query returns; and every question a window
 * asks about those objects is answered or refused in the runtime's own terms. Answers are
 * generated from a fixed seed.
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

const NAMES = [
  'Harbour',
  'harbour',
  '',
  ' ',
  'x'.repeat(600),
  'Line\nbreak',
  'constructor',
  '__proto__',
  'last 5 aircraft',
  'a,b"c',
  '=SUM(A1)',
  '<img src=x onerror=1>',
  '北駅',
  'near 21.3,-157.8',
];
const LATS = [40.71, -40.71, 0, 89.999999, -89.999999, 90, -90, 91, Number.NaN];
const LONS = [-74, 74, 0, 179.999999, -179.999999, 180, -180, 181];
const NUMBERS = [0, -0, 1, -1, 55, 1e308, -1e308, 1e-320, 9_007_199_254_740_993, 0.1 + 0.2];
const TYPED = new Set(['InvalidRequestError', 'NotFoundError', 'DeniedError', 'UnavailableError']);

test('integration: a window that applies every change holds what a query returns, poll after poll', async () => {
  const next = rng(2026);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const example = JSON.parse(
    readFileSync(path.join(repoRoot, 'connectors', 'examples', 'citibike-stations-rest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const checked = defaultConnectorRegistry.validate({ ...example, id: 'churn', review: 'bundled', enabled: true });
  assert.ok(checked.ok && checked.definition, JSON.stringify(checked));
  const provider = defaultConnectorRegistry.createProvider(checked.definition);

  let answer: unknown = { data: { stations: [] } };
  const { impl: fetchImpl } = tableFetch({
    'https://gbfs.citibikenyc.com/': () =>
      // JSON has no NaN: a station given one is written with null, as a server would write it.
      new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [provider] });
  try {
    const shown = new Map<string, string>();
    let changes = 0;
    h.runtime.on('world.changed', (payload: WorldChangedEvent, clientId) => {
      if (clientId !== 'test-client') return;
      changes++;
      for (const o of payload.objects) shown.set(o.id, o.updatedAt);
      for (const id of payload.removed) shown.delete(id);
    });
    await h.client.request('world.subscribe', { objectTypes: ['infrastructure'] });

    const ask = async (what: string, run: () => Promise<unknown>): Promise<unknown> => {
      try {
        const result = await run();
        // What is sent to a window is JSON: nothing in it may be lost on the way.
        JSON.stringify(result, (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${what} answered with ${value}`);
          return value;
        });
        return result;
      } catch (error) {
        assert.ok(
          error instanceof Error && TYPED.has(error.name),
          `${what} threw ${error instanceof Error ? error.stack : String(error)}`,
        );
        return undefined;
      }
    };

    let peak = 0;
    for (let round = 0; round < 14; round++) {
      const count = round === 7 ? 0 : Math.floor(next() * 40);
      const stations = Array.from({ length: count }, () => ({
        station_id:
          next() < 0.9 ? `s${Math.floor(next() * 60)}` : pick(['', ' ', 'constructor', 's 1', 'x'.repeat(300)]),
        name: pick(NAMES),
        lat: pick(LATS),
        lon: pick(LONS),
        capacity: next() < 0.8 ? pick(NUMBERS) : pick(['12', null, [], { n: 1 }]),
        region_id: pick(['71', '', 71, null]),
        short_name: pick(NAMES),
      }));
      answer = round === 11 ? { data: { stations: 'nope' } } : { data: { stations } };
      await ask('sources.refresh', () => h.client.request('sources.refresh', { providerId: 'churn' }));
      await settle(8);

      const found = await h.client.request('world.query', { objectTypes: ['infrastructure'], limit: 5000 });
      assert.equal(found.truncated, false);
      assert.deepEqual(
        [...shown.keys()].sort(),
        found.items.map((o) => o.id).sort(),
        `round ${round}: the window and the query differ`,
      );
      peak = Math.max(peak, found.items.length);

      for (const object of found.items.slice(0, 6)) {
        assert.equal((await h.client.request('world.get', { objectId: object.id }))?.id, object.id);
        await ask('world.details', () => h.client.request('world.details', { objectId: object.id }));
        await ask('world.track', () => h.client.request('world.track', { objectId: object.id }));
        await ask('world.related', () => h.client.request('world.related', { objectId: object.id }));
        const name = object.labels['name'];
        if (name) await ask('search.query', () => h.client.request('search.query', { text: name.slice(0, 200) }));
      }
      const now = h.clock.now();
      for (const region of [
        { kind: 'bounds' as const, bounds: { west: 170, south: -90, east: -170, north: 90 } },
        { kind: 'circle' as const, center: { latitude: 90, longitude: 0 }, radiusM: 500_000 },
        { kind: 'bounds' as const, bounds: { west: -180, south: -90, east: 180, north: 90 } },
      ]) {
        const inRegion = (await ask('world.query in a region', () =>
          h.client.request('world.query', { objectTypes: ['infrastructure'], region, limit: 5000 }),
        )) as { items: Array<{ id: string }> } | undefined;
        if (inRegion)
          for (const o of inRegion.items) assert.ok(shown.has(o.id), `${o.id} is in a region and not in the world`);
        await ask('world.whatChanged', () =>
          h.client.request('world.whatChanged', {
            region,
            time: { start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 60_000).toISOString() },
          }),
        );
      }
      for (const text of ['harbour', 'constructor', 'last 5 infrastructure', 'near 90,180', '北', '"', ''])
        await ask(`search.query ${JSON.stringify(text)}`, () => h.client.request('search.query', { text }));
      await ask('feed.recent', () => h.client.request('feed.recent', {}));
      await ask('world.events', () => h.client.request('world.events', {}));
      for (const format of ['csv', 'geojson', 'kml', 'json'] as const)
        await ask(`export.objects ${format}`, () =>
          h.client.request('export.objects', { query: { objectTypes: ['infrastructure'] }, format }),
        );
      await ask('sources.list', () => h.client.request('sources.list', undefined));
      await ask('history.availability', () => h.client.request('history.availability', {}));
      await ask('diagnostics.get', () => h.client.request('diagnostics.get', undefined));

      // Time passes between polls: minutes mostly, now and then long enough for things to age out.
      h.clock.advance(round % 5 === 4 ? 6 * 3_600_000 : 10 * 60_000);
      await settle(4);
      const later = await h.client.request('world.query', { objectTypes: ['infrastructure'], limit: 5000 });
      assert.deepEqual(
        [...shown.keys()].sort(),
        later.items.map((o) => o.id).sort(),
        `round ${round}, after time passed: the window and the query differ`,
      );
    }
    assert.ok(changes > 5 && peak > 5, `${changes} changes sent, ${peak} objects at most`);
  } finally {
    await h.dispose();
  }
});
