import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonDocStore } from './json-doc-store.js';
import { FileProviderCache } from './provider-storage.js';

/**
 * The small file-backed stores when several callers use them in the same turn, before the
 * file has been read for the first time and after. Each change that was answered is in the
 * store and in the file; none is undone by another's.
 */
interface Doc {
  id: string;
  name: string;
}
const asDoc = (v: unknown): Doc | undefined =>
  v && typeof v === 'object' && typeof (v as Doc).id === 'string' ? (v as Doc) : undefined;

async function inTemp(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-stores-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const onDisk = async (file: string): Promise<Doc[]> =>
  (JSON.parse(await fs.readFile(file, 'utf8')) as { items: Doc[] }).items;

test('document store: forty first saves at once are forty documents', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'docs.json');
    const store = new JsonDocStore<Doc>(file, asDoc);
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.save({ id: `d${i}`, name: 'first' })));
    assert.equal((await store.list()).length, 40);
    assert.equal((await onDisk(file)).length, 40);
  });
});

test('document store: a file already there is read once, and saves made while it is read are kept', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'docs.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, items: [{ id: 'old', name: 'kept' }] }));
    const store = new JsonDocStore<Doc>(file, asDoc);
    const [listed] = await Promise.all([
      store.list(),
      store.save({ id: 'a', name: 'new' }),
      store.get('old'),
      store.save({ id: 'b', name: 'new' }),
      store.remove('nothing'),
    ]);
    assert.ok(listed.some((d) => d.id === 'old'));
    assert.deepEqual((await store.list()).map((d) => d.id).sort(), ['a', 'b', 'old']);
    assert.deepEqual((await onDisk(file)).map((d) => d.id).sort(), ['a', 'b', 'old']);
  });
});

test('document store: removals, saves and a replacement asked for together all take effect, in order', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'docs.json');
    const store = new JsonDocStore<Doc>(file, asDoc);
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.save({ id: `d${i}`, name: 'first' })));
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        i % 3 === 0 ? store.remove(`d${i}`) : store.save({ id: `d${i}`, name: 'second' }),
      ),
    );
    const left = await store.list();
    assert.equal(left.length, 20);
    assert.ok(left.every((d) => d.name === 'second' && Number(d.id.slice(1)) % 3 !== 0));
    assert.deepEqual(await onDisk(file), left);
    // What a list hands out is a copy: changing it changes nothing.
    left[0]!.name = 'changed outside';
    assert.ok((await store.list()).every((d) => d.name === 'second'));
    // A replacement and a save in the same turn: the save is of the list after the replacement.
    await Promise.all([
      store.replaceAll([{ id: 'only', name: 'replaced' }]),
      store.save({ id: 'after', name: 'saved' }),
    ]);
    assert.deepEqual((await store.list()).map((d) => d.id).sort(), ['after', 'only']);
    assert.deepEqual((await onDisk(file)).map((d) => d.id).sort(), ['after', 'only']);
  });
});

test('source cache: entries set together before the first read are all there, and on disk', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'cache.json');
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, entries: { old: { value: 1, storedAt: '2026-09-21T00:00:00.000Z' } } }),
    );
    const clock = { now: () => Date.parse('2026-09-21T08:00:00Z') };
    const cache = new FileProviderCache(file, clock, true);
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => cache.set(`k${i}`, { n: i })),
      cache.get('old'),
      cache.get('constructor'),
    ]);
    for (let i = 0; i < 20; i++) assert.deepEqual((await cache.get(`k${i}`))?.value, { n: i }, `k${i}`);
    assert.equal((await cache.get('old'))?.value, 1);
    assert.equal(await cache.get('constructor'), undefined);
    const again = new FileProviderCache(file, clock, true);
    for (let i = 0; i < 20; i++) assert.deepEqual((await again.get(`k${i}`))?.value, { n: i }, `k${i} on disk`);
  });
});
