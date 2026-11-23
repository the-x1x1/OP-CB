import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIpcError } from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';

/*
 * The private folder through the runtime: chosen, a file put in through the open dialog, a
 * copy saved out through the save dialog, closed, opened again, closed by itself when unused.
 * Nothing in the data folder holds the passphrase, the file's name or its contents.
 */

const PASS = 'integration test passphrase';

async function refused(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    // The in-process client hands the handler's error back as it is; the IPC router turns its
    // `ipcCode` into the answer's code (ipc-router.ts toIpcError).
    const e = err as { ipcCode?: string; code?: string; message?: string };
    const got = isIpcError(err) ? err.code : e.ipcCode;
    assert.equal(got, code, e.message ?? '');
    if (message) assert.match(e.message ?? '', message);
    assert.equal((e.message ?? '').includes(PASS), false, 'the passphrase is in an error');
    return;
  }
  assert.fail('not refused');
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

test('private folder: set up, add through the dialog, save a copy out, close and open again', async () => {
  const h = await startRuntime();
  try {
    assert.deepEqual(await h.client.request('private.status', undefined), { set: false, open: false });
    await refused(h.client.request('private.unlock', { passphrase: PASS }), 'INVALID_REQUEST', /not been set up/);
    await refused(h.client.request('private.setup', { passphrase: 'short' }), 'INVALID_REQUEST', /at least 8/);
    await refused(h.client.request('private.setup', { passphrase: PASS, extra: 1 } as never), 'INVALID_REQUEST');
    assert.deepEqual(await h.client.request('private.setup', { passphrase: PASS }), {
      set: true,
      open: true,
      entries: [],
    });

    const outside = path.join(h.dataDir, '..', `${path.basename(h.dataDir)}-insurance-policy.txt`);
    const contents = 'Policy 88-ABC-1234, flood cover, agent 808-555-0100';
    await fs.writeFile(outside, contents);
    h.host.openQueue.push(outside);
    const added = await h.client.request('private.add', undefined);
    assert.equal(added.added?.name, path.basename(outside));
    assert.equal(added.status.entries?.length, 1);
    // A cancelled dialog adds nothing.
    assert.equal((await h.client.request('private.add', undefined)).cancelled, true);

    const copy = `${outside}.copy`;
    h.host.saveQueue.push(copy);
    const id = added.added!.id;
    assert.deepEqual(await h.client.request('private.export', { id }), { path: copy });
    assert.equal(await fs.readFile(copy, 'utf8'), contents);

    // Nothing in the data folder gives the passphrase, the name or the contents away.
    for (const f of await allFiles(h.dataDir)) {
      const raw = await fs.readFile(f);
      for (const needle of [PASS, 'insurance-policy', '88-ABC-1234'])
        assert.equal(raw.includes(Buffer.from(needle)), false, `${path.relative(h.dataDir, f)} holds ${needle}`);
    }

    assert.deepEqual(await h.client.request('private.lock', undefined), { set: true, open: false });
    await refused(h.client.request('private.export', { id }), 'DENIED', /closed/);
    await refused(h.client.request('private.add', undefined), 'DENIED', /closed/);
    assert.equal(h.host.openQueue.length, 0);
    await refused(h.client.request('private.unlock', { passphrase: 'not the passphrase' }), 'DENIED');
    const opened = await h.client.request('private.unlock', { passphrase: PASS });
    assert.deepEqual(
      opened.entries?.map((e) => e.id),
      [id],
    );

    // Closes itself after fifteen minutes unused.
    h.clock.advance(15 * 60_000);
    assert.equal((await h.client.request('private.status', undefined)).open, false);
    await h.client.request('private.unlock', { passphrase: PASS });

    await h.client.request('private.changePassphrase', { current: PASS, next: `${PASS} two` });
    assert.deepEqual((await h.client.request('private.remove', { id })).entries, []);
    await refused(h.client.request('private.remove', { id }), 'INVALID_REQUEST');
    await refused(h.client.request('private.export', { id: '../x' } as never), 'INVALID_REQUEST');
    await fs.rm(outside, { force: true });
    await fs.rm(copy, { force: true });
  } finally {
    await h.dispose();
  }
});

test('private folder: open again after a restart; closed at stop', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-private-restart-'));
  const h = await startRuntime({ dataDir });
  await h.client.request('private.setup', { passphrase: PASS });
  await h.dispose();
  const h2 = await startRuntime({ dataDir });
  try {
    assert.deepEqual(await h2.client.request('private.status', undefined), { set: true, open: false });
    await refused(h2.client.request('private.setup', { passphrase: 'a different passphrase' }), 'INVALID_REQUEST');
    assert.equal((await h2.client.request('private.unlock', { passphrase: PASS })).open, true);
  } finally {
    await h2.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
