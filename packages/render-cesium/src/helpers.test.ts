import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsToRectangle,
  flattenPositions,
  groundLinePositions,
  heightFor,
  heightReferenceFor,
  positionsValid,
  toCartesian,
  toCartesianArray,
} from './geometry.js';
import { createGoogle3DTileset, google3dAvailability } from './google3d.js';
import { EntityLayer } from './layers/entities.js';
import { ICON_MODEL, modelKindFor } from './layers/models.js';
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

test('modelKindFor: a model for an icon that has one, on a point; none for an icon named after an object member', () => {
  type Feature = Parameters<typeof modelKindFor>[0];
  const feature = (icon: string | undefined, kind = 'point') =>
    ({ geometry: { kind }, style: { icon } }) as unknown as Feature;
  for (const [icon, model] of Object.entries(ICON_MODEL)) assert.equal(modelKindFor(feature(icon)), model, icon);
  assert.equal(modelKindFor(feature('aircraft', 'line')), undefined, 'only a point is drawn as a model');
  for (const icon of [undefined, '', 'no-such-icon', 'constructor', 'toString', 'hasOwnProperty', '__proto__'])
    assert.equal(modelKindFor(feature(icon)), undefined, String(icon));
});

test('groundLinePositions: one place written twice running is kept once; a line Cesium cannot draw on the ground is not drawn', () => {
  const at = (longitude: number, latitude: number) => ({ latitude, longitude });
  const lonLat = (ps: ReturnType<typeof groundLinePositions>) => ps?.map((p) => [p.longitude, p.latitude]);
  const line = [at(-158, 21), at(-157, 21), at(-157, 22)];
  assert.deepEqual(groundLinePositions(line), line, 'an ordinary line is unchanged');
  // The positions that stopped the globe: one place, as -180 and as 180.
  assert.equal(groundLinePositions([at(-180, 51), at(180, 51)]), undefined);
  assert.equal(groundLinePositions([at(180, 51), at(-180, 51)]), undefined);
  assert.equal(groundLinePositions([at(180, 10), at(-180, 10), at(180, 10), at(-180, 10)]), undefined);
  assert.equal(groundLinePositions([at(10, 90), at(50, 90)]), undefined, 'every longitude at a pole is the pole');
  assert.equal(groundLinePositions([at(10, -90), at(-120, -90)]), undefined);
  assert.equal(groundLinePositions([at(5, 5), at(5, 5), at(5, 5)]), undefined);
  assert.equal(groundLinePositions([at(5, 5)]), undefined);
  assert.equal(groundLinePositions([]), undefined);
  // A seam written twice inside a longer line is written once, and the line is drawn.
  assert.deepEqual(lonLat(groundLinePositions([at(179, 0), at(180, 0), at(-180, 0), at(-179, 0)])), [
    [179, 0],
    [180, 0],
    [-179, 0],
  ]);
  assert.deepEqual(
    lonLat(
      groundLinePositions([
        at(170, 50),
        at(180, 50),
        at(-180, 50),
        at(-170, 50),
        at(-170, 55),
        at(170, 55),
        at(170, 50),
      ]),
    ),
    [
      [170, 50],
      [180, 50],
      [-170, 50],
      [-170, 55],
      [170, 55],
      [170, 50],
    ],
  );
  assert.equal(
    groundLinePositions([at(172, 52), at(180, 52), at(180, 53), at(172, 53), at(172, 52)])!.length,
    5,
    'a ring that ends on the seam keeps its corners',
  );
  assert.equal(groundLinePositions([at(179, 51), at(-179, 51)])!.length, 2, 'crossing the seam is not the same place');
  // Opposite sides of the globe: no one line joins them.
  assert.equal(groundLinePositions([at(0, 0), at(180, 0)]), undefined);
  assert.equal(groundLinePositions([at(-30, 40), at(150, -40)]), undefined);
  assert.equal(groundLinePositions([at(0, 90), at(77, -90)]), undefined);
  assert.equal(groundLinePositions([at(0, 0), at(179, 0)])!.length, 2);
  assert.equal(
    groundLinePositions([at(-30, 40), at(150, 40)])!.length,
    2,
    'the same latitude half a turn apart goes over the pole',
  );
});

test('an area whose ring is one place gets its fill decided by Cesium and no edge; an ordinary area gets both', () => {
  const fake = {
    Cartesian3: {
      fromDegrees: (lon: number, lat: number, h: number) => ({ lon, lat, h }),
      fromDegreesArrayHeights: (flat: number[]) =>
        Array.from({ length: flat.length / 3 }, (_, i) => ({ lon: flat[i * 3], lat: flat[i * 3 + 1] })),
    },
    createPolygonHierarchy: (positions: unknown[], holes?: unknown[]) => ({ positions, holes }),
    ClassificationType: { BOTH: 2 },
  } as unknown as ConstructorParameters<typeof EntityLayer>[0];
  const theme = { color: (c: unknown) => c } as unknown as ConstructorParameters<typeof EntityLayer>[1];
  const layer = new EntityLayer(fake, theme, { entities: {} } as unknown as ConstructorParameters<
    typeof EntityLayer
  >[2]);
  type Feature = Parameters<EntityLayer['entityOptions']>[0];
  const resolved = { color: { r: 1, g: 0, b: 0, a: 1 }, fillAlpha: 0.2 } as unknown as Parameters<
    EntityLayer['entityOptions']
  >[1];
  const polygon = (ring: Array<[number, number]>) =>
    ({
      id: 'f',
      geometry: { kind: 'polygon', rings: [ring.map(([longitude, latitude]) => ({ latitude, longitude }))] },
      style: { styleClass: 'x' },
    }) as unknown as Feature;

  const square = layer.entityOptions(
    polygon([
      [-158, 21],
      [-157, 21],
      [-157, 22],
      [-158, 22],
    ]),
    resolved,
  )!;
  assert.ok(square.polygon && square.polyline);
  assert.equal((square.polyline as { positions: unknown[] }).positions.length, 5, 'the edge is the ring, closed');
  assert.equal((square.polyline as { clampToGround: boolean }).clampToGround, true);

  const seam = layer.entityOptions(
    polygon([
      [180, 51],
      [-180, 51],
      [180, 51],
    ]),
    resolved,
  )!;
  assert.ok(seam.polygon, 'the fill is still handed over');
  assert.ok(!('polyline' in seam), 'no edge for a ring that is one place');

  const circle = layer.entityOptions(
    {
      id: 'c',
      geometry: { kind: 'circle', center: { latitude: 51, longitude: 180 }, radiusM: 50_000 },
      style: { styleClass: 'x' },
    } as unknown as Feature,
    resolved,
  )!;
  assert.ok(circle.ellipse && circle.polyline, 'a circle on the antimeridian keeps its edge');
});
