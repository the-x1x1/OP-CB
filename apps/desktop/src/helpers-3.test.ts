import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNeeds, runCheck } from './renderer/command-center/checks.js';
import { stepIndex, stepVerified } from './renderer/command-center/guide-engine.js';
import { GUIDES, guideById, guidesFor } from './renderer/command-center/guides/index.js';
import { connectionFrom } from './renderer/demo/sources.js';
import { LAYER_GROUPS, buildLayerGroups } from './renderer/layer-tree.js';
import { packOrigin, savedEnabled, savedMessage } from './renderer/panels/sources-definitions-model.js';

test('the guides: each found by its id and under its section, with steps a reader can follow to the end', () => {
  assert.ok(GUIDES.length >= 5);
  assert.equal(new Set(GUIDES.map((g) => g.id)).size, GUIDES.length, 'no guide id twice');
  for (const guide of GUIDES) {
    assert.equal(guideById(guide.id), guide);
    assert.ok(guidesFor(guide.section).includes(guide), guide.id);
    assert.ok(Number.isInteger(guide.version) && guide.version >= 1, guide.id);
    assert.ok(guide.title.trim() && guide.summary.trim() && guide.whatItDoes.trim(), guide.id);
    assert.ok(guide.steps.length > 0, guide.id);
    const ids = guide.steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${guide.id}: no step id twice`);
    guide.steps.forEach((step, i) => {
      const where = `${guide.id}/${step.id}`;
      assert.equal(stepIndex(guide, step.id), i, where);
      assert.ok(step.title.trim(), where);
      assert.ok(step.body.length > 0 && step.body.every((p) => p.trim()), `${where}: says something`);
      // Words keyed by a choice must name a choice some step offers, at or before this one.
      if (step.byChoice) {
        const from = guide.steps.find((s) => s.id === (step.choiceFrom ?? step.id));
        assert.ok(from?.choice, `${where}: byChoice reads a step with a choice`);
        assert.ok(stepIndex(guide, from.id) <= i, `${where}: the choice comes first`);
        const offered = new Set(from.choice.options.map((o) => o.id));
        for (const key of Object.keys(step.byChoice))
          assert.ok(offered.has(key), `${where}: "${key}" is not an option of ${from.id}`);
      }
      if (step.choice) {
        const options = step.choice.options.map((o) => o.id);
        assert.ok(
          options.length >= 2 && new Set(options).size === options.length,
          `${where}: at least two different options`,
        );
      }
      // Every link is https: the shell opens nothing else.
      for (const link of step.links ?? [])
        assert.match((link as { url: string }).url, /^https:\/\/[a-z0-9.-]+(\/|$)/i, where);
      if (step.final) assert.ok(step.check, `${where}: the final test is a check`);
      if (step.check) assert.equal(typeof checkNeeds(step.check), 'object', where);
    });
    assert.equal(stepIndex(guide, 'no-such-step'), -1);
  }
  assert.equal(guideById('no-such-guide'), undefined);
  assert.equal(guideById('constructor'), undefined);
  assert.deepEqual(guidesFor('no-such-section' as Parameters<typeof guidesFor>[0]), []);
});

test('every check a guide names runs on an empty world and fails with words, never passes and never throws', () => {
  const checks = new Set(GUIDES.flatMap((g) => g.steps.flatMap((s) => (s.check ? [s.check] : []))));
  assert.ok(checks.size >= 10, `${checks.size} checks`);
  // What the shell has before anything was fetched, set up or tried.
  const empty: Parameters<typeof runCheck>[1] = {
    nowMs: Date.parse('2026-11-19T10:00:00Z'),
    mode: null,
    offline: null,
    sources: [],
    services: null,
    aiModel: undefined,
    prep: [],
  };
  for (const id of checks) {
    let result: ReturnType<typeof runCheck> | undefined;
    assert.doesNotThrow(() => (result = runCheck(id, empty)), id);
    assert.ok(result, id);
    assert.notEqual(result.status, 'pass', `${id} passes with nothing to see`);
    assert.ok(typeof result.message === 'string' && result.message.trim().length > 0, `${id}: says why`);
  }
});

test('stepVerified: only a verified record of the guide as it is now', () => {
  const guide = GUIDES.find((g) => g.steps.some((s) => s.check))!;
  const step = guide.steps.find((s) => s.check)!;
  const record = { outcome: 'verified', at: '2026-11-19T10:00:00.000Z' };
  const progress = (version: number, steps: Record<string, unknown>) =>
    ({
      id: guide.id,
      guideVersion: version,
      currentStepId: step.id,
      steps,
      startedAt: record.at,
      updatedAt: record.at,
    }) as unknown as Parameters<typeof stepVerified>[1];
  assert.equal(stepVerified(guide, undefined, step.id), undefined);
  assert.deepEqual(stepVerified(guide, progress(guide.version, { [step.id]: record }), step.id), record);
  assert.equal(
    stepVerified(guide, progress(guide.version, { [step.id]: { ...record, outcome: 'failed' } }), step.id),
    undefined,
  );
  assert.equal(stepVerified(guide, progress(guide.version, {}), step.id), undefined);
  assert.equal(
    stepVerified(guide, progress(guide.version + 1, { [step.id]: record }), step.id),
    undefined,
    'progress from another version of the guide does not count',
  );
  assert.equal(stepVerified(guide, progress(guide.version, { [step.id]: record }), 'constructor'), undefined);
});

test('connectionFrom: connected, degraded or offline from the remote sources that are on', () => {
  type Entry = Parameters<typeof connectionFrom>[0][number];
  const entry = (locality: string, status: string, enabled = true) =>
    ({ enabled, locality, health: { status } }) as unknown as Entry;
  const now = Date.parse('2026-11-19T10:00:00Z');
  const state = (entries: Entry[], online = true) => connectionFrom(entries, now, online);
  assert.deepEqual(state([]), {
    state: 'CONNECTED',
    networkOnline: true,
    remoteLive: 0,
    remoteTotal: 0,
    localLive: 0,
    at: '2026-11-19T10:00:00.000Z',
  });
  assert.equal(state([entry('remote', 'LIVE'), entry('remote', 'STALE')]).state, 'CONNECTED');
  assert.equal(state([entry('remote', 'LIVE'), entry('remote', 'ERROR')]).state, 'DEGRADED');
  assert.equal(state([entry('remote', 'ERROR'), entry('remote', 'OFFLINE')]).state, 'OFFLINE');
  assert.equal(
    state([entry('remote', 'LIVE')], false).state,
    'OFFLINE',
    'no network is offline whatever the sources last said',
  );
  const mixed = state([
    entry('remote', 'RATE_LIMITED'),
    entry('remote', 'ERROR', false),
    entry('local', 'LIVE'),
    entry('local', 'ERROR'),
    entry('local', 'DEGRADED', false),
  ]);
  assert.deepEqual(
    [mixed.state, mixed.remoteLive, mixed.remoteTotal, mixed.localLive],
    ['CONNECTED', 1, 1, 1],
    'a source switched off is not counted',
  );
  assert.equal(
    state([entry('local', 'ERROR')]).state,
    'CONNECTED',
    'local sources failing is not the connection failing',
  );
});

test('definition files: where a pack’s came from, and what saving one says', () => {
  type Pack = Parameters<typeof packOrigin>[0];
  assert.equal(
    packOrigin({ name: 'Hawaii', trusted: false, publisher: 'Someone' } as Pack),
    'From pack Hawaii · not signed by one of your publishers',
  );
  assert.equal(
    packOrigin({ name: 'Hawaii', trusted: true, publisher: 'Island Maps' } as Pack),
    'From pack Hawaii · signed by Island Maps',
  );
  assert.equal(
    packOrigin({ name: 'Hawaii', trusted: true } as Pack),
    'From pack Hawaii · signed by a trusted publisher',
  );

  type Listing = Parameters<typeof savedEnabled>[1];
  const listing = {
    files: [{ file: 'on.json', enabled: true }, { file: 'off.json', enabled: false }, { file: 'unset.json' }],
  } as unknown as Listing;
  assert.equal(savedEnabled('on.json', listing), true);
  assert.equal(savedEnabled('off.json', listing), false);
  assert.equal(savedEnabled('unset.json', listing), false);
  assert.equal(savedEnabled('missing.json', listing), false);
  assert.match(savedMessage('on.json', listing), /^Saved on\.json\. It is ON/);
  assert.match(savedMessage('off.json', listing), /^Saved off\.json\. It is disabled until you switch it on\.$/);
});

test('layer groups: one switch and one name per type wherever it is listed', () => {
  assert.deepEqual(buildLayerGroups(), [...LAYER_GROUPS]);
  assert.equal(new Set(LAYER_GROUPS.map((g) => g.id)).size, LAYER_GROUPS.length, 'no category id twice');
  // A type may sit under more than one category (an airport under aviation and under places):
  // wherever it does, it is the same switch with the same name.
  const byType = new Map<string, { id: string; name: string }>();
  for (const layer of LAYER_GROUPS.flatMap((g) => g.layers)) {
    const first = byType.get(layer.objectType) ?? { id: layer.id, name: layer.name };
    byType.set(layer.objectType, first);
    assert.deepEqual({ id: layer.id, name: layer.name }, first, layer.objectType);
  }
  const typeIds = [...byType.values()].map((v) => v.id);
  assert.equal(new Set(typeIds).size, typeIds.length, 'two types never share a switch');
  const categoryIds = new Set(LAYER_GROUPS.map((g) => g.id));
  assert.ok(
    typeIds.every((id) => !categoryIds.has(id)),
    'a type and a category never share a switch',
  );
  for (const group of LAYER_GROUPS) {
    assert.ok(group.name.trim(), group.id);
    for (const layer of group.layers)
      assert.ok(layer.name.trim() && /^[A-Z]/.test(layer.name), `${layer.objectType} -> "${layer.name}"`);
  }
  const custom = buildLayerGroups([
    { id: 'cat:x', name: 'X', objectTypes: ['brand-new-type', 'constructor'] },
  ] as unknown as Parameters<typeof buildLayerGroups>[0]);
  assert.deepEqual(
    custom[0]!.layers.map((l) => [l.name, l.children]),
    [
      ['Brand new type', []],
      ['Constructor', []],
    ],
    'a type with no name of its own is named from its id',
  );
});
