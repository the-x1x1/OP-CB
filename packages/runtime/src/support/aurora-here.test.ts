import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldGeometry, WorldObject } from '@worldview/world-model';
import { auroraHere, geometryHolds } from './aurora-here.js';

const box = (w: number, s: number, e: number, n: number): number[][] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

function area(id: string, pct: number | undefined, geometry: WorldGeometry, props: Record<string, unknown> = {}) {
  return {
    id: `weather-alert:swpc-aurora:${id}`,
    type: 'weather-alert',
    labels: {},
    geometry,
    observedAt: '2026-09-23T19:05:00.000Z',
    properties: { ...(pct !== undefined ? { auroraChancePct: pct } : {}), ...props },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [],
    provenance: {
      providerId: 'swpc-aurora',
      sourceName: 'Aurora forecast (NOAA SWPC OVATION)',
      attribution: 'Aurora forecast: NOAA Space Weather Prediction Center (OVATION)',
      origin: 'live',
      receivedAt: '2026-09-23T19:06:00.000Z',
    },
  } as unknown as WorldObject;
}

const nested = [
  area('aurora-10', 10, { type: 'MultiPolygon', coordinates: [[box(-170, 55, -90, 75)]] } as WorldGeometry, {
    auroraChanceBelowPct: 30,
    forecastFor: '2026-09-23T20:08:00.000Z',
  }),
  area('aurora-30', 30, { type: 'MultiPolygon', coordinates: [[box(-150, 60, -120, 70)]] } as WorldGeometry, {
    auroraChanceBelowPct: 50,
    forecastFor: '2026-09-23T20:08:00.000Z',
  }),
];

test('the highest level whose area holds the place, with the next level up, the time it is for and the credit', () => {
  assert.deepEqual(auroraHere(nested, { latitude: 65, longitude: -147.7 }), {
    chancePct: 30,
    belowPct: 50,
    forecastFor: '2026-09-23T20:08:00.000Z',
    attribution: 'Aurora forecast: NOAA Space Weather Prediction Center (OVATION)',
  });
  assert.equal(auroraHere(nested, { latitude: 58, longitude: -100 })?.chancePct, 10);
  assert.equal(auroraHere(nested, { latitude: 21.3, longitude: -157.9 }), undefined, 'Honolulu: none');
  assert.equal(auroraHere([], { latitude: 65, longitude: -147.7 }), undefined, 'the source off: no answer');
});

test('an alert without auroraChancePct is not an aurora area', () => {
  const warning = area('w', undefined, { type: 'Polygon', coordinates: [box(-180, -90, 180, 90)] } as WorldGeometry);
  assert.equal(auroraHere([warning], { latitude: 65, longitude: -147.7 }), undefined);
});

test('holes are outside; a longitude past 180 is folded first', () => {
  const ring: WorldGeometry = {
    type: 'Polygon',
    coordinates: [box(-20, -20, 20, 20), box(-5, -5, 5, 5).reverse()],
  } as WorldGeometry;
  assert.equal(geometryHolds(ring, { latitude: 10, longitude: 10 }), true);
  assert.equal(geometryHolds(ring, { latitude: 0, longitude: 0 }), false, 'in the hole');
  const east: WorldGeometry = { type: 'MultiPolygon', coordinates: [[box(160, 50, 180, 70)]] } as WorldGeometry;
  assert.equal(geometryHolds(east, { latitude: 60, longitude: -190 }), true, '−190 is 170');
  assert.equal(geometryHolds({ type: 'Point', coordinates: [0, 0] }, { latitude: 0, longitude: 0 }), false);
});
