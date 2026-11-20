import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import type { WorldChangedEvent } from '@opcb/ipc-contract';
import { repoRoot, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * A connector definition may give its source any kebab-case id, and `constructor` is such a
 * name — one every plain JavaScript object already answers to. (Its object type must be one
 * of the world model's, so that cannot be so named.) A source with that id goes through the
 * whole runtime like any other: polled, kept, queried, subscribed to, counted, configured and
 * switched off.
 */
const ID = 'constructor';

test('integration: a source named "constructor" works end to end', async () => {
  const example = JSON.parse(
    readFileSync(path.join(repoRoot, 'connectors', 'examples', 'citibike-stations-rest.json'), 'utf8'),
  ) as Record<string, unknown>;
  // Reviewed and on from the start, as a shipped definition is: the harness has no reachability
  // probe, and a source switched on by hand before its first answer reads there as "offline".
  const checked = defaultConnectorRegistry.validate({ ...example, id: ID, review: 'bundled', enabled: true });
  assert.ok(checked.ok && checked.definition, JSON.stringify(checked));
  const provider = defaultConnectorRegistry.createProvider(checked.definition);
  assert.equal(provider.manifest.id, ID);

  const stations = {
    data: {
      stations: [
        { station_id: 's1', name: 'First', lat: 40.71, lon: -74.0, capacity: 20, region_id: '71', short_name: 'A1' },
        { station_id: 's2', name: 'Second', lat: 40.72, lon: -74.01, capacity: 30, region_id: '71', short_name: 'A2' },
        { station_id: 's3', name: 'Third', lat: 40.73, lon: -74.02, capacity: 10, region_id: '71', short_name: 'A3' },
      ],
    },
  };
  const { impl: fetchImpl, calls } = tableFetch({
    'https://gbfs.citibikenyc.com/': () =>
      new Response(JSON.stringify(stations), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [provider] });
  try {
    const deltas: WorldChangedEvent[] = [];
    h.runtime.on('world.changed', (payload, clientId) => {
      if (clientId === 'test-client') deltas.push(payload);
    });
    const initial = await h.client.request('world.subscribe', { objectTypes: ['infrastructure'] });
    assert.equal(initial.count, 0);

    await h.client.request('sources.refresh', { providerId: ID });
    await settle();
    assert.ok(calls.length >= 1, 'the source was polled');

    const found = await h.client.request('world.query', { objectTypes: ['infrastructure'] });
    assert.equal(found.items.length, 3);
    assert.ok(found.items.every((o) => o.type === 'infrastructure' && o.provenance.providerId === ID));
    assert.ok(
      found.items.every((o) => ['LIVE', 'RECENT'].includes(o.freshness)),
      'freshness by the definition’s own policy',
    );
    const first = found.items.find((o) => o.labels['name'] === 'First')!;
    assert.equal((await h.client.request('world.get', { objectId: first.id }))?.id, first.id);
    await h.client.request('world.related', { objectId: first.id });
    await h.client.request('world.track', { objectId: first.id });
    await h.client.request('world.details', { objectId: first.id });

    assert.ok(deltas.length >= 1, 'the subscriber was told');
    assert.equal(new Set(deltas.flatMap((d) => d.added)).size, 3);

    const region = { kind: 'bounds' as const, bounds: { west: -74.1, south: 40.6, east: -73.9, north: 40.8 } };
    const now = h.clock.now();
    const changed = await h.client.request('world.whatChanged', {
      region,
      time: { start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 60_000).toISOString() },
    });
    for (const c of changed.countChanges)
      assert.ok(Number.isFinite(c.before) && Number.isFinite(c.after), JSON.stringify(c));
    assert.deepEqual(
      changed.countChanges.find((c) => c.objectType === 'infrastructure'),
      { objectType: 'infrastructure', before: 0, after: 3 },
    );

    const sources = await h.client.request('sources.list', undefined);
    const entry = sources.find((s) => s.providerId === ID)!;
    assert.ok(entry && entry.enabled);
    assert.equal(entry.health.status, 'LIVE');
    assert.equal((await h.client.request('sources.manifest', { providerId: ID }))?.id, ID);

    // Its settings are its own: empty until written, and what was written afterwards.
    assert.deepEqual(await h.client.request('sources.settings.get', { providerId: ID }), {});
    await h.client.request('sources.settings.set', { providerId: ID, settings: {} });
    assert.deepEqual(await h.client.request('sources.settings.get', { providerId: ID }), {});

    await h.client.request('sources.setEnabled', { providerId: ID, enabled: false });
    await settle();
    assert.equal((await h.client.request('sources.list', undefined)).find((s) => s.providerId === ID)?.enabled, false);
    assert.equal(({} as Record<string, unknown>)['enabled'], undefined, 'nothing was written to Object.prototype');
  } finally {
    await h.dispose();
  }
});
