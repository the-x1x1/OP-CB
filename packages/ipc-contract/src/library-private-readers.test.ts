import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COLLECTION_ENTRIES, readLibraryDownloadRequest } from './command-center.js';
import { readCollectionLookupRequest } from './library-collection.js';
import { readPassphraseChange, readPassphraseRequest, readPrivateId } from './private-folder.js';

/*
 * The request readers added for the starter collection and the private folder, against
 * generated hostile payloads: each answers a value of the right shape or undefined, never
 * throws, never passes an extra key through, and never reads inherited members.
 */

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

const ATOMS: unknown[] = [
  undefined,
  null,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  2 ** 53,
  '',
  ' ',
  'eng',
  'EN',
  'a'.repeat(1025),
  'a'.repeat(32),
  '0'.repeat(32),
  'g'.repeat(32),
  '../x',
  '\u0000',
  true,
  [],
  {},
  Object.create(null),
  'constructor',
  '__proto__',
  'https://lb.download.kiwix.org/zim/other/x_2024-01.zim',
];

function value(depth: number): unknown {
  if (depth <= 0 || rnd() < 0.5) return pick(ATOMS);
  if (rnd() < 0.3) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth - 1));
  const o: Record<string, unknown> = {};
  const keys = [
    'kind',
    'entries',
    'entry',
    'ids',
    'language',
    'passphrase',
    'current',
    'next',
    'id',
    'url',
    'name',
    'title',
    'sizeBytes',
    'extra',
    '__proto__',
    'constructor',
  ];
  for (let i = Math.floor(rnd() * 5); i > 0; i--) o[pick(keys)] = value(depth - 1);
  if (rnd() < 0.4) o['kind'] = pick(['zim', 'references', 'collection', 'Collection', '']);
  return o;
}

test('readers: 20,000 generated payloads each — no throw, right shape or undefined', () => {
  for (let i = 0; i < 20_000; i++) {
    const v = value(4);
    const d = readLibraryDownloadRequest(v);
    if (d?.kind === 'collection') {
      assert.ok(d.entries.length >= 1 && d.entries.length <= MAX_COLLECTION_ENTRIES);
      for (const e of d.entries) {
        assert.deepEqual(
          Object.keys(e).filter((k) => !['id', 'name', 'title', 'url', 'sizeBytes'].includes(k)),
          [],
        );
        assert.ok(typeof e.url === 'string' && e.url.length <= 1000);
      }
      assert.equal(new Set(d.entries.map((e) => e.url)).size, d.entries.length);
    }
    const l = readCollectionLookupRequest(v);
    if (l) assert.ok(l.language === undefined || /^[a-z]{3}$/.test(l.language));
    const p = readPassphraseRequest(v);
    if (p) {
      assert.deepEqual(Object.keys(p), ['passphrase']);
      assert.ok(p.passphrase.length >= 1 && p.passphrase.length <= 1024);
    }
    const c = readPassphraseChange(v);
    if (c) assert.deepEqual(Object.keys(c).sort(), ['current', 'next']);
    const id = readPrivateId(v);
    if (id) assert.match(id.id, /^[0-9a-f]{32}$/);
  }
});

test('readers: inherited members are not read', () => {
  const proto = { passphrase: 'inherited passphrase', id: 'a'.repeat(32), language: 'eng', current: 'x', next: 'y' };
  const o = Object.create(proto) as object;
  assert.equal(readPassphraseRequest(o), undefined);
  assert.equal(readPrivateId(o), undefined);
  assert.equal(readPassphraseChange(o), undefined);
  // No own keys at all: the lookup takes its default, not the inherited language.
  assert.deepEqual(readCollectionLookupRequest(o), {});
  assert.equal(readLibraryDownloadRequest(Object.create({ kind: 'collection', entries: [] })), undefined);
});
