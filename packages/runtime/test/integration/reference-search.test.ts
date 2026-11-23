import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LibraryDownloadStatus, WorldClient } from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';
import { buildPdf } from '../helpers/pdf-file.js';

/*
 * Searching inside the downloaded references, through the runtime: PDFs served for a few of the
 * references (one encrypted, one with no text), downloaded with `kind: 'references'`, then
 * searched page by page. The text is kept beside each PDF and read again when the PDF changes.
 */

const CANNING_1 = buildPdf([
  'Principles of Home Canning\nWhy can foods? Canning can be a safe and economical way to preserve quality food.',
  'Ensuring safe canned foods\nClostridium botulinum spores: pressure canning at 240 degrees F destroys them.\nAltitude changes the pressure needed.',
]);
const CANNING_4 = buildPdf([
  'Vegetables and Vegetable Products',
  'Beans or peas, shelled, dried: soak, boil 30 minutes, fill jars, pressure can.',
  'Corn, whole kernel: process in a pressure canner, not a boiling water canner.',
]);
const CARPENTRY = buildPdf([
  'Chapter 1. Construction drawings',
  'Roof framing: rafters, ridge boards and collar ties.',
]);
const ENCRYPTED = Buffer.from(
  buildPdf(['secret']).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
  'latin1',
);
const PICTURES = buildPdf(['', '']);

function fakeServer(files: Record<string, Buffer>) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const f = files[url];
    if (!f) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(f), { headers: { 'content-type': 'application/pdf' } });
  }) as typeof fetch;
}

async function done(client: WorldClient): Promise<LibraryDownloadStatus> {
  for (let i = 0; i < 800; i++) {
    const st = await client.request('library.download.status', undefined);
    if (st.phase === 'done' || st.phase === 'failed' || st.phase === 'cancelled') return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('download did not end');
}

const G = (n: number) => `https://nchfp.uga.edu/papers/guide/GUIDE0${n}_HomeCan_rev0715.pdf`;

test('reference search: downloaded guides searched page by page; encrypted and picture-only said so', async () => {
  const files: Record<string, Buffer> = {
    [G(1)]: CANNING_1,
    [G(4)]: CANNING_4,
    'https://archive.org/download/MManuals/UsArmyEngineerCarpentry1995.pdf': CARPENTRY,
    [G(2)]: ENCRYPTED,
    [G(3)]: PICTURES,
  };
  const h = await startRuntime({ fetchImpl: fakeServer(files) });
  try {
    // Nothing downloaded: nothing searched.
    assert.deepEqual(await h.client.request('library.references.search', { query: 'canning' }), {
      hits: [],
      searched: 0,
      unreadable: [],
    });
    await h.client.request('library.download.start', { kind: 'references' });
    await done(h.client);

    const a = await h.client.request('library.references.search', { query: 'pressure canning' });
    assert.equal(a.searched, 3);
    assert.deepEqual(
      a.unreadable.map((u) => [u.id, u.why]),
      [
        ['usda-canning-02', 'the file is encrypted'],
        ['usda-canning-03', 'its pages are pictures, with no text to search'],
      ],
    );
    // Every word on the page, as word starts: guide 4 says "pressure can" and "pressure canner",
    // which "canning" does not start.
    assert.deepEqual(
      a.hits.map((x) => [x.id, x.page]),
      [['usda-canning-01', 2]],
    );
    assert.match(a.hits[0]!.snippet, /pressure canning at 240 degrees/);
    assert.equal(a.hits[0]!.title, 'Complete Guide to Home Canning, Guide 1: Principles of Home Canning');

    const roof = await h.client.request('library.references.search', { query: 'RAFTER' });
    assert.deepEqual(
      roof.hits.map((x) => [x.id, x.page]),
      [['army-fm-5-426', 2]],
    );
    const can = await h.client.request('library.references.search', { query: 'can' });
    assert.ok(can.hits.length >= 4, 'a word start: "can" finds canning, canner, canned');
    assert.deepEqual((await h.client.request('library.references.search', { query: 'zzzz' })).hits, []);

    // The text is kept beside each PDF, tied to its SHA-256.
    const dir = path.join(h.dataDir, 'library', 'references');
    const kept = JSON.parse(await fs.readFile(path.join(dir, 'usda-canning-04.text.json'), 'utf8')) as {
      sha256: string;
      pages: string[];
    };
    assert.equal(kept.pages.length, 3);
    // A PDF swapped on disk for another of the same size is not searched as the old text.
    const swapped = Buffer.from(CANNING_4);
    swapped[swapped.length - 30] = swapped[swapped.length - 30]! ^ 0xff;
    await fs.writeFile(path.join(dir, 'usda-canning-04.pdf'), swapped);
    // The kept text is untouched: the change is seen from the file's own time.
    const after = await h.client.request('library.references.search', { query: 'kernel' });
    assert.deepEqual(after.hits, []);
    assert.deepEqual(after.unreadable.map((u) => [u.id, u.why]).slice(-1), [
      ['usda-canning-04', 'the file is not the one downloaded'],
    ]);

    // Requests are checked.
    for (const bad of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(201) }, { query: 'a', more: 1 }])
      await assert.rejects(h.client.request('library.references.search', bad as never));
  } finally {
    await h.dispose();
  }
});

test('reference search: a damaged text file is read again from the PDF', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-refsearch-'));
  const h = await startRuntime({ dataDir, fetchImpl: fakeServer({ [G(4)]: CANNING_4 }) });
  try {
    await h.client.request('library.download.start', { kind: 'references', ids: ['usda-canning-04'] });
    await done(h.client);
    assert.equal((await h.client.request('library.references.search', { query: 'kernel' })).hits.length, 1);
    const dir = path.join(h.dataDir, 'library', 'references');
    await fs.writeFile(path.join(dir, 'usda-canning-04.text.json'), '{"damaged":');
    // A fresh runtime on the same folder has nothing in memory.
    await h.dispose();
    const h2 = await startRuntime({ dataDir, fetchImpl: fakeServer({}) });
    try {
      const r = await h2.client.request('library.references.search', { query: 'kernel' });
      assert.deepEqual(
        r.hits.map((x) => x.page),
        [3],
      );
      const kept = JSON.parse(await fs.readFile(path.join(dir, 'usda-canning-04.text.json'), 'utf8')) as {
        pages: string[];
      };
      assert.equal(kept.pages.length, 3);
    } finally {
      await h2.dispose();
    }
  } finally {
    await h.dispose().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
