import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startRuntime } from '../helpers/harness.js';
import { buildZim, type ZimItemSpec } from '../helpers/zim-file.js';

/*
 * The library shared through the runtime: a real ZIM on the shelf, read over HTTP from
 * 127.0.0.1 with the share's code, and nothing once the share is stopped.
 */

const items: ZimItemSpec[] = [
  {
    ns: 'C',
    path: 'index',
    title: 'Main Page',
    body: '<h1>Survival library</h1><a href="Water_purification">water</a>',
  },
  { ns: 'C', path: 'Water_purification', title: 'Water purification', body: '<p>Boil water for one minute.</p>' },
  { ns: 'C', path: 'Boiling', title: 'Boiling', redirect: 'C/Water_purification' },
  { ns: 'M', path: 'Title', mime: 'text/plain', body: 'Field medicine' },
  { ns: 'M', path: 'Language', mime: 'text/plain', body: 'eng' },
];

test('share through the runtime: off at start, a ZIM read over HTTP with the code, gone after stop', async () => {
  const h = await startRuntime();
  try {
    assert.deepEqual(await h.client.request('library.share.status', undefined), { sharing: false });
    const dir = path.join(h.dataDir, 'library');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'field.zim'), buildZim(items, { minor: 2 }));
    const book = (await h.client.request('library.shelf', undefined)).books[0]!;

    const st = await h.client.request('library.share.start', { minutes: 30 });
    assert.equal(st.sharing, true);
    const base = `http://127.0.0.1:${st.port}/${st.code}`;
    const index = await fetch(`${base}/`);
    assert.match(await index.text(), /Field medicine/);
    const start = await fetch(`${base}/book/${book.id}/`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const page = await fetch(new URL(start.headers.get('location')!, base));
    assert.match(await page.text(), /Survival library/);
    // A link inside the page, followed relative to it, stays in the book and under the code.
    const linked = await fetch(new URL('Water_purification', page.url));
    assert.equal(linked.status, 200);
    assert.match(await linked.text(), /Boil water for one minute/);
    const find = await (await fetch(`${base}/find?q=boil`)).text();
    assert.match(find, /Boiling|Water purification/);
    assert.equal((await fetch(`http://127.0.0.1:${st.port}/wrong-code-here/`)).status, 404);

    assert.deepEqual(await h.client.request('library.share.stop', undefined), { sharing: false });
    await assert.rejects(fetch(`${base}/`));
    await assert.rejects(h.client.request('library.share.start', { minutes: 45 } as never));
  } finally {
    await h.dispose();
  }
});

test('share through the runtime: closing OP-CB ends the share', async () => {
  const h = await startRuntime();
  const st = await h.client.request('library.share.start', { minutes: 720 });
  await h.dispose();
  await assert.rejects(fetch(`http://127.0.0.1:${st.port}/${st.code}/`));
});
