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

test('the store: an AI or radio test whose request fails says so, and no radio report is made up', async () => {
  const demo = createDemoClient({ autoTick: false });
  const failing = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      channel === 'ai.test' || channel === 'mesh.sendTest'
        ? Promise.reject(Object.assign(new Error('request timed out'), { code: 'UNAVAILABLE', channel }))
        : demo.request(channel as never, req as never),
  });
  const store = new CommandCenterStore(failing, () => Date.parse('2026-11-22T09:00:00.000Z'));
  const ai = await store.aiTest('llama3.2', 'hello');
  assert.equal(ai.ok, false);
  assert.match(ai.message ?? '', /^The model could not be asked: request timed out/);
  assert.equal(store.get().lastAiTest?.answer, ai, 'shown where the answer goes');
  assert.equal(store.get().aiBusy, false);

  assert.equal(await store.meshTest('!a1b2c3d4', 'Base', 'radio check'), null);
  assert.equal(store.get().lastMeshTest, undefined, 'no report from the radio is invented');
  assert.match(store.get().meshError ?? '', /could not be asked .*request timed out.*not known/);
  assert.equal(store.get().meshBusy, false);
});

test('the store: a map or library download whose start or stop request fails says so, apart from the status', async () => {
  const demo = createDemoClient({ autoTick: false });
  const refused = new Set(['maps.download.start', 'maps.download.cancel', 'library.download.cancel']);
  const failing = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      refused.has(channel)
        ? Promise.reject(Object.assign(new Error('rate limited; retry in 5s'), { code: 'DENIED', channel }))
        : demo.request(channel as never, req as never),
  });
  const store = new CommandCenterStore(failing, () => Date.parse('2026-11-22T09:00:00.000Z'));
  const before = store.get().mapDownload;
  await store.startMap();
  assert.match(store.get().mapNote ?? '', /^The download could not be started: rate limited/);
  assert.equal(store.get().mapDownload, before, 'the status is the runtime’s, not made up');
  await store.cancelMap();
  assert.match(store.get().mapNote ?? '', /could not be stopped: rate limited/);
  refused.delete('maps.download.cancel');
  await store.cancelMap();
  assert.equal(store.get().mapNote, undefined, 'the next press that goes through clears it');

  await store.cancelLibraryDownload();
  assert.match(store.get().libraryNote ?? '', /could not be stopped: rate limited/);
  refused.delete('library.download.cancel');
  await store.cancelLibraryDownload();
  assert.equal(store.get().libraryNote, undefined);
  // The polling a press starts ends by itself once the runtime reports nothing running.
  await new Promise((r) => setTimeout(r, 1_200));
});

test('the store: a library shelf that cannot be read says why, and the books last read stay', async () => {
  const demo = createDemoClient({ autoTick: false });
  let refuse = false;
  const failing = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      refuse && channel === 'library.shelf'
        ? Promise.reject(
            Object.assign(new Error('the library folder could not be read (ENOTDIR)'), {
              code: 'UNAVAILABLE',
              channel,
            }),
          )
        : demo.request(channel as never, req as never),
  });
  const store = new CommandCenterStore(failing, () => Date.parse('2026-11-22T09:00:00.000Z'));
  const first = await store.refreshShelf();
  assert.equal(store.get().shelfProblem, undefined);
  refuse = true;
  assert.equal(await store.refreshShelf(), first, 'the shelf last read');
  assert.match(store.get().shelfProblem ?? '', /the library folder could not be read \(ENOTDIR\)/);
  refuse = false;
  await store.refreshShelf();
  assert.equal(store.get().shelfProblem, undefined, 'cleared once it reads');
});

test('the store: an inventory save, removal or export that fails says why; the next that works clears it', async () => {
  const demo = createDemoClient({ autoTick: false });
  let refuse = true;
  const failing = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      refuse && channel.startsWith('prep.')
        ? Promise.reject(
            Object.assign(new Error('the file could not be written: another program has the file open'), {
              code: 'UNAVAILABLE',
              channel,
            }),
          )
        : demo.request(channel as never, req as never),
  });
  const store = new CommandCenterStore(failing, () => Date.parse('2026-11-22T09:00:00.000Z'));
  const record = {
    id: 'w',
    kind: 'item' as const,
    category: 'water' as const,
    name: 'Water',
    quantity: 10,
    updatedAt: '2026-11-22T09:00:00.000Z',
  };
  assert.equal(await store.savePrep(record), false);
  assert.match(store.get().prepProblem ?? '', /^Not saved: .*another program has the file open/);
  await store.deletePrep('w');
  assert.match(store.get().prepProblem ?? '', /^Not removed: /);
  assert.equal(await store.exportPrep('csv'), null);
  assert.match(store.get().prepProblem ?? '', /^Not saved to a file: .*could not be written/, 'not taken for a cancel');
  refuse = false;
  assert.equal(await store.savePrep(record), true);
  assert.equal(store.get().prepProblem, undefined);
});

test('the store: a local service page that cannot be opened gives the reason to show', async () => {
  const demo = createDemoClient({ autoTick: false });
  let answer: 'refuse' | 'not-opened' | 'opened' = 'refuse';
  const client = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      channel === 'services.open'
        ? answer === 'refuse'
          ? Promise.reject(
              Object.assign(new Error('The page could not be opened: no application is associated'), {
                code: 'UNAVAILABLE',
                channel,
              }),
            )
          : Promise.resolve({ opened: answer === 'opened' })
        : demo.request(channel as never, req as never),
  });
  const store = new CommandCenterStore(client, () => Date.parse('2026-11-22T09:00:00.000Z'));
  assert.match((await store.openService('kiwix')) ?? '', /could not be opened: no application/);
  answer = 'not-opened';
  assert.equal(await store.openService('kiwix', '/content/x'), 'The page could not be opened from here.');
  answer = 'opened';
  assert.equal(await store.openService('kolibri'), null);
});

test('the store: a walkthrough started over whose save fails says it may come back', async () => {
  const demo = createDemoClient({ autoTick: false });
  let refuse = true;
  const client = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) =>
      refuse && channel === 'guides.reset'
        ? Promise.reject(
            Object.assign(new Error('guides.json could not be written (EBUSY)'), { code: 'UNAVAILABLE', channel }),
          )
        : demo.request(channel as never, req as never),
  });
  const t = Date.parse('2026-11-22T09:00:00.000Z');
  const store = new CommandCenterStore(client, () => t);
  await store.saveGuide(startGuide(MAPS_GUIDE, t));
  const note = await store.resetGuide(MAPS_GUIDE.id);
  assert.match(
    note ?? '',
    /^Started over here, but not saved \(guides\.json could not be written \(EBUSY\).*may come back/,
  );
  assert.equal(store.get().guides.length, 0, 'started over here all the same');
  refuse = false;
  await store.saveGuide(startGuide(MAPS_GUIDE, t));
  assert.equal(await store.resetGuide(MAPS_GUIDE.id), null);
});

test('the store: a status answer older than a Start or a mode choice does not undo it', async () => {
  const demo = createDemoClient({ autoTick: false });
  const held: Array<() => void> = [];
  let holding = true;
  // Held while the test runs; afterwards answered at once (the polling a Start begins ends on "idle").
  const hold = <T>(answer: T) =>
    holding ? new Promise<T>((r) => held.push(() => r(answer))) : Promise.resolve(answer);
  const client = Object.assign(Object.create(demo) as typeof demo, {
    request: (channel: string, req: unknown) => {
      if (channel === 'maps.download.status') return hold({ phase: 'idle' });
      if (channel === 'maps.download.start') return Promise.resolve({ phase: 'downloading', done: 0, total: 10 });
      if (channel === 'mode.state') return hold({ mode: 'online' });
      if (channel === 'mode.choose') return Promise.resolve({ mode: (req as { mode: string }).mode });
      if (channel === 'library.shelf') return hold({ books: [], dir: 'old' });
      return demo.request(channel as never, req as never);
    },
  });
  const store = new CommandCenterStore(client, () => Date.parse('2026-11-22T09:00:00.000Z'));
  try {
    // A poll is out; Start is pressed and answered; then the poll's "idle" comes.
    const poll = store.refreshMap();
    await store.startMap();
    assert.equal(store.get().mapDownload.phase, 'downloading');
    held.shift()!();
    assert.equal((await poll).phase, 'downloading', 'the older answer is not taken');
    assert.equal(store.get().mapDownload.phase, 'downloading', 'and the download is still shown running');

    const modeRead = store.refreshMode();
    await store.chooseMode('offline' as never);
    held.shift()!();
    await modeRead;
    assert.equal((store.get().mode as { mode: string } | null)?.mode, 'offline', 'the choice stands');
  } finally {
    holding = false;
    for (const r of held) r();
    await new Promise((r) => setTimeout(r, 1_200));
  }
});
