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
  // The catalogue's name is not the file's (as for the real Gardenology), and the title does
  // not hold the search word: only the item's own `names` finds it.
  'gardenology.org_en_all_2026-09.zim': { name: 'gardenology_en_all', title: 'Plants', data: zim('Plants') },
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

function fakeCatalog(opts: { down?: boolean; failWhen?: (url: URL) => boolean } = {}) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(`${init?.method === 'HEAD' ? 'HEAD ' : ''}${url.toString()}`);
    if (url.href.startsWith('https://library.kiwix.org/catalog/v2/entries')) {
      if (opts.down) return new Response('busy', { status: 503 });
      if (opts.failWhen?.(url)) throw new TypeError('fetch failed');
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
    assert.deepEqual(
      answer.items.find((x) => x.id === 'gardenology')!.choices.map((c) => c.file),
      ['gardenology.org_en_all'],
    );
    assert.ok(k.asked.some((u) => /[?&]name=gardenology_en_all(&|$)/.test(u)));
    assert.ok(!k.asked.some((u) => /[?&]name=gardenology\.org_en_all(&|$)/.test(u)));
    // The name filter went out without the flavour; the language with every question.
    assert.ok(k.asked.some((u) => u.includes('name=wikipedia_en_all&') || u.endsWith('name=wikipedia_en_all')));
    assert.ok(k.asked.filter((u) => u.includes('/catalog/')).every((u) => u.includes('lang=eng')));

    const plan = planCollection(resolvedFromAnswer(answer), 10 * 1024 ** 3);
    assert.deepEqual(
      plan.picks.map((p) => p.item.id),
      ['post-disaster', 'water', 'knots', 'gardenology'],
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
    assert.deepEqual(st.step, { done: 3, total: 4 });
    assert.equal(st.problems?.length, 1);
    assert.match(st.problems![0]!, /^Post-disaster: /);
    assert.match(st.message ?? '', /3 of 4 in the library; 1 could not be fetched/);
    const lib = path.join(h.dataDir, 'library');
    assert.deepEqual((await fs.readdir(lib)).filter((n) => n.endsWith('.zim')).sort(), [
      'gardenology.org_en_all_2026-09.zim',
      'zimgit-knots_en_2024-08.zim',
      'zimgit-water_en_2024-08.zim',
    ]);
    const shelf = await h.client.request('library.shelf', undefined);
    assert.deepEqual(shelf.books.map((b) => b.title).sort(), ['Knots', 'Plants', 'Water']);
    // Planned again with what the shelf holds: those two are had, not fetched again.
    const again = planCollection(resolvedFromAnswer(answer), 10 * 1024 ** 3, {
      haveFiles: shelf.books.map((b) => b.file),
    });
    assert.deepEqual(again.have.sort(), ['gardenology', 'knots', 'water']);
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

test('collection: a catalogue that answers some questions and not others still plans what it found', async () => {
  // Every question about water fails; the rest answer.
  const k = fakeCatalog({
    failWhen: (u) => u.searchParams.get('name') === 'zimgit-water_en' || u.searchParams.get('q') === 'water',
  });
  const h = await startRuntime({ fetchImpl: k.fetchImpl });
  try {
    const a = await h.client.request('library.collection.lookup', {});
    assert.equal(a.ok, true);
    assert.equal(a.items.find((x) => x.id === 'water')!.choices.length, 0);
    assert.equal(a.items.find((x) => x.id === 'knots')!.choices.length, 1);
    assert.ok(a.notes.length >= 1 && a.notes.length <= 20);
    assert.ok(
      a.notes.some((n) => /^(zimgit-water_en|water): /.test(n)),
      a.notes.join(' | '),
    );
    // Notes name the question, never repeat one, and carry no address.
    assert.equal(new Set(a.notes).size, a.notes.length);
    assert.ok(a.notes.every((n) => !/https?:/.test(n)));
    const plan = planCollection(resolvedFromAnswer(a), 10 * 1024 ** 3);
    assert.ok(plan.missing.some((m) => m.id === 'water'));
    assert.ok(plan.picks.some((p) => p.item.id === 'knots'));
  } finally {
    await h.dispose();
  }
});

/*
 * One thing decides when a download has finished. While a collection runs, a book's own end is
 * not the queue's (the status stays "downloading" between books), and a single book asked for
 * meanwhile is not started: the answer is the collection's status, and nothing of it is fetched.
 */
test('collection: a single book asked for while a collection downloads is not started; only the queue ends it', async () => {
  const k = fakeCatalog();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // The second book's body waits until the test lets it go.
    if (url.endsWith('zimgit-knots_en_2024-08.zim') && init?.method !== 'HEAD') await held;
    return k.fetchImpl(input, init);
  }) as typeof fetch;
  const h = await startRuntime({ fetchImpl });
  try {
    const answer = await h.client.request('library.collection.lookup', { language: 'eng' });
    const pick = (id: string) => answer.items.find((x) => x.id === id)!.choices[0]!.entry;
    await h.client.request('library.download.start', { kind: 'collection', entries: [pick('water'), pick('knots')] });

    // Between books and while the second is held, the status is the queue's and still running.
    const seen: LibraryDownloadStatus[] = [];
    for (let i = 0; i < 400; i++) {
      const st = await h.client.request('library.download.status', undefined);
      seen.push(st);
      if (st.book === 'Knots') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(seen.at(-1)?.book, 'Knots', JSON.stringify(seen.at(-1)));
    for (const st of seen) {
      assert.equal(st.item, COLLECTION_ITEM, JSON.stringify(st));
      assert.ok(st.phase === 'downloading' || st.phase === 'verifying', `not ended between books: ${st.phase}`);
    }

    // A single book now: not started; the answer is the collection's own status.
    const single = await h.client.request('library.download.start', { kind: 'zim', entry: pick('gardenology') });
    assert.equal(single.item, COLLECTION_ITEM);
    assert.equal(single.book, 'Knots');
    assert.ok(!k.asked.some((u) => u.includes('gardenology.org_en_all_2026-09.zim')), 'nothing of it fetched');

    release();
    const st = await until(h.client, ['done', 'failed', 'cancelled']);
    assert.equal(st.phase, 'done', JSON.stringify(st));
    assert.equal(st.item, COLLECTION_ITEM);
    assert.deepEqual(st.step, { done: 2, total: 2 });
    const lib = path.join(h.dataDir, 'library');
    assert.deepEqual((await fs.readdir(lib)).filter((n) => n.endsWith('.zim')).sort(), [
      'zimgit-knots_en_2024-08.zim',
      'zimgit-water_en_2024-08.zim',
    ]);

    // Once it has ended, the single book starts as any other.
    await h.client.request('library.download.start', { kind: 'zim', entry: pick('gardenology') });
    const one = await until(h.client, ['done', 'failed', 'cancelled']);
    assert.equal(one.phase, 'done', JSON.stringify(one));
    assert.equal(one.item, 'Plants');
    assert.equal(one.step, undefined, 'a single book carries no queue step');
  } finally {
    release();
    await h.dispose();
  }
});
