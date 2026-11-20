import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileProviderCache } from './provider-storage.js';

async function cacheAt(now = { ms: Date.parse('2026-11-19T00:00:00.000Z') }, enabled = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-cache-'));
  const file = path.join(dir, 'cache', 'p.json');
  const clock = { now: () => now.ms };
  return { file, now, open: () => new FileProviderCache(file, clock, enabled) };
}

test('the provider cache: set, get, delete, and a second instance reads what the first wrote', async () => {
  const { file, open } = await cacheAt();
  const cache = open();
  assert.equal(await cache.get('k'), undefined);
  await cache.set('k', { a: [1, 2] });
  assert.deepEqual(await cache.get('k'), { value: { a: [1, 2] }, storedAt: '2026-11-19T00:00:00.000Z' });
  await cache.set('zero', 0);
  await cache.set('nothing', null);
  const again = open();
  assert.deepEqual((await again.get('k'))!.value, { a: [1, 2] });
  assert.equal((await again.get('zero'))!.value, 0);
  assert.equal((await again.get('nothing'))!.value, null);
  await again.delete('k');
  assert.equal(await again.get('k'), undefined);
  assert.equal(await open().get('k'), undefined);
  await again.delete('never-there');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1);
});

test('the provider cache: an entry past its time is gone; one with no time stays', async () => {
  const { now, open } = await cacheAt();
  const cache = open();
  await cache.set('short', 1, 1000);
  await cache.set('kept', 2);
  now.ms += 1000;
  assert.equal((await cache.get('short'))!.value, 1, 'still there at exactly its time');
  now.ms += 1;
  assert.equal(await cache.get('short'), undefined);
  now.ms += 365 * 86_400_000;
  assert.equal((await cache.get('kept'))!.value, 2);
});

test('the provider cache: a key named like something every object has is a key like any other', async () => {
  const { open } = await cacheAt();
  const cache = open();
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(await cache.get(key), undefined, `${key} before it is set`);
    await cache.set(key, `value of ${key}`);
    assert.equal((await cache.get(key))!.value, `value of ${key}`, key);
    assert.equal((await open().get(key))!.value, `value of ${key}`, `${key} from the file`);
    await cache.delete(key);
    assert.equal(await cache.get(key), undefined, `${key} after it is deleted`);
  }
});

test('the provider cache: keeps the newest 256 entries', async () => {
  const { now, open } = await cacheAt();
  const cache = open();
  for (let i = 0; i < 260; i++) {
    now.ms += 1000;
    await cache.set(`k${i}`, i);
  }
  for (const gone of [0, 1, 2, 3]) assert.equal(await cache.get(`k${gone}`), undefined);
  assert.equal((await cache.get('k4'))!.value, 4);
  assert.equal((await cache.get('k259'))!.value, 259);
});

test('the provider cache: a file that is not a cache, or holds things that are not entries, reads as empty there', async () => {
  const { file, open } = await cacheAt();
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const body of [
    'not json',
    '[]',
    'null',
    '{"version":1}',
    '{"version":1,"entries":[1,2]}',
    '{"version":1,"entries":"x"}',
  ]) {
    await fs.writeFile(file, body);
    assert.equal(await open().get('k'), undefined, body);
  }
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      entries: {
        good: { value: 1, storedAt: '2026-11-18T00:00:00.000Z' },
        text: 'not an entry',
        noTime: { value: 2 },
        badExpiry: { value: 3, storedAt: '2026-11-18T00:00:00.000Z', expiresAt: 'soon' },
        none: null,
      },
    }),
  );
  const cache = open();
  assert.equal((await cache.get('good'))!.value, 1);
  for (const key of ['text', 'noTime', 'badExpiry', 'none']) assert.equal(await cache.get(key), undefined, key);
  // And it can still be written to.
  await cache.set('new', 5);
  assert.equal((await open().get('new'))!.value, 5);
});

test('the provider cache: switched off, it stores and returns nothing and writes no file', async () => {
  const { file, open } = await cacheAt(undefined, false);
  const cache = open();
  await cache.set('k', 1);
  assert.equal(await cache.get('k'), undefined);
  await cache.delete('k');
  await assert.rejects(fs.stat(file));
});

test('the provider cache: an entry with a life, kept while the clock read ahead, has run out once the clock is put right', async () => {
  const start = Date.parse('2026-11-19T00:00:00.000Z');
  const { now, open } = await cacheAt({ ms: start + 365 * 86_400_000 });
  const cache = open();
  await cache.set('hour', 'h', 3_600_000);
  await cache.set('kept', 'k');
  now.ms = start;
  assert.equal(await cache.get('hour'), undefined, 'not good for a year and an hour');
  assert.equal((await cache.get('kept'))!.value, 'k', "an entry with no life is its reader's to judge");
  assert.equal(await open().get('hour'), undefined, 'and it is gone from the file');
  // An entry kept now is used for its life and no longer.
  await cache.set('hour', 'h2', 3_600_000);
  now.ms = start + 3_599_999;
  assert.equal((await cache.get('hour'))!.value, 'h2');
  now.ms = start + 3_600_001;
  assert.equal(await cache.get('hour'), undefined);
});
