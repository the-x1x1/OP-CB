import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHostProblem, readGuideProgress, readPrepRecord } from './command-center.js';

test('localHostProblem: one private or local-only host each; never the internet, loopback or metadata', () => {
  for (const ok of [
    '192.168.1.20',
    '10.0.0.5',
    '172.16.4.1',
    '172.31.255.254',
    '169.254.10.2',
    'fd12:3456::1',
    '[fe80::1]',
    'meshtastic.local',
    'ha.lan',
    'pi.home.arpa',
    'readsb',
    'Weatherlink.local.',
  ])
    assert.equal(localHostProblem(ok), undefined, ok);
  for (const bad of [
    '',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.1.1',
    '169.254.169.254',
    '127.0.0.1',
    'localhost',
    '::1',
    '2001:db8::1',
    'example.com',
    'evil.local.example.com',
    'http://192.168.1.2',
    '192.168.1.0/24',
    '300.1.1.1',
  ])
    assert.notEqual(localHostProblem(bad), undefined, bad);
});

const at = '2026-10-30T09:00:00.000Z';

test('readGuideProgress: a well-formed record survives; anything off is dropped', () => {
  const good = {
    id: 'meshtastic',
    guideVersion: 1,
    currentStepId: 'connect',
    steps: { intro: { outcome: 'done', at }, connect: { outcome: 'failed', at, evidence: 'no node answered' } },
    startedAt: at,
    updatedAt: at,
  };
  assert.deepEqual(readGuideProgress(good), good);
  assert.equal(readGuideProgress({ ...good, id: '../x' }), undefined);
  assert.equal(readGuideProgress({ ...good, steps: { intro: { outcome: 'passed', at } } }), undefined);
  assert.equal(readGuideProgress({ ...good, guideVersion: 0 }), undefined);
  assert.equal(readGuideProgress({ ...good, updatedAt: 'yesterday' }), undefined);
});

test('readPrepRecord: items, contacts and notes; bad dates, negative counts and unknown kinds refused', () => {
  const item = {
    id: 'water-1',
    kind: 'item',
    category: 'water',
    name: 'Bottled water',
    quantity: 24,
    unit: 'L',
    expires: '2027-06-01',
    updatedAt: at,
  };
  assert.deepEqual(readPrepRecord(item), item);
  assert.equal(readPrepRecord({ ...item, quantity: -1 }), undefined);
  assert.equal(readPrepRecord({ ...item, expires: '2027-13-45' }), undefined);
  assert.equal(readPrepRecord({ ...item, kind: 'weapon' }), undefined);
  assert.equal(readPrepRecord({ ...item, name: ' ' }), undefined);
  assert.equal(readPrepRecord({ ...item, category: 'misc' }), undefined);
  assert.ok(
    readPrepRecord({ id: 'c1', kind: 'contact', category: 'other', name: 'Neighbour', phone: '555', updatedAt: at }),
  );
});
