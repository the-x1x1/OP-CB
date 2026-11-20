import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsToRectangle,
  flattenPositions,
  heightFor,
  heightReferenceFor,
  positionsValid,
  toCartesian,
  toCartesianArray,
} from './geometry.js';
import { createGoogle3DTileset, google3dAvailability } from './google3d.js';
import { REEARTH_TERRAIN_URL, terrainSourceFor, type TerrainFactoryModule } from './terrain.js';

const cesium = {
  HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
  Cartesian3: {
    fromDegrees: (lon: number, lat: number, h: number) => ({ lon, lat, h }),
    fromDegreesArrayHeights: (flat: number[]) =>
      Array.from({ length: flat.length / 3 }, (_, i) => ({
        lon: flat[i * 3],
        lat: flat[i * 3 + 1],
        h: flat[i * 3 + 2],
      })),
  },
  Rectangle: { fromDegrees: (w: number, s: number, e: number, n: number) => ({ w, s, e, n }) },
} as unknown as Parameters<typeof heightReferenceFor>[0] &
  Parameters<typeof toCartesian>[0] &
  Parameters<typeof boundsToRectangle>[0];

test('heights and coordinates handed to Cesium: clamped draws at 0, an altitude is never negative or NaN', () => {
  const p = { latitude: 21.3, longitude: -157.8, altitudeM: 1200 };
  assert.equal(heightFor(p, undefined), 0);
  assert.equal(heightFor(p, 'clamp'), 0);
  assert.equal(heightFor(p, 'absolute'), 1200);
  assert.equal(heightFor(p, 'relative'), 1200);
  assert.equal(heightFor({ ...p, altitudeM: -30 }, 'absolute'), 0);
  assert.equal(heightFor({ ...p, altitudeM: Number.NaN }, 'absolute'), 0);
  assert.equal(heightFor({ latitude: 0, longitude: 0 }, 'absolute'), 0);
  assert.deepEqual(
    [
      heightReferenceFor(cesium, 'absolute'),
      heightReferenceFor(cesium, 'relative'),
      heightReferenceFor(cesium, 'clamp'),
      heightReferenceFor(cesium, undefined),
    ],
    [0, 2, 1, 1],
  );

  assert.deepEqual(toCartesian(cesium, p, 'absolute'), { lon: -157.8, lat: 21.3, h: 1200 });
  assert.deepEqual(toCartesian(cesium, p, undefined), { lon: -157.8, lat: 21.3, h: 0 });
  const line = [p, { latitude: 22, longitude: -158 }];
  assert.deepEqual(flattenPositions(line, 'absolute'), [-157.8, 21.3, 1200, -158, 22, 0]);
  assert.deepEqual(flattenPositions([], 'absolute'), []);
  assert.deepEqual(toCartesianArray(cesium, line, 'clamp'), [
    { lon: -157.8, lat: 21.3, h: 0 },
    { lon: -158, lat: 22, h: 0 },
  ]);
  assert.deepEqual(boundsToRectangle(cesium, { west: -161, south: 18, east: -154, north: 23 }), {
    w: -161,
    s: 18,
    e: -154,
    n: 23,
  });

  assert.equal(positionsValid(line), true);
  assert.equal(positionsValid([p]), false, 'one point is no line');
  assert.equal(positionsValid([]), false);
  for (const bad of [
    { latitude: Number.NaN, longitude: 0 },
    { latitude: 0, longitude: Infinity },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
  ])
    assert.equal(positionsValid([p, bad]), false, JSON.stringify(bad));
});

test('Google 3D tiles: offered only with a key of the operator’s own, which is read at use and never kept', async () => {
  assert.equal(google3dAvailability(undefined).available, false);
  assert.equal(google3dAvailability({}).available, false);
  assert.equal(google3dAvailability({ credentialRef: 'google.maps' }).available, false);
  assert.match(
    google3dAvailability({ credentialRef: '', resolveCredential: async () => 'k' }).reason ?? '',
    /your own Google Maps Platform key/,
  );
  assert.deepEqual(google3dAvailability({ credentialRef: 'google.maps', resolveCredential: async () => 'k' }), {
    available: true,
  });

  const made: unknown[] = [];
  const module = {
    createGooglePhotorealistic3DTileset: async (o: unknown) => (made.push(o), { tileset: true }),
  } as unknown as Parameters<typeof createGoogle3DTileset>[0];
  const signal = new AbortController().signal;
  const asked: string[] = [];
  const tileset = await createGoogle3DTileset(
    module,
    { credentialRef: 'google.maps', resolveCredential: async (ref) => (asked.push(ref), '  key-1  ') },
    { signal },
  );
  assert.deepEqual(tileset, { tileset: true });
  assert.deepEqual(asked, ['google.maps']);
  assert.deepEqual(made, [{ key: 'key-1', onlyUsingWithGoogleGeocoder: true }]);
  for (const stored of [undefined, '', '   '])
    await assert.rejects(
      createGoogle3DTileset(
        module,
        { credentialRef: 'google.maps', resolveCredential: async () => stored },
        { signal },
      ),
      /no key stored/,
    );
  const aborted = new AbortController();
  await assert.rejects(
    createGoogle3DTileset(
      module,
      { credentialRef: 'google.maps', resolveCredential: async () => (aborted.abort(), 'key-1') },
      { signal: aborted.signal },
    ),
    (e: unknown) => (e as Error).name === 'AbortError',
  );
  assert.equal(made.length, 1, 'nothing is made after a cancel or without a key');
});

test('terrain sources: nothing is fetched until one is applied, and each asks only for its own', async () => {
  const calls: Array<[unknown, unknown]> = [];
  const ion: Array<[number, unknown]> = [];
  class Ellipsoid {}
  const module = {
    EllipsoidTerrainProvider: Ellipsoid,
    createTerrainFromUrl: async (url: unknown, options: unknown) => (calls.push([url, options]), { terrain: url }),
    IonResource: { fromAssetId: async (id: number, options: unknown) => (ion.push([id, options]), { resource: id }) },
  } as unknown as TerrainFactoryModule;
  const signal = new AbortController().signal;
  const gone = new AbortController();
  gone.abort();

  const flat = terrainSourceFor(module, { kind: 'ellipsoid' });
  assert.deepEqual([flat.id, flat.attribution], ['ellipsoid', '']);
  assert.ok((await flat.create({ signal })) instanceof Ellipsoid);

  const mesh = terrainSourceFor(module, { kind: 'quantized-mesh', url: REEARTH_TERRAIN_URL, attribution: 'credit' });
  assert.deepEqual([mesh.id, mesh.attribution], [`quantized-mesh:${REEARTH_TERRAIN_URL}`, 'credit']);
  assert.equal(calls.length, 0, 'making the source fetches nothing');
  await mesh.create({ signal });
  assert.deepEqual(calls, [[REEARTH_TERRAIN_URL, { requestVertexNormals: true, requestWaterMask: false }]]);
  await assert.rejects(mesh.create({ signal: gone.signal }));
  assert.equal(calls.length, 1);

  const local = terrainSourceFor(
    module,
    { kind: 'local', path: 'packs/hi/terrain', attribution: 'pack' },
    { resolveLocalUrl: (p) => `opcb-pack://${p}` },
  );
  assert.equal(local.id, 'local:packs/hi/terrain');
  await local.create({ signal });
  assert.deepEqual(calls[1], [
    'opcb-pack://packs/hi/terrain',
    { requestVertexNormals: false, requestWaterMask: false },
  ]);
  await terrainSourceFor(module, { kind: 'local', path: 'p', attribution: '' }).create({ signal });
  assert.equal(calls[2]![0], 'p', 'with no resolver the path is used as it is');

  const world = terrainSourceFor(module, { kind: 'cesium-ion-world-terrain' }, { ionToken: '  tok  ' });
  await world.create({ signal });
  assert.deepEqual(ion, [[1, { accessToken: 'tok' }]]);
  assert.deepEqual(calls[3]![0], { resource: 1 });
  for (const ionToken of [undefined, '', '  '])
    await assert.rejects(
      terrainSourceFor(module, { kind: 'cesium-ion-world-terrain' }, ionToken === undefined ? {} : { ionToken }).create(
        { signal },
      ),
      /explicit ion token/,
    );
  await assert.rejects(world.create({ signal: gone.signal }));
  assert.equal(ion.length, 1, 'no token and no cancel reaches ion');
});
