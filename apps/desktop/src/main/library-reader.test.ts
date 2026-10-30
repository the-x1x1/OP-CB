import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READER_CSP, parseReaderUrl, readerResponse, readerUrl, type ReaderSource } from './library-reader-pages.js';

const BOOK = '0123456789abcdef0123456789abcdef';

test('reader addresses: a book id and a key, encoded and read back; anything else refused', () => {
  const u = readerUrl(BOOK, 'Water_(disambiguation)/Ünïcode #1?');
  assert.equal(u.startsWith(`wvzim://${BOOK}/`), true);
  assert.deepEqual(parseReaderUrl(u), { bookId: BOOK, key: 'Water_(disambiguation)/Ünïcode #1?' });
  assert.deepEqual(parseReaderUrl(`wvzim://${BOOK}/A/index`), { bookId: BOOK, key: 'A/index' });
  assert.deepEqual(parseReaderUrl(`wvzim://${BOOK}/`), { bookId: BOOK, key: '' });
  // Relative links resolve inside the book, never above it.
  assert.deepEqual(parseReaderUrl(new URL('../../../etc/passwd', `wvzim://${BOOK}/A/x`).toString()), {
    bookId: BOOK,
    key: 'etc/passwd',
  });
  for (const bad of [
    'worldview://app/index.html',
    'https://example.org/',
    `wvzim://not-a-book/x`,
    `wvzim://${BOOK.toUpperCase()}x/x`,
    `wvzim://${BOOK}/%E0%A4%A`,
    'file:///etc/passwd',
  ])
    assert.equal(parseReaderUrl(bad), undefined, bad);
});

const source: ReaderSource = {
  mainKey: async (id) => (id === BOOK ? 'index' : undefined),
  lookup: async (_id, key) => {
    if (key === 'index')
      return { kind: 'item', item: { mimeType: 'text/html', data: new TextEncoder().encode('<h1>Hi</h1>') } };
    if (key === 'Boiling') return { kind: 'redirect', key: 'Water purification' };
    if (key === 'pic.png') return { kind: 'item', item: { mimeType: 'image/png', data: new Uint8Array([1, 2]) } };
    if (key === 'odd') return { kind: 'item', item: { mimeType: 'text/html"><script>', data: new Uint8Array([1]) } };
    if (key === 'boom') throw new Error('cluster <b>damaged</b>');
    return { kind: 'missing' };
  },
};

test('reader answers: the strict policy on every answer, redirects inside the book, the start page, not found', async () => {
  const page = await readerResponse(source, `wvzim://${BOOK}/index`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('Content-Security-Policy'), READER_CSP);
  assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(READER_CSP, /script-src 'none'/);
  assert.doesNotMatch(READER_CSP, /https?:/);
  assert.equal(await page.text(), '<h1>Hi</h1>');

  const start = await readerResponse(source, `wvzim://${BOOK}/`);
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('Location'), `wvzim://${BOOK}/index`);

  const redirect = await readerResponse(source, `wvzim://${BOOK}/Boiling`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), `wvzim://${BOOK}/Water%20purification`);

  assert.equal((await readerResponse(source, `wvzim://${BOOK}/pic.png`)).headers.get('Content-Type'), 'image/png');
  // A MIME type from the file that is not a MIME type is not passed on.
  assert.equal(
    (await readerResponse(source, `wvzim://${BOOK}/odd`)).headers.get('Content-Type'),
    'text/html; charset=utf-8',
  );
  const missing = await readerResponse(source, `wvzim://${BOOK}/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Content-Security-Policy'), READER_CSP);
  const broken = await readerResponse(source, `wvzim://${BOOK}/boom`);
  assert.equal(broken.status, 404);
  assert.doesNotMatch(await broken.text(), /<b>/);
  assert.equal((await readerResponse(source, 'https://example.org/')).status, 404);
});
