import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeNotification, NOTIFICATION_MERGE_MS } from './reducer.js';
import type { Notification } from './types.js';

const entry = (callsign: string, at: number, group = 'zone:wz-fra'): Notification => ({
  id: `n-${callsign}`,
  title: `Zone near 50.04, 8.56: aircraft ${callsign} entered`,
  body: `Aircraft ${callsign} entered watch zone "Zone near 50.04, 8.56".`,
  severity: 'MINOR',
  at,
  group,
});

test('notifications from one zone close together are one toast', () => {
  let list = mergeNotification([], entry('SX52KZ', 0));
  list = mergeNotification(list, entry('RYR631K', 1_000));
  list = mergeNotification(list, entry('DLH7VT', 2_000));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.title, 'Zone near 50.04, 8.56: 3 new');
  assert.equal(list[0]!.body, 'aircraft DLH7VT entered; aircraft RYR631K entered; aircraft SX52KZ entered');
  assert.equal(list[0]!.id, 'n-SX52KZ', 'the toast on screen is updated, not replaced');
  list = mergeNotification(list, entry('AUA21V', 3_000));
  assert.match(list[0]!.body, /; and 1 more$/);
  // Later, or another zone, or no group: a toast of its own.
  assert.equal(mergeNotification(list, entry('LATE1', 3_000 + NOTIFICATION_MERGE_MS)).length, 2);
  assert.equal(mergeNotification(list, entry('OTHER', 4_000, 'zone:wz-lhr')).length, 2);
  const plain: Notification = { id: 'x', title: 'Settings not saved', body: '', severity: 'MINOR', at: 4_000 };
  assert.equal(mergeNotification(list, plain).length, 2);
});

test('a toast from before the clock was put back is not one to fold into', () => {
  // The toast was raised at a time the clock has since gone back from: every new entry of the
  // zone was folded into it while it was on screen, however far apart.
  const before = mergeNotification([], entry('SX52KZ', 10 * 3_600_000));
  assert.equal(mergeNotification(before, entry('RYR631K', 1_000)).length, 2);
});
