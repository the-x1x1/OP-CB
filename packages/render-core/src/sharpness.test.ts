import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharpnessGovernor, graphicsProfile, maxSharpnessStep, sharperProfile } from './graphics.js';

const balanced = graphicsProfile('balanced');
const good = { fpsAvg: 59.5, fpsMin: 55 };
const bad = { fpsAvg: 41, fpsMin: 18 };

test('sharper profiles: a quarter pixel and half a pixel of error a step, to the display and to 2', () => {
  assert.equal(sharperProfile(balanced, 0, 2), balanced);
  const one = sharperProfile(balanced, 1, 2);
  assert.equal(one.maxPixelRatio, 1.5);
  assert.equal(one.maximumScreenSpaceError, 2.5);
  assert.equal(one.msaaSamples, balanced.msaaSamples, 'MSAA is never changed');
  const top = sharperProfile(balanced, 9, 2);
  assert.equal(top.maxPixelRatio, 2);
  assert.equal(top.maximumScreenSpaceError, 2);
  assert.equal(maxSharpnessStep(balanced, 2), 3, '1.25 → 2 in three steps');
  assert.equal(maxSharpnessStep(balanced, 1), 2, 'a 1× display: only the tile error to sharpen');
  assert.equal(sharperProfile(balanced, 5, 1).maxPixelRatio, 1.25, 'never below the profile');
  assert.equal(maxSharpnessStep(graphicsProfile('high'), 2), 0);
});

test('the sharpness governor: up after three good windows, down at once, a twice-failed step not retried', () => {
  const g = new SharpnessGovernor(balanced, 2);
  assert.equal(g.sample(good), false, 'the first window settles');
  assert.equal(g.sample(good), false);
  assert.equal(g.sample(good), false);
  assert.equal(g.sample(good), true, 'three good windows: one step up');
  assert.equal(g.step, 1);
  assert.equal(g.profile().maxPixelRatio, 1.5);
  assert.equal(g.sample(bad), false, 'the window after a change is not judged');
  assert.equal(g.sample(bad), true, 'then a bad one: straight back down');
  assert.equal(g.step, 0);
  g.sample(good); // settle
  for (let i = 0; i < 5; i++) assert.equal(g.sample(good), false, 'one failure: six good windows needed');
  assert.equal(g.sample(good), true);
  g.sample(good); // settle
  assert.equal(g.sample(bad), true, 'failed a second time');
  g.sample(good); // settle
  for (let i = 0; i < 30; i++) assert.equal(g.sample(good), false, 'not tried a third time');
  assert.equal(g.step, 0);
});

test('the sharpness governor climbs no higher than changes anything', () => {
  const g = new SharpnessGovernor(balanced, 1.25);
  for (let i = 0; i < 40; i++) g.sample(good);
  assert.equal(g.step, maxSharpnessStep(balanced, 1.25));
  assert.equal(g.profile().maximumScreenSpaceError, 2);
  assert.equal(g.profile().maxPixelRatio, 1.25);
});
