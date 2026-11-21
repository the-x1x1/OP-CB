import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider as createUsgs } from '@opcb/provider-usgs';
import type { WorldProvider } from '@opcb/provider-sdk';
import { readFixture, settle, startRuntime, tableFetch } from '../helpers/harness.js';

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

/**
 * A source switched on and off at random over IPC, without waiting for one switch to finish
 * before the next, while its start and its polls are held back and let through at random.
 * When everything has come back: the source is in the state last asked for, the settings say
 * the same (so it comes back that way after a restart), and its objects are on the map only if
 * it is on.
 */
for (const seed of [21, 22, 23, 24, 25, 26]) {
  test(`integration: a source switched on and off while it starts and polls ends as last asked (seed ${seed})`, async () => {
    const next = rng(seed);
    const body = await readFixture('usgs', 'normal.geojson');
    const { impl: fetchImpl } = tableFetch({
      'https://earthquake.usgs.gov/': () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
    });
    const usgs = createUsgs();
    const held: Array<() => void> = [];
    // Nothing is held while the runtime starts (its start waits for the source's).
    let holding = false;
    const hold = () => (holding ? new Promise<void>((r) => held.push(r)) : Promise.resolve());
    // The real source, whose start and answers wait to be let through, and which does not
    // look at the signal it is given.
    const slow: WorldProvider = {
      manifest: usgs.manifest,
      initialize: (c) => usgs.initialize(c),
      start: async () => {
        await hold();
        await usgs.start();
      },
      stop: () => usgs.stop(),
      health: () => usgs.health(),
      query: async (q) => {
        const observations = await usgs.query!({ ...q, signal: new AbortController().signal });
        await hold();
        return observations;
      },
    };
    const id = usgs.manifest.id;
    // The reachability probe is on (it asks the same host, answered here): without it a source
    // that is still starting reads as the network being down, and nothing polls again.
    const h = await startRuntime({ fetchImpl, providerInstances: [slow], disableReachabilityProbe: false });
    holding = true;
    try {
      const pending: Promise<unknown>[] = [];
      let last: boolean | undefined;
      for (let step = 0; step < 30; step++) {
        const r = next();
        if (r < 0.4) {
          last = next() < 0.5;
          pending.push(h.client.request('sources.setEnabled', { providerId: id, enabled: last }));
        } else if (r < 0.55) {
          pending.push(h.client.request('sources.refresh', { providerId: id }).catch(() => undefined));
        } else if (held.length) {
          held.splice(Math.floor(next() * held.length), 1)[0]!();
        }
        await settle(2);
      }
      if (last === undefined) {
        last = true;
        pending.push(h.client.request('sources.setEnabled', { providerId: id, enabled: true }));
      }
      // Everything comes back.
      for (let i = 0; i < 60; i++) {
        while (held.length) held.shift()!();
        await settle(3);
      }
      await Promise.all(pending);
      for (let i = 0; i < 10; i++) {
        while (held.length) held.shift()!();
        await settle(3);
      }
      if (last) {
        const refreshing = h.client.request('sources.refresh', { providerId: id });
        for (let i = 0; i < 20; i++) {
          while (held.length) held.shift()!();
          await settle(3);
        }
        await refreshing;
      }
      const source = (await h.client.request('sources.list', undefined)).find((s) => s.providerId === id)!;
      assert.equal(source.enabled, last, `the source: ${source.health.status}, last asked ${last}`);
      assert.equal(source.health.status === 'DISABLED', !last);
      const settings = await h.client.request('settings.get', undefined);
      assert.equal(settings.providers?.[id]?.enabled, last, 'the settings say what was last asked');
      const objects = (await h.client.request('world.query', { objectTypes: ['earthquake'] })).items;
      if (last) assert.ok(objects.length > 0, 'on: its objects are on the map');
      else assert.equal(objects.length, 0, 'off: none of its objects are on the map');
    } finally {
      holding = false;
      while (held.length) held.shift()!();
      await h.dispose();
    }
  });
}

test('integration: switched on, and off again before it has started: the settings say off', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const usgs = createUsgs();
  let holding = false;
  let release: () => void = () => undefined;
  const slow: WorldProvider = {
    manifest: usgs.manifest,
    initialize: (c) => usgs.initialize(c),
    start: async () => {
      if (holding) await new Promise<void>((r) => (release = r));
      await usgs.start();
    },
    stop: () => usgs.stop(),
    health: () => usgs.health(),
    query: (q) => usgs.query!(q),
  };
  const id = usgs.manifest.id;
  const h = await startRuntime({ fetchImpl, providerInstances: [slow], disableReachabilityProbe: false });
  try {
    await h.client.request('sources.setEnabled', { providerId: id, enabled: false });
    holding = true;
    const on = h.client.request('sources.setEnabled', { providerId: id, enabled: true });
    await settle();
    await h.client.request('sources.setEnabled', { providerId: id, enabled: false });
    release();
    await on;
    await settle();
    const source = (await h.client.request('sources.list', undefined)).find((s) => s.providerId === id)!;
    assert.equal(source.enabled, false, 'the source is off');
    const settings = await h.client.request('settings.get', undefined);
    assert.equal(settings.providers?.[id]?.enabled, false, 'and the settings say off, so it stays off after a restart');
  } finally {
    holding = false;
    release();
    await h.dispose();
  }
});
