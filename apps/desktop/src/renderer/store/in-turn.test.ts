import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Collection, RequestChannel } from '@opcb/ipc-contract';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { createActions } from './actions.js';
import type { RootAction, RootState } from './types.js';

const T0 = Date.parse('2026-11-20T08:00:00.000Z');

/**
 * A change built from the state and saved whole — a collection with one more item, a source's
 * settings with one more key — asked for again before the first has come back. Each request
 * here is answered a little later, as over IPC, so the second is asked for while the first is
 * on its way.
 */
async function shell() {
  const demo = new DemoClient({ now: () => T0 });
  const collections = new Map<string, Collection>();
  const settings = new Map<string, Record<string, unknown>>();
  const later = () => new Promise((r) => setTimeout(r, 5));
  let failNext = false;
  const eventsAsked: string[][] = [];
  const client = {
    contractVersion: demo.contractVersion,
    on: demo.on.bind(demo),
    request: async (channel: RequestChannel, request: unknown) => {
      if (channel === 'collections.save') {
        await later();
        const c = request as Collection;
        collections.set(c.id, c);
        return [...collections.values()];
      }
      if (channel === 'sources.settings.set') {
        await later();
        if (failNext) {
          failNext = false;
          throw new Error('refused');
        }
        const r = request as { providerId: string; settings: Record<string, unknown> };
        settings.set(r.providerId, r.settings);
        return r.settings;
      }
      if (channel === 'world.events') {
        const r = request as { eventTypes?: string[] };
        eventsAsked.push(r.eventTypes ?? []);
        await later();
        await later();
        return {
          items: (r.eventTypes ?? []).map((type, i) => ({
            id: `event:${type}:${i}`,
            type,
            title: type,
            severity: 'MINOR',
            startTime: '2026-11-20T07:00:00.000Z',
            sourceIds: [],
            objectIds: [],
          })),
        };
      }
      if (channel === 'settings.set') {
        // Answered later, as over IPC; the demo keeps the settings and merges the patch.
        const answer = await demo.request(channel as never, request as never);
        await later();
        return answer;
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
    now: () => t++,
  });
  return { actions, collections, settings, eventsAsked, state: () => state, refuseNext: () => (failNext = true) };
}

test('collections: items added one straight after another are all kept', async () => {
  const s = await shell();
  const id = await s.actions.createCollection('Trip');
  const place = (n: number) => ({
    kind: 'location' as const,
    title: `place ${n}`,
    position: { latitude: n, longitude: n },
  });
  await Promise.all([1, 2, 3, 4, 5].map((n) => s.actions.addToCollection(id, place(n))));
  const saved = s.collections.get(id)!;
  assert.deepEqual(
    saved.items.map((i) => i.title),
    ['place 1', 'place 2', 'place 3', 'place 4', 'place 5'],
  );
  assert.equal(new Set(saved.items.map((i) => i.id)).size, 5, 'each with its own id');

  // A note, a removal, a rename and one more item, all at once: none undoes another.
  const [first, second] = saved.items;
  await Promise.all([
    s.actions.setItemNote(id, first!.id, 'fuel here'),
    s.actions.removeFromCollection(id, second!.id),
    s.actions.renameCollection(id, 'Trip north'),
    s.actions.addToCollection(id, place(6)),
  ]);
  const after = s.collections.get(id)!;
  assert.equal(after.name, 'Trip north');
  assert.deepEqual(
    after.items.map((i) => i.title),
    ['place 1', 'place 3', 'place 4', 'place 5', 'place 6'],
  );
  assert.equal(after.items[0]!.note, 'fuel here');
  assert.deepEqual(
    s.state().collections.collections.find((c) => c.id === id),
    after,
    'and the window shows what was saved',
  );
});

test('collections: the same object asked for twice before the first is saved is collected once', async () => {
  const s = await shell();
  const id = await s.actions.createCollection('Watch');
  const item = { kind: 'object' as const, title: 'N123', objectId: 'aircraft:icao24:a1b2c3' };
  await Promise.all([s.actions.addToCollection(id, item), s.actions.addToCollection(id, item)]);
  assert.equal(s.collections.get(id)!.items.length, 1);
});

test('source settings: two keys changed one straight after the other are both saved; a refusal does not stop the next', async () => {
  const s = await shell();
  await Promise.all([
    s.actions.setProviderSetting('public-cameras', 'packs.nsw', true),
    s.actions.setProviderSetting('public-cameras', 'packs.queensland', true),
    s.actions.setProviderSetting('usgs-earthquakes', 'feed', 'all_day'),
  ]);
  assert.deepEqual(s.settings.get('public-cameras'), { packs: { nsw: true, queensland: true } });
  assert.deepEqual(s.settings.get('usgs-earthquakes'), { feed: 'all_day' });
  s.refuseNext();
  await Promise.all([
    s.actions.setProviderSetting('public-cameras', 'packs.hongkong', true),
    s.actions.setProviderSetting('public-cameras', 'packs.nsw', false),
  ]);
  assert.deepEqual(s.settings.get('public-cameras'), { packs: { nsw: false, queensland: true } });
});

test('settings: pass alerts and the home view changed one straight after another keep every change', async () => {
  const s = await shell();
  const sat = (n: number) => ({ objectId: `satellite:norad:${40000 + n}`, name: `SAT ${n}` });
  await Promise.all([1, 2, 3].map((n) => s.actions.setPassAlert(sat(n), true)));
  assert.deepEqual(
    s.state().session.settings?.passAlerts?.satellites.map((x) => x.name),
    ['SAT 1', 'SAT 2', 'SAT 3'],
  );
  await Promise.all([
    s.actions.setPassAlert(sat(2), false),
    s.actions.setPassAlertOptions({ leadMinutes: 15 }),
    s.actions.setPassAlertOptions({ visibleOnly: true }),
  ]);
  const alerts = s.state().session.settings?.passAlerts;
  assert.deepEqual(
    alerts?.satellites.map((x) => x.name),
    ['SAT 1', 'SAT 3'],
  );
  assert.equal(alerts?.leadMinutes, 15);
  assert.equal(alerts?.visibleOnly, true);

  await Promise.all([s.actions.setHomeFlyOnStart(true), s.actions.clearHome(), s.actions.setHomeFlyOnStart(true)]);
  assert.deepEqual(s.state().session.settings?.home, { view: null, flyOnStart: true }, 'applied in the order asked');
});

test("lenses: a lens chosen straight after another shows its own events, not the first one's", async () => {
  const s = await shell();
  const withEvents = s.state().lenses.lenses.filter((l) => l.eventTypes.length > 0);
  assert.ok(withEvents.length >= 2, 'two lenses with events to choose between');
  const [a, b] = withEvents as [(typeof withEvents)[0], (typeof withEvents)[0]];
  const onlyInA = a.eventTypes.filter((t) => !b.eventTypes.includes(t));
  assert.ok(onlyInA.length > 0, `${a.id} has an event type ${b.id} does not`);
  const before = new Set(s.state().world.events.keys());
  await Promise.all([s.actions.setLens(a.id), s.actions.setLens(b.id)]);
  assert.equal(s.state().lenses.activeId, b.id);
  const added = [...s.state().world.events.values()].filter((e) => !before.has(e.id));
  assert.ok(added.length > 0, "the second lens's events are there");
  assert.deepEqual(
    added.filter((e) => onlyInA.includes(e.type)).map((e) => e.type),
    [],
    'and none that only the first lens asked for',
  );
});
