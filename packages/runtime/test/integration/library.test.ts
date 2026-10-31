import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LibraryDownloadStatus, WorldClient } from '@opcb/ipc-contract';
import { readCatalog, readMetalink } from '../../src/index.js';
import { startRuntime } from '../helpers/harness.js';
import { buildZim, type ZimItemSpec } from '../helpers/zim-file.js';

/*
 * The catalogue feed below follows libkiwix's own expected output (test/library_server.cpp
 * CATALOG_ENTRY, test/library.cpp), read 2026-10-30; the Metalink file follows RFC 5854. Both are
 * written here; nothing is copied from a live answer.
 */

const items: ZimItemSpec[] = [
  { ns: 'C', path: 'index', title: 'Main Page', body: '<h1>Survival library</h1>' },
  { ns: 'C', path: 'Water_purification', title: 'Water purification', body: '<p>Boil water for one minute.</p>' },
  { ns: 'C', path: 'Boiling', title: 'Boiling', redirect: 'C/Water_purification' },
  { ns: 'C', path: 'Burns', title: 'Burns', body: '<p>Cool the burn with running water for twenty minutes.</p>' },
  { ns: 'M', path: 'Title', mime: 'text/plain', body: 'Field medicine' },
  { ns: 'M', path: 'Language', mime: 'text/plain', body: 'eng' },
];

function feed(entry: { size: number; href: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="https://specs.opds.io/opds-1.2">
  <id>x</id>
  <title>Filtered Entries (q=medicine)</title>
  <updated>2026-10-30T00:00:00Z</updated>
  <totalResults>1</totalResults>
  <startIndex>0</startIndex>
  <itemsPerPage>1</itemsPerPage>
  <entry>
    <id>urn:uuid:9f1a3c2e-0000-4000-8000-000000000001</id>
    <title>Field medicine</title>
    <updated>2026-10-01T00:00:00Z</updated>
    <summary>Medicine for when help is far &amp; slow</summary>
    <language>eng</language>
    <name>field_medicine_en</name>
    <flavour>maxi</flavour>
    <category>other</category>
    <tags>_category:other;_pictures:yes</tags>
    <articleCount>3</articleCount>
    <mediaCount>0</mediaCount>
    <link type="text/html" href="/content/field_medicine_en_2026-10" />
    <author>
      <name>Someone</name>
    </author>
    <publisher>
      <name>Kiwix</name>
    </publisher>
    <dc:issued>2026-10-01T00:00:00Z</dc:issued>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="${entry.href}" length="${entry.size}" />
  </entry>
  <entry>
    <id>urn:uuid:9f1a3c2e-0000-4000-8000-000000000002</id>
    <title>Elsewhere</title>
    <name>elsewhere</name>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="https://example.org/zim/x.zim" length="5" />
  </entry>
</feed>`;
}

function metalink(size: number, sha256: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="field_medicine_en_2026-10.zim">
    <size>${size}</size>
    <hash type="md5">00000000000000000000000000000000</hash>
    <hash type="sha-256">${sha256}</hash>
    <pieces length="262144" type="sha-1"><hash>0000000000000000000000000000000000000000</hash></pieces>
    <url location="de" priority="1">https://mirror.example.de/kiwix/zim/other/field_medicine_en_2026-10.zim</url>
    <url location="us" priority="2">http://insecure.example.com/field_medicine_en_2026-10.zim</url>
  </file>
</metalink>`;
}

const ZIM_URL = 'https://download.kiwix.org/zim/other/field_medicine_en_2026-10.zim';

function fakeKiwix(file: Uint8Array, opts: { sha?: string; stallAt?: number } = {}) {
  const asked: string[] = [];
  const sha = opts.sha ?? createHash('sha256').update(file).digest('hex');
  let stalled = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const range = new Headers(init?.headers).get('range');
    asked.push(`${url}${range ? ` ${range}` : ''}`);
    if (url.startsWith('https://library.kiwix.org/catalog/v2/entries'))
      return new Response(
        feed({ size: file.length, href: `http://download.kiwix.org/zim/other/field_medicine_en_2026-10.zim.meta4` }),
      );
    if (url === `${ZIM_URL}.meta4`) return new Response(metalink(file.length, sha));
    if (url === 'https://mirror.example.de/kiwix/zim/other/field_medicine_en_2026-10.zim' || url === ZIM_URL) {
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
      if (opts.stallAt !== undefined && !stalled && start < opts.stallAt) {
        stalled = true;
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(file.slice(start, opts.stallAt));
            signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { status: range ? 206 : 200 });
      }
      return new Response(file.slice(start), { status: range ? 206 : 200 });
    }
    if (url.endsWith('.pdf') && url.includes('irp.fas.org'))
      return new Response(Buffer.from('%PDF-1.7 survival'), { headers: { 'content-type': 'application/pdf' } });
    if (url.includes('ready.gov'))
      return new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } });
    if (url.includes('nj.gov'))
      return new Response(Buffer.from('%PDF-1.4 fema'), { headers: { 'content-type': 'application/pdf' } });
    if (url.endsWith('.pdf')) return new Response('not found', { status: 404 });
    throw new TypeError(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchImpl, asked };
}

async function until(client: WorldClient, phases: LibraryDownloadStatus['phase'][]): Promise<LibraryDownloadStatus> {
  for (let i = 0; i < 500; i++) {
    const st = await client.request('library.download.status', undefined);
    if (phases.includes(st.phase)) return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out at ${JSON.stringify(await client.request('library.download.status', undefined))}`);
}

test('library: a ZIM file in the folder is listed, searched by title (across redirects) and read', async () => {
  const h = await startRuntime();
  try {
    const dir = path.join(h.dataDir, 'library');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'field.zim'), buildZim(items, { minor: 2 }));
    await fs.writeFile(path.join(dir, 'not-a-zim.zim'), 'hello');
    const shelf = await h.client.request('library.shelf', undefined);
    assert.equal(shelf.folder, dir);
    const book = shelf.books.find((b) => b.title === 'Field medicine');
    assert.ok(book);
    assert.equal(book.readable, true);
    assert.equal(book.titleSearch, true);
    assert.equal(book.language, 'eng');
    const broken = shelf.books.find((b) => b.file === 'not-a-zim.zim');
    assert.equal(broken?.readable, false);
    assert.match(broken?.problem ?? '', /smaller than a ZIM header|not a ZIM/);
    assert.equal(shelf.references.length, 6);
    assert.ok(shelf.references.every((r) => !r.installed));

    const found = await h.client.request('library.find', { query: 'boil', withText: true });
    assert.deepEqual(
      found.hits.map((x) => [x.title, x.key]),
      [['Boiling', 'Water_purification']],
    );
    assert.equal(found.hits[0]!.text, 'Boil water for one minute.');
    // A question: the longer words of it are tried as titles too.
    const q = await h.client.request('library.find', { query: 'how do I treat burns quickly', withText: true });
    assert.equal(q.hits[0]?.title, 'Burns');
    assert.match(q.hits[0]?.text ?? '', /twenty minutes/);

    const lib = h.runtime.core.zimLibrary;
    assert.equal(await lib.mainKey(book.id), 'index');
    const page = await lib.lookup(book.id, 'Water_purification');
    assert.equal(page.kind, 'item');
    assert.deepEqual(await lib.lookup(book.id, 'Boiling'), { kind: 'redirect', key: 'Water_purification' });
    assert.deepEqual(await lib.lookup(book.id, 'Nope'), { kind: 'missing' });
    // The runtime opens nothing itself; requests are checked.
    assert.equal((await h.client.request('library.open', { kind: 'book', bookId: book.id })).opened, false);
    await assert.rejects(h.client.request('library.open', { kind: 'book', bookId: '../etc' } as never));
  } finally {
    await h.dispose();
  }
});

test('library: the catalogue is read, a book downloaded from its Metalink mirror and checked three ways', async () => {
  const file = buildZim(items, { minor: 2 });
  const k = fakeKiwix(file);
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    const cat = await h.client.request('library.catalog', { query: 'medicine', language: 'eng' });
    assert.equal(cat.ok, true);
    assert.equal(cat.total, 1);
    // The entry whose download is not on download.kiwix.org is left out.
    assert.equal(cat.entries.length, 1);
    const e = cat.entries[0]!;
    assert.equal(e.url, `${ZIM_URL}.meta4`, 'made https');
    assert.equal(e.sizeBytes, file.length);
    assert.equal(e.summary, 'Medicine for when help is far & slow');
    assert.equal(e.issued, '2026-10-01');
    assert.ok(k.asked.some((u) => u.includes('q=medicine') && u.includes('lang=eng')));

    await h.client.request('library.download.start', { kind: 'zim', entry: e });
    const done = await until(h.client, ['done', 'failed']);
    assert.equal(done.phase, 'done', done.message ?? '');
    // From the https mirror the Metalink file names; never the http one.
    assert.ok(k.asked.includes('https://mirror.example.de/kiwix/zim/other/field_medicine_en_2026-10.zim'));
    assert.ok(!k.asked.some((u) => u.startsWith('http://')));
    const placed = await fs.readFile(path.join(h.dataDir, 'library', 'field_medicine_en_2026-10.zim'));
    assert.ok(placed.equals(file));
    const shelf = await h.client.request('library.shelf', undefined);
    assert.equal(shelf.books.length, 1);
    // Again: already there.
    await h.client.request('library.download.start', { kind: 'zim', entry: e });
    assert.match((await until(h.client, ['done', 'failed'])).message ?? '', /already in the library/);
  } finally {
    await h.dispose();
  }
  // A file that does not match its SHA-256 is removed, not put in the library.
  const bad = fakeKiwix(file, { sha: 'a'.repeat(64) });
  const h2 = await startRuntime({ fetchImpl: bad.fetchImpl });
  try {
    const cat = await h2.client.request('library.catalog', { query: 'medicine' });
    await h2.client.request('library.download.start', { kind: 'zim', entry: cat.entries[0]! });
    const st = await until(h2.client, ['done', 'failed']);
    assert.equal(st.phase, 'failed');
    assert.match(st.message ?? '', /SHA-256/);
    assert.deepEqual(
      (await fs.readdir(path.join(h2.dataDir, 'library'))).filter((n) => n.endsWith('.zim')),
      [],
    );
  } finally {
    await h2.dispose();
  }
});

test('library: a damaged download fails the checksum the ZIM file ends with', async () => {
  const file = Buffer.from(buildZim(items, { minor: 2 }));
  file[200] = file[200]! ^ 0xff; // changed after the MD5 was written
  const k = fakeKiwix(file);
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    const cat = await h.client.request('library.catalog', {});
    await h.client.request('library.download.start', { kind: 'zim', entry: cat.entries[0]! });
    const st = await until(h.client, ['done', 'failed']);
    assert.equal(st.phase, 'failed');
    assert.match(st.message ?? '', /checksum it ends with/);
  } finally {
    await h.dispose();
  }
});

test('library: a stopped book download carries on after a restart', async () => {
  const file = buildZim(items, { minor: 2 });
  const stallAt = Math.floor(file.length / 3);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-library-'));
  try {
    const k = fakeKiwix(file, { stallAt });
    const h = await startRuntime({ fetchImpl: k.fetchImpl, dataDir });
    try {
      const cat = await h.client.request('library.catalog', {});
      await h.client.request('library.download.start', { kind: 'zim', entry: cat.entries[0]! });
      for (let i = 0; i < 400; i++) {
        const st = await h.client.request('library.download.status', undefined);
        if ((st.progress?.bytesDone ?? 0) >= stallAt) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await h.client.request('library.download.cancel', undefined);
      const st = await until(h.client, ['cancelled', 'failed', 'done']);
      assert.equal(st.phase, 'cancelled');
    } finally {
      await h.dispose();
    }
    const k2 = fakeKiwix(file);
    const h2 = await startRuntime({ fetchImpl: k2.fetchImpl, dataDir });
    try {
      const cat = await h2.client.request('library.catalog', {});
      await h2.client.request('library.download.start', { kind: 'zim', entry: cat.entries[0]! });
      const st = await until(h2.client, ['done', 'failed']);
      assert.equal(st.phase, 'done', st.message ?? '');
      assert.equal(st.phase === 'done' && k2.asked.some((u) => u.endsWith(`bytes=${stallAt}-`)), true);
      assert.ok((await fs.readFile(path.join(dataDir, 'library', 'field_medicine_en_2026-10.zim'))).equals(file));
    } finally {
      await h2.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('library: the emergency references — PDFs only, a fallback address, problems said; offline asks nothing', async () => {
  const k = fakeKiwix(new Uint8Array(0));
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    await h.client.request('library.download.start', { kind: 'references' });
    const st = await until(h.client, ['done', 'failed']);
    assert.equal(st.phase, 'done');
    assert.equal(st.step?.total, 6);
    const shelf = await h.client.request('library.shelf', undefined);
    const got = shelf.references.filter((r) => r.installed).map((r) => r.id);
    assert.deepEqual(got.sort(), ['army-atp-3-50-21', 'army-fm-4-25-11', 'fema-are-you-ready']);
    const fema = shelf.references.find((r) => r.id === 'fema-are-you-ready')!;
    assert.equal(fema.installed?.from, 'https://www.nj.gov/njoem/pdf/areyouready.pdf', 'the web page was refused');
    assert.equal(fema.installed?.sha256, createHash('sha256').update('%PDF-1.4 fema').digest('hex'));
    assert.equal(st.problems?.length, 3);
    assert.match(st.problems!.join('\n'), /answered 404/);
    await assert.rejects(h.client.request('library.download.start', { kind: 'references', ids: ['../x'] }));
  } finally {
    await h.dispose();
  }
  const offline = (async () => {
    throw Object.assign(new Error('working offline'), { name: 'WorkingOfflineError' });
  }) as typeof fetch;
  const h2 = await startRuntime({ fetchImpl: offline });
  try {
    const cat = await h2.client.request('library.catalog', { query: 'x' });
    assert.equal(cat.ok, false);
    assert.match(cat.message ?? '', /Offline mode/);
  } finally {
    await h2.dispose();
  }
});

test('library: the readers refuse what is not theirs', () => {
  assert.throws(() => readCatalog('<html></html>'), /not an OPDS/);
  assert.throws(() => readMetalink('<feed/>'), /not a Metalink/);
  const m = readMetalink(metalink(10, 'B'.repeat(64)));
  assert.equal(m.sha256, 'b'.repeat(64));
  assert.equal(m.size, 10);
  assert.deepEqual(m.urls, ['https://mirror.example.de/kiwix/zim/other/field_medicine_en_2026-10.zim']);
});
