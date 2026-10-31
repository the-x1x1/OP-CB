import { createHash } from 'node:crypto';
import type { GeoBounds } from '@opcb/world-model';
import {
  PM_HEADER_BYTES,
  PM_MAX_ZOOM,
  PM_ROOT_BYTES,
  PmtilesFormatError,
  buildPmDirectories,
  compressInternal,
  decodePmDirectory,
  decompressInternal,
  encodePmHeader,
  readPmHeader,
  tileRangeForBounds,
  zoomStartId,
  zxyToTileId,
  type PmEntry,
  type PmHeader,
} from './pmtiles.js';

/**
 * A map extract from a PMTiles archive read by byte ranges — the whole world down to one zoom,
 * plus more detail inside an area — written as a new clustered archive. What `pmtiles extract`
 * does, done inside the app so a map can be downloaded with a button.
 *
 *  1. plan: the header, the root directory, and only the leaf directories that hold wanted
 *     tiles; every wanted tile's place and length are then known, so the size is exact before
 *     a byte of tile data is asked for;
 *  2. write: the new header, directories and metadata first, then the tile data as it arrives,
 *     in the source's order (fetched in coalesced ranges), hashed as it is written.
 *
 * Duplicate tiles (the open sea) are fetched and stored once, as in the source.
 */

export interface RangeSource {
  /** Bytes [offset, offset+length) of the archive. Must return exactly that many. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ExtractSelection {
  /** Every tile of the world from zoom 0 down to this zoom. */
  worldMaxZoom: number;
  /** Deeper detail inside `bounds`, down to this zoom (≥ worldMaxZoom); ignored without bounds. */
  maxZoom: number;
  bounds?: GeoBounds;
}

export interface ExtractPlan {
  source: PmHeader;
  metadata: Uint8Array;
  selection: ExtractSelection;
  /** The new archive's tile entries, sorted, with offsets into the SOURCE tile data. */
  entries: PmEntry[];
  /** Unique blobs to copy, sorted by source offset: [sourceOffset, length] pairs. */
  blobs: Float64Array;
  addressedTiles: number;
  tileBytes: number;
  /** Bytes the new file will have, headers and directories included. */
  totalBytes: number;
  /** Directory bytes fetched to make the plan (what planning cost). */
  directoryBytesRead: number;
}

/** Most tiles one extract will address: a bigger area or deeper zoom is refused before planning. */
export const MAX_EXTRACT_TILES = 20_000_000;

/** How many tiles a selection could address at most (the area's boxes, before the source is read). */
export function selectionTileCount(sel: ExtractSelection): number {
  let n = zoomStartId(sel.worldMaxZoom + 1);
  if (sel.bounds)
    for (let z = sel.worldMaxZoom + 1; z <= sel.maxZoom; z++) {
      const r = tileRangeForBounds(sel.bounds, z);
      n += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    }
  return n;
}

export function selectionProblem(sel: ExtractSelection): string | undefined {
  const ok = (z: number) => Number.isInteger(z) && z >= 0 && z <= PM_MAX_ZOOM;
  if (!ok(sel.worldMaxZoom) || !ok(sel.maxZoom)) return `zooms are whole numbers from 0 to ${PM_MAX_ZOOM}`;
  if (sel.maxZoom < sel.worldMaxZoom) return 'the area zoom must be at least the world zoom';
  if (sel.bounds) {
    const b = sel.bounds;
    if (![b.west, b.east].every((v) => v >= -180 && v <= 180) || ![b.south, b.north].every((v) => v >= -90 && v <= 90))
      return 'the area is not on the Earth';
    if (b.west >= b.east || b.south >= b.north) return 'the area has no size (or crosses 180°)';
  }
  if (selectionTileCount(sel) > MAX_EXTRACT_TILES)
    return 'that area and zoom are too many tiles: choose a smaller area or a lower zoom';
  return undefined;
}

/** The wanted tile ids: one interval for the world part, then the area's ids, sorted. */
function wantedIds(sel: ExtractSelection): { worldEnd: number; area: Float64Array } {
  const worldEnd = zoomStartId(sel.worldMaxZoom + 1);
  if (!sel.bounds || sel.maxZoom === sel.worldMaxZoom) return { worldEnd, area: new Float64Array(0) };
  const ids: number[] = [];
  for (let z = sel.worldMaxZoom + 1; z <= sel.maxZoom; z++) {
    const r = tileRangeForBounds(sel.bounds, z);
    for (let x = r.minX; x <= r.maxX; x++) for (let y = r.minY; y <= r.maxY; y++) ids.push(zxyToTileId(z, x, y));
  }
  const area = Float64Array.from(ids);
  area.sort();
  return { worldEnd, area };
}

/** Index of the first value ≥ v in a sorted array. */
function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface PlanProgress {
  directoriesRead: number;
  directoryBytesRead: number;
}

export async function planExtract(
  src: RangeSource,
  sel: ExtractSelection,
  opts: { signal?: AbortSignal; onProgress?: (p: PlanProgress) => void } = {},
): Promise<ExtractPlan> {
  const problem = selectionProblem(sel);
  if (problem) throw new PmtilesFormatError(problem);
  const head = await src.read(0, PM_ROOT_BYTES, opts.signal);
  const header = readPmHeader(head);
  if (!header.clustered) throw new PmtilesFormatError('the source archive is not clustered');
  const ic = header.internalCompression;
  const rootEnd = header.rootDirectoryOffset + header.rootDirectoryLength;
  const rootBytes =
    rootEnd <= head.length
      ? head.subarray(header.rootDirectoryOffset, rootEnd)
      : await src.read(header.rootDirectoryOffset, header.rootDirectoryLength, opts.signal);
  const metadata = decompressInternal(
    await src.read(header.metadataOffset, header.metadataLength, opts.signal),
    ic,
    16 * 1024 * 1024,
  );
  const { worldEnd, area } = wantedIds(sel);
  const wantsRange = (from: number, to: number): boolean =>
    from < worldEnd || (area.length > 0 && lowerBound(area, from) < area.length && area[lowerBound(area, from)]! < to);

  const out: PmEntry[] = [];
  let progress: PlanProgress = { directoriesRead: 0, directoryBytesRead: 0 };
  const visit = async (entries: PmEntry[], end: number, depth: number): Promise<void> => {
    for (let i = 0; i < entries.length; i++) {
      opts.signal?.throwIfAborted();
      const e = entries[i]!;
      const next = i + 1 < entries.length ? entries[i + 1]!.tileId : end;
      if (e.runLength === 0) {
        if (depth > 2) throw new PmtilesFormatError('leaf directories nested too deep');
        if (!wantsRange(e.tileId, next)) continue;
        const raw = await src.read(header.leafDirectoryOffset + e.offset, e.length, opts.signal);
        progress = {
          directoriesRead: progress.directoriesRead + 1,
          directoryBytesRead: progress.directoryBytesRead + e.length,
        };
        opts.onProgress?.(progress);
        await visit(decodePmDirectory(decompressInternal(raw, ic)), next, depth + 1);
        continue;
      }
      const runEnd = e.tileId + e.runLength;
      // The world part: the run up to the end of the world zoom.
      if (e.tileId < worldEnd) out.push({ ...e, runLength: Math.min(runEnd, worldEnd) - e.tileId });
      // The area part: each wanted id inside the run, merged into runs where consecutive.
      if (area.length && runEnd > worldEnd) {
        let k = lowerBound(area, Math.max(e.tileId, worldEnd));
        while (k < area.length && area[k]! < runEnd) {
          const start = area[k]!;
          let len = 1;
          while (k + len < area.length && area[k + len]! === start + len && start + len < runEnd) len++;
          out.push({ tileId: start, offset: e.offset, length: e.length, runLength: len });
          k += len;
        }
      }
    }
  };
  await visit(decodePmDirectory(decompressInternal(rootBytes, ic)), Number.MAX_SAFE_INTEGER, 0);
  if (!out.length) throw new PmtilesFormatError('the source has no tiles in that selection');
  out.sort((a, b) => a.tileId - b.tileId);

  // Unique blobs by source offset, in source order: their new offsets follow the same order.
  const offsets = new Map<number, number>();
  for (const e of out) if (!offsets.has(e.offset)) offsets.set(e.offset, e.length);
  const sorted = [...offsets.keys()].sort((a, b) => a - b);
  const blobs = new Float64Array(sorted.length * 2);
  let tileBytes = 0;
  sorted.forEach((off, i) => {
    blobs[i * 2] = off;
    blobs[i * 2 + 1] = offsets.get(off)!;
    tileBytes += offsets.get(off)!;
  });
  const addressedTiles = out.reduce((s, e) => s + e.runLength, 0);
  const draft = layoutFor(header, sel, metadata, out, blobs, tileBytes, addressedTiles);
  return {
    source: header,
    metadata,
    selection: sel,
    entries: out,
    blobs,
    addressedTiles,
    tileBytes,
    totalBytes: draft.totalBytes,
    directoryBytesRead: progress.directoryBytesRead,
  };
}

interface Layout {
  head: Uint8Array;
  root: Uint8Array;
  metadata: Uint8Array;
  leaves: Uint8Array;
  totalBytes: number;
}

/** The new archive's front part (header, root, metadata, leaves); tile data follows it. */
function layoutFor(
  src: PmHeader,
  sel: ExtractSelection,
  metadataJson: Uint8Array,
  entries: readonly PmEntry[],
  blobs: Float64Array,
  tileBytes: number,
  addressedTiles: number,
): Layout {
  // Re-point every entry at its blob's offset in the new tile data.
  const newOffset = new Map<number, number>();
  let at = 0;
  for (let i = 0; i < blobs.length; i += 2) {
    newOffset.set(blobs[i]!, at);
    at += blobs[i + 1]!;
  }
  const moved = entries.map((e) => ({ ...e, offset: newOffset.get(e.offset)! }));
  const ic = src.internalCompression;
  const dirs = buildPmDirectories(moved, ic);
  const metadata = compressInternal(metadataJson, ic);
  const rootOffset = PM_HEADER_BYTES;
  const metadataOffset = rootOffset + dirs.root.length;
  const leafOffset = metadataOffset + metadata.length;
  const tileOffset = leafOffset + dirs.leaves.length;
  const b = sel.bounds;
  // The world is always in an extract (its low zooms), so the bounds stay the source's.
  const bounds = { minLon: src.minLon, minLat: src.minLat, maxLon: src.maxLon, maxLat: src.maxLat };
  const header: PmHeader = {
    ...src,
    rootDirectoryOffset: rootOffset,
    rootDirectoryLength: dirs.root.length,
    metadataOffset,
    metadataLength: metadata.length,
    leafDirectoryOffset: leafOffset,
    leafDirectoryLength: dirs.leaves.length,
    tileDataOffset: tileOffset,
    tileDataLength: tileBytes,
    numAddressedTiles: addressedTiles,
    numTileEntries: moved.length,
    numTileContents: blobs.length / 2,
    clustered: true,
    minZoom: 0,
    maxZoom: b ? sel.maxZoom : sel.worldMaxZoom,
    ...bounds,
    centerZoom: b ? Math.min(sel.maxZoom, Math.max(sel.worldMaxZoom, 8)) : Math.min(2, sel.worldMaxZoom),
    centerLon: b ? (b.west + b.east) / 2 : 0,
    centerLat: b ? (b.south + b.north) / 2 : 0,
  };
  return {
    head: encodePmHeader(header),
    root: dirs.root,
    metadata,
    leaves: dirs.leaves,
    totalBytes: tileOffset + tileBytes,
  };
}

export interface WriteSink {
  write(bytes: Uint8Array): Promise<void>;
}

export interface WriteProgress {
  bytesWritten: number;
  totalBytes: number;
  tileBytesWritten: number;
}

/** Coalesce blobs into requests: neighbours less than `gap` apart, at most `maxRange` each. */
export function coalesce(
  blobs: Float64Array,
  gap = 256 * 1024,
  maxRange = 8 * 1024 * 1024,
): Array<[number, number, number, number]> {
  // [rangeStart, rangeLength, firstBlobIndex, blobCount]
  const out: Array<[number, number, number, number]> = [];
  let i = 0;
  const n = blobs.length / 2;
  while (i < n) {
    const start = blobs[i * 2]!;
    let end = start + blobs[i * 2 + 1]!;
    let j = i + 1;
    while (j < n) {
      const s = blobs[j * 2]!;
      const e = s + blobs[j * 2 + 1]!;
      if (s - end > gap || e - start > maxRange) break;
      end = Math.max(end, e);
      j++;
    }
    out.push([start, end - start, i, j - i]);
    i = j;
  }
  return out;
}

/**
 * Write the planned archive to `sink`: the front part, then every blob in order, fetched in
 * coalesced ranges, up to `concurrency` at a time but always written in order. Returns the
 * SHA-256 of everything written.
 */
export async function writeExtract(
  src: RangeSource,
  plan: ExtractPlan,
  sink: WriteSink,
  opts: { signal?: AbortSignal; concurrency?: number; onProgress?: (p: WriteProgress) => void } = {},
): Promise<{ sha256: string; bytes: number }> {
  const layout = layoutFor(
    plan.source,
    plan.selection,
    plan.metadata,
    plan.entries,
    plan.blobs,
    plan.tileBytes,
    plan.addressedTiles,
  );
  const hash = createHash('sha256');
  let written = 0;
  let tileWritten = 0;
  const put = async (b: Uint8Array) => {
    if (!b.length) return;
    await sink.write(b);
    hash.update(b);
    written += b.length;
  };
  await put(layout.head);
  await put(layout.root);
  await put(layout.metadata);
  await put(layout.leaves);
  const ranges = coalesce(plan.blobs);
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const base = plan.source.tileDataOffset;
  const pending = new Map<number, Promise<Uint8Array>>();
  let nextToStart = 0;
  const startUpTo = (k: number) => {
    while (nextToStart < ranges.length && nextToStart <= k) {
      const [s, len] = ranges[nextToStart]!;
      pending.set(nextToStart, src.read(base + s, len, opts.signal));
      nextToStart++;
    }
  };
  for (let r = 0; r < ranges.length; r++) {
    opts.signal?.throwIfAborted();
    startUpTo(r + concurrency - 1);
    const bytes = await pending.get(r)!;
    pending.delete(r);
    const [s, len, first, count] = ranges[r]!;
    if (bytes.length !== len) throw new PmtilesFormatError(`asked for ${len} bytes, got ${bytes.length}`);
    for (let b = first; b < first + count; b++) {
      const off = plan.blobs[b * 2]! - s;
      const blen = plan.blobs[b * 2 + 1]!;
      await put(bytes.subarray(off, off + blen));
      tileWritten += blen;
    }
    opts.onProgress?.({ bytesWritten: written, totalBytes: layout.totalBytes, tileBytesWritten: tileWritten });
  }
  // Settle anything still in flight (none, unless a read failed above).
  for (const p of pending.values()) await p.catch(() => undefined);
  if (written !== layout.totalBytes)
    throw new PmtilesFormatError(`wrote ${written} bytes, planned ${layout.totalBytes}`);
  return { sha256: hash.digest('hex'), bytes: written };
}

/**
 * Read back a written archive's header and every directory and check they hold together:
 * entries sorted, inside the tile data, counts as the header says. Undefined when it does.
 */
export async function verifyArchive(src: RangeSource, size: number): Promise<string | undefined> {
  try {
    const head = await src.read(0, Math.min(PM_ROOT_BYTES, size));
    const h = readPmHeader(head);
    // The specification fixes only the header's place; the other sections may come in any
    // order. Protomaps' daily planet builds (Planetiler) put the leaf directories after the tile
    // data. Each section must lie inside the file, and the last of them must end where it does.
    const sections: Array<[string, number, number]> = [
      ['root directory', h.rootDirectoryOffset, h.rootDirectoryLength],
      ['metadata', h.metadataOffset, h.metadataLength],
      ['leaf directories', h.leafDirectoryOffset, h.leafDirectoryLength],
      ['tile data', h.tileDataOffset, h.tileDataLength],
    ];
    let end = PM_HEADER_BYTES;
    for (const [name, offset, length] of sections) {
      if (length === 0) continue;
      if (offset < PM_HEADER_BYTES || offset + length > size) return `the ${name} lies outside the file`;
      end = Math.max(end, offset + length);
    }
    if (end !== size) return 'the file size does not match its header';
    const ic = h.internalCompression;
    let tiles = 0;
    let entries = 0;
    let last = -1;
    const check = async (bytes: Uint8Array, depth: number): Promise<void> => {
      for (const e of decodePmDirectory(decompressInternal(bytes, ic))) {
        if (e.tileId < last) throw new PmtilesFormatError('entries out of order');
        if (e.runLength === 0) {
          if (depth > 1) throw new PmtilesFormatError('leaf directories nested');
          if (e.offset + e.length > h.leafDirectoryLength)
            throw new PmtilesFormatError('a leaf points outside its section');
          await check(await src.read(h.leafDirectoryOffset + e.offset, e.length), depth + 1);
          continue;
        }
        last = e.tileId;
        if (e.offset + e.length > h.tileDataLength) throw new PmtilesFormatError('a tile points outside the data');
        tiles += e.runLength;
        entries++;
      }
    };
    await check(await src.read(h.rootDirectoryOffset, h.rootDirectoryLength), 0);
    if (tiles !== h.numAddressedTiles)
      return `the directories address ${tiles} tiles, the header says ${h.numAddressedTiles}`;
    if (entries !== h.numTileEntries)
      return `the directories hold ${entries} entries, the header says ${h.numTileEntries}`;
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
