import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoClient } from '../demo/demo-client.js';
import { CommandCenterStore } from './cc-store.js';
import { MAPS_GUIDE } from './guides/maps.js';
import { back, goTo, startGuide } from './guide-engine.js';

test('the store: no mode until chosen, then the choice and its remembering; records kept', async () => {
  const client = createDemoClient({ autoTick: false });
  const store = new CommandCenterStore(client, () => Date.parse('2026-10-30T09:00:00.000Z'));
  store.start();
  await store.refreshMode();
  assert.equal(store.get().mode?.chosen, null, 'the start screen shows until a mode is chosen');
  assert.equal(store.get().mode?.remembered, null);
  assert.equal(await store.chooseMode('offline'), true);
  assert.equal(store.get().mode?.chosen, 'offline');
  assert.equal(store.isOffline(), true);
  store.notePlaceSearch('Kailua', 2);
  assert.deepEqual(store.get().lastPlaceSearch, {
    offline: true,
    text: 'Kailua',
    count: 2,
    at: Date.parse('2026-10-30T09:00:00.000Z'),
  });
  store.openAt('comms', 'meshtastic');
  assert.deepEqual([store.get().open, store.get().section, store.get().guideId], [true, 'comms', 'meshtastic']);
  store.close();
  assert.equal(store.get().open, false);

  await store.saveGuide(startGuide(MAPS_GUIDE, Date.parse('2026-10-30T09:00:00.000Z')));
  assert.equal(store.get().guides.length, 1);
  await store.resetGuide(MAPS_GUIDE.id);
  assert.equal(store.get().guides.length, 0);
  assert.equal(
    await store.savePrep({
      id: 'w',
      kind: 'item',
      category: 'water',
      name: 'Water',
      quantity: 10,
      updatedAt: '2026-10-30T09:00:00.000Z',
    }),
    true,
  );
  assert.equal(store.get().prep.length, 1);
  // The demo answers every local service as not found, and says why; nothing is invented.
  await store.refreshServices();
  assert.ok(store.get().services?.every((s) => s.state === 'not-found'));
  const ai = await store.aiTest('llama3.2', 'hello');
  assert.equal(ai.ok, false);
});

test('the store: a check that comes back after the operator moved on is recorded on its step, and the move is kept', async () => {
  const client = createDemoClient({ autoTick: false });
  let t = Date.parse('2026-10-30T09:00:00.000Z');
  const store = new CommandCenterStore(client, () => t++);
  const def = MAPS_GUIDE;
  const checkedStep = def.steps[1]!;
  assert.ok(checkedStep.check, 'the step checked has a check');
  // On step two; its check is run, and before it comes back the operator goes Back.
  await store.saveGuide(goTo(def, startGuide(def, t), checkedStep.id, t));
  await store.saveGuide(back(def, store.get().guides[0]!, t));
  await store.recordCheckResult(def, checkedStep.id, { status: 'pass', message: 'ok', evidence: 'a pack is on' });
  const p = store.get().guides.find((g) => g.id === def.id)!;
  assert.equal(p.currentStepId, def.steps[0]!.id, 'the walkthrough stays where the operator took it');
  assert.equal(p.steps[checkedStep.id]?.outcome, 'verified', 'and the check is kept on the step it ran on');
  assert.equal(p.steps[checkedStep.id]?.evidence, 'a pack is on');
  assert.equal(p.steps[def.steps[0]!.id]?.outcome === 'verified', false, 'not on the step shown now');
});
