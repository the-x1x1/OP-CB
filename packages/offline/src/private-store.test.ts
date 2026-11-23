import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_PRIVATE_FILE_BYTES,
  PrivateStore,
  PrivateStoreError,
  passphraseProblem,
  privateName,
} from './private-store.js';

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'opcb-private-'));
}

function kind(err: unknown): string | undefined {
  return err instanceof PrivateStoreError ? err.kind : undefined;
}

test('private folder: set up, add, read back, close, open again with the passphrase only', async () => {
  const dir = await tmp();
  let now = Date.parse('2026-11-22T00:00:00Z');
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP, now: () => now });
  assert.deepEqual(await store.status(), { set: false, open: false });
  const st = await store.setup('correct horse battery');
  assert.deepEqual(st, { set: true, open: true, entries: [] });
  const secret = Buffer.from('Passport number X1234567\nBlood type O-\n');
  const e = await store.add('C:\\Users\\me\\Documents\\passport.txt', secret);
  assert.equal(e.name, 'passport.txt');
  assert.equal(e.sizeBytes, secret.length);
  assert.equal(e.addedAt, '2026-11-22T00:00:00.000Z');
  assert.ok((await store.read(e.id)).data.equals(secret));

  // Nothing readable on disk: no name, no contents, no passphrase.
  const files = await fs.readdir(path.join(dir, 'private'));
  assert.deepEqual(files.sort(), [`${e.id}.opcbx`, 'index.opcbx', 'key.json'].sort());
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, 'private', f));
    for (const needle of ['passport', 'X1234567', 'correct horse', 'Blood'])
      assert.equal(raw.includes(Buffer.from(needle)), false, `${f} holds ${needle}`);
  }

  store.close();
  assert.deepEqual(await store.status(), { set: true, open: false });
  await assert.rejects(store.read(e.id), (err) => kind(err) === 'closed');
  await assert.rejects(store.add('x', Buffer.from('x')), (err) => kind(err) === 'closed');

  // A second store on the same folder (a restart).
  const again = new PrivateStore({ dataDir: dir, scrypt: CHEAP, now: () => now });
  await assert.rejects(again.unlock('wrong horse battery'), (err) => kind(err) === 'wrong-passphrase');
  const opened = await again.unlock('correct horse battery');
  assert.deepEqual(
    opened.entries?.map((x) => x.name),
    ['passport.txt'],
  );
  assert.ok((await again.read(e.id)).data.equals(secret));
  await assert.rejects(again.setup('another passphrase'), (err) => kind(err) === 'already-set');

  // Removal deletes the encrypted copy.
  assert.deepEqual(await again.remove(e.id), []);
  assert.deepEqual((await fs.readdir(path.join(dir, 'private'))).sort(), ['index.opcbx', 'key.json']);
  await assert.rejects(again.remove(e.id), (err) => kind(err) === 'invalid');
  await assert.rejects(again.read('../../etc/passwd'), (err) => kind(err) === 'invalid');
  now += 1;
});

test('private folder: closes itself when unused; a clock put back is not idleness', async () => {
  const dir = await tmp();
  let now = 1_000_000;
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP, now: () => now, idleMs: 60_000 });
  await store.setup('a long passphrase');
  now += 59_000;
  assert.equal((await store.status()).open, true);
  store.list(); // use
  now += 59_000;
  assert.equal((await store.status()).open, true);
  now -= 10 * 60_000; // clock put back
  assert.equal((await store.status()).open, true);
  now += 60_000;
  assert.equal((await store.status()).open, false);
  assert.throws(
    () => store.list(),
    (err) => kind(err) === 'closed',
  );
});

test('private folder: changing the passphrase keeps every file; the old one no longer opens it', async () => {
  const dir = await tmp();
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP });
  await store.setup('first passphrase');
  const e = await store.add('deed.pdf', Buffer.from('%PDF deed'));
  await assert.rejects(
    store.changePassphrase('not it at all', 'second passphrase'),
    (err) => kind(err) === 'wrong-passphrase',
  );
  await assert.rejects(store.changePassphrase('first passphrase', 'short'), (err) => kind(err) === 'invalid');
  await store.changePassphrase('first passphrase', 'second passphrase');
  store.close();
  const s2 = new PrivateStore({ dataDir: dir, scrypt: CHEAP });
  await assert.rejects(s2.unlock('first passphrase'), (err) => kind(err) === 'wrong-passphrase');
  await s2.unlock('second passphrase');
  assert.equal((await s2.read(e.id)).data.toString(), '%PDF deed');
});

test('private folder: wrong passphrases are slowed after the fifth in a row', async () => {
  const dir = await tmp();
  let now = 5_000_000;
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP, now: () => now });
  await store.setup('the right passphrase');
  store.close();
  for (let i = 0; i < 5; i++)
    await assert.rejects(store.unlock(`wrong ${i} passphrase`), (err) => kind(err) === 'wrong-passphrase');
  // Now even the right one waits.
  await assert.rejects(store.unlock('the right passphrase'), (err) => kind(err) === 'wait');
  assert.equal((await store.status()).waitSeconds, 1);
  now += 1_000;
  await assert.rejects(store.unlock('still wrong pass'), (err) => kind(err) === 'wrong-passphrase');
  await assert.rejects(store.unlock('the right passphrase'), (err) => kind(err) === 'wait');
  now += 2_000;
  assert.equal((await store.unlock('the right passphrase')).open, true);
  // A success clears the count.
  store.close();
  await assert.rejects(store.unlock('wrong again pass'), (err) => kind(err) === 'wrong-passphrase');
  assert.equal((await store.unlock('the right passphrase')).open, true);
});

test('private folder: a changed byte anywhere is refused, never returned as other contents', async () => {
  const dir = await tmp();
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP });
  await store.setup('tamper test passphrase');
  const e = await store.add('notes.txt', Buffer.from('meet at the north gate at dawn'));
  const file = path.join(dir, 'private', `${e.id}.opcbx`);
  const good = await fs.readFile(file);
  for (let i = 0; i < good.length; i++) {
    const bad = Buffer.from(good);
    bad[i] = bad[i]! ^ 0x01;
    await fs.writeFile(file, bad);
    await assert.rejects(store.read(e.id), (err) => kind(err) === 'damaged', `byte ${i}`);
  }
  // Cut short, or the index put in its place: refused too.
  await fs.writeFile(file, good.subarray(0, 20));
  await assert.rejects(store.read(e.id), (err) => kind(err) === 'damaged');
  await fs.copyFile(path.join(dir, 'private', 'index.opcbx'), file);
  await assert.rejects(store.read(e.id), (err) => kind(err) === 'damaged');
  await fs.writeFile(file, good);
  assert.equal((await store.read(e.id)).data.toString(), 'meet at the north gate at dawn');

  // A damaged index refuses to open rather than showing an empty folder over real files.
  store.close();
  const idx = path.join(dir, 'private', 'index.opcbx');
  const raw = await fs.readFile(idx);
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
  await fs.writeFile(idx, raw);
  await assert.rejects(store.unlock('tamper test passphrase'), (err) => kind(err) === 'damaged');
  // A damaged key file: set, not offered for setup, and not opened.
  await fs.writeFile(path.join(dir, 'private', 'key.json'), '{"formatVersion":1}');
  assert.equal((await store.status()).set, true);
  await assert.rejects(store.unlock('tamper test passphrase'), (err) => kind(err) === 'damaged');
  await assert.rejects(store.setup('a new passphrase'), (err) => kind(err) === 'already-set');
});

test('private folder: adds asked together all land; limits hold', async () => {
  const dir = await tmp();
  const store = new PrivateStore({ dataDir: dir, scrypt: CHEAP });
  await store.setup('concurrency passphrase');
  const added = await Promise.all(
    Array.from({ length: 12 }, (_, i) => store.add(`f${i}.txt`, Buffer.from(`file ${i}`))),
  );
  assert.equal(new Set(added.map((a) => a.id)).size, 12);
  store.close();
  await store.unlock('concurrency passphrase');
  assert.equal(store.list().length, 12);
  for (const a of added) assert.equal((await store.read(a.id)).data.toString(), `file ${a.name.slice(1, -4)}`);
  await assert.rejects(store.add('big', new Uint8Array(MAX_PRIVATE_FILE_BYTES + 1)), (err) => kind(err) === 'invalid');
});

test('privateName and passphraseProblem', () => {
  assert.equal(privateName('/home/me/a b.pdf'), 'a b.pdf');
  assert.equal(privateName('..'), 'file');
  assert.equal(privateName(''), 'file');
  assert.equal(privateName('evil\u202Etxt.exe'), 'eviltxt.exe');
  assert.equal(privateName('x'.repeat(500)).length, 200);
  assert.equal(passphraseProblem('1234567'), 'the passphrase must be at least 8 characters');
  assert.equal(passphraseProblem('12345678'), undefined);
  assert.equal(passphraseProblem(42), 'the passphrase must be text');
  assert.match(passphraseProblem('x'.repeat(1025)) ?? '', /at most/);
  // Eight characters, not eight UTF-16 units.
  assert.match(passphraseProblem('😀😀😀😀') ?? '', /at least/);
});
