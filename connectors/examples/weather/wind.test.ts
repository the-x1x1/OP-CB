import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@opcb/provider-sdk';
import { parseDefinition } from '@opcb/connector-sdk';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import { WorldState } from '@opcb/state-engine';
import { presentObjects } from '@opcb/render-core';

/**
 * The GFS wind example end to end, as the runtime runs a definition: the request it sends,
 * the recorded ERDDAP answer polled through the provider, the observations into the world
 * state, and the objects to the presentation — what the connector suite's sidecar cannot say.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const NOW = '2026-09-23T19:34:54.000Z';

async function world() {
  const parsed = parseDefinition(JSON.parse(readFileSync(path.join(here, 'noaa-gfs-wind.json'), 'utf8')));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.issues.join('; '));
  const def = parsed.definition;
  const provider = defaultConnectorRegistry.createProvider(def);
  const urls: string[] = [];
  const ctx = testing.createFixtureContext({
    providerId: def.id,
    clock: new testing.VirtualClock(Date.parse(NOW)),
    responder: (req: { url: string }) => {
      urls.push(req.url);
      return {
        status: 200,
        body: readFileSync(path.join(root, 'fixtures/connectors/wind/gfs-wind-10deg.json'), 'utf8'),
      };
    },
  } as never);
  await provider.initialize(ctx);
  await provider.start();
  const observations = await provider.query!({ signal: new AbortController().signal, background: true });
  const now = Date.parse(NOW);
  const state = new WorldState({ clock: { now: () => now }, flushDelayMs: 0 });
  const freshness = provider.manifest.refreshPolicy.freshness;
  state.ingest(observations, {
    snapshot: true,
    withdraws: true,
    providerId: def.id,
    ...(freshness ? { freshness } : {}),
  });
  state.flush();
  return { urls, observations, objects: [...state.all()] };
}

test('GFS wind: asks for the step at or before now, and every grid point becomes a wind object', async () => {
  const { urls, observations, objects } = await world();
  assert.equal(urls.length, 1);
  assert.match(urls[0]!, /ugrd10m\[\(2026-09-23T18:04:54Z\)\]\[\(80\):20:\(-80\)\]/, 'now less 90 minutes');
  assert.equal(observations.length, 90);
  assert.equal(objects.length, 90);
  const o = objects.find((x) => x.id === 'wind:noaa-gfs-wind:50N160W');
  assert.ok(o, 'the object id is the point as a chart names it, unescaped');
  assert.equal(o.type, 'wind');
  assert.equal(o.labels['name'], 'Wind at 50°N 160°W');
  assert.deepEqual(o.position, { latitude: 50, longitude: -160 });
  assert.equal(o.properties['speedMps'], 13.12);
  assert.equal(o.properties['fromDeg'], 294.8);
  assert.equal(o.motion?.headingDegrees, 114.8, 'its arrow points where it blows to');
  assert.equal(o.freshness, 'LIVE', 'the 18:00 step at 19:35');
});

test('GFS wind: drawn as arrows at global zoom, every point, none of them moving', async () => {
  const { objects } = await world();
  const view = {
    center: { latitude: 0, longitude: 0 },
    zoom: 1,
    altitudeM: 20_000_000,
    headingDegrees: 0,
    pitchDegrees: -90,
  };
  const r = presentObjects({ objects, view: view as never });
  const arrows = r.upsert.filter((f) => f.style.icon === 'wind');
  assert.equal(arrows.length, 90);
  assert.ok(arrows.every((f) => f.style.styleClass.startsWith('wind.') && f.motion === undefined));
});
