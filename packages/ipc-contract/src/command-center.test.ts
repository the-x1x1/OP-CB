import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localHostProblem,
  normaliseLocalHost,
  readGuideProgress,
  readLibraryDownloadRequest,
  readLibraryOpenRequest,
  readPrepRecord,
} from './command-center.js';

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

test('localHostProblem: an address the network stack would read as another one is refused', () => {
  // 010.1.2.3 is 8.1.2.3 in octal, and a bare number is an address: 134744072 is 8.8.8.8.
  for (const bad of ['010.1.2.3', '10.01.2.3', '192.168.001.1', '134744072', '167772161', '0x0a000001', '0x', '10'])
    assert.notEqual(localHostProblem(bad), undefined, bad);
  for (const ok of ['10.0.0.1', '10.10.0.100', 'pi4', 'nas01', 'x10'])
    assert.equal(localHostProblem(ok), undefined, ok);
});

test('normaliseLocalHost: lower case, no brackets or trailing dot, and an IPv6 address in the form a URL has it', () => {
  assert.equal(normaliseLocalHost('  Weatherlink.LOCAL. '), 'weatherlink.local');
  assert.equal(normaliseLocalHost('192.168.1.20'), '192.168.1.20');
  assert.equal(normaliseLocalHost('[FE80::1]'), 'fe80::1');
  for (const spelling of ['fd00::1', 'FD00:0:0:0:0:0:0:1', 'fd00:0000:0000:0000:0000:0000:0000:0001', '[fd00::0001]'])
    assert.equal(normaliseLocalHost(spelling), new URL(`http://[fd00::1]/`).hostname.replace(/^\[|\]$/g, ''), spelling);
  // An IPv4 address is never rewritten: what was checked is what is compared.
  assert.equal(normaliseLocalHost('010.1.2.3'), '010.1.2.3');
  assert.equal(normaliseLocalHost('not:an:address:zz'), 'not:an:address:zz');
  assert.equal(normaliseLocalHost(''), '');
});

test('readLibraryOpenRequest and readLibraryDownloadRequest: only the shapes asked for', () => {
  const bookId = 'a'.repeat(32);
  assert.deepEqual(readLibraryOpenRequest({ kind: 'folder' }), { kind: 'folder' });
  assert.deepEqual(readLibraryOpenRequest({ kind: 'reference', id: 'first-aid' }), {
    kind: 'reference',
    id: 'first-aid',
  });
  assert.deepEqual(readLibraryOpenRequest({ kind: 'book', bookId }), { kind: 'book', bookId });
  assert.deepEqual(readLibraryOpenRequest({ kind: 'book', bookId, key: 'A/Page' }), {
    kind: 'book',
    bookId,
    key: 'A/Page',
  });
  for (const bad of [
    null,
    'folder',
    {},
    { kind: 'folder', path: 'C:\\' },
    { kind: 'reference' },
    { kind: 'reference', id: '../etc' },
    { kind: 'reference', id: 'first-aid\n' },
    { kind: 'reference', id: 'a', extra: 1 },
    { kind: 'book', bookId: 'short' },
    { kind: 'book', bookId: 'A'.repeat(32) },
    { kind: 'book', bookId, key: 5 },
    { kind: 'book', bookId, key: 'a\0b' },
    { kind: 'book', bookId, key: 'k'.repeat(2001) },
    { kind: 'book', bookId, path: 'x' },
    { kind: 'other' },
  ])
    assert.equal(readLibraryOpenRequest(bad), undefined, JSON.stringify(bad));

  assert.deepEqual(readLibraryDownloadRequest({ kind: 'references' }), { kind: 'references' });
  assert.deepEqual(readLibraryDownloadRequest({ kind: 'references', ids: ['a', 'b-2'] }), {
    kind: 'references',
    ids: ['a', 'b-2'],
  });
  const entry = { id: 'wikipedia_en', name: 'wikipedia', title: 'Wikipedia', url: 'https://download.kiwix.org/x.zim' };
  const zim = readLibraryDownloadRequest({ kind: 'zim', entry: { ...entry, sizeBytes: 10, extra: 'dropped' } });
  assert.ok(zim && zim.kind === 'zim');
  assert.equal('extra' in (zim.kind === 'zim' ? zim.entry : {}), false);
  for (const bad of [
    null,
    {},
    { kind: 'references', ids: 'a' },
    { kind: 'references', ids: ['A'] },
    { kind: 'references', ids: Array.from({ length: 51 }, () => 'a') },
    { kind: 'zim' },
    { kind: 'zim', entry: null },
    { kind: 'zim', entry: { ...entry, id: '' } },
    { kind: 'zim', entry: { ...entry, url: 5 } },
    { kind: 'zim', entry: { ...entry, sizeBytes: -1 } },
    { kind: 'zim', entry: { ...entry, sizeBytes: 1.5 } },
    { kind: 'zim', entry: { ...entry, title: 't'.repeat(301) } },
  ])
    assert.equal(readLibraryDownloadRequest(bad), undefined, JSON.stringify(bad));
});
