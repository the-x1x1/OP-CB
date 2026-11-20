import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { silentLogger } from '@opcb/core';
import type { LibraryDownloadStatus } from '@opcb/ipc-contract';
import { LibraryDownloads } from './library-downloads.js';

/**
 * The library folder cannot be made: its place is taken by a file. A download asked for then
 * must end as failed and leave the next one free to start — it used to stand at "downloading",
 * its failure a rejection nobody handled.
 */
test('library downloads: a folder that cannot be made ends the download as failed, and the next can start', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-library-'));
  const blocked = path.join(tmp, 'library');
  await fs.writeFile(blocked, 'a file where the folder should be');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let asked = 0;
  const downloads = new LibraryDownloads({
    fetchImpl: (async () => {
      asked++;
      return new Response('', { status: 503 });
    }) as typeof fetch,
    dir: blocked,
    now: () => Date.parse('2026-11-20T00:00:00Z'),
    log: silentLogger,
    freeBytes: async () => 1e12,
  });
  const ended = async (): Promise<LibraryDownloadStatus> => {
    for (let i = 0; i < 200 && downloads.current().phase === 'downloading'; i++)
      await new Promise((r) => setTimeout(r, 5));
    return downloads.current();
  };

  assert.equal(downloads.start({ kind: 'references' }).phase, 'downloading');
  const references = await ended();
  assert.equal(references.phase, 'failed');
  assert.ok((references.message ?? '').length > 0);

  const entry = {
    title: 'A book',
    url: 'https://download.kiwix.org/zim/other/a-book_en_all_2026-10.zim.meta4',
  };
  const first = downloads.start({ kind: 'zim', entry } as never);
  assert.equal(first.phase, 'downloading', 'the failed one does not hold the next off');
  assert.equal((await ended()).phase, 'failed');

  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal(asked, 0, 'nothing was fetched for a folder that is not there');
  await fs.rm(tmp, { recursive: true, force: true });
});
