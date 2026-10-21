import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readViewLink } from '@worldview/ipc-contract';
import { DemoClient } from '../demo/demo-client.js';
import { loadInitialState } from './bootstrap-state.js';
import { rootReducer } from './reducer.js';
import { createActions } from './actions.js';
import type { RootAction, RootState } from './types.js';
import type { RendererHostLike } from '../renderer-host-like.js';
import { linkForView, linkHiddenLayers, linkableLayerIds } from './view-link.js';

const T0 = Date.parse('2026-10-20T08:00:00.000Z');

function recordingHost() {
  const flights: Array<{ position: { latitude: number; longitude: number }; zoom?: number; altitudeM?: number }> = [];
  const modes: string[] = [];
  const host: RendererHostLike = {
    mount() {},
    unmount() {},
    setMode(m) {
      modes.push(m);
    },
    activeMode: () => '2D',
    supportsMode: () => true,
    getView: () => ({
      center: { latitude: 21.30694, longitude: -157.85833 },
      altitudeM: 25_000,
      zoom: 11.25,
      headingDegrees: 0,
      pitchDegrees: -90,
    }),
    flyTo(target) {
      flights.push(target);
    },
    select() {},
    setLens() {},
    on: () => () => {},
  };
  return { host, flights, modes };
}

async function harness() {
  const client = new DemoClient({ now: () => T0 });
  let state: RootState = await loadInitialState(client, () => T0);
  const dispatch = (action: RootAction) => {
    state = rootReducer(state, action);
  };
  const rec = recordingHost();
  const actions = createActions({
    client,
    dispatch,
    getState: () => state,
    hosts: { get: () => rec.host, set: () => {} },
    now: () => T0,
  });
  return { actions, get: () => state, ...rec };
}

test('view link layers: show and hide turn switches; ids that are no switch here are named', () => {
  const known = linkableLayerIds();
  assert.ok(known.has('aviation') && known.has('imagery.infrared'));
  const turned = linkHiddenLayers(['aviation', 'maritime'], { show: ['aviation', 'nope'], hide: ['disasters'] });
  assert.deepEqual(turned.hidden.sort(), ['disasters', 'maritime']);
  assert.deepEqual(turned.unknown, ['nope']);
});

test('view link for the view: 2D by zoom, the globe by height, lens and selection kept', () => {
  const view = { center: { latitude: 10, longitude: 181 }, altitudeM: 3_000, zoom: 14 };
  assert.deepEqual(linkForView(view, '2D', { lensId: 'overview', selectedId: 'vessel:ais:1' }), {
    latitude: 10,
    longitude: -179,
    mode: '2D',
    zoom: 14,
    lensId: 'overview',
    select: 'vessel:ais:1',
  });
  assert.deepEqual(linkForView(view, '3D'), { latitude: 10, longitude: -179, mode: '3D', altitudeM: 3_000 });
});

test('view link: opening one flies there and turns its layers; unknown parts are said once', async () => {
  const h = await harness();
  const read = readViewLink('worldview://view?lat=19.42&lon=-155.29&z=9&hide=aviation&show=madeup');
  assert.ok(read.ok);
  await h.actions.openViewLink(read.link);
  assert.equal(h.flights.length, 1);
  assert.deepEqual(h.flights[0]!.position, { latitude: 19.42, longitude: -155.29 });
  assert.equal(h.flights[0]!.zoom, 9);
  assert.ok((h.flights[0]!.altitudeM ?? 0) > 0);
  assert.ok(h.get().session.settings?.hiddenLayers.includes('aviation'));
  const notes = h.get().ui.notifications.map((n) => n.body);
  assert.ok(
    notes.some((b) => /madeup/.test(b)),
    notes.join(' | '),
  );
});

test('view link: a link pasted into search is one result that opens it', async () => {
  const h = await harness();
  const [result] = await h.actions.search('worldview://view?lat=1&lon=2&z=5');
  assert.equal(result?.title, 'Open this link');
  await h.actions.goTo(result!);
  assert.deepEqual(h.flights[0]?.position, { latitude: 1, longitude: 2 });

  const [bad] = await h.actions.search('worldview://view?lat=100&lon=2');
  assert.equal(bad?.title, 'This link cannot be opened');
  await h.actions.goTo(bad!);
  assert.equal(h.flights.length, 1, 'a refused link flies nowhere');
});

test('view link: Copy a link to this view writes the link for what is on the map', async () => {
  const h = await harness();
  await h.actions.copyViewLink();
  const last = h.get().ui.notifications.at(-1);
  assert.equal(last?.title, 'Link to this view', 'the demo has no clipboard: the link is shown');
  assert.match(last?.body ?? '', /worldview:\/\/view\?lat=21\.30694&lon=-157\.85833&z=11\.25&mode=2d/);
});

test('view link: a pending link waits in the store until it is opened', async () => {
  const h = await harness();
  const read = readViewLink('worldview://view?lat=1&lon=2');
  assert.ok(read.ok);
  let s = rootReducer(h.get(), { type: 'ui/link', link: read.link });
  assert.deepEqual(s.ui.pendingLink, read.link);
  s = rootReducer(s, { type: 'ui/link', link: null });
  assert.equal(s.ui.pendingLink, null);
});
