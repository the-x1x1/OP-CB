import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonDocStore } from './json-doc-store.js';

/**
 * A list file that is there but cannot be read at the moment (held by another program, as
 * OneDrive or a virus scanner does on Windows; a refused read; a folder in its place) is not
 * an empty list. Read as one, the next save wrote the new item alone over the operator's
 * whole list. And a save that did not reach the disk is not answered as saved.
 */
interface Item {
  id: string;
  name: string;
}
const valid = (v: unknown): Item | undefined => {
  const o = v as Partial<Item>;
  return o && typeof o.id === 'string' && typeof o.name === 'string' ? { id: o.id, name: o.name } : undefined;
};

test('json doc store: a file that cannot be read is never written over; it is read again once it can be', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-docstore-'));
  try {
    const file = path.join(dir, 'collections.json');
    // In place of the file, something that is there but does not read as one.
    await fs.mkdir(file);
    await fs.writeFile(path.join(file, 'inside'), 'kept');
    const store = new JsonDocStore<Item>(file, valid);
    assert.deepEqual(await store.list(), [], 'the window still opens, with nothing listed');
    await assert.rejects(store.save({ id: 'new', name: 'New' }), (err: unknown) => {
      assert.equal((err as { ipcCode?: string }).ipcCode, 'UNAVAILABLE');
      assert.match((err as Error).message, /collections\.json could not be read/);
      return true;
    });
    await assert.rejects(store.remove('x'), /could not be read/);
    await assert.rejects(store.replaceAll([]), /could not be read/);
    assert.equal(await fs.readFile(path.join(file, 'inside'), 'utf8'), 'kept', 'nothing was written over it');

    // The hold ends and the real list is there: it is read, and the save goes on top of it.
    await fs.rm(file, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, items: [{ id: 'a', name: 'Kept' }] }));
    const after = await store.save({ id: 'new', name: 'New' });
    assert.deepEqual(after.map((i) => i.id).sort(), ['a', 'new']);
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { items: Item[] };
    assert.deepEqual(onDisk.items.map((i) => i.id).sort(), ['a', 'new']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json doc store: a save that cannot be written says so', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-docstore-'));
  try {
    const file = path.join(dir, 'watchzones.json');
    const store = new JsonDocStore<Item>(file, valid);
    assert.deepEqual(await store.list(), []);
    // Where the file would go, a folder appears: the write's rename cannot replace it.
    await fs.mkdir(file);
    await assert.rejects(store.save({ id: 'z', name: 'Zone' }), (err: unknown) => {
      assert.equal((err as { ipcCode?: string }).ipcCode, 'UNAVAILABLE');
      assert.match((err as Error).message, /watchzones\.json could not be written/);
      return true;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
