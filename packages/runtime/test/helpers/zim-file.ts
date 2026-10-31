import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { ZIM_MAGIC } from '@opcb/offline';

/** A small ZIM file built here for tests, laid out as packages/offline/src/zim.ts describes. */
export interface ZimItemSpec {
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

export function buildZim(
  items: ZimItemSpec[],
  opts: { minor?: number; noTitleList?: boolean; xz?: boolean } = {},
): Uint8Array {
  const enc = new TextEncoder();
  const key = (i: ZimItemSpec) => Buffer.from(i.ns + i.path);
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
