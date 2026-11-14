import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { createActions } from './actions.js';
import type { RootAction, RootState } from './types.js';

const T0 = Date.parse('2026-09-21T08:00:00.000Z');

async function harness() {
  const client = new DemoClient({ now: () => T0 });
  const asked: unknown[] = [];
  const request = client.request.bind(client);
  // Spy on the export request; everything else as the demo answers it.
  (client as unknown as { request: typeof request }).request = (async (channel: string, payload: unknown) => {
    if (channel === 'export.objects') {
      asked.push(payload);
      return { cancelled: true };
    }
    return request(channel as never, payload as never);
  }) as typeof request;
  let state: RootState = await loadInitialState(client, () => T0);
  const dispatch = (action: RootAction) => {
    state = rootReducer(state, action);
  };
  const actions = createActions({
    client,
    dispatch,
    getState: () => state,
    hosts: { get: () => null, set: () => {} },
    now: () => T0,
  });
  return { actions, get: () => state, asked };
}

test('Export visible objects leaves out the layers switched off; with every layer off it exports nothing', async () => {
  const h = await harness();
  await h.actions.exportVisible('geojson');
  const all = (h.asked[0] as { query: { objectTypes: string[] } }).query.objectTypes;
  assert.ok(all.includes('aircraft') && all.includes('wind'));
  await h.actions.setLayerVisible('aviation', false);
  await h.actions.exportVisible('geojson');
  const less = (h.asked[1] as { query: { objectTypes: string[] } }).query.objectTypes;
  assert.ok(!less.includes('aircraft'), 'Aviation off: no aircraft');
  assert.ok(less.includes('vessel'));
  // Every layer off: types no layer claims (places found by search) are still drawn, so only
  // those are asked for — never an empty list, which would mean every type.
  await h.actions.setAllLayersVisible(false);
  const before = h.asked.length;
  await h.actions.exportVisible('geojson');
  const rest = h.asked.slice(before) as Array<{ query: { objectTypes: string[] } }>;
  assert.deepEqual(rest[0]!.query.objectTypes, ['place']);
});
