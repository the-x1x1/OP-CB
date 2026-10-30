import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * PMTiles v3, read and written by hand from the published specification
 * (github.com/protomaps/PMTiles `spec/v3/spec.md`): the 127-byte header, directories of
 * varint-encoded entries (delta tile ids, run lengths, lengths, offsets), leaf directories, and
 * the Hilbert-curve tile ids. Only what the map download needs: read a remote archive by byte
 * ranges, write a new clustered archive. Tile ids are checked against the specification's
 * table; reading and extracting were checked outside this repository on the specification's
 * Protomaps sample archive (docs/architecture/COMMAND-CENTER.md, "Map download").
 */

export const PM_HEADER_BYTES = 127;
/** The header and the root directory are within the first 16 KiB of every archive. */
export const PM_ROOT_BYTES = 16_384;
export const PM_MAX_ROOT_DIR = PM_ROOT_BYTES - PM_HEADER_BYTES;
/** Deepest zoom a tile id is computed for here (2^30 tiles a side would overflow the 32-bit maths). */
export const PM_MAX_ZOOM = 15;

export const enum PmCompression {
  Unknown = 0,
  None = 1,
  Gzip = 2,
  Brotli = 3,
  Zstd = 4,
}

export interface PmHeader {
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

export interface PmEntry {
  tileId: number;
  offset: number;
  length: number;
  /** 0: a leaf directory. */
  runLength: number;
}

export class PmtilesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmtilesFormatError';
  }
}

function u64(view: DataView, at: number): number {
  const v = view.getBigUint64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PmtilesFormatError('a header value is too large');
  return Number(v);
}

export function readPmHeader(bytes: Uint8Array): PmHeader {
  if (bytes.length < PM_HEADER_BYTES) throw new PmtilesFormatError('shorter than a PMTiles header');
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== 'PMTiles') throw new PmtilesFormatError('not a PMTiles archive');
  if (bytes[7] !== 3) throw new PmtilesFormatError(`PMTiles version ${bytes[7]} is not 3`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, PM_HEADER_BYTES);
  return {
    rootDirectoryOffset: u64(v, 8),
    rootDirectoryLength: u64(v, 16),
    metadataOffset: u64(v, 24),
    metadataLength: u64(v, 32),
    leafDirectoryOffset: u64(v, 40),
    leafDirectoryLength: u64(v, 48),
    tileDataOffset: u64(v, 56),
    tileDataLength: u64(v, 64),
    numAddressedTiles: u64(v, 72),
    numTileEntries: u64(v, 80),
    numTileContents: u64(v, 88),
    clustered: v.getUint8(96) === 1,
    internalCompression: v.getUint8(97),
    tileCompression: v.getUint8(98),
    tileType: v.getUint8(99),
    minZoom: v.getUint8(100),
    maxZoom: v.getUint8(101),
    minLon: v.getInt32(102, true) / 1e7,
    minLat: v.getInt32(106, true) / 1e7,
    maxLon: v.getInt32(110, true) / 1e7,
    maxLat: v.getInt32(114, true) / 1e7,
    centerZoom: v.getUint8(118),
    centerLon: v.getInt32(119, true) / 1e7,
    centerLat: v.getInt32(123, true) / 1e7,
  };
}

export function encodePmHeader(h: PmHeader): Uint8Array {
  const out = new Uint8Array(PM_HEADER_BYTES);
  out.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 3]); // "PMTiles", 3
  const v = new DataView(out.buffer);
  const u = (at: number, n: number) => v.setBigUint64(at, BigInt(n), true);
  u(8, h.rootDirectoryOffset);
  u(16, h.rootDirectoryLength);
  u(24, h.metadataOffset);
  u(32, h.metadataLength);
  u(40, h.leafDirectoryOffset);
  u(48, h.leafDirectoryLength);
  u(56, h.tileDataOffset);
  u(64, h.tileDataLength);
  u(72, h.numAddressedTiles);
  u(80, h.numTileEntries);
  u(88, h.numTileContents);
  v.setUint8(96, h.clustered ? 1 : 0);
  v.setUint8(97, h.internalCompression);
  v.setUint8(98, h.tileCompression);
  v.setUint8(99, h.tileType);
  v.setUint8(100, h.minZoom);
  v.setUint8(101, h.maxZoom);
  const e7 = (at: number, deg: number) => v.setInt32(at, Math.round(deg * 1e7), true);
  e7(102, h.minLon);
  e7(106, h.minLat);
  e7(110, h.maxLon);
  e7(114, h.maxLat);
  v.setUint8(118, h.centerZoom);
  e7(119, h.centerLon);
  e7(123, h.centerLat);
  return out;
}

// ---- compression ---------------------------------------------------------------------------

/** Directories and metadata: gzip or none (Protomaps builds use gzip). */
export function decompressInternal(bytes: Uint8Array, compression: number, maxBytes = 64 * 1024 * 1024): Uint8Array {
  if (compression === PmCompression.None) return bytes;
  if (compression === PmCompression.Gzip) return gunzipSync(bytes, { maxOutputLength: maxBytes });
  throw new PmtilesFormatError(`internal compression ${compression} is not read here (gzip or none only)`);
}

export function compressInternal(bytes: Uint8Array, compression: number): Uint8Array {
  if (compression === PmCompression.None) return bytes;
  if (compression === PmCompression.Gzip) return gzipSync(bytes, { level: 9 });
  throw new PmtilesFormatError(`internal compression ${compression} is not written here`);
}

// ---- directories ---------------------------------------------------------------------------

class VarintReader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  next(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new PmtilesFormatError('a directory ends inside a number');
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (!Number.isSafeInteger(result)) throw new PmtilesFormatError('a directory number is too large');
        return result;
      }
      mul *= 128;
    }
    throw new PmtilesFormatError('a directory number is too long');
  }
}

/** A directory's bytes (already decompressed) as its entries. */
export function decodePmDirectory(bytes: Uint8Array): PmEntry[] {
  const r = new VarintReader(bytes);
  const n = r.next();
  if (n > 50_000_000) throw new PmtilesFormatError('a directory says it has too many entries');
  const entries: PmEntry[] = new Array(n);
  let id = 0;
  for (let i = 0; i < n; i++) {
    id += r.next();
    entries[i] = { tileId: id, offset: 0, length: 0, runLength: 0 };
  }
  for (let i = 0; i < n; i++) entries[i]!.runLength = r.next();
  for (let i = 0; i < n; i++) entries[i]!.length = r.next();
  for (let i = 0; i < n; i++) {
    const v = r.next();
    if (v === 0 && i > 0) entries[i]!.offset = entries[i - 1]!.offset + entries[i - 1]!.length;
    else entries[i]!.offset = v - 1;
  }
  return entries;
}

class VarintWriter {
  private chunks: number[] = [];
  private parts: Uint8Array[] = [];
  push(n: number): void {
    let v = n;
    while (v >= 0x80) {
      this.chunks.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    this.chunks.push(v);
    if (this.chunks.length > 65_536) this.flush();
  }
  private flush(): void {
    this.parts.push(Uint8Array.from(this.chunks));
    this.chunks = [];
  }
  bytes(): Uint8Array {
    this.flush();
    const total = this.parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Entries (sorted by tile id) as directory bytes, before compression. */
export function encodePmDirectory(entries: readonly PmEntry[]): Uint8Array {
  if (!entries.length) throw new PmtilesFormatError('a directory must have at least one entry');
  const w = new VarintWriter();
  w.push(entries.length);
  let last = 0;
  for (const e of entries) {
    if (e.tileId < last) throw new PmtilesFormatError('directory entries must be sorted by tile id');
    w.push(e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) w.push(e.runLength);
  for (const e of entries) {
    if (e.length <= 0) throw new PmtilesFormatError('a directory entry has no length');
    w.push(e.length);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const prev = entries[i - 1];
    w.push(i > 0 && prev && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  }
  return w.bytes();
}

/**
 * Tile entries as a root directory and leaf directories, the root within its 16 KiB: all in the
 * root when that fits, else leaves of `leafSize` entries (4,096 first, doubled until the root of
 * leaf pointers fits). Leaf offsets are relative to the leaf section, as the spec says.
 */
export function buildPmDirectories(
  entries: readonly PmEntry[],
  compression: number,
): { root: Uint8Array; leaves: Uint8Array; leafCount: number } {
  const whole = compressInternal(encodePmDirectory(entries), compression);
  if (whole.length <= PM_MAX_ROOT_DIR) return { root: whole, leaves: new Uint8Array(0), leafCount: 0 };
  for (let leafSize = 4096; ; leafSize *= 2) {
    const pointers: PmEntry[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = compressInternal(encodePmDirectory(entries.slice(i, i + leafSize)), compression);
      pointers.push({ tileId: entries[i]!.tileId, offset, length: leaf.length, runLength: 0 });
      parts.push(leaf);
      offset += leaf.length;
    }
    const root = compressInternal(encodePmDirectory(pointers), compression);
    if (root.length <= PM_MAX_ROOT_DIR) {
      const leaves = new Uint8Array(offset);
      let at = 0;
      for (const p of parts) {
        leaves.set(p, at);
        at += p.length;
      }
      return { root, leaves, leafCount: pointers.length };
    }
    if (leafSize > entries.length) throw new PmtilesFormatError('the directory cannot be made to fit');
  }
}

// ---- tile ids ------------------------------------------------------------------------------

function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx !== 0) return [n - 1 - y, n - 1 - x];
    return [y, x];
  }
  return [x, y];
}

/** The first tile id of zoom `z`: the number of tiles in all the zooms above it. */
export function zoomStartId(z: number): number {
  return (Math.pow(4, z) - 1) / 3;
}

/** z/x/y → its tile id (Hilbert curve per zoom, zooms one after another). */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z < 0 || z > PM_MAX_ZOOM) throw new RangeError(`zoom ${z} out of range`);
  const n = 1 << z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new RangeError('tile outside its zoom');
  let d = 0;
  let tx = x;
  let ty = y;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    [tx, ty] = rotate(n, tx, ty, rx, ry);
  }
  return zoomStartId(z) + d;
}

/** Tile id → z/x/y. */
export function tileIdToZxy(id: number): [number, number, number] {
  let z = 0;
  while (z <= PM_MAX_ZOOM && zoomStartId(z + 1) <= id) z++;
  if (z > PM_MAX_ZOOM) throw new RangeError('tile id beyond the deepest zoom read here');
  const n = 1 << z;
  let t = id - zoomStartId(z);
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s <<= 1) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    [x, y] = rotate(s, x, y, rx, ry);
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [z, x, y];
}

/** The x and y ranges of a zoom's tiles that touch a lon/lat box (Web Mercator). */
export function tileRangeForBounds(
  b: { west: number; south: number; east: number; north: number },
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const n = 1 << z;
  const clampLat = (lat: number) => Math.max(-85.0511287, Math.min(85.0511287, lat));
  const tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (lat: number) => {
    const r = (clampLat(lat) * Math.PI) / 180;
    return Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)));
  };
  return { minX: tx(b.west), maxX: tx(b.east), minY: ty(b.north), maxY: ty(b.south) };
}

/** The entry holding `id`, in a sorted directory: the last entry starting at or before it. */
export function findPmEntry(entries: readonly PmEntry[], id: number): PmEntry | undefined {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = entries[mid]!.tileId;
    if (c < id) lo = mid + 1;
    else if (c > id) hi = mid - 1;
    else return entries[mid];
  }
  if (hi >= 0) {
    const e = entries[hi]!;
    if (e.runLength === 0 || id - e.tileId < e.runLength) return e;
  }
  return undefined;
}

/** One tile's bytes from an archive read by ranges, or undefined when it has none. */
export async function readPmTile(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  header: PmHeader,
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array | undefined> {
  const id = zxyToTileId(z, x, y);
  let dirOffset = header.rootDirectoryOffset;
  let dirLength = header.rootDirectoryLength;
  for (let depth = 0; depth < 4; depth++) {
    const dir = decodePmDirectory(decompressInternal(await read(dirOffset, dirLength), header.internalCompression));
    const e = findPmEntry(dir, id);
    if (!e) return undefined;
    if (e.runLength > 0) return read(header.tileDataOffset + e.offset, e.length);
    dirOffset = header.leafDirectoryOffset + e.offset;
    dirLength = e.length;
  }
  throw new PmtilesFormatError('leaf directories nested too deep');
}
