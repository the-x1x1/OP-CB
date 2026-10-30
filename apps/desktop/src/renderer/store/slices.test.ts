import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, rootReducer } from './reducer.js';
import { createSliceStore } from './store.js';
import type { RootState } from './types.js';

const T0 = Date.parse('2026-10-20T08:00:00.000Z');

/**
 * `useAppSlice` renders a component only when its selected value changes (useSyncExternalStore
 * compares with Object.is). What that rests on is below: a world change produces a new `world`
 * slice and leaves every other slice the same object, and the store tells its subscribers
 * once per change with the state the reducer produced.
 */
test('slices: a world change leaves the other slices the same object, so their readers do not render', () => {
  const before = initialState(T0);
  const object = {
    id: 'aircraft:test:1',
    type: 'aircraft',
    position: { latitude: 21.3, longitude: -157.86 },
    observedAt: new Date(T0).toISOString(),
    labels: {},
    properties: {},
    provenance: {
      providerId: 'test',
      sourceName: 'test',
      origin: 'test',
      observationId: 'o1',
      receivedAt: new Date(T0).toISOString(),
    },
    sourceRefs: [],
    quality: { complete: true, sourceQuality: 'unknown' },
    freshness: 'LIVE',
  };
  const after = rootReducer(before, {
    type: 'world/changed',
    change: {
      added: ['aircraft:test:1'],
      updated: [],
      removed: [],
      refreshed: [],
      at: new Date(T0).toISOString(),
      objectCount: 1,
      objects: [object],
      freshness: [],
    } as never,
  });
  assert.notEqual(after.world, before.world, 'the world slice is new');
  for (const key of [
    'session',
    'sources',
    'timeline',
    'feed',
    'lenses',
    'collections',
    'watchzones',
    'offline',
    'updater',
    'ui',
  ] as const)
    assert.equal(after[key], before[key], `${key} is the same object`);
  // What the top bar selects: the count changed; the connection and settings did not.
  assert.equal(after.world.objects.size, before.world.objects.size + 1);
  assert.equal(after.sources.connection, before.sources.connection);
  assert.equal(after.session.settings, before.session.settings);
});

test('slices: the store reads what the reducer holds now and tells each subscriber once per change', () => {
  let state: RootState = initialState(T0);
  const store = createSliceStore(() => state);
  let told = 0;
  const off = store.subscribe(() => told++);
  assert.equal(store.get(), state);
  state = rootReducer(state, { type: 'ui/railCollapsed', collapsed: true });
  store.notify();
  assert.equal(told, 1);
  assert.equal(store.get().ui.railCollapsed, true);
  off();
  store.notify();
  assert.equal(told, 1, 'unsubscribed');
});
