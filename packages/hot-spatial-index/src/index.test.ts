import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, regionContains, type GeoRegion } from '@opcb/world-model';
import { GridSpatialIndex } from './index.js';

// A deterministic world of points, a fifth of them near a pole and a seventh on the 180° seam.
function world(n: number) {
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const idx = new GridSpatialIndex();
  const pts: Array<{ id: string; latitude: number; longitude: number }> = [];
  for (let i = 0; i < n; i++) {
    const latitude = i % 5 === 0 ? (rnd() < 0.5 ? 1 : -1) * (80 + rnd() * 10) : rnd() * 180 - 90;
    const longitude = i % 7 === 0 ? (rnd() < 0.5 ? 179 + rnd() : -180 + rnd()) : rnd() * 360 - 180;
    const p = { id: `p${i}`, latitude, longitude };
    pts.push(p);
    idx.upsert(p);
  }
  return { idx, pts, rnd };
}

test('the grid answers regions exactly as checking every point would — poles and 180° included', () => {
  const { idx, pts, rnd } = world(5000);
  for (let q = 0; q < 120; q++) {
    let region: GeoRegion;
    if (q % 3 === 0) {
      const west = rnd() * 360 - 180;
      const span = [1, 20, 120][q % 3]!;
      const south = rnd() * 160 - 85;
      region = {
        kind: 'bounds',
        bounds: { west, east: ((west + span + 540) % 360) - 180, south, north: Math.min(90, south + span / 3) },
      };
    } else if (q % 3 === 1) {
      // Circles reaching a pole and circles on 180° (circleBounds, 2026-11-14).
      region = {
        kind: 'circle',
        center: {
          latitude: q % 2 ? 85 + rnd() * 5 : rnd() * 160 - 80,
          longitude: q % 4 < 2 ? 179.9 : rnd() * 360 - 180,
        },
        radiusM: [5e3, 2e5, 2e6][q % 3]!,
      };
    } else {
      const c = rnd() * 360 - 180;
      const lat = rnd() * 140 - 70;
      region = {
        kind: 'polygon',
        polygon: [
          [c - 3, lat - 2],
          [((c + 4 + 540) % 360) - 180, lat - 1],
          [c, lat + 3],
        ],
      };
    }
    const got = new Set(idx.withinRegion(region).map((x) => x.id));
    const want = new Set(pts.filter((p) => regionContains(region, p)).map((p) => p.id));
    assert.deepEqual([...got].sort(), [...want].sort(), JSON.stringify(region));
  }
});

test('nearest is the true nearest, at the poles and across 180°', () => {
  const { idx, pts, rnd } = world(5000);
  for (let q = 0; q < 60; q++) {
    const c = {
      latitude: q % 3 === 0 ? 89 + rnd() : q % 3 === 1 ? rnd() * 160 - 80 : -88 + rnd() * 3,
      longitude: q % 2 ? 179.95 : rnd() * 360 - 180,
    };
    const k = [1, 5, 20][q % 3]!;
    const want = pts
      .map((p) => ({ id: p.id, d: haversineMeters(c, p) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, k)
      .map((x) => x.id);
    assert.deepEqual(
      idx.nearest(c, k).map((x) => x.id),
      want,
      JSON.stringify(c),
    );
  }
});
