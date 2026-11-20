import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundsContain, haversineMeters, regionContains, type GeoBounds, type GeoRegion } from '@opcb/world-model';
import { GridSpatialIndex, type SpatialItem } from './index.js';

/**
 * The index against a plain search of everything it holds. The grid is only a way of looking
 * in fewer places: whatever is put in, moved and taken out, and wherever the question is
 * asked — across the antimeridian, over a pole, on a cell's edge — it must give the answer a
 * search of every item gives. Operations and questions are generated from a fixed seed.
 */
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

const TYPES = ['aircraft', 'vessel', 'earthquake'] as const;
const EDGE_LATS = [-90, -89.999, -45, 0, 45, 60, 89.999, 90];
const EDGE_LONS = [-180, -179.999, -90, 0, 90, 135, 179.999, 180];

function ids(items: readonly SpatialItem[]): string[] {
  return items.map((i) => i.id).sort();
}

function run(seed: number, cellSizeDeg: number, steps: number): { problems: string[]; questions: number } {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const lat = () =>
    next() < 0.2 ? pick(EDGE_LATS) : next() < 0.3 ? Math.round((next() * 2 - 1) * 90) : (next() * 2 - 1) * 90;
  const lon = () =>
    next() < 0.2 ? pick(EDGE_LONS) : next() < 0.3 ? Math.round((next() * 2 - 1) * 180) : (next() * 2 - 1) * 180;
  const index = new GridSpatialIndex({ cellSizeDeg });
  const model = new Map<string, SpatialItem>();
  const problems: string[] = [];
  let questions = 0;
  const same = (what: string, got: readonly SpatialItem[], want: readonly SpatialItem[]) => {
    questions++;
    const a = ids(got);
    const b = ids(want);
    if (a.join() !== b.join() && problems.length < 6) {
      const missing = b.filter((id) => !a.includes(id)).slice(0, 3);
      const extra = a.filter((id) => !b.includes(id)).slice(0, 3);
      problems.push(
        `${what}: ${a.length} for ${b.length}; missing ${JSON.stringify(missing.map((id) => model.get(id)))} extra ${extra.join()}`,
      );
    }
  };
  const typesFor = (): string[] | undefined => (next() < 0.3 ? [pick(TYPES)] : undefined);
  const ofTypes = (types: string[] | undefined) => (i: SpatialItem) =>
    !types || (i.type !== undefined && types.includes(i.type));

  for (let step = 0; step < steps; step++) {
    const roll = next();
    if (roll < 0.55) {
      const item: SpatialItem = { id: `o${Math.floor(next() * 400)}`, latitude: lat(), longitude: lon() };
      if (next() < 0.8) item.type = pick(TYPES);
      index.upsert(item);
      model.set(item.id, item);
    } else if (roll < 0.7) {
      const id = `o${Math.floor(next() * 400)}`;
      if (index.remove(id) !== model.delete(id) && problems.length < 6) problems.push(`remove ${id} disagreed`);
    } else if (roll < 0.8) {
      const south = lat();
      const north = Math.min(90, south + next() * (next() < 0.3 ? 180 : 20));
      const bounds: GeoBounds = { south, north, west: lon(), east: lon() };
      const types = typesFor();
      const all = [...model.values()].filter(ofTypes(types));
      same(
        `withinBounds ${JSON.stringify(bounds)}`,
        index.withinBounds(bounds, types ? { types } : undefined),
        all.filter((i) => boundsContain(bounds, i)),
      );
      // Every item the bounds hold is in one of the counted cells, once.
      const counted = index.cellCounts(bounds, types ? { types } : undefined);
      const cells = new Set(counted.map((c) => c.cell));
      if (cells.size !== counted.length && problems.length < 6) problems.push('cellCounts named a cell twice');
      const total = counted.reduce((sum, c) => sum + c.count, 0);
      const inside = all.filter((i) => boundsContain(bounds, i)).length;
      if (total < inside && problems.length < 6)
        problems.push(`cellCounts ${JSON.stringify(bounds)} counted ${total}, ${inside} are inside`);
    } else if (roll < 0.9) {
      const center = { latitude: lat(), longitude: lon() };
      const radiusM = next() < 0.2 ? next() * 20_000_000 : next() < 0.5 ? next() * 2_000_000 : next() * 50_000;
      const types = typesFor();
      const all = [...model.values()].filter(ofTypes(types));
      const want = all.filter((i) => haversineMeters(center, i) <= radiusM);
      const got = index.withinRadius(center, radiusM, types ? { types } : undefined);
      same(`withinRadius ${JSON.stringify(center)} ${Math.round(radiusM)}`, got, want);
      if (got.some((g, i) => i > 0 && g.distanceM < got[i - 1]!.distanceM) && problems.length < 6)
        problems.push('withinRadius out of order');
      same(
        `withinRegion circle ${JSON.stringify(center)} ${Math.round(radiusM)}`,
        index.withinRegion({ kind: 'circle', center, radiusM }, types ? { types } : undefined),
        all.filter((i) => regionContains({ kind: 'circle', center, radiusM }, i)),
      );
    } else if (roll < 0.95) {
      const center = { latitude: lat(), longitude: lon() };
      const n = 1 + Math.floor(next() * 8);
      const types = typesFor();
      const all = [...model.values()].filter(ofTypes(types));
      const want = all
        .map((i) => haversineMeters(center, i))
        .filter((d) => d <= 20_000_000)
        .sort((a, b) => a - b)
        .slice(0, n);
      const got = index.nearest(center, n, types ? { types } : undefined).map((g) => g.distanceM);
      questions++;
      if ((got.length !== want.length || got.some((d, i) => Math.abs(d - want[i]!) > 1e-6)) && problems.length < 6)
        problems.push(`nearest ${n} of ${JSON.stringify(center)}: ${JSON.stringify(got)} for ${JSON.stringify(want)}`);
    } else {
      // A four-cornered area, sometimes across the antimeridian.
      const south = (next() * 2 - 1) * 70;
      const west = next() < 0.3 ? 170 + next() * 9 : (next() * 2 - 1) * 150;
      const h = 1 + next() * 15;
      const w = 1 + next() * 25;
      const wrap = (x: number) => (x > 180 ? x - 360 : x);
      const polygon: Array<[number, number]> = [
        [west, south],
        [wrap(west + w), south],
        [wrap(west + w), south + h],
        [west, south + h],
        [west, south],
      ];
      const region: GeoRegion = { kind: 'polygon', polygon };
      same(
        `withinRegion polygon ${JSON.stringify(polygon)}`,
        index.withinRegion(region),
        [...model.values()].filter((i) => regionContains(region, i)),
      );
    }
    if (index.size !== model.size && problems.length < 6) problems.push(`size ${index.size} for ${model.size}`);
  }
  for (const [id, item] of model) if (index.get(id) !== item && problems.length < 6) problems.push(`get ${id} differs`);
  return { problems, questions };
}

test('the index answers as a search of everything it holds would', () => {
  let questions = 0;
  for (const cellSizeDeg of [1, 0.5, 5, 90]) {
    for (const seed of [3, 17, 2026]) {
      const result = run(seed + cellSizeDeg * 1000, cellSizeDeg, 3000);
      assert.deepEqual(result.problems, [], `cell ${cellSizeDeg}, seed ${seed}`);
      questions += result.questions;
    }
  }
  // The generator did ask: a change that made it ask nothing would pass for no reason.
  assert.ok(questions > 8000, `${questions} questions asked`);
});

test('a cell size that does not divide the grid is refused', () => {
  for (const bad of [0, -1, 7, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new GridSpatialIndex({ cellSizeDeg: bad }), /cellSizeDeg/, String(bad));
});

test('an item with no finite position is refused and leaves the index as it was', () => {
  const index = new GridSpatialIndex();
  index.upsert({ id: 'a', latitude: 1, longitude: 1 });
  for (const [latitude, longitude] of [
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ] as const)
    assert.throws(() => index.upsert({ id: 'a', latitude, longitude }), /invalid position/);
  assert.equal(index.size, 1);
  assert.deepEqual(ids(index.withinBounds({ south: 0, north: 2, west: 0, east: 2 })), ['a']);
});
