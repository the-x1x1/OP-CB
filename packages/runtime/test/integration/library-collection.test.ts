import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  COLLECTION_ITEM,
  STARTER_COLLECTION,
  planCollection,
  resolvedFromAnswer,
  type LibraryDownloadStatus,
  type WorldClient,
} from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';
import { buildZim } from '../helpers/zim-file.js';

/*
 * The starter collection through the runtime: looked up in a catalogue that answers the
 * `name` filter and `q` search the way libkiwix does (an Atom feed of entries), then fetched
 * one book after another. Three books are served; the post-disaster one fails at the server.
 */

const kib = (n: number) => Math.ceil(n / 1024) * 1024;
let uuids = 0;
const zim = (title: string) =>
  buildZim(
    [
      { ns: 'C', path: 'index', title: 'Main Page', body: `<h1>${title}</h1>` },
      { ns: 'M', path: 'Title', mime: 'text/plain', body: title },
    ],
    // Each book its own UUID, as real ZIM files have.
    { minor: 2, uuid: (++uuids).toString(16).padStart(32, '0') },
  );

const BOOKS: Record<string, { name: string; title: string; data: Uint8Array; broken?: boolean }> = {
  'zimgit-water_en_2024-08.zim': { name: 'zimgit-water_en', title: 'Water', data: zim('Water') },
  'zimgit-knots_en_2024-08.zim': { name: 'zimgit-knots_en', title: 'Knots', data: zim('Knots') },
  // An older water book: the lookup takes the newest.
  'zimgit-water_en_2023-01.zim': { name: 'zimgit-water_en', title: 'Water (old)', data: zim('Old water') },
  'zimgit-post-disaster_en_2024-05.zim': {
    name: 'zimgit-post-disaster_en',
    title: 'Post-disaster',
    data: zim('Post-disaster'),
    broken: true,
  },
};

function entryXml(file: string): string {
  const b = BOOKS[file]!;
  return `<entry>
    <id>urn:uuid:${file.replace(/[^a-z0-9]/g, '').slice(0, 30)}</id>
    <title>${b.title}</title>
    <name>${b.name}</name>
    <language>eng</language>
    <link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="https://lb.download.kiwix.org/zim/other/${file}" length="${kib(b.data.length)}" />
  </entry>`;
}

function fakeCatalog(opts: { down?: boolean } = {}) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(`${init?.method === 'HEAD' ? 'HEAD ' : ''}${url.toString()}`);
    if (url.href.startsWith('https://library.kiwix.org/catalog/v2/entries')) {
      if (opts.down) return new Response('busy', { status: 503 });
      const name = url.searchParams.get('name');
      const q = url.searchParams.get('q')?.toLowerCase();
      const files = Object.keys(BOOKS).filter((f) =>
        name ? BOOKS[f]!.name === name : q ? BOOKS[f]!.title.toLowerCase().includes(q.split(' ')[0]!) : false,
      );
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><totalResults>${files.length}</totalResults>${files.map(entryXml).join('')}</feed>`,
      );
    }
    const file = url.pathname.split('/').pop()!;
    const b = BOOKS[file];
    if (!b || !url.pathname.startsWith('/zim/other/')) throw new TypeError(`unexpected ${url.href}`);
    if (b.broken) return new Response('gone', { status: 410 });
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': String(b.data.length) } });
    return new Response(Buffer.from(b.data), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

async function until(client: WorldClient, phases: LibraryDownloadStatus['phase'][]): Promise<LibraryDownloadStatus> {
  for (let i = 0; i < 800; i++) {
    const st = await client.request('library.download.status', undefined);
    if (phases.includes(st.phase)) return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out at ${JSON.stringify(await client.request('library.download.status', undefined))}`);
}

test('collection: looked up by name and search, newest file kept, planned, fetched in turn', async () => {
  const k = fakeCatalog();
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    const answer = await h.client.request('library.collection.lookup', { language: 'eng' });
    assert.equal(answer.ok, true);
    assert.equal(answer.items.length, STARTER_COLLECTION.length);
    assert.deepEqual(answer.notes, []);
    const water = answer.items.find((x) => x.id === 'water')!;
    assert.deepEqual(
      water.choices.map((c) => c.entry.url),
      ['https://lb.download.kiwix.org/zim/other/zimgit-water_en_2024-08.zim'],
    );
    assert.equal(answer.items.find((x) => x.id === 'wikipedia')!.choices.length, 0);
    // The name filter went out without the flavour; the language with every question.
    assert.ok(k.asked.some((u) => u.includes('name=wikipedia_en_all&') || u.endsWith('name=wikipedia_en_all')));
    assert.ok(k.asked.filter((u) => u.includes('/catalog/')).every((u) => u.includes('lang=eng')));

    const plan = planCollection(resolvedFromAnswer(answer), 10 * 1024 ** 3);
    assert.deepEqual(
      plan.picks.map((p) => p.item.id),
      ['post-disaster', 'water', 'knots'],
    );
    assert.ok(plan.missing.some((m) => m.id === 'wikipedia'));

    const started = await h.client.request('library.download.start', {
      kind: 'collection',
      entries: plan.picks.map((p) => p.entry),
    });
    assert.equal(started.item, COLLECTION_ITEM);
    const st = await until(h.client, ['done', 'failed', 'cancelled']);
    assert.equal(st.phase, 'done', JSON.stringify(st));
    assert.equal(st.item, COLLECTION_ITEM);
    assert.deepEqual(st.step, { done: 2, total: 3 });
    assert.equal(st.problems?.length, 1);
    assert.match(st.problems![0]!, /^Post-disaster: /);
    assert.match(st.message ?? '', /2 of 3 in the library; 1 could not be fetched/);
    const lib = path.join(h.dataDir, 'library');
    assert.deepEqual((await fs.readdir(lib)).filter((n) => n.endsWith('.zim')).sort(), [
      'zimgit-knots_en_2024-08.zim',
      'zimgit-water_en_2024-08.zim',
    ]);
    const shelf = await h.client.request('library.shelf', undefined);
    assert.deepEqual(shelf.books.map((b) => b.title).sort(), ['Knots', 'Water']);
    // Planned again with what the shelf holds: those two are had, not fetched again.
    const again = planCollection(resolvedFromAnswer(answer), 10 * 1024 ** 3, {
      haveFiles: shelf.books.map((b) => b.file),
    });
    assert.deepEqual(again.have.sort(), ['knots', 'water']);
    assert.deepEqual(
      again.picks.map((p) => p.item.id),
      ['post-disaster'],
    );
  } finally {
    await h.dispose();
  }
});

test('collection: a catalogue that does not answer says so; requests are checked', async () => {
  const h = await startRuntime({ fetchImpl: fakeCatalog({ down: true }).fetchImpl });
  try {
    const a = await h.client.request('library.collection.lookup', {});
    assert.equal(a.ok, false);
    assert.match(a.message ?? '', /did not answer/);
    assert.ok(a.notes.length > 0 && a.notes.every((n) => /503/.test(n)));
    await assert.rejects(h.client.request('library.collection.lookup', { language: 'english' } as never));
    await assert.rejects(h.client.request('library.collection.lookup', { other: 1 } as never));
    await assert.rejects(h.client.request('library.download.start', { kind: 'collection', entries: [] } as never));
    const e = { id: 'x', name: 'x', title: 'x', url: 'https://lb.download.kiwix.org/zim/other/x_2024-01.zim' };
    await assert.rejects(h.client.request('library.download.start', { kind: 'collection', entries: [e, e] } as never));
    await assert.rejects(
      h.client.request('library.download.start', {
        kind: 'collection',
        entries: Array.from({ length: 31 }, (_, i) => ({ ...e, url: `${e.url}?${i}` })),
      } as never),
    );
    await assert.rejects(h.client.request('library.catalog', { name: '../x' } as never));
  } finally {
    await h.dispose();
  }
});

test('collection: a stop ends the queue and keeps what is there; an entry off download.kiwix.org is noted', async () => {
  const k = fakeCatalog();
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    const water = {
      id: 'w',
      name: 'zimgit-water_en',
      title: 'Water',
      url: 'https://lb.download.kiwix.org/zim/other/zimgit-water_en_2024-08.zim',
    };
    const elsewhere = { id: 'e', name: 'e', title: 'Elsewhere', url: 'https://example.org/zim/other/e_2024-01.zim' };
    await h.client.request('library.download.start', { kind: 'collection', entries: [elsewhere, water] });
    const st = await until(h.client, ['done', 'failed', 'cancelled']);
    assert.equal(st.phase, 'done');
    assert.deepEqual(st.problems, ['Elsewhere: no download on download.kiwix.org']);
    assert.deepEqual(st.step, { done: 1, total: 2 });

    // Stopped before it begins: nothing more is fetched and the status says stopped.
    const knots = { ...water, id: 'k', title: 'Knots', url: water.url.replace('water', 'knots') };
    await h.client.request('library.download.start', { kind: 'collection', entries: [knots] });
    await h.client.request('library.download.cancel', undefined);
    const stopped = await until(h.client, ['done', 'failed', 'cancelled']);
    assert.equal(stopped.phase, 'cancelled');
    assert.equal(stopped.item, COLLECTION_ITEM);
  } finally {
    await h.dispose();
  }
});
