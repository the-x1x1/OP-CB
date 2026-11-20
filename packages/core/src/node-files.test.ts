import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, sha256Hex, writeFileAtomic } from './node.js';
import { abortError, combineSignals, withRetry } from './resilience.js';

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'opcb-core-'));

test('sha256Hex: the published digests, text and bytes alike', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(new Uint8Array([0x61, 0x62, 0x63])), sha256Hex('abc'));
  assert.equal(sha256Hex('é'), sha256Hex(new Uint8Array([0xc3, 0xa9])), 'text is hashed as UTF-8');
});

test('writeFileAtomic: writes text or bytes, makes the folder, replaces what was there, leaves no temporary file', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'deep', 'er', 'settings.json');
  await writeFileAtomic(target, '{"a":1}');
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":1}');
  await writeFileAtomic(target, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await fs.readFile(target))], [1, 2, 3]);
  await writeFileAtomic(target, '');
  assert.equal((await fs.stat(target)).size, 0);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['settings.json']);
});

test('writeFileAtomic: twenty writes of one file at once leave one whole file and nothing else', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'state.json');
  const bodies = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(20_000) }));
  await Promise.all(bodies.map((b) => writeFileAtomic(target, b)));
  assert.ok(bodies.includes(await fs.readFile(target, 'utf8')));
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('writeFileAtomic: a write that cannot replace its target fails, and takes its temporary file with it', async () => {
  const dir = await tempDir();
  const target = path.join(dir, 'taken');
  // A folder with something in it cannot be renamed over.
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'inside'), 'x');
  await assert.rejects(writeFileAtomic(target, 'data'));
  assert.deepEqual(await fs.readdir(dir), ['taken']);
  assert.deepEqual(await fs.readdir(target), ['inside']);
});

test(
  'writeFileAtomic: the mode asked for is the mode the file gets',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'secret');
    await writeFileAtomic(target, 'x', { mode: 0o600 });
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  },
);

test('readJsonFile: the value, undefined when there is no file, and an error when it is not JSON', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'a.json');
  assert.equal(await readJsonFile(file), undefined);
  await fs.writeFile(file, '{"a":[1,2]}');
  assert.deepEqual(await readJsonFile(file), { a: [1, 2] });
  await fs.writeFile(file, 'null');
  assert.equal(await readJsonFile(file), null);
  await fs.writeFile(file, '{"a":');
  await assert.rejects(readJsonFile(file), SyntaxError);
  await fs.writeFile(file, '');
  await assert.rejects(readJsonFile(file), SyntaxError);
  await assert.rejects(readJsonFile(dir), (err: NodeJS.ErrnoException) => err.code === 'EISDIR');
});

const retryable = { isRetryable: () => true, sleep: () => Promise.resolve() };

test('withRetry: returns the first success, counting attempts from zero', async () => {
  const seen: number[] = [];
  const value = await withRetry(
    (attempt) => {
      seen.push(attempt);
      if (attempt < 2) return Promise.reject(new Error(`fail ${attempt}`));
      return Promise.resolve('done');
    },
    { ...retryable, maxRetries: 5 },
  );
  assert.equal(value, 'done');
  assert.deepEqual(seen, [0, 1, 2]);
});

test('withRetry: gives up after maxRetries more tries with the last error; zero means one try', async () => {
  let calls = 0;
  const failing = () => Promise.reject(new Error(`fail ${++calls}`));
  await assert.rejects(withRetry(failing, { ...retryable, maxRetries: 3 }), /fail 4/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(withRetry(failing, { ...retryable, maxRetries: 0 }), /fail 1/);
  assert.equal(calls, 1);
});

test('withRetry: an error that is not retryable, or an aborted signal, stops it at once', async () => {
  let calls = 0;
  const failing = () => Promise.reject(new Error(`fail ${++calls}`));
  await assert.rejects(withRetry(failing, { ...retryable, maxRetries: 3, isRetryable: () => false }), /fail 1/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        if (++calls === 2) controller.abort();
        return Promise.reject(new Error(`fail ${calls}`));
      },
      { ...retryable, maxRetries: 9, signal: controller.signal },
    ),
    /fail 2/,
  );
  assert.equal(calls, 2);
});

test('withRetry: waits what the error asks for, else the backoff, and reports each retry', async () => {
  const slept: number[] = [];
  const retries: Array<[number, number]> = [];
  let calls = 0;
  await withRetry(() => (++calls < 4 ? Promise.reject(new Error(String(calls))) : Promise.resolve(calls)), {
    maxRetries: 5,
    isRetryable: () => true,
    backoff: { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0 },
    retryAfterMs: (err) => ((err as Error).message === '2' ? 7_000 : undefined),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    onRetry: (attempt, delay) => retries.push([attempt, delay]),
  });
  assert.deepEqual(slept, [100, 7_000, 400]);
  assert.deepEqual(retries, [
    [1, 100],
    [2, 7_000],
    [3, 400],
  ]);
});

test('abortError: an Error named AbortError', () => {
  const e = abortError();
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'AbortError');
});

test('combineSignals: aborts when any signal does, with its reason; undefined entries are skipped', () => {
  const a = new AbortController();
  const b = new AbortController();
  const { signal, dispose } = combineSignals([a.signal, undefined, b.signal]);
  assert.equal(signal.aborted, false);
  const reason = new Error('stop b');
  b.abort(reason);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
  dispose();
  const none = combineSignals([]);
  assert.equal(none.signal.aborted, false);
  none.dispose();
});

test('combineSignals: already aborted is aborted from the start; after dispose nothing reaches it', () => {
  const done = new AbortController();
  done.abort(new Error('earlier'));
  const first = combineSignals([new AbortController().signal, done.signal]);
  assert.equal(first.signal.aborted, true);
  assert.equal((first.signal.reason as Error).message, 'earlier');
  first.dispose();
  const later = new AbortController();
  const second = combineSignals([later.signal]);
  second.dispose();
  later.abort();
  assert.equal(second.signal.aborted, false);
});

test('combineSignals: a timeout aborts with a TimeoutError, and dispose cancels it', async () => {
  const timed = combineSignals([], 10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timed.signal.aborted, true);
  assert.equal((timed.signal.reason as Error).name, 'TimeoutError');
  assert.match((timed.signal.reason as Error).message, /10ms/);
  const cancelled = combineSignals([], 10);
  cancelled.dispose();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cancelled.signal.aborted, false);
  for (const off of [0, -5]) {
    const never = combineSignals([], off);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(never.signal.aborted, false);
  }
});
