import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeoRegion, WorldGeometry } from '@opcb/world-model';
import { geometryBounds, geometryIntersectsRegion } from './geometry.js';

// An alert over Fiji drawn across 180°.
const alert: WorldGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [179, -17],
      [-179, -17],
      [-179, -19],
      [179, -19],
      [179, -17],
    ],
  ],
};

test('a geometry across 180° has bounds across it, not round the rest of the world', () => {
  assert.deepEqual(geometryBounds(alert), { west: 179, south: -19, east: -179, north: -17 });
  assert.deepEqual(geometryBounds({ type: 'Point', coordinates: [10, 20] }), {
    west: 10,
    south: 20,
    east: 10,
    north: 20,
  });
  const wide: WorldGeometry = {
    type: 'LineString',
    coordinates: [
      [-170, 0],
      [0, 0],
      [170, 0],
    ],
  };
  assert.deepEqual(geometryBounds(wide), { west: -170, south: 0, east: 170, north: 0 });
});

test('an alert across 180° meets the zones inside it on either side, and no others', () => {
  const inside: GeoRegion[] = [
    { kind: 'circle', center: { latitude: -18, longitude: -179.6 }, radiusM: 10_000 },
    { kind: 'circle', center: { latitude: -18, longitude: 179.6 }, radiusM: 10_000 },
    { kind: 'bounds', bounds: { west: -179.8, south: -18.2, east: -179.6, north: -17.9 } },
    {
      kind: 'polygon',
      polygon: [
        [-179.8, -18],
        [-179.6, -18],
        [-179.6, -18.2],
      ],
    },
  ];
  for (const z of inside) assert.ok(geometryIntersectsRegion(alert, z), JSON.stringify(z));
  const outside: GeoRegion[] = [
    { kind: 'circle', center: { latitude: -18, longitude: 0 }, radiusM: 10_000 },
    { kind: 'bounds', bounds: { west: 100, south: -18.2, east: 110, north: -17.9 } },
  ];
  for (const z of outside) assert.ok(!geometryIntersectsRegion(alert, z), JSON.stringify(z));
});

test('a zone across 180° meets what is inside it on either side', () => {
  const zone: GeoRegion = {
    kind: 'polygon',
    polygon: [
      [179.5, -17],
      [-179.5, -17.5],
      [-179.5, -18.5],
      [179.2, -18.5],
    ],
  };
  const at = (lon: number): WorldGeometry => ({ type: 'Point', coordinates: [lon, -17.8] });
  assert.ok(geometryIntersectsRegion(at(-179.8), zone));
  assert.ok(geometryIntersectsRegion(at(179.6), zone));
  assert.ok(!geometryIntersectsRegion(at(0), zone));
  assert.ok(!geometryIntersectsRegion(at(178), zone));
});
