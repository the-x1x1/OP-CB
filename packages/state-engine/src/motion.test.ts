import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMotion } from './index.js';

test('motion: a heading is brought into 0–360 exactly, without float noise', () => {
  assert.equal(extractMotion({ headingDegrees: 114.8 })?.headingDegrees, 114.8, 'not 114.80000000000001');
  assert.equal(extractMotion({ headingDegrees: 359.9 })?.headingDegrees, 359.9);
  assert.equal(extractMotion({ headingDegrees: 360 })?.headingDegrees, 0);
  assert.equal(extractMotion({ headingDegrees: -90 })?.headingDegrees, 270);
  assert.equal(extractMotion({ headingDegrees: 725 })?.headingDegrees, 5);
  assert.ok(Object.is(extractMotion({ headingDegrees: -0 })?.headingDegrees, 0), 'never -0');
  assert.equal(extractMotion({ courseDegrees: 45 })?.headingDegrees, 45);
  assert.equal(extractMotion({ headingDegrees: Number.NaN }), undefined);
});
