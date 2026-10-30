import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from '../store/bootstrap-state.js';
import { rootReducer } from '../store/reducer.js';
import { createActions } from '../store/actions.js';
import type { RootAction, RootState } from '../store/types.js';
import type { RequestChannel } from '@worldview/ipc-contract';

const T0 = Date.parse('2026-10-20T08:00:00.000Z');

test('connections: Home Assistant in one step sets every source, stores the token, turns on the ones asked for', async () => {
  const demo = new DemoClient({ now: () => T0 });
  const sent: Array<{ channel: RequestChannel; request: unknown }> = [];
  const settings = new Map<string, Record<string, unknown>>();
  const client = {
    contractVersion: demo.contractVersion,
    on: demo.on.bind(demo),
    request: async (channel: RequestChannel, request: unknown) => {
      sent.push({ channel, request });
      if (channel === 'sources.settings.get')
        return settings.get((request as { providerId: string }).providerId) ?? { entities: 'weather.*' };
      if (channel === 'sources.settings.set') {
        const r = request as { providerId: string; settings: Record<string, unknown> };
        settings.set(r.providerId, r.settings);
        return r.settings;
      }
      if (channel === 'credentials.set' || channel === 'sources.setEnabled') return undefined;
      return demo.request(channel as never, request as never);
    },
  } as unknown as DemoClient;
  let state: RootState = await loadInitialState(demo, () => T0);
  const dispatch = (a: RootAction) => {
    state = rootReducer(state, a);
  };
  const actions = createActions({
    client,
    dispatch,
    getState: () => state,
    hosts: { get: () => null, set: () => {} },
    now: () => T0,
  });
  const ok = await actions.connectHomeAssistant({
    address: { host: '192.168.1.20', port: 8123, tls: false },
    token: ' abc.def ',
    enable: ['home-assistant-zones', 'home-assistant-weather'],
    providerIds: ['home-assistant-zones', 'home-assistant-weather', 'home-assistant-people'],
  });
  assert.equal(ok, true);
  assert.deepEqual(sent.find((x) => x.channel === 'credentials.set')?.request, {
    key: 'home-assistant-token',
    value: 'abc.def',
  });
  assert.deepEqual(settings.get('home-assistant-people'), {
    entities: 'weather.*',
    host: '192.168.1.20',
    port: 8123,
    tls: false,
  });
  assert.deepEqual(
    sent
      .filter((x) => x.channel === 'sources.setEnabled')
      .map((x) => x.request as { providerId: string; enabled: boolean }),
    [
      { providerId: 'home-assistant-zones', enabled: true },
      { providerId: 'home-assistant-weather', enabled: true },
      { providerId: 'home-assistant-people', enabled: false },
    ],
    'every source is switched as picked: the people, unticked, go off',
  );
  assert.ok(state.ui.notifications.some((n) => n.title === 'Home Assistant connected'));
});
