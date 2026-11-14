import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beaufort, windFrom } from './sections.js';

test('wind: where it blows from, in m/s and knots, the way a forecast says it', () => {
  assert.equal(windFrom(6.9, 75), '6.9 m/s (13 kn) from ENE (075°)');
  assert.equal(windFrom(12, 359.9), '12.0 m/s (23 kn) from N (000°)');
  assert.equal(windFrom(0.3, 90), 'Calm');
  assert.equal(windFrom(4, undefined), 'Calm', 'no direction: a calm');
  assert.equal(windFrom(undefined, 90), undefined);
});

test('wind: the Beaufort force by the WMO bounds', () => {
  assert.deepEqual(beaufort(0.2), { force: 0, name: 'Calm' });
  assert.deepEqual(beaufort(5.5), { force: 4, name: 'Moderate breeze' }, 'a bound belongs to the force above');
  assert.deepEqual(beaufort(17.2), { force: 8, name: 'Gale' });
  assert.deepEqual(beaufort(40), { force: 12, name: 'Hurricane force' });
});
