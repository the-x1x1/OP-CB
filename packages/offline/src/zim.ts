import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

/**
 * A reader for ZIM files — the offline archives Kiwix publishes (Wikipedia, WikiMed, iFixit,
 * survival and medicine collections, …) — so WorldView can open them itself, with no Kiwix
 * program installed (operator decision 2026-10-30).
 *
 * Written from the openZIM file format as libzim lays it out and as the openZIM test files
 * show it; no openZIM code is included. Checked against the openZIM testing suite's own files
 * (old and new namespace schemes, and a 2024 Kiwix Wikipedia selection), which are not part of
 * this repository.
 *
 * What it does: header and MIME list, the URL-sorted entry list (find by path), the
 * title-sorted list (find by title prefix), redirects, metadata, the main page, clusters stored
 * plain or zstd-compressed (every Kiwix file made since 2021), and the file's MD5 checksum.
 * What it does not do: xz-compressed clusters (files made before about 2021 — open those with
 * kiwix-serve, or download a newer copy) and the Xapian full-text index (title search only).
 *
 * Layout (all little-endian), header 80 bytes:
 *   0 magic u32 = 72173914 · 4 major u16 · 6 minor u16 · 8 uuid[16] · 24 entryCount u32
 *   28 clusterCount u32 · 32 urlPtrPos u64 · 40 titlePtrPos u64 · 48 clusterPtrPos u64
 *   56 mimeListPos u64 · 64 mainPage u32 · 68 layoutPage u32 · 72 checksumPos u64
 * Entry: mime u16 · paramLen u8 · namespace u8 · revision u32 · then cluster u32 + blob u32
 *   (content) or redirect index u32 (mime 0xffff) · path\0 · title\0 · parameter bytes.
 * Cluster: one info byte (low 4 bits compression: 0/1 none, 4 xz, 5 zstd; 0x10 = 8-byte
 *   offsets), then — compressed or not — the blob offset table and the blobs.
 */

export const ZIM_MAGIC = 72173914;
export const ZIM_HEADER_SIZE = 80;
const NO_PAGE = 0xffffffff;
const REDIRECT = 0xffff;
const LINK_TARGET = 0xfffe;
const DELETED = 0xfffd;
/** A single cluster is never allowed to decompress to more than this. */
export const MAX_CLUSTER_BYTES = 512 * 1024 * 1024;

export interface ZimSource {
  /** Total size of the file. */
  readonly size: number;
  /** Up to `length` bytes from `offset`; fewer only at the end of the file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZimHeader {
  majorVersion: number;
  minorVersion: number;
  uuid: string;
  entryCount: number;
  clusterCount: number;
  urlPtrPos: number;
  /** Undefined when the file has no title list in the header (newer files may leave it out). */
  titlePtrPos: number | undefined;
  clusterPtrPos: number;
  mimeListPos: number;
  mainPage: number | undefined;
  layoutPage: number | undefined;
  checksumPos: number;
}

export interface ZimEntry {
  /** Position in the URL-sorted list. */
  index: number;
  namespace: string;
  path: string;
  title: string;
  /** Present for content entries. */
  mimeType?: string;
  cluster?: number;
  blob?: number;
  /** Present for redirects: the index of the entry pointed to. */
  redirectTo?: number;
}

export class ZimError extends Error {
  constructor(
    message: string,
    readonly code: 'not-zim' | 'damaged' | 'unsupported' | 'too-large',
  ) {
    super(message);
    this.name = 'ZimError';
  }
}

function u64(view: DataView, at: number): number {
  const lo = view.getUint32(at, true);
  const hi = view.getUint32(at + 4, true);
  if (hi > 0x1fffff) throw new ZimError('an offset is beyond what can be read', 'damaged');
  return hi * 2 ** 32 + lo;
}

function viewOf(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function readZimHeader(b: Uint8Array, fileSize: number): ZimHeader {
  if (b.length < ZIM_HEADER_SIZE) throw new ZimError('the file is smaller than a ZIM header', 'not-zim');
  const v = viewOf(b);
  if (v.getUint32(0, true) !== ZIM_MAGIC) throw new ZimError('not a ZIM file', 'not-zim');
  const uuid = Buffer.from(b.subarray(8, 24)).toString('hex');
  const h: ZimHeader = {
    majorVersion: v.getUint16(4, true),
    minorVersion: v.getUint16(6, true),
    uuid,
    entryCount: v.getUint32(24, true),
    clusterCount: v.getUint32(28, true),
    urlPtrPos: u64(v, 32),
    titlePtrPos: v.getUint32(44, true) > 0x1fffff ? undefined : u64(v, 40),
    clusterPtrPos: u64(v, 48),
    mimeListPos: u64(v, 56),
    mainPage: v.getUint32(64, true) === NO_PAGE ? undefined : v.getUint32(64, true),
    layoutPage: v.getUint32(68, true) === NO_PAGE ? undefined : v.getUint32(68, true),
    checksumPos: u64(v, 72),
  };
  if (h.majorVersion !== 5 && h.majorVersion !== 6)
    throw new ZimError(`ZIM version ${h.majorVersion} is not one this reader knows`, 'unsupported');
  const within = (pos: number, len: number) => pos >= ZIM_HEADER_SIZE && pos + len <= fileSize;
  if (!within(h.checksumPos, 16)) throw new ZimError('the checksum position is outside the file', 'damaged');
  if (!within(h.mimeListPos, 1) || h.mimeListPos >= h.checksumPos)
    throw new ZimError('the MIME list position is outside the file', 'damaged');
  if (!within(h.urlPtrPos, h.entryCount * 8)) throw new ZimError('the entry list is outside the file', 'damaged');
  if (h.titlePtrPos !== undefined && !within(h.titlePtrPos, h.entryCount * 4)) h.titlePtrPos = undefined;
  if (!within(h.clusterPtrPos, h.clusterCount * 8))
    throw new ZimError('the cluster list is outside the file', 'damaged');
  if (h.mainPage !== undefined && h.mainPage >= h.entryCount)
    throw new ZimError('the main page points past the last entry', 'damaged');
  return h;
}

/** The zero-terminated MIME type strings, ending at an empty one. */
export function readMimeList(b: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const end = b.indexOf(0, at);
    if (end < 0) throw new ZimError('the MIME list does not end', 'damaged');
    if (end === at) return out;
    out.push(Buffer.from(b.subarray(at, end)).toString('utf8'));
    at = end + 1;
    if (out.length > 4096) throw new ZimError('the MIME list is too long', 'damaged');
  }
}

/** Decode one entry from bytes starting at it; undefined when the bytes stop before it ends. */
export function decodeZimEntry(b: Uint8Array, index: number, mimeTypes: readonly string[]): ZimEntry | undefined {
  if (b.length < 8) return undefined;
  const v = viewOf(b);
  const mime = v.getUint16(0, true);
  const paramLen = b[2]!;
  const namespace = String.fromCharCode(b[3]!);
  let at: number;
  const e: ZimEntry = { index, namespace, path: '', title: '' };
  if (mime === REDIRECT) {
    if (b.length < 12) return undefined;
    e.redirectTo = v.getUint32(8, true);
    at = 12;
  } else if (mime === LINK_TARGET || mime === DELETED) {
    at = 8;
  } else {
    if (b.length < 16) return undefined;
    const type = mimeTypes[mime];
    if (type === undefined)
      throw new ZimError(`entry ${index} names MIME type ${mime}, which is not listed`, 'damaged');
    e.mimeType = type;
    e.cluster = v.getUint32(8, true);
    e.blob = v.getUint32(12, true);
    at = 16;
  }
  const pathEnd = b.indexOf(0, at);
  if (pathEnd < 0) return undefined;
  const titleEnd = b.indexOf(0, pathEnd + 1);
  if (titleEnd < 0 || titleEnd + 1 + paramLen > b.length) return undefined;
  e.path = Buffer.from(b.subarray(at, pathEnd)).toString('utf8');
  const title = Buffer.from(b.subarray(pathEnd + 1, titleEnd)).toString('utf8');
  e.title = title || e.path;
  return e;
}

type Zstd = (buf: Uint8Array, opts: { maxOutputLength: number }, cb: (err: Error | null, out: Buffer) => void) => void;

async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  const fn = (zlib as unknown as { zstdDecompress?: Zstd }).zstdDecompress;
  if (!fn) throw new ZimError('this build cannot read zstd-compressed ZIM files', 'unsupported');
  return new Promise((resolve, reject) =>
    fn(data, { maxOutputLength: MAX_CLUSTER_BYTES }, (err, out) =>
      err
        ? reject(
            err instanceof RangeError || /maxOutputLength|buffer/i.test(err.message)
              ? new ZimError('a cluster is larger than WorldView reads', 'too-large')
              : new ZimError(`a cluster could not be decompressed (${err.message})`, 'damaged'),
          )
        : resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
    ),
  );
}

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(a, b);
}

const enc = new TextEncoder();

/**
 * One open ZIM file. Reads only what it needs: a lookup is a binary search over the pointer
 * lists, a few small reads each; an article is one cluster (cached, the last few).
 */
export class ZimArchive {
  private readonly clusterCache = new Map<number, Promise<{ offsets: number[]; data: Uint8Array }>>();
  private readonly entryCache = new Map<number, ZimEntry>();

  private constructor(
    private readonly src: ZimSource,
    readonly header: ZimHeader,
    readonly mimeTypes: readonly string[],
  ) {}

  static async open(src: ZimSource): Promise<ZimArchive> {
    const head = await src.read(0, ZIM_HEADER_SIZE);
    const header = readZimHeader(head, src.size);
    const mimeBytes = await src.read(header.mimeListPos, Math.min(64 * 1024, header.checksumPos - header.mimeListPos));
    return new ZimArchive(src, header, readMimeList(mimeBytes));
  }

  /** New namespace scheme (libzim 7, minor version ≥ 1): content in C, metadata in M. */
  get newNamespaces(): boolean {
    return this.header.majorVersion === 6 && this.header.minorVersion >= 1;
  }

  /** Where readable content lives: C in new files, A in old ones. */
  get contentNamespace(): string {
    return this.newNamespaces ? 'C' : 'A';
  }

  private async readExact(offset: number, length: number): Promise<Uint8Array> {
    const b = await this.src.read(offset, length);
    if (b.length !== length) throw new ZimError('the file ends early', 'damaged');
    return b;
  }

  private async pointer(listPos: number, index: number, width: 4 | 8): Promise<number> {
    const b = await this.readExact(listPos + index * width, width);
    return width === 8 ? u64(viewOf(b), 0) : viewOf(b).getUint32(0, true);
  }

  /** The entry at a position of the URL-sorted list. */
  async entry(index: number): Promise<ZimEntry> {
    if (!Number.isInteger(index) || index < 0 || index >= this.header.entryCount)
      throw new ZimError(`entry ${index} is outside the file`, 'damaged');
    const cached = this.entryCache.get(index);
    if (cached) return cached;
    const at = await this.pointer(this.header.urlPtrPos, index, 8);
    if (at < ZIM_HEADER_SIZE || at >= this.header.checksumPos)
      throw new ZimError(`entry ${index} points outside the file`, 'damaged');
    let want = 512;
    for (;;) {
      const b = await this.src.read(at, Math.min(want, this.header.checksumPos - at));
      const e = decodeZimEntry(b, index, this.mimeTypes);
      if (e) {
        if (this.entryCache.size > 4096) this.entryCache.clear();
        this.entryCache.set(index, e);
        return e;
      }
      if (want >= 1 << 20 || at + b.length >= this.header.checksumPos)
        throw new ZimError(`entry ${index} does not end`, 'damaged');
      want *= 8;
    }
  }

  private frontList: Promise<Uint32Array | undefined> | undefined;

  /**
   * The title-sorted list: the header's (every entry), or else the file's list of front
   * articles (X/listing/titleOrdered/v1), or none.
   */
  private async titleList(): Promise<{ count: number; at: (i: number) => Promise<number> } | undefined> {
    const pos = this.header.titlePtrPos;
    if (pos !== undefined) return { count: this.header.entryCount, at: (i) => this.pointer(pos, i, 4) };
    this.frontList ??= (async () => {
      const e = this.newNamespaces ? await this.find('X', 'listing/titleOrdered/v1') : undefined;
      if (!e) return undefined;
      const { data } = await this.content(e);
      const v = viewOf(data);
      const list = new Uint32Array(Math.floor(data.length / 4));
      for (let i = 0; i < list.length; i++) list[i] = v.getUint32(i * 4, true);
      return list;
    })();
    const list = await this.frontList;
    return list ? { count: list.length, at: async (i) => list[i]! } : undefined;
  }

  /** Whether title search is possible in this file. */
  async hasTitleList(): Promise<boolean> {
    return (await this.titleList()) !== undefined;
  }

  /** Find by namespace and path (exact, as stored). */
  async find(namespace: string, path: string): Promise<ZimEntry | undefined> {
    const want = enc.encode(namespace + path);
    let lo = 0;
    let hi = this.header.entryCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const e = await this.entry(mid);
      const c = byteCompare(enc.encode(e.namespace + e.path), want);
      if (c === 0) return e;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  /** Follow redirects to content (at most 16 hops). */
  async resolve(e: ZimEntry): Promise<ZimEntry> {
    let cur = e;
    for (let hops = 0; cur.redirectTo !== undefined; hops++) {
      if (hops >= 16) throw new ZimError('a redirect goes round in circles', 'damaged');
      cur = await this.entry(cur.redirectTo);
    }
    return cur;
  }

  /** The main page entry, resolved, or undefined when the file names none. */
  async mainEntry(): Promise<ZimEntry | undefined> {
    if (this.header.mainPage !== undefined) return this.resolve(await this.entry(this.header.mainPage));
    if (this.newNamespaces) {
      const w = await this.find('W', 'mainPage');
      if (w) return this.resolve(w);
    }
    return undefined;
  }

  private async clusterBounds(cluster: number): Promise<[number, number]> {
    if (cluster >= this.header.clusterCount) throw new ZimError(`cluster ${cluster} is outside the file`, 'damaged');
    const start = await this.pointer(this.header.clusterPtrPos, cluster, 8);
    const end =
      cluster + 1 < this.header.clusterCount
        ? await this.pointer(this.header.clusterPtrPos, cluster + 1, 8)
        : this.header.checksumPos;
    if (start < ZIM_HEADER_SIZE || end <= start || end > this.src.size)
      throw new ZimError(`cluster ${cluster} has impossible bounds`, 'damaged');
    return [start, end];
  }

  private async loadCluster(cluster: number): Promise<{ offsets: number[]; data: Uint8Array }> {
    const [start, end] = await this.clusterBounds(cluster);
    const info = (await this.readExact(start, 1))[0]!;
    const compression = info & 0x0f;
    const width = info & 0x10 ? 8 : 4;
    let data: Uint8Array;
    if (compression === 0 || compression === 1) {
      if (end - start - 1 > MAX_CLUSTER_BYTES) {
        // Large plain cluster (video, big images): read the offset table only, blobs on demand.
        return { offsets: await this.plainOffsets(start + 1, end - start - 1, width), data: new Uint8Array(0) };
      }
      data = await this.readExact(start + 1, end - start - 1);
    } else if (compression === 5) {
      data = await zstdDecompress(await this.readExact(start + 1, end - start - 1));
    } else if (compression === 4) {
      throw new ZimError(
        'this ZIM file uses the older xz compression, which WorldView does not read; open it with kiwix-serve or download a newer copy',
        'unsupported',
      );
    } else {
      throw new ZimError(`cluster compression ${compression} is not one WorldView reads`, 'unsupported');
    }
    return { offsets: offsetsFrom(data, width), data };
  }

  private async plainOffsets(at: number, length: number, width: 4 | 8): Promise<number[]> {
    const first = await this.readExact(at, width);
    const firstOff = width === 8 ? u64(viewOf(first), 0) : viewOf(first).getUint32(0, true);
    if (firstOff % width !== 0 || firstOff < width * 2 || firstOff > length)
      throw new ZimError('a cluster offset table is damaged', 'damaged');
    const table = await this.readExact(at, firstOff);
    const offsets = offsetsFrom(table, width, length);
    return offsets.map((o) => -(o + at + 1)); // negative: absolute file positions, + 1 so 0 is impossible
  }

  private cluster(n: number): Promise<{ offsets: number[]; data: Uint8Array }> {
    let p = this.clusterCache.get(n);
    if (!p) {
      p = this.loadCluster(n);
      p.catch(() => this.clusterCache.delete(n));
      this.clusterCache.set(n, p);
      while (this.clusterCache.size > 8) this.clusterCache.delete(this.clusterCache.keys().next().value!);
    }
    return p;
  }

  /** The bytes of a content entry (redirects are followed). */
  async content(e: ZimEntry, maxBytes = 256 * 1024 * 1024): Promise<{ mimeType: string; data: Uint8Array }> {
    const target = await this.resolve(e);
    if (target.cluster === undefined || target.blob === undefined || target.mimeType === undefined)
      throw new ZimError(`${target.namespace}/${target.path} holds no content`, 'damaged');
    const c = await this.cluster(target.cluster);
    const i = target.blob;
    if (i + 1 >= c.offsets.length) throw new ZimError(`blob ${i} is outside its cluster`, 'damaged');
    const a = c.offsets[i]!;
    const b = c.offsets[i + 1]!;
    if (a < 0) {
      const from = -a - 1;
      const to = -b - 1;
      if (to - from > maxBytes) throw new ZimError('the item is larger than WorldView shows', 'too-large');
      return { mimeType: target.mimeType, data: await this.readExact(from, to - from) };
    }
    if (b - a > maxBytes) throw new ZimError('the item is larger than WorldView shows', 'too-large');
    return { mimeType: target.mimeType, data: c.data.subarray(a, b) };
  }

  /** Metadata (M namespace) as text: Title, Description, Language, Date, Creator, Publisher, Name, Flavour, … */
  async metadata(keys: readonly string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const e = await this.find('M', k);
      if (!e) continue;
      try {
        out[k] = Buffer.from((await this.content(e, 64 * 1024)).data).toString('utf8');
      } catch {
        /* unreadable metadata is left out */
      }
    }
    return out;
  }

  /**
   * Titles starting with `prefix`, in the readable namespace, in title order. Tries the prefix
   * as typed and with its first letter in upper and lower case, since titles are sorted by bytes.
   */
  async titlesStartingWith(prefix: string, limit = 20): Promise<ZimEntry[]> {
    const q = prefix.trim();
    if (!q) return [];
    const variants = [...new Set([q, q[0]!.toUpperCase() + q.slice(1), q[0]!.toLowerCase() + q.slice(1)])];
    const ns = this.contentNamespace;
    const list = await this.titleList();
    if (!list) return [];
    const byTitle = async (i: number) => this.entry(await list.at(i));
    const seen = new Set<number>();
    const out: ZimEntry[] = [];
    for (const v of variants) {
      const want = enc.encode(ns + v);
      let lo = 0;
      let hi = list.count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const e = await byTitle(mid);
        if (byteCompare(enc.encode(e.namespace + e.title), want) < 0) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.count && out.length < limit * 3; i++) {
        const e = await byTitle(i);
        if (e.namespace !== ns || !e.title.startsWith(v)) break;
        if (seen.has(e.index)) continue;
        seen.add(e.index);
        if (e.redirectTo === undefined && !isArticleMime(e.mimeType)) continue;
        out.push(e);
        if (out.length >= limit * 3) break;
      }
    }
    out.sort((a, b) => byteCompare(enc.encode(a.title), enc.encode(b.title)));
    return out.slice(0, limit);
  }

  /** Check the MD5 over the whole file against the one it ends with. Reads every byte. */
  async verifyChecksum(opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}) {
    const md5 = createHash('md5');
    const total = this.header.checksumPos;
    const step = 4 * 1024 * 1024;
    for (let at = 0; at < total; at += step) {
      opts.signal?.throwIfAborted();
      md5.update(await this.readExact(at, Math.min(step, total - at)));
      opts.onProgress?.(Math.min(total, at + step), total);
    }
    const want = Buffer.from(await this.readExact(total, 16)).toString('hex');
    return md5.digest('hex') === want;
  }
}

function offsetsFrom(data: Uint8Array, width: 4 | 8, limit = data.length): number[] {
  if (data.length < width) throw new ZimError('a cluster is empty', 'damaged');
  const v = viewOf(data);
  const read = (i: number) => (width === 8 ? u64(v, i * width) : v.getUint32(i * width, true));
  const first = read(0);
  if (first % width !== 0 || first < width * 2 || first > data.length)
    throw new ZimError('a cluster offset table is damaged', 'damaged');
  const n = first / width;
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = read(i);
    if (o > limit || (i > 0 && o < offsets[i - 1]!)) throw new ZimError('a cluster offset is out of order', 'damaged');
    offsets.push(o);
  }
  return offsets;
}

/** Entries worth offering in a title search: pages, not images or scripts. */
export function isArticleMime(mime: string | undefined): boolean {
  return mime === undefined || mime.startsWith('text/html') || mime === 'text/plain' || mime === 'application/pdf';
}

/** Plain text of an HTML article: scripts, styles and tags removed, entities for the common few. */
export function htmlToText(html: string, maxChars = 20_000): string {
  return html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

/** A ZimSource over an open file handle. */
export function fileZimSource(
  handle: { read(buf: Uint8Array, off: number, len: number, pos: number): Promise<{ bytesRead: number }> },
  size: number,
): ZimSource {
  return {
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await handle.read(buf, got, len - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    },
  };
}
