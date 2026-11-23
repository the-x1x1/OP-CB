import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { LibraryBook, ReferenceDoc } from '@opcb/ipc-contract';
import { LibraryShare, SHARE_CSP, isPrivatePeer, newShareCode, type LibraryShareDeps } from './library-share.js';

const BOOK = 'a'.repeat(32);
const silent = { info() {}, warn() {} };

async function setup(over: Partial<LibraryShareDeps> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-share-'));
  const pdf = path.join(dir, 'usda-canning-01.pdf');
  await fs.writeFile(pdf, '%PDF-1.4 test');
  let now = Date.parse('2026-11-22T20:00:00Z');
  const books: LibraryBook[] = [
    {
      id: BOOK,
      file: 'x_2024-01.zim',
      title: 'Water <script>alert(1)</script>',
      sizeBytes: 20e6,
      entryCount: 3,
      readable: true,
      titleSearch: true,
    },
    {
      id: 'b'.repeat(32),
      file: 'y_2024-01.zim',
      title: 'Unreadable',
      sizeBytes: 1,
      entryCount: 0,
      readable: false,
      titleSearch: false,
    },
  ];
  const refs = [
    {
      id: 'usda-canning-01',
      title: 'Canning, Guide 1',
      publisher: 'USDA',
      topic: 't',
      licence: 'pd',
      urls: [],
      installed: { sizeBytes: 13, sha256: 'x', downloadedAt: 'x', from: 'x' },
    },
    { id: 'army-fm-5-426', title: 'Carpentry', publisher: 'U.S. Army', topic: 't', licence: 'pd', urls: [] },
  ] as ReferenceDoc[];
  const share = new LibraryShare({
    books: async () => books,
    lookup: async (bookId, key) =>
      bookId !== BOOK
        ? { kind: 'missing' }
        : key === 'A/Water'
          ? {
              kind: 'item',
              item: {
                mimeType: 'text/html; charset=evil',
                data: Buffer.from('<h1>Boil it</h1><a href="Wells">wells</a>'),
              },
            }
          : key === 'A/Old name'
            ? { kind: 'redirect', key: 'A/Water' }
            : { kind: 'missing' },
    mainKey: async (bookId) => (bookId === BOOK ? 'A/Water' : undefined),
    references: async () => refs,
    referenceFile: (id) => (id === 'usda-canning-01' ? pdf : undefined),
    findTitles: async (q) => ({
      hits: q === 'water' ? [{ bookId: BOOK, bookTitle: 'Water', key: 'A/Water', title: 'Water & wells' }] : [],
      searched: 1,
      notes: [],
    }),
    searchReferences: async (q) => ({
      hits:
        q === 'water'
          ? [{ id: 'usda-canning-01', title: 'Canning, Guide 1', page: 3, snippet: 'boiling <water> bath', score: 2 }]
          : [],
      searched: 1,
      unreadable: [],
    }),
    now: () => now,
    log: silent,
    listenHost: '127.0.0.1',
    addresses: () => ['127.0.0.1', '192.168.1.20'],
    ...over,
  });
  return { share, dir, setNow: (t: number) => (now = t), getNow: () => now };
}

function get(
  port: number,
  p: string,
  method = 'GET',
  host?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path: p, method, ...(host ? { headers: { host } } : {}) };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('share: off until started; the code is in every address; books, pages, guides and search answer', async () => {
  const { share, dir } = await setup();
  try {
    assert.deepEqual(share.status(), { sharing: false });
    const st = await share.start(30);
    assert.equal(st.sharing, true);
    assert.match(st.code!, /^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
    assert.deepEqual(st.urls, [
      `http://127.0.0.1:${st.port}/${st.code}/`,
      `http://192.168.1.20:${st.port}/${st.code}/`,
    ]);
    assert.equal(st.until, '2026-11-22T20:30:00.000Z');
    const pre = `/${st.code}`;

    const index = await get(st.port!, `${pre}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-security-policy'], SHARE_CSP);
    assert.equal(index.headers['referrer-policy'], 'no-referrer');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.match(index.body, /Water &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(index.body, /<script>/);
    assert.doesNotMatch(index.body, /Unreadable/, 'a book that cannot be read is not listed');
    assert.match(index.body, new RegExp(`href="${pre}/ref/usda-canning-01.pdf"`));
    assert.doesNotMatch(index.body, /Carpentry/, 'a guide not downloaded is not listed');
    assert.equal((await get(st.port!, pre)).headers.location, `${pre}/`);
    assert.match(index.body, /Shared from OP-CB for another 30 minutes\. Read only\./);

    // A book: its start page by redirect, its pages with only the type passed on.
    const start = await get(st.port!, `${pre}/book/${BOOK}/`);
    assert.equal(start.status, 302);
    assert.equal(start.headers.location, `${pre}/book/${BOOK}/A/Water`);
    const art = await get(st.port!, `${pre}/book/${BOOK}/A/Water`);
    assert.equal(art.status, 200);
    assert.equal(art.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(art.body, /Boil it/);
    assert.equal(
      (await get(st.port!, `${pre}/book/${BOOK}/A/Old%20name`)).headers.location,
      `${pre}/book/${BOOK}/A/Water`,
    );
    assert.equal((await get(st.port!, `${pre}/book/${BOOK}/A/Nope`)).status, 404);
    assert.equal((await get(st.port!, `${pre}/book/${'c'.repeat(32)}/`)).status, 404);
    assert.equal((await get(st.port!, `${pre}/book/${BOOK}/%E0%A4%A`)).status, 404);

    // A downloaded guide; one not downloaded, or not a guide, is not there.
    const ref = await get(st.port!, `${pre}/ref/usda-canning-01.pdf`);
    assert.equal(ref.status, 200);
    assert.equal(ref.headers['content-type'], 'application/pdf');
    assert.equal(ref.body, '%PDF-1.4 test');
    assert.equal((await get(st.port!, `${pre}/ref/army-fm-5-426.pdf`)).status, 404);
    assert.equal((await get(st.port!, `${pre}/ref/../../etc/passwd`)).status, 404);
    assert.equal((await get(st.port!, `${pre}/ref/%2e%2e%2fcredentials.json`)).status, 404);

    // Search: titles in the books and pages of the guides, escaped.
    const find = await get(st.port!, `${pre}/find?q=water`);
    assert.match(find.body, /Water &amp; wells/);
    assert.match(find.body, new RegExp(`href="${pre}/ref/usda-canning-01.pdf#page=3"`));
    assert.match(find.body, /boiling &lt;water&gt; bath/);
    assert.match((await get(st.port!, `${pre}/find?q=%22%3E%3Cscript%3E`)).body, /value="&quot;&gt;&lt;script&gt;"/);

    // Read only.
    assert.equal((await get(st.port!, `${pre}/`, 'POST')).status, 405);
    assert.equal((await get(st.port!, `${pre}/`, 'HEAD')).body, '');
    assert.equal(share.status().served! >= 10, true);
  } finally {
    await share.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('share: a wrong code is a plain 404, and after twenty the device is not answered', async () => {
  const { share, dir } = await setup();
  try {
    const st = await share.start(30);
    const other = newShareCode();
    const bad = await get(st.port!, `/${other}/`);
    assert.equal(bad.status, 404);
    assert.equal(
      bad.body,
      (await get(st.port!, `/${st.code}/nothing-here`)).body,
      'a wrong code looks like a missing page',
    );
    for (let i = 0; i < 18; i++) await get(st.port!, `/${newShareCode()}/`);
    // Nineteen wrong so far: still answered.
    assert.equal((await get(st.port!, `/${st.code}/`)).status, 200);
    await get(st.port!, `/${newShareCode()}/`);
    await assert.rejects(
      get(st.port!, `/${st.code}/`),
      'after the twentieth wrong code, even the right one is not answered',
    );
  } finally {
    await share.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('share: stop, a new share has a new code, the time runs out; minutes are checked', async () => {
  const { share, dir, setNow, getNow } = await setup();
  try {
    const a = await share.start(30);
    const b = await share.start(120);
    assert.notEqual(a.code, b.code);
    await assert.rejects(get(a.port!, `/${a.code}/`));
    assert.equal((await get(b.port!, `/${a.code}/`)).status, 404, 'the old code is not the new one');
    // Clock put back: still sharing (the timer decides).
    setNow(getNow() - 3_600_000);
    assert.equal(share.status().sharing, true);
    setNow(Date.parse(b.until!) + 1);
    assert.deepEqual(share.status(), { sharing: false });
    await assert.rejects(get(b.port!, `/${b.code}/`));
    for (const m of [0, -1, 1.5, 721, NaN]) await assert.rejects(share.start(m), RangeError);
    assert.deepEqual(await share.stop(), { sharing: false });
  } finally {
    await share.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("share: asked by this computer's own address only, not by a name (DNS rebinding)", async () => {
  const { share, dir } = await setup();
  try {
    const st = await share.start(30);
    const p = `/${st.code}/`;
    assert.equal((await get(st.port!, p)).status, 200);
    assert.equal((await get(st.port!, p, 'GET', `192.168.1.20:${st.port}`)).status, 200);
    assert.equal((await get(st.port!, p, 'GET', `localhost:${st.port}`)).status, 200);
    for (const host of [
      `evil.example:${st.port}`,
      `192.168.1.20:${st.port! + 1}`,
      '192.168.1.20',
      `10.9.9.9:${st.port}`,
      `127.0.0.1:${st.port}x`,
    ])
      assert.equal((await get(st.port!, p, 'GET', host)).status, 421, host);
  } finally {
    await share.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('isPrivatePeer: private and local networks only', () => {
  for (const a of [
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.9',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    '::ffff:192.168.1.5',
    'fd12::1',
    'fe80::1',
  ])
    assert.equal(isPrivatePeer(a), true, a);
  for (const a of [
    undefined,
    '',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '100.128.0.1',
    '2001:db8::1',
    '::ffff:8.8.8.8',
    '300.1.1.1',
    'localhost',
  ])
    assert.equal(isPrivatePeer(a), false, String(a));
});

test('newShareCode: three groups of four from 31 unambiguous characters, all different over many', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const c = newShareCode();
    assert.match(c, /^[23456789abcdefghjkmnpqrstuvwxyz]{4}(-[23456789abcdefghjkmnpqrstuvwxyz]{4}){2}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 5000);
});
