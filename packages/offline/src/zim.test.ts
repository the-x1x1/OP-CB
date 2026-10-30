import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { ZIM_MAGIC, ZimArchive, ZimError, htmlToText, readZimHeader, type ZimSource } from './zim.js';

/*
 * ZIM files built here, laid out as the openZIM format describes (see zim.ts); no file from
 * outside is included. The reader was also run against the openZIM testing suite's own files
 * (outside this repository) on 2026-10-30: old and new namespace schemes, a 2024 Kiwix
 * Wikipedia selection, and the suite's damaged files.
 */

interface Item {
  ns: string;
  path: string;
  title?: string;
  mime?: string;
  body?: string | Uint8Array;
  redirect?: string;
  plain?: boolean;
}

const zstd = (zlib as unknown as { zstdCompressSync?: (b: Uint8Array) => Buffer }).zstdCompressSync;

function cluster(blobs: Uint8Array[], compression: 1 | 4 | 5): Uint8Array {
  const offs: number[] = [];
  let at = 4 * (blobs.length + 1);
  for (const b of blobs) {
    offs.push(at);
    at += b.length;
  }
  offs.push(at);
  const table = Buffer.alloc(offs.length * 4);
  offs.forEach((o, i) => table.writeUInt32LE(o, i * 4));
  const raw = Buffer.concat([table, ...blobs]);
  const body = compression === 5 ? zstd!(raw) : compression === 4 ? Buffer.from([0xfd, 0x37, 0x7a]) : raw;
  return Buffer.concat([Buffer.from([compression]), body]);
}

function buildZim(items: Item[], opts: { minor?: number; noTitleList?: boolean; xz?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const key = (i: Item) => Buffer.from(i.ns + i.path);
  const sorted = [...items].sort((a, b) => Buffer.compare(key(a), key(b)));
  const index = new Map(sorted.map((it, i) => [it.ns + '/' + it.path, i]));
  const mimes = [...new Set(sorted.filter((i) => !i.redirect).map((i) => i.mime ?? 'text/html'))].sort();
  const packed: Uint8Array[] = [];
  const plain: Uint8Array[] = [];
  const where = new Map<number, [number, number]>();
  sorted.forEach((it, i) => {
    if (it.redirect) return;
    const body = typeof it.body === 'string' ? enc.encode(it.body) : (it.body ?? new Uint8Array(0));
    if (it.plain) where.set(i, [1, plain.push(body) - 1]);
    else where.set(i, [0, packed.push(body) - 1]);
  });
  const dirents = sorted.map((it, i) => {
    const head = Buffer.alloc(it.redirect ? 12 : 16);
    head.writeUInt16LE(it.redirect ? 0xffff : mimes.indexOf(it.mime ?? 'text/html'), 0);
    head[2] = 0;
    head[3] = it.ns.charCodeAt(0);
    if (it.redirect) head.writeUInt32LE(index.get(it.redirect)!, 8);
    else {
      head.writeUInt32LE(where.get(i)![0], 8);
      head.writeUInt32LE(where.get(i)![1], 12);
    }
    return Buffer.concat([head, Buffer.from(it.path + '\0' + (it.title ?? '') + '\0')]);
  });
  const titleOrder = sorted
    .map((it, i) => ({ i, k: Buffer.from(it.ns + (it.title || it.path)) }))
    .sort((a, b) => Buffer.compare(a.k, b.k))
    .map((x) => x.i);
  const mimeBytes = Buffer.from(mimes.map((m) => m + '\0').join('') + '\0');
  const clusters = [cluster(packed, opts.xz ? 4 : 5), cluster(plain, 1)];
  const n = sorted.length;
  let at = 80;
  const mimePos = at;
  at += mimeBytes.length;
  const urlPos = at;
  at += 8 * n;
  const titlePos = at;
  at += 4 * n;
  const direntPos: number[] = [];
  for (const d of dirents) {
    direntPos.push(at);
    at += d.length;
  }
  const clusterPtrPos = at;
  at += 8 * clusters.length;
  const clusterPos: number[] = [];
  for (const c of clusters) {
    clusterPos.push(at);
    at += c.length;
  }
  const checksumPos = at;
  const header = Buffer.alloc(80);
  header.writeUInt32LE(ZIM_MAGIC, 0);
  header.writeUInt16LE(opts.minor !== undefined ? 6 : 5, 4);
  header.writeUInt16LE(opts.minor ?? 0, 6);
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(header, 8);
  header.writeUInt32LE(n, 24);
  header.writeUInt32LE(clusters.length, 28);
  header.writeBigUInt64LE(BigInt(urlPos), 32);
  header.writeBigUInt64LE(opts.noTitleList ? 0xffffffffffffffffn : BigInt(titlePos), 40);
  header.writeBigUInt64LE(BigInt(clusterPtrPos), 48);
  header.writeBigUInt64LE(BigInt(mimePos), 56);
  const main = index.get(opts.minor !== undefined ? 'C/index' : 'A/index');
  header.writeUInt32LE(main ?? 0xffffffff, 64);
  header.writeUInt32LE(0xffffffff, 68);
  header.writeBigUInt64LE(BigInt(checksumPos), 72);
  const url = Buffer.alloc(8 * n);
  direntPos.forEach((p, i) => url.writeBigUInt64LE(BigInt(p), i * 8));
  const title = Buffer.alloc(4 * n);
  titleOrder.forEach((p, i) => title.writeUInt32LE(p, i * 4));
  const cptr = Buffer.alloc(8 * clusters.length);
  clusterPos.forEach((p, i) => cptr.writeBigUInt64LE(BigInt(p), i * 8));
  const body = Buffer.concat([header, mimeBytes, url, title, ...dirents, cptr, ...clusters]);
  return Buffer.concat([body, createHash('md5').update(body).digest()]);
}

function mem(b: Uint8Array): ZimSource & { reads: number } {
  const s = {
    size: b.length,
    reads: 0,
    read: async (o: number, l: number) => {
      s.reads++;
      return b.slice(o, Math.min(b.length, o + l));
    },
  };
  return s;
}

const newScheme: Item[] = [
  { ns: 'C', path: 'index', title: 'Main Page', body: '<html><body><h1>Welcome</h1><p>Start here.</p></body></html>' },
  { ns: 'C', path: 'Water_purification', title: 'Water purification', body: '<p>Boil water for one minute.</p>' },
  { ns: 'C', path: 'Water_tower', title: 'Water tower', body: '<p>A tower.</p>' },
  { ns: 'C', path: 'Boiling_water', title: 'Boiling water', redirect: 'C/Water_purification' },
  { ns: 'C', path: 'wound.png', mime: 'image/png', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), plain: true },
  {
    ns: 'C',
    path: 'wound_care',
    title: 'wound care',
    body: '<p>Clean <b>wounds</b> &amp; cover.<script>x()</script></p>',
  },
  { ns: 'M', path: 'Title', mime: 'text/plain', body: 'Survival library' },
  { ns: 'M', path: 'Language', mime: 'text/plain', body: 'eng' },
  { ns: 'W', path: 'mainPage', redirect: 'C/index' },
];

test('new namespace scheme: header, metadata, main page, lookup by path, redirects, plain and zstd clusters', async () => {
  assert.ok(zstd, 'this Node reads zstd (22.15 and later; the app needs it for every Kiwix file since 2021)');
  const z = await ZimArchive.open(mem(buildZim(newScheme, { minor: 2 })));
  assert.equal(z.newNamespaces, true);
  assert.equal(z.contentNamespace, 'C');
  assert.equal(z.header.uuid, '00112233445566778899aabbccddeeff');
  assert.deepEqual(await z.metadata(['Title', 'Language', 'Creator']), { Title: 'Survival library', Language: 'eng' });
  const main = await z.mainEntry();
  assert.equal(main?.path, 'index');
  assert.match(Buffer.from((await z.content(main!)).data).toString(), /Welcome/);
  const redirect = await z.find('C', 'Boiling_water');
  assert.equal(redirect?.redirectTo !== undefined, true);
  const target = await z.content(redirect!);
  assert.equal(Buffer.from(target.data).toString(), '<p>Boil water for one minute.</p>');
  const img = await z.content((await z.find('C', 'wound.png'))!);
  assert.equal(img.mimeType, 'image/png');
  assert.deepEqual([...img.data], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(await z.find('C', 'Nope'), undefined);
  assert.equal(await z.verifyChecksum(), true);
});

test('title search: prefix as typed and with the first letter in either case; images left out', async () => {
  if (!zstd) return;
  const z = await ZimArchive.open(mem(buildZim(newScheme, { minor: 2 })));
  assert.deepEqual(
    (await z.titlesStartingWith('water')).map((e) => e.title),
    ['Water purification', 'Water tower'],
  );
  assert.deepEqual(
    (await z.titlesStartingWith('Wound')).map((e) => e.title),
    ['wound care'],
  );
  assert.deepEqual(
    (await z.titlesStartingWith('boil')).map((e) => [e.title, e.redirectTo !== undefined]),
    [['Boiling water', true]],
  );
  assert.deepEqual(await z.titlesStartingWith('   '), []);
  assert.deepEqual(await z.titlesStartingWith('Wound.png'), []);
});

test('old namespace scheme: content in A, main page from the header', async () => {
  if (!zstd) return;
  const old = newScheme
    .filter((i) => i.ns !== 'W')
    .map((i) => ({
      ...i,
      ns: i.ns === 'C' ? 'A' : i.ns,
      ...(i.redirect ? { redirect: i.redirect.replace(/^C\//, 'A/') } : {}),
    }));
  const z = await ZimArchive.open(mem(buildZim(old)));
  assert.equal(z.newNamespaces, false);
  assert.equal(z.contentNamespace, 'A');
  assert.equal((await z.mainEntry())?.path, 'index');
  assert.deepEqual(
    (await z.titlesStartingWith('Water')).map((e) => e.title),
    ['Water purification', 'Water tower'],
  );
});

test('refusals: not a ZIM, damaged positions, a changed byte, and the older xz compression', async () => {
  await assert.rejects(ZimArchive.open(mem(new Uint8Array(40))), (e: unknown) => (e as ZimError).code === 'not-zim');
  const bad = Buffer.alloc(80);
  assert.throws(() => readZimHeader(bad, 80), /not a ZIM/);
  if (!zstd) return;
  const good = buildZim(newScheme, { minor: 2 });
  const broken = Buffer.from(good);
  broken.writeBigUInt64LE(BigInt(good.length + 100), 32); // entry list beyond the end
  await assert.rejects(ZimArchive.open(mem(broken)), /entry list is outside/);
  const flipped = Buffer.from(good);
  flipped[100] = flipped[100]! ^ 0xff;
  assert.equal(await (await ZimArchive.open(mem(flipped))).verifyChecksum(), false);
  const xz = await ZimArchive.open(mem(buildZim(newScheme, { minor: 2, xz: true })));
  await assert.rejects(xz.content((await xz.find('C', 'index'))!), /older xz compression/);
  // The plain cluster is still readable in that file.
  assert.equal((await xz.content((await xz.find('C', 'wound.png'))!)).data.length, 4);
});

test('no title list in the header: title search uses nothing rather than guessing', async () => {
  if (!zstd) return;
  const z = await ZimArchive.open(mem(buildZim(newScheme, { minor: 2, noTitleList: true })));
  assert.equal(z.header.titlePtrPos, undefined);
  assert.equal(await z.hasTitleList(), false);
  assert.deepEqual(await z.titlesStartingWith('Water'), []);
});

test('article text: tags, scripts and entities removed', () => {
  assert.equal(
    htmlToText('<p>Clean <b>wounds</b> &amp; cover.<script>x()</script></p><p>Then&nbsp;rest</p>'),
    'Clean wounds & cover.\nThen rest',
  );
});
