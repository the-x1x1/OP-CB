import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contourRecords, type ContourRecord } from './contours.js';

/** A grid body: `rows[j][i]` is the value at longitude `x0 + i·step`, latitude `y0 + j·step`. */
function grid(rows: number[][], x0 = 0, y0 = 0, step = 1, extra: Record<string, unknown> = {}) {
  const coordinates: number[][] = [];
  rows.forEach((row, j) => row.forEach((v, i) => coordinates.push([x0 + i * step, y0 + j * step, v])));
  return { 'Forecast Time': '2026-09-23T20:05:00Z', coordinates, ...extra };
}

const signedArea = (ring: number[][]) => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  return s / 2;
};

function records(body: unknown, levels: number[]): ContourRecord[] {
  const r = contourRecords(body, { pointsPath: 'coordinates', levels });
  assert.ok('records' in r, 'malformed' in r ? r.malformed : '');
  return r.records;
}

test('a single peak: one area per level, counter-clockwise, closed, round the peak', () => {
  const body = grid([
    [0, 0, 0, 0, 0],
    [0, 10, 10, 10, 0],
    [0, 10, 40, 10, 0],
    [0, 10, 10, 10, 0],
    [0, 0, 0, 0, 0],
  ]);
  const [low, high, ...rest] = records(body, [5, 30, 90]);
  assert.equal(rest.length, 0, 'no area reaches 90');
  assert.equal(low!.level, 5);
  assert.equal(low!.upTo, 30);
  assert.equal(low!.band, 1);
  assert.equal(high!.upTo, 90, 'the next level, though nothing reaches it');
  assert.equal(low!.geometry.coordinates.length, 1);
  const ring = low!.geometry.coordinates[0]![0]!;
  assert.deepEqual(ring[0], ring[ring.length - 1], 'closed');
  assert.ok(signedArea(ring) > 0, 'counter-clockwise');
  // Interpolated half-way from 0 to 10: the 5 line runs at 0.5 and 3.5.
  const xs = ring.map((p) => p[0]!);
  assert.equal(Math.min(...xs), 0.5);
  assert.equal(Math.max(...xs), 3.5);
  // 30 lies two-thirds of the way from 10 to 40.
  const hx = high!.geometry.coordinates[0]![0]!.map((p) => p[0]!);
  assert.equal(Math.min(...hx), 1.667);
  assert.equal(Math.max(...hx), 2.333);
  assert.equal(low!.source['Forecast Time'], '2026-09-23T20:05:00Z');
  assert.equal('coordinates' in low!.source, false, 'the grid itself is not carried');
});

test('a ring of high values: one area with a hole, the hole clockwise', () => {
  const body = grid([
    [0, 0, 0, 0, 0, 0, 0],
    [0, 20, 20, 20, 20, 20, 0],
    [0, 20, 0, 0, 0, 20, 0],
    [0, 20, 0, 0, 0, 20, 0],
    [0, 20, 0, 0, 0, 20, 0],
    [0, 20, 20, 20, 20, 20, 0],
    [0, 0, 0, 0, 0, 0, 0],
  ]);
  const [r] = records(body, [10]);
  assert.equal(r!.geometry.coordinates.length, 1);
  const [outer, hole, ...more] = r!.geometry.coordinates[0]!;
  assert.equal(more.length, 0);
  assert.ok(signedArea(outer!) > 0);
  assert.ok(signedArea(hole!) < 0);
  const hx = hole!.map((p) => p[0]!);
  assert.deepEqual([Math.min(...hx), Math.max(...hx)], [1.5, 4.5]);
});

test('an area at the edge of the grid closes along the edge', () => {
  const body = grid([
    [50, 50, 0],
    [50, 50, 0],
    [0, 0, 0],
  ]);
  const [r] = records(body, [10]);
  const ring = r!.geometry.coordinates[0]![0]!;
  assert.ok(
    ring.some((p) => p[0] === 0 && p[1] === 0),
    'the corner of the grid is on the outline',
  );
  assert.ok(signedArea(ring) > 0);
});

test('saddle cells follow the cell mean', () => {
  const joined = records(
    grid([
      [0, 0, 0, 0],
      [0, 20, 8, 0],
      [0, 8, 20, 0],
      [0, 0, 0, 0],
    ]),
    [10],
  );
  assert.equal(joined[0]!.geometry.coordinates.length, 1, 'mean 14 ≥ 10: the two highs are one area');
  const one = records(
    grid([
      [0, 0, 0, 0],
      [0, 20, 1, 0],
      [0, 1, 20, 0],
      [0, 0, 0, 0],
    ]),
    [15],
  );
  assert.equal(one[0]!.geometry.coordinates.length, 2, 'mean 10.5 < 15: two areas');
});

test('a global grid wraps: an area across 180° is two polygons meeting there, all longitudes within ±180', () => {
  // 30° grid, longitudes 0…330 (the source's 0–359 form), latitudes −60…60.
  const rows: number[][] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const row: number[] = [];
    for (let lon = 0; lon < 360; lon += 30) row.push(lat === 0 && (lon === 180 || lon === 150 || lon === 210) ? 50 : 0);
    rows.push(row);
  }
  const [r] = records(grid(rows, 0, -60, 30), [10]);
  const all = r!.geometry.coordinates.flat(2);
  assert.ok(all.every(([x]) => x! >= -180 && x! <= 180));
  // The 50s at 150 and −150 fall to 10 a fifth of the way to the 0s at 120 and −120: at ±126.
  assert.equal(r!.geometry.coordinates.length, 2);
  const spans = r!.geometry.coordinates
    .map((poly) => {
      const xs = poly[0]!.map((p) => p[0]!);
      return [Math.min(...xs), Math.max(...xs)];
    })
    .sort((a, b) => a[0]! - b[0]!);
  assert.deepEqual(spans, [
    [-180, -126],
    [126, 180],
  ]);
});

test('not a grid', () => {
  assert.deepEqual(contourRecords({ coordinates: 'x' }, { pointsPath: 'coordinates', levels: [1] }), {
    malformed: 'coordinates is not an array of grid points',
  });
  const uneven = { coordinates: [0, 1, 3].flatMap((x) => [0, 1].map((y) => [x, y, 1])) };
  assert.deepEqual(contourRecords(uneven, { pointsPath: 'coordinates', levels: [1] }), {
    malformed: 'longitudes: not evenly spaced',
  });
  assert.deepEqual(contourRecords({ coordinates: [[0, 0, 1]] }, { pointsPath: 'coordinates', levels: [1] }), {
    malformed: 'too few grid points',
  });
});

test('points as objects, by paths', () => {
  const body = {
    points: [0, 1, 2].flatMap((x) => [0, 1, 2].map((y) => ({ x, y, p: x === 1 && y === 1 ? 9 : 0 }))),
  };
  const r = contourRecords(body, { pointsPath: 'points', lon: 'x', lat: 'y', value: 'p', levels: [3] });
  assert.ok('records' in r);
  assert.equal(r.records.length, 1);
});

test('points along two lines are not a grid to fill (a sparse body must not cost millions of cells)', () => {
  const coordinates: number[][] = [];
  for (let i = 0; i < 3000; i++) coordinates.push([i * 0.01, 0, 1], [0, i * 0.01 - 15, 1]);
  const started = Date.now();
  assert.deepEqual(contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [1, 2, 3, 4, 5, 6, 7, 8] }), {
    malformed: 'the points do not fill a grid',
  });
  assert.ok(Date.now() - started < 2000);
});

test('a global grid offset from 180° (0.5°, 1.5° …) is covered up to ±180° on both sides, never past', () => {
  // 10° grid, longitudes 5…355 (−175…175), latitudes −20…20; high values at the seam (±175).
  const coordinates: number[][] = [];
  for (let lon = 5; lon < 360; lon += 10)
    for (let lat = -20; lat <= 20; lat += 10)
      coordinates.push([lon, lat, lat === 0 && (lon === 175 || lon === 185) ? 50 : 0]);
  const r = contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [10] });
  assert.ok('records' in r);
  const xs = r.records[0]!.geometry.coordinates.flat(2).map((p) => p[0]!);
  assert.equal(Math.max(...xs), 180, 'reaches 180° on the east side');
  assert.equal(Math.min(...xs), -180, 'and −180° on the west');
  assert.ok(xs.every((x) => x >= -180 && x <= 180));
});

test('a grid whose step is not exact at six decimals (1/3°) is still a grid', () => {
  const coordinates: number[][] = [];
  for (let i = 0; i < 1080; i++)
    for (const lat of [0, 1 / 3, 2 / 3]) coordinates.push([i / 3, lat, i === 10 && lat > 0.3 && lat < 0.4 ? 9 : 0]);
  const r = contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [5] });
  assert.ok('records' in r, 'malformed' in r ? r.malformed : '');
  assert.equal(r.records.length, 1);
});

test('a regional grid across 180° (160° E to 160° W) is read: an area across 180° is cut there', () => {
  // 5° grid, longitudes 160…200 (the source's 0–359 form), latitudes 50…70. High at 175…185 on
  // 60° N, and a separate peak at 165° E.
  const coordinates: number[][] = [];
  for (let lon = 160; lon <= 200; lon += 5)
    for (let lat = 50; lat <= 70; lat += 5)
      coordinates.push([
        lon,
        lat,
        lat === 60 && (lon === 175 || lon === 180 || lon === 185) ? 50 : lon === 165 && lat === 55 ? 50 : 0,
      ]);
  const r = contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [10] });
  assert.ok('records' in r, 'malformed' in r ? r.malformed : '');
  const polys = r.records[0]!.geometry.coordinates;
  const spans = polys
    .map((poly) => {
      const xs = poly[0]!.map((p) => p[0]!);
      return [Math.min(...xs), Math.max(...xs)];
    })
    .sort((a, b) => a[0]! - b[0]!);
  // A 50 falls to 10 four fifths of the way to a 0 5° on: 4° out, at 171° and −171° (189° E).
  assert.deepEqual(spans, [
    [-180, -171],
    [161, 169],
    [171, 180],
  ]);
  assert.ok(polys.flat(2).every(([x]) => x! >= -180 && x! <= 180));
});

test('a grid with a column missing in the middle is still not a grid', () => {
  const coordinates = [0, 1, 2, 4, 5].flatMap((x) => [0, 1].map((y) => [x, y, 1]));
  assert.deepEqual(contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [1] }), {
    malformed: 'longitudes: not evenly spaced',
  });
});

test('a regional grid across 180° on a step not exact at six decimals (1/3°) keeps every column', () => {
  const coordinates: number[][] = [];
  for (let i = 0; i <= 60; i++) for (let lat = 50; lat <= 52; lat++) coordinates.push([170 + i / 3, lat, 50]);
  const r = contourRecords({ coordinates }, { pointsPath: 'coordinates', levels: [10] });
  assert.ok('records' in r, 'malformed' in r ? r.malformed : '');
  const xs = r.records[0]!.geometry.coordinates.flat(2).map((p) => p[0]!);
  assert.ok(Math.min(...xs.filter((x) => x > 0)) <= 170.0001, 'from 170° E');
  assert.ok(Math.max(...xs.filter((x) => x < 0)) >= -170.0001, 'to 170° W');
});
