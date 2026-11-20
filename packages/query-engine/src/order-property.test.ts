import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue, WorldFilter, WorldQuery } from '@opcb/world-model';
import { applyObjectQuery } from './execute.js';
import { compareValues, type FieldValue } from './fields.js';
import { matchesFilter } from './filters.js';
import { objectFrom, T0 } from './test-fixtures.js';

/**
 * Sorting and filtering over whatever a source may put in a column: numbers, numbers written
 * as text, dates, words in either case, booleans, lists, nothing. A comparison that is not an
 * order makes a list whose order depends on how its rows arrived; these check that it is one,
 * that the short way of taking the first few gives what sorting them all gives, and that a
 * filter and its opposite never both hold. Values are generated from a fixed seed.
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

const ZOO: FieldValue[] = [
  undefined,
  null,
  0,
  -0,
  1,
  -1,
  9,
  9.5,
  10,
  1e21,
  -1e21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '9',
  '10',
  '10.0',
  ' 10 ',
  '1e1',
  '0x10',
  '-5',
  '',
  ' ',
  'Infinity',
  'NaN',
  'alpha',
  'Alpha',
  'ALPHA',
  'beta',
  'true',
  'false',
  'null',
  '2026-11-20T00:00:00Z',
  '2026-11-20T00:00:00.000Z',
  '2026-11-19T14:00:00-10:00',
  '2026-11-20T10:00',
  '2026-13-45T99:99:99Z',
  '2026',
  true,
  false,
  [],
  [1],
  ['1'],
  {},
  { a: 1 },
  { a: '1' },
  '\u{1F525}',
  'é',
  'é',
];

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
const show = (v: FieldValue): string => (v === undefined ? 'undefined' : Object.is(v, -0) ? '-0' : JSON.stringify(v));

test('comparing two values is an order: the same both ways round, and through a third', () => {
  const problems: string[] = [];
  for (const a of ZOO)
    for (const b of ZOO) {
      const ab = compareValues(a, b);
      if (Number.isNaN(ab)) problems.push(`${show(a)} against ${show(b)} is not a number`);
      if (sign(ab) !== -sign(compareValues(b, a))) problems.push(`${show(a)} against ${show(b)} disagrees with itself`);
      for (const c of ZOO) {
        const bc = compareValues(b, c);
        if (sign(ab) <= 0 && sign(bc) <= 0 && sign(compareValues(a, c)) > 0)
          problems.push(`${show(a)} ≤ ${show(b)} ≤ ${show(c)} yet ${show(a)} > ${show(c)}`);
      }
    }
  assert.deepEqual(problems.slice(0, 8), []);
});

function objects(seed: number, count: number) {
  const next = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  return Array.from({ length: count }, (_, i) => {
    const payload: Record<string, JsonValue> = {};
    const v = pick(ZOO);
    // What JSON can carry is what reaches a property; the rest stand for "nothing there".
    if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) payload['v'] = v;
    payload['n'] = Math.floor(next() * 50);
    return objectFrom({
      providerId: 'p',
      objectType: 'aircraft',
      externalId: `x${i}`,
      observedAt: new Date(T0 - Math.floor(next() * 40) * 60_000).toISOString(),
      payload,
    });
  });
}

test('the first few of many are the first few of them all sorted, in either direction', () => {
  for (const seed of [5, 23, 2026]) {
    const all = objects(seed, 1200);
    // Arrival order must not matter: the same objects handed over backwards.
    const backwards = [...all].reverse();
    for (const sort of [
      undefined,
      { field: 'v', direction: 'asc' as const },
      { field: 'v', direction: 'desc' as const },
      { field: 'n', direction: 'asc' as const },
      { field: 'observedAt', direction: 'desc' as const },
      { field: 'properties.absent', direction: 'asc' as const },
    ]) {
      const query = (limit?: number): WorldQuery => ({
        ...(sort ? { sort } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const whole = applyObjectQuery(all, query(), 'live', T0).items.map((o) => o.id);
      assert.equal(whole.length, all.length);
      assert.deepEqual(
        applyObjectQuery(backwards, query(), 'live', T0).items.map((o) => o.id),
        whole,
        `seed ${seed} ${JSON.stringify(sort)}: order depends on arrival`,
      );
      for (const limit of [1, 3, 50, 149, 150, 151, 1000, 1200, 5000]) {
        const part = applyObjectQuery(backwards, query(limit), 'live', T0);
        assert.deepEqual(
          part.items.map((o) => o.id),
          whole.slice(0, limit),
          `seed ${seed} ${JSON.stringify(sort)} limit ${limit}`,
        );
        assert.equal(part.total, all.length);
        assert.equal(part.truncated, limit < all.length);
      }
      // Nothing there sorts last whichever way the rest run.
      if (sort?.field === 'v') {
        const items = applyObjectQuery(all, query(), 'live', T0).items;
        const firstNone = items.findIndex((o) => o.properties['v'] === undefined || o.properties['v'] === null);
        assert.ok(
          firstNone === -1 ||
            items.slice(firstNone).every((o) => o.properties['v'] === undefined || o.properties['v'] === null),
          `seed ${seed} ${sort.direction}: a value sorted after nothing`,
        );
      }
    }
  }
});

test('a filter and its opposite never both hold, and an ordering test never throws', () => {
  const problems: string[] = [];
  const f = (op: WorldFilter['op'], value: JsonValue): WorldFilter => ({ field: 'v', op, value });
  for (const field of ZOO)
    for (const raw of ZOO) {
      if (raw === undefined || (typeof raw === 'number' && !Number.isFinite(raw))) continue;
      const value = raw as JsonValue;
      const at = `${show(field)} against ${show(value)}`;
      try {
        const eq = matchesFilter(field, f('eq', value));
        if (eq === matchesFilter(field, f('neq', value))) problems.push(`${at}: eq and neq agree`);
        const gt = matchesFilter(field, f('gt', value));
        const lt = matchesFilter(field, f('lt', value));
        const gte = matchesFilter(field, f('gte', value));
        const lte = matchesFilter(field, f('lte', value));
        if (gt && lt) problems.push(`${at}: both above and below`);
        if (gt && !gte) problems.push(`${at}: above but not at least`);
        if (lt && !lte) problems.push(`${at}: below but not at most`);
        if (gt && lte) problems.push(`${at}: above and at most`);
        if (lt && gte) problems.push(`${at}: below and at least`);
        if (eq && (gt || lt)) problems.push(`${at}: equal and to one side`);
        if (eq !== matchesFilter(field, f('in', [value]))) problems.push(`${at}: "in" a list of one is not "eq"`);
        if (matchesFilter(field, f('exists', true)) === matchesFilter(field, f('exists', false)))
          problems.push(`${at}: there and not there`);
        matchesFilter(field, f('contains', value));
      } catch (error) {
        problems.push(`${at}: threw ${String(error)}`);
      }
    }
  assert.deepEqual(problems.slice(0, 8), []);
});
