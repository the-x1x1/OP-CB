import { test } from 'node:test';
import assert from 'node:assert/strict';
import { someOf } from './some-of.js';

test('someOf: the first few, and how many more', () => {
  assert.equal(someOf(['a', 'b'], 3), 'a; b');
  assert.equal(someOf(['a', 'b', 'c'], 3), 'a; b; c');
  assert.equal(someOf(['a', 'b', 'c', 'd', 'e'], 3), 'a; b; c; and 2 more');
  assert.equal(someOf(['x', 'y'], 1, ' — '), 'x — and 1 more');
  assert.equal(someOf([], 2), '');
});
