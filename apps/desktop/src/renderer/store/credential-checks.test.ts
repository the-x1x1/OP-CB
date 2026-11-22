import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RequestChannel } from '@opcb/ipc-contract';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { CREDENTIAL_CHECK_REUSE_MS, createActions } from './actions.js';
import type { RootAction, RootState } from './types.js';

const T0 = Date.parse('2026-11-22T04:00:00.000Z');

/**
 * Looking through sources asks for each key's presence; the key channels share one budget of
 * ten a minute, so the key the operator then typed was refused as "rate limited". A key is
 * asked once in a while, and storing or removing it counts as knowing it.
 */
test('credentials: a key is asked once in a while, not at every look; storing one is not crowded out', async () => {
  const demo = new DemoClient({ now: () => T0 });
  const asked: string[] = [];
  let failHas = false;
  const client = {
    contractVersion: demo.contractVersion,
    on: demo.on.bind(demo),
    request: async (channel: RequestChannel, request: unknown) => {
      if (channel.startsWith('credentials.')) {
        asked.push(channel);
        if (channel === 'credentials.has' && failHas) throw new Error('rate limited; retry in 5s');
        return channel === 'credentials.has' ? { present: false } : undefined;
      }
      return demo.request(channel as never, request as never);
    },
  } as unknown as DemoClient;
  let state: RootState = await loadInitialState(demo, () => T0);
  const dispatch = (a: RootAction) => {
    state = rootReducer(state, a);
  };
  let t = T0;
  const actions = createActions({
    client,
    dispatch,
    getState: () => state,
    hosts: { get: () => null, set: () => {} },
    now: () => t,
  });

  // Six sources opened in turn, each asking for the same two keys twice (before and after its manifest).
  for (let i = 0; i < 6; i++)
    await Promise.all(
      ['firms.mapKey', 'aisstream.key', 'firms.mapKey', 'aisstream.key'].map((k) => actions.checkCredential(k)),
    );
  assert.equal(asked.filter((c) => c === 'credentials.has').length, 2, 'once per key');
  assert.equal(state.sources.credentials['firms.mapKey'], false);

  assert.equal(await actions.setCredential('firms.mapKey', 'test-value'), true);
  await actions.checkCredential('firms.mapKey');
  assert.equal(state.sources.credentials['firms.mapKey'], true, 'stored is known, not asked again over it');
  assert.equal(asked.filter((c) => c === 'credentials.has').length, 2);

  // After a while it is asked again (a key stored elsewhere, by a source drafted from an address).
  t += CREDENTIAL_CHECK_REUSE_MS + 1;
  await actions.checkCredential('aisstream.key');
  assert.equal(asked.filter((c) => c === 'credentials.has').length, 3);

  // A check that failed is not taken as known: the next look asks again.
  t += CREDENTIAL_CHECK_REUSE_MS + 1;
  failHas = true;
  await actions.checkCredential('aisstream.key');
  failHas = false;
  await actions.checkCredential('aisstream.key');
  assert.equal(asked.filter((c) => c === 'credentials.has').length, 5);

  // A clock put back does not stop the asking for good.
  t -= 10 * CREDENTIAL_CHECK_REUSE_MS;
  await actions.checkCredential('aisstream.key');
  assert.equal(asked.filter((c) => c === 'credentials.has').length, 6);
});
