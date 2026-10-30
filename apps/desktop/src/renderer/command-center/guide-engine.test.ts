import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuideDefinition } from './guide-types.js';
import {
  back,
  canAdvance,
  canSkip,
  choiceWords,
  completion,
  currentProgress,
  currentStep,
  next,
  recordCheck,
  recordChoice,
  skip,
  startGuide,
  stepLabel,
} from './guide-engine.js';

const DEF: GuideDefinition = {
  id: 'demo',
  version: 2,
  section: 'comms',
  title: 'Demo',
  summary: 's',
  whatItDoes: 'w',
  prerequisites: [],
  steps: [
    { id: 'intro', title: 'Intro', body: ['b'] },
    {
      id: 'pick',
      title: 'Pick',
      body: ['b'],
      choice: {
        prompt: 'p',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      byChoice: { a: ['words for a'] },
    },
    { id: 'connect', title: 'Connect', body: ['b'], check: 'mesh.nodeConnected' },
    { id: 'test', title: 'Test', body: ['b'], check: 'mesh.otherNodeHeard', final: true },
  ],
};

let t = Date.parse('2026-10-30T09:00:00.000Z');
const now = () => (t += 1000);

test('Next does not pass a check step: only a passed check does; a choice must be made', () => {
  let p = startGuide(DEF, now());
  assert.equal(stepLabel(DEF, p), 'Step 1 of 4');
  p = next(DEF, p, now());
  assert.equal(p.steps['intro']?.outcome, 'done');
  assert.equal(currentStep(DEF, p).id, 'pick');
  assert.equal(next(DEF, p, now()).currentStepId, 'pick', 'no choice yet');
  assert.equal(recordChoice(DEF, p, 'zzz', now()), p, 'an option not offered is ignored');
  p = recordChoice(DEF, p, 'a', now());
  assert.deepEqual(choiceWords(DEF.steps[1]!, p), ['words for a']);
  p = next(DEF, p, now());
  assert.equal(currentStep(DEF, p).id, 'connect');
  assert.equal(canAdvance(DEF.steps[2]!, p.steps['connect']), false);
  assert.equal(next(DEF, p, now()).currentStepId, 'connect', 'Next is closed until the check passes');
  p = recordCheck(DEF, p, { status: 'fail', message: 'not connected' }, now());
  assert.equal(p.steps['connect']?.outcome, 'failed');
  assert.equal(next(DEF, p, now()).currentStepId, 'connect');
  p = recordCheck(DEF, p, { status: 'pass', message: 'ok', evidence: '3 nodes' }, now());
  assert.deepEqual([p.steps['connect']?.outcome, p.steps['connect']?.evidence], ['verified', '3 nodes']);
  p = next(DEF, p, now());
  assert.equal(currentStep(DEF, p).id, 'test');
  assert.equal(completion(DEF, p), 'in-progress');
  assert.equal(canSkip(DEF.steps[3]!), false, 'the final test cannot be skipped');
  assert.equal(skip(DEF, p, now()), p);
  p = recordCheck(DEF, p, { status: 'pass', message: 'heard' }, now());
  p = next(DEF, p, now());
  assert.ok(p.completedAt);
  assert.equal(completion(DEF, p), 'verified');
});

test('a skipped check finishes the guide unverified; back keeps what was recorded', () => {
  let p = startGuide(DEF, now());
  p = next(DEF, p, now());
  p = next(DEF, recordChoice(DEF, p, 'b', now()), now());
  assert.equal(canSkip(DEF.steps[2]!), true);
  p = skip(DEF, p, now());
  assert.equal(p.steps['connect']?.outcome, 'skipped');
  p = back(DEF, p, now());
  assert.equal(p.currentStepId, 'connect');
  assert.equal(p.steps['connect']?.outcome, 'skipped');
  p = skip(DEF, p, now());
  p = next(DEF, recordCheck(DEF, p, { status: 'pass', message: 'heard' }, now()), now());
  assert.equal(completion(DEF, p), 'unverified');
});

test('progress against another version of the guide counts as not started', () => {
  const old = { ...startGuide(DEF, now()), guideVersion: 1 };
  assert.equal(currentProgress(DEF, old), undefined);
  assert.equal(completion(DEF, old), 'not-started');
  assert.equal(completion(DEF, undefined), 'not-started');
  assert.equal(currentProgress(DEF, { ...startGuide(DEF, now()), currentStepId: 'gone' }), undefined);
});
