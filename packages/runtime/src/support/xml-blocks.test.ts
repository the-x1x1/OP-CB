import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog, readMetalink } from './library-downloads.js';
import { readKiwixCatalog, readKiwixSearch } from './local-services.js';
import {
  BodyTooLarge,
  firstXmlBlock,
  readTextCapped,
  stripXmlTags,
  withoutXmlBlocks,
  xmlBlocks,
  xmlStartTags,
  xmlTagText,
  xmlText,
} from './xml-blocks.js';

test('xmlBlocks: each element of a name, with its start tag and what it holds, in order', () => {
  const text =
    '<feed><entry><id>1</id></entry> <entry lang="en">two</entry><entries>no</entries><entry/><entry>4</entry></feed>';
  const blocks = xmlBlocks(text, 'entry');
  assert.deepEqual(
    blocks.map((b) => [b.startTag, b.body]),
    [
      ['<entry>', '<id>1</id>'],
      ['<entry lang="en">', 'two'],
      ['<entry/>', ''],
      ['<entry>', '4'],
    ],
  );
  for (const b of blocks) assert.ok(text.slice(b.start, b.end).startsWith(b.startTag));
  assert.equal(xmlBlocks(text, 'entry', 2).length, 2);
  assert.deepEqual(xmlBlocks(text, 'missing'), []);
  assert.deepEqual(xmlBlocks('', 'entry'), []);
  assert.equal(firstXmlBlock(text, 'entry')!.body, '<id>1</id>');
  assert.equal(firstXmlBlock(text, 'missing'), undefined);
  // An element left open ends the reading: nothing after it can be closed either.
  assert.deepEqual(
    xmlBlocks('<entry>a</entry><entry>never closed <entry>x', 'entry').map((b) => b.body),
    ['a'],
  );
  assert.deepEqual(xmlBlocks('<entry>a</entry><entry never closed', 'entry').length, 1);
  assert.equal(xmlBlocks('<dc:issued>2026-01-01</dc:issued>', 'dc:issued')[0]!.body, '2026-01-01');
});

test('withoutXmlBlocks and xmlStartTags', () => {
  const text = 'a<author><name>X</name></author>b<author>Y</author>c<authority>kept</authority>';
  assert.equal(withoutXmlBlocks(text, 'author'), 'abc<authority>kept</authority>');
  assert.equal(withoutXmlBlocks(text, 'missing'), text);
  assert.equal(withoutXmlBlocks('a<author>open', 'author'), 'a<author>open');
  assert.deepEqual(xmlStartTags('<link rel="a" href="1"/><linkage/><link\nrel="b">x</link><link', 'link'), [
    '<link rel="a" href="1"/>',
    '<link\nrel="b">',
  ]);
  assert.equal(xmlStartTags('<link a><link b><link c>', 'link', 2).length, 2);
});

test('xmlText and xmlTagText: CDATA unwrapped, each reference decoded once, what names no character left out', () => {
  assert.equal(xmlText('  Tom &amp; Jerry &lt;3 &quot;x&quot; &apos;y&apos;  '), 'Tom & Jerry <3 "x" \'y\'');
  assert.equal(xmlText('<![CDATA[a < b & c]]> and <![CDATA[more]]>'), 'a < b & c and more');
  assert.equal(xmlText('<![CDATA[never closed'), '<![CDATA[never closed');
  assert.equal(xmlText('&amp;#38; &amp;lt;'), '&#38; &lt;', 'decoded once, not twice');
  assert.equal(xmlText('&#65;&#x42;&#x1F30B;'), 'AB\u{1F30B}');
  assert.equal(xmlText('a&#0;b&#55296;c&#x110000;d&#9999999;e'), 'abcde');
  assert.equal(xmlText('&unknown; &;'), '&unknown; &;');
  assert.equal(xmlText(''), '');
  assert.equal(xmlTagText('<title> A &amp; B </title><title>second</title>', 'title'), 'A & B');
  assert.equal(xmlTagText('<title type="text">typed</title>', 'title'), 'typed');
  assert.equal(xmlTagText('<title/>', 'title'), '');
  assert.equal(xmlTagText('<subtitle>x</subtitle>', 'title'), undefined);
});

test('stripXmlTags: the text of a snippet without its marks', () => {
  assert.equal(stripXmlTags('clean <b>water</b> and <i class="x">rest</i>'), 'clean water and rest');
  assert.equal(stripXmlTags('2 < 3'), '2 < 3');
  assert.equal(stripXmlTags('a <b unfinished'), 'a <b unfinished');
  assert.equal(stripXmlTags(''), '');
});

test('the catalogue, Metalink and search readers still read what they read', () => {
  const catalog = readCatalog(
    '<feed xmlns="http://www.w3.org/2005/Atom"><totalResults>2</totalResults>' +
      '<entry><id>urn:uuid:abc</id><title>First &amp; Aid</title><name>firstaid_en</name><language>eng</language>' +
      '<author><name>Someone</name></author><publisher><name>Pub</name></publisher><dc:issued>2026-03-04T00:00:00Z</dc:issued>' +
      '<link rel="http://opds-spec.org/image/thumbnail" href="/x.png"/>' +
      '<link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="https://download.kiwix.org/zim/other/firstaid_en.zim.meta4" length="1048576"/></entry>' +
      '<entry><id>urn:uuid:def</id><title>No link</title><name>nolink</name></entry></feed>',
  );
  assert.equal(catalog.total, 2);
  assert.deepEqual(catalog.entries, [
    {
      id: 'abc',
      name: 'firstaid_en',
      title: 'First & Aid',
      url: 'https://download.kiwix.org/zim/other/firstaid_en.zim.meta4',
      language: 'eng',
      issued: '2026-03-04',
      sizeBytes: 1_048_576,
    },
  ]);
  assert.throws(() => readCatalog('<html>'), /not an OPDS catalogue/);

  const sha = 'ab'.repeat(32);
  const meta = readMetalink(
    `<metalink xmlns="urn:ietf:params:xml:ns:metalink"><file name="firstaid_en.zim"><size>1048576</size>` +
      `<hash type="md5">ignored</hash><hash type="sha-256">${sha.toUpperCase()}</hash>` +
      `<pieces length="1" type="sha-1"><hash>p1</hash><hash type="sha-256">${'cd'.repeat(32)}</hash></pieces>` +
      `<url location="us" priority="2">https://mirror.example/b.zim</url><url priority="1">https://download.kiwix.org/a.zim</url>` +
      `<url priority="0">http://plain.example/c.zim</url><url>https://last.example/d.zim</url></file></metalink>`,
  );
  assert.deepEqual(meta, {
    name: 'firstaid_en.zim',
    size: 1_048_576,
    sha256: sha,
    urls: ['https://download.kiwix.org/a.zim', 'https://mirror.example/b.zim', 'https://last.example/d.zim'],
  });
  assert.throws(() => readMetalink('<html>'), /not a Metalink file/);
  assert.throws(() => readMetalink('<metalink></metalink>'), /names no file/);

  const books = readKiwixCatalog(
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:uuid:1</id><title>Wiki</title><name>wiki_en</name>' +
      '<language>eng</language><tags>wikipedia;_ftindex:yes</tags><author><name>Author</name></author></entry>' +
      '<entry><id>urn:uuid:2</id><title>Small</title><author><name>Only the author</name></author><tags>_ftindex:no</tags></entry></feed>',
  );
  assert.deepEqual(books, [
    { id: '1', title: 'Wiki', name: 'wiki_en', language: 'eng', fullText: true },
    { id: '2', title: 'Small', fullText: false },
  ]);

  const hits = readKiwixSearch(
    '<rss><channel><item><title>Water</title><link>/content/wiki_en/A/Water</link>' +
      '<description>Clean <b>water</b> &amp; rest</description><book><title>Wiki</title></book></item>' +
      '<item><title>Elsewhere</title><link>https://evil.example/content/x</link></item></channel></rss>',
  );
  assert.deepEqual(hits, [
    { title: 'Water', path: '/content/wiki_en/A/Water', snippet: 'Clean water & rest', book: 'Wiki' },
  ]);
});

test('a megabyte of start tags with no end tag is read in a moment by every reader', () => {
  const feed = '<feed xmlns="http://www.w3.org/2005/Atom">';
  const quick = (name: string, read: () => unknown) => {
    const started = Date.now();
    try {
      read();
    } catch {
      /* refused is fine; slow is not */
    }
    assert.ok(Date.now() - started < 1500, `${name} took ${Date.now() - started} ms`);
  };
  quick('catalogue, unclosed entries', () => readCatalog(feed + '<entry>'.repeat(150_000)));
  quick('catalogue, unclosed authors', () => readCatalog(`${feed}<entry>${'<author>'.repeat(130_000)}</entry>`));
  quick('catalogue, unclosed CDATA', () =>
    readCatalog(`${feed}<entry><id>1</id><title>${'<![CDATA['.repeat(110_000)}</title></entry>`),
  );
  quick('catalogue, unfinished links', () =>
    readCatalog(`${feed}<entry><id>1</id><title>t</title><name>n</name>${'<link '.repeat(170_000)}</entry>`),
  );
  quick('Metalink, unclosed pieces', () =>
    readMetalink(`<metalink><file name="a">${'<pieces'.repeat(150_000)}</file></metalink>`),
  );
  quick('Metalink, unfinished files', () => readMetalink(`<metalink>${'<file x'.repeat(150_000)}`));
  quick('Metalink, unfinished urls', () =>
    readMetalink(`<metalink><file name="a">${'<url '.repeat(200_000)}</file></metalink>`),
  );
  quick('library catalogue, unclosed entries', () => readKiwixCatalog(feed + '<entry>'.repeat(150_000)));
  quick('search, unclosed items', () => readKiwixSearch(`<rss>${'<item>'.repeat(170_000)}`));
  quick('search, unclosed books', () => readKiwixSearch(`<rss><item>${'<book>'.repeat(170_000)}</item></rss>`));
  quick('search, a snippet of <', () =>
    readKiwixSearch(
      `<rss><item><title>t</title><link>/content/x/A</link><description>${'&lt;'.repeat(1)}${'<'.repeat(900_000)}</description></item></rss>`,
    ),
  );
});

test('readTextCapped: the body as text up to the limit, refused beyond it by its declared or its real size', async () => {
  const body = (chunks: string[], headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
      { headers },
    );
  assert.equal(await readTextCapped(body(['hello ', 'wörld']), 100), 'hello wörld');
  assert.equal(await readTextCapped(body([]), 100), '');
  assert.equal(await readTextCapped(body(['12345']), 5), '12345', 'exactly the limit');
  await assert.rejects(readTextCapped(body(['123456']), 5), BodyTooLarge);
  await assert.rejects(readTextCapped(body(['123', '456']), 5), BodyTooLarge);
  await assert.rejects(readTextCapped(body(['x'], { 'content-length': '999999' }), 5), BodyTooLarge);
  // A character split across two chunks is one character.
  const bytes = new TextEncoder().encode('é');
  const split = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1));
        controller.enqueue(bytes.subarray(1));
        controller.close();
      },
    }),
  );
  assert.equal(await readTextCapped(split, 100), 'é');
  // A stand-in with only text() is held to the limit too.
  const plain = (text: string) => ({ text: () => Promise.resolve(text) }) as unknown as Response;
  assert.equal(await readTextCapped(plain('abc'), 3), 'abc');
  await assert.rejects(readTextCapped(plain('abcd'), 3), /larger than/);
});
