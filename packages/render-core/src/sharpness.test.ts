import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharpnessGovernor, graphicsProfile, maxSharpnessStep, sharperProfile } from './graphics.js';

const balanced = graphicsProfile('balanced');
let clock = 0;
const w = (fpsAvg: number, fpsMin: number, drawn = 500) => ({ fpsAvg, fpsMin, drawn, atMs: (clock += 10_000) });
const good = () => w(59.5, 55);
const idle = () => w(60, 60, 8);

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

test('a resting globe is no evidence: the loop ticks at 60 whatever a frame costs', () => {
  const g = new SharpnessGovernor(balanced, 2);
  for (let i = 0; i < 40; i++) assert.equal(g.sample(idle()), false);
  assert.equal(g.step, 0);
  // Resting between good windows neither builds nor breaks the run.
  g.sample(good());
  g.sample(idle());
  g.sample(good());
  g.sample(idle());
  assert.equal(g.sample(good()), true, 'three good drawing windows, rests between them');
});

test('down at once on a slow average; one deep dip is a fly-to, two in a row are not', () => {
  const g = new SharpnessGovernor(balanced, 2);
  g.sample(good()); // settle
  g.sample(good());
  g.sample(good());
  assert.equal(g.sample(good()), true);
  assert.equal(g.step, 1);
  g.sample(good()); // settle
  assert.equal(g.sample(w(57, 22)), false, 'one dip: kept');
  assert.equal(g.sample(w(57, 24)), true, 'a second in a row: back down');
  assert.equal(g.step, 0);
  g.sample(good()); // settle
  for (let i = 0; i < 5; i++) assert.equal(g.sample(good()), false, 'one failure: six good windows needed');
  assert.equal(g.sample(good()), true);
  g.sample(good()); // settle
  assert.equal(g.sample(w(41, 18)), true, 'a slow average: down at once');
  g.sample(good()); // settle
  for (let i = 0; i < 30; i++) g.sample(good());
  assert.equal(g.step, 0, 'failed twice in ten minutes: waits');
  for (let i = 0; i < 40; i++) g.sample(good());
  assert.equal(g.step > 0, true, 'failures forgotten after ten minutes: tried again');
});

test('the presentation governor stepping down takes every step back; a mode change resets', () => {
  const g = new SharpnessGovernor(balanced, 2);
  for (let i = 0; i < 20; i++) g.sample(good());
  assert.ok(g.step >= 2);
  assert.equal(g.yieldAll(clock), true);
  assert.equal(g.step, 0);
  assert.equal(g.yieldAll(clock), false);
  for (let i = 0; i < 20; i++) g.sample(good());
  assert.ok(g.step >= 1);
  assert.equal(g.resetRuns(), true);
  assert.equal(g.step, 0);
});

test('the sharpness governor climbs no higher than changes anything', () => {
  const g = new SharpnessGovernor(balanced, 1.25);
  for (let i = 0; i < 40; i++) g.sample(good());
  assert.equal(g.step, maxSharpnessStep(balanced, 1.25));
  assert.equal(g.profile().maximumScreenSpaceError, 2);
  assert.equal(g.profile().maxPixelRatio, 1.25);
});
