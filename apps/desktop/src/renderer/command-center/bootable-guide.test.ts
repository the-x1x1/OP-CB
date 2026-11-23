import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOTABLE_GUIDE } from './guides/bootable.js';
import { GUIDES, guidesFor } from './guides/index.js';
import {
  canAdvance,
  choiceWords,
  completion,
  currentStep,
  next,
  recordCheck,
  recordChoice,
  skip,
  startGuide,
} from './guide-engine.js';

let t = Date.parse('2026-11-22T00:00:00.000Z');
const now = () => (t += 1000);

test('bootable drive guide: listed under Resources, well formed', () => {
  assert.ok(GUIDES.includes(BOOTABLE_GUIDE));
  assert.deepEqual(
    guidesFor('resources').map((g) => g.id),
    ['bootable-drive'],
  );
  const ids = BOOTABLE_GUIDE.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(BOOTABLE_GUIDE.steps.filter((s) => s.final).length, 1);
  assert.equal(BOOTABLE_GUIDE.steps.at(-1)!.final, true);
  const choiceStep = BOOTABLE_GUIDE.steps.find((s) => s.choice)!;
  const options = new Set(choiceStep.choice!.options.map((o) => o.id));
  for (const s of BOOTABLE_GUIDE.steps) {
    assert.ok(s.body.length > 0 && s.title.trim(), s.id);
    if (s.choiceFrom) assert.ok(BOOTABLE_GUIDE.steps.find((x) => x.id === s.choiceFrom)?.choice, s.id);
    for (const k of Object.keys(s.byChoice ?? {})) assert.ok(options.has(k), `${s.id}: ${k}`);
    for (const l of s.links ?? []) assert.match(l.url, /^https:\/\/[a-z0-9.-]+\//, l.url);
    for (const line of [...s.body, ...Object.values(s.byChoice ?? {}).flat()])
      assert.doesNotMatch(line, /WorldView|TODO|lorem/i, s.id);
  }
});

test('bootable drive guide: walked through on Windows; only a book in the library on the drive passes the final test', () => {
  const def = BOOTABLE_GUIDE;
  let p = startGuide(def, now());
  p = next(def, p, now());
  assert.equal(currentStep(def, p).id, 'which', 'a choice must be made first');
  p = recordChoice(def, p, 'windows', now());
  p = next(def, p, now());
  const ventoy = currentStep(def, p);
  assert.equal(ventoy.id, 'ventoy');
  assert.match(choiceWords(ventoy, p).join(' '), /Ventoy2Disk\.exe/);
  for (const id of ['ubuntu', 'persistence', 'boot']) {
    p = next(def, p, now());
    assert.equal(currentStep(def, p).id, id);
  }
  p = next(def, p, now());
  assert.equal(currentStep(def, p).id, 'data');
  p = next(def, p, now());
  assert.equal(currentStep(def, p).id, 'test');
  // The final test is not passed by Next, and cannot be skipped.
  assert.equal(canAdvance(currentStep(def, p), p.steps['test']), false);
  assert.equal(next(def, p, now()), p);
  assert.equal(skip(def, p, now()), p);
  const failed = recordCheck(def, p, { status: 'fail', message: 'no books' }, now());
  assert.equal(next(def, failed, now()), failed);
  // With a book in the library on the drive, verified.
  const passed = recordCheck(def, p, { status: 'pass', message: 'a book' }, now());
  assert.equal(completion(def, next(def, passed, now())), 'verified');
});
