import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@opcb/world-model';
import { boundsToRing } from './geojson.js';
import { NIGHT_LAYER_IDS, NIGHT_SOURCE, nightLayers, nightSource } from './night.js';
import {
  RASTER_OVERLAY_PREFIX,
  rasterOverlayLayerId,
  rasterOverlaySourceId,
  usesWmtsProtocol,
} from './raster-overlays.js';
import { MAX_MAPLIBRE_PITCH, mapLibrePitchToDegrees, normalizeBearing, pitchDegreesToMapLibre } from './view.js';

test('boundsToRing: a closed ring, counter-clockwise from the south-west corner', () => {
  const ring = boundsToRing({ west: -161, south: 18, east: -154, north: 23 });
  assert.deepEqual(ring, [
    [-161, 18],
    [-154, 18],
    [-154, 23],
    [-161, 23],
    [-161, 18],
  ]);
  const area2 = ring.slice(0, -1).reduce((sum, p, i) => sum + (p[0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * p[1]!), 0);
  assert.ok(area2 > 0, 'counter-clockwise, as GeoJSON wants an exterior');
});

test('pitch and bearing between the app’s terms and MapLibre’s', () => {
  assert.equal(pitchDegreesToMapLibre(-90), 0, 'straight down');
  assert.equal(pitchDegreesToMapLibre(-45), 45);
  assert.equal(pitchDegreesToMapLibre(0), MAX_MAPLIBRE_PITCH, 'the horizon is past what MapLibre tilts to');
  assert.equal(pitchDegreesToMapLibre(-120), 0);
  for (const pitch of [0, 30, 60, MAX_MAPLIBRE_PITCH])
    assert.equal(pitchDegreesToMapLibre(mapLibrePitchToDegrees(pitch)), pitch);
  assert.equal(mapLibrePitchToDegrees(0), -90);

  for (const [given, want] of [
    [0, 0],
    [90, 90],
    [359.5, 359.5],
    [360, 0],
    [725, 5],
    [-90, 270],
    [-0.5, 359.5],
    [-720, 0],
  ] as const)
    assert.equal(normalizeBearing(given), want, String(given));
  assert.ok(Object.is(normalizeBearing(-360), 0), 'zero, not minus zero');
  assert.ok(Object.is(normalizeBearing(-0), 0));
});

test('raster overlay ids, and which overlays go through the tile protocol', () => {
  assert.equal(rasterOverlaySourceId('gibs:ir'), `${RASTER_OVERLAY_PREFIX}gibs:ir`);
  assert.equal(rasterOverlayLayerId('gibs:ir'), `${RASTER_OVERLAY_PREFIX}gibs:ir:layer`);
  assert.notEqual(rasterOverlaySourceId('a'), rasterOverlayLayerId('a'));
  assert.notEqual(rasterOverlayLayerId('a'), rasterOverlaySourceId('a:layer'.slice(0, 1)));

  const wmts = {
    kind: 'wmts',
    id: 'ir',
    providerId: 'ir',
    name: 'Infrared',
    attribution: 'test',
    url: 'https://gibs.example/ir/{TileMatrix}/{TileRow}/{TileCol}.png',
    layer: 'ir',
    style: 'default',
    format: 'image/png',
    tileMatrixSet: 'GoogleMapsCompatible_Level6',
    webMercator: true,
    opacity: 0.5,
  } as unknown as RasterOverlay;
  assert.equal(usesWmtsProtocol(wmts), false, 'a plain web-mercator WMTS is a tile template MapLibre reads itself');
  assert.equal(
    usesWmtsProtocol({ ...wmts, fadeBelow: 0.3 } as unknown as RasterOverlay),
    true,
    'its pixels are touched',
  );
  assert.equal(
    usesWmtsProtocol({ ...wmts, fadeBelow: 0 } as unknown as RasterOverlay),
    true,
    'a fade from zero is still a fade',
  );
  assert.equal(
    usesWmtsProtocol({ ...wmts, tileMatrixLabels: ['00', '01', '02'] } as unknown as RasterOverlay),
    true,
    'matrix names no template can write',
  );
  assert.equal(usesWmtsProtocol({ ...wmts, tileMatrixLabels: ['0', '1', '2'] } as unknown as RasterOverlay), false);
  assert.equal(usesWmtsProtocol({ ...wmts, kind: 'wms', fadeBelow: 0.3 } as unknown as RasterOverlay), false);
});

test('night: one fill per twilight band over one source, the ring never simplified', () => {
  const layers = nightLayers();
  assert.equal(layers.length, NIGHT_LAYER_IDS.length);
  assert.deepEqual(
    layers.map((l) => l.id),
    [...NIGHT_LAYER_IDS],
  );
  assert.equal(new Set(NIGHT_LAYER_IDS).size, NIGHT_LAYER_IDS.length);
  layers.forEach((layer, band) => {
    assert.equal(layer.type, 'fill');
    assert.equal(layer.source, NIGHT_SOURCE);
    assert.deepEqual(layer.filter, ['==', ['get', 'band'], band]);
  });
  const source = nightSource(Date.parse('2026-06-21T12:00:00Z')) as {
    type: string;
    tolerance: number;
    data: { features: Array<{ id: number; properties: { band: number }; geometry: { coordinates: number[][][] } }> };
  };
  assert.equal(source.type, 'geojson');
  assert.equal(source.tolerance, 0);
  assert.equal(source.data.features.length, NIGHT_LAYER_IDS.length);
  source.data.features.forEach((feature, band) => {
    assert.equal(feature.id, band);
    assert.equal(feature.properties.band, band);
    const ring = feature.geometry.coordinates[0]!;
    assert.ok(ring.length >= 4);
    assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
    assert.ok(ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat!) <= 90));
  });
  // At the June solstice at noon UTC the night is in the south: its pole is inside every band.
  const south = source.data.features[0]!.geometry.coordinates[0]!.reduce((min, p) => Math.min(min, p[1]!), 90);
  assert.ok(south <= -89, `the night reaches the south pole (${south})`);
});
