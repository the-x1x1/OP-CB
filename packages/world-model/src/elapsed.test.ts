import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedMs } from './time.js';

test('elapsedMs: time since a moment, and a moment ahead of the clock counts as long ago', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(elapsedMs(now, now - 30_000), 30_000);
  assert.equal(elapsedMs(now, now), 0);
  assert.equal(elapsedMs(now, 0), now);
  // Written by a clock three hours fast, read by the corrected one: every "wait at least"
  // is over and every "keep at most" has run out.
  const ahead = elapsedMs(now, now + 3 * 3_600_000);
  assert.ok(ahead >= 30_000 && ahead > 365 * 86_400_000);
  assert.equal(elapsedMs(now, now + 1) < 1000, false, 'even a millisecond ahead is not "a moment ago"');
  assert.ok(!Number.isNaN(elapsedMs(now, Number.POSITIVE_INFINITY)));
});
