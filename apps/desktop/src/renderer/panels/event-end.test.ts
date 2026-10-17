import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endRow } from './event-end.js';

test('an event end: ended once past; a future end from freshness alone is "kept until"', () => {
  const now = Date.parse('2026-10-17T04:00:00Z');
  assert.deepEqual(endRow({}, now), { label: 'Ended', value: undefined });
  assert.equal(endRow({ endAt: '2026-10-17T03:00:00Z' }, now).label, 'Ended');
  assert.equal(endRow({ endAt: '2026-10-17T06:00:00Z' }, now).label, 'Ends');
  const kept = endRow({ endAt: '2026-10-18T04:02:51Z', properties: { endFromFreshness: true } }, now);
  assert.equal(kept.label, 'Kept until');
  assert.match(kept.value ?? '', /\(unless read again\)$/);
  assert.equal(
    endRow({ endAt: '2026-10-17T03:00:00Z', properties: { endFromFreshness: true } }, now).label,
    'Ended',
    'withdrawn or stale: past is past',
  );
});
