import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  PM_MAX_ROOT_DIR,
  PmCompression,
  buildPmDirectories,
  decodePmDirectory,
  decompressInternal,
  encodePmDirectory,
  encodePmHeader,
  readPmHeader,
  readPmTile,
  tileIdToZxy,
  tileRangeForBounds,
  zxyToTileId,
  type PmEntry,
  type PmHeader,
} from './pmtiles.js';
import { planExtract, selectionProblem, verifyArchive, writeExtract, type RangeSource } from './pmtiles-extract.js';

/*
 * Tile ids: the table in the PMTiles v3 specification (spec/v3/spec.md, "TileID") and the
 * reference implementation's own tests (js/test/v3.test.ts), copied as values; read
 * 2026-10-30. Everything else is built here: no archive from outside is included.
 */
test('tile ids: the specification table, round trips to zoom 8, and the corners of every zoom', () => {
  const table: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [1, 0, 1, 2],
    [1, 1, 1, 3],
    [1, 1, 0, 4],
    [2, 0, 0, 5],
    [12, 3423, 1763, 19078479],
  ];
  for (const [z, x, y, id] of table) {
    assert.equal(zxyToTileId(z, x, y), id, `${z}/${x}/${y}`);
    assert.deepEqual(tileIdToZxy(id), [z, x, y]);
  }
  for (let z = 0; z <= 8; z++)
    for (let x = 0; x < 1 << z; x++)
      for (let y = 0; y < 1 << z; y++) assert.deepEqual(tileIdToZxy(zxyToTileId(z, x, y)), [z, x, y]);
  for (let z = 0; z <= 15; z++) {
    const d = 2 ** z - 1;
    for (const [x, y] of [
      [0, 0],
      [d, 0],
      [0, d],
      [d, d],
    ] as const)
      assert.deepEqual(tileIdToZxy(zxyToTileId(z, x, y)), [z, x, y]);
  }
  assert.throws(() => zxyToTileId(16, 0, 0));
  assert.throws(() => zxyToTileId(0, 1, 1));
});

test('directories: encode and decode back, contiguous offsets written as 0, leaves when the root would not fit', () => {
  const entries: PmEntry[] = [
    { tileId: 0, offset: 0, length: 10, runLength: 1 },
    { tileId: 1, offset: 10, length: 20, runLength: 1 },
    { tileId: 2, offset: 0, length: 10, runLength: 3 }, // a duplicate of the first, three times
    { tileId: 9, offset: 30, length: 5, runLength: 1 },
  ];
  const bytes = encodePmDirectory(entries);
  assert.deepEqual(decodePmDirectory(bytes), entries);
  // Offsets: 1 (0+1), 0 (contiguous), 1 (0+1, not contiguous), 31 (30+1)
  assert.deepEqual([...bytes.slice(-4)], [1, 0, 1, 31]);

  const many: PmEntry[] = [];
  let off = 0;
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let id = 0;
  for (let i = 0; i < 60_000; i++) {
    const len = 100 + Math.floor(rand() * 50_000);
    id += 1 + Math.floor(rand() * 40);
    many.push({ tileId: id, offset: off, length: len, runLength: 1 + Math.floor(rand() * 3) });
    off += len;
  }
  const dirs = buildPmDirectories(many, PmCompression.Gzip);
  assert.ok(dirs.leafCount > 0, 'leaves used');
  assert.ok(dirs.root.length <= PM_MAX_ROOT_DIR);
  const root = decodePmDirectory(decompressInternal(dirs.root, PmCompression.Gzip));
  assert.ok(root.every((e) => e.runLength === 0));
  const back: PmEntry[] = [];
  for (const p of root)
    back.push(
      ...decodePmDirectory(decompressInternal(dirs.leaves.subarray(p.offset, p.offset + p.length), PmCompression.Gzip)),
    );
  assert.deepEqual(back, many);
});

test("tile ranges for an area: O'ahu at zoom 10, the antimeridian edge clamped", () => {
  assert.deepEqual(tileRangeForBounds({ west: -158.35, south: 21.2, east: -157.6, north: 21.75 }, 10), {
    minX: 61,
    maxX: 63,
    // By hand: y = (1 − ln(tan φ + sec φ)/π)/2 · 2^z; 21.75° → 448.6, 21.2° → 450.4.
    minY: 448,
    maxY: 450,
  });
  assert.deepEqual(tileRangeForBounds({ west: -180, south: -90, east: 180, north: 90 }, 2), {
    minX: 0,
    maxX: 3,
    minY: 0,
    maxY: 3,
  });
});

// ---- a synthetic archive, built here ------------------------------------------------------

/** An archive with every tile to `maxZoom`; the sea (x+y odd at zoom ≥ 3) is one shared tile. */
function synthetic(maxZoom: number): Uint8Array {
  const entries: PmEntry[] = [];
  const blobs: Uint8Array[] = [];
  let off = 0;
  let seaOffset = -1;
  const ids: Array<[number, number, number, number]> = [];
  for (let z = 0; z <= maxZoom; z++)
    for (let x = 0; x < 1 << z; x++) for (let y = 0; y < 1 << z; y++) ids.push([zxyToTileId(z, x, y), z, x, y]);
  ids.sort((a, b) => a[0] - b[0]);
  for (const [id, z, x, y] of ids) {
    const sea = z >= 3 && (x + y) % 2 === 1;
    if (sea && seaOffset >= 0) {
      const last = entries[entries.length - 1]!;
      if (last.offset === seaOffset && last.tileId + last.runLength === id) last.runLength++;
      else entries.push({ tileId: id, offset: seaOffset, length: 3, runLength: 1 });
      continue;
    }
    const data = sea ? Uint8Array.from([0x53, 0x45, 0x41]) : new TextEncoder().encode(`tile ${z}/${x}/${y}`);
    if (sea) seaOffset = off;
    entries.push({ tileId: id, offset: off, length: data.length, runLength: 1 });
    blobs.push(data);
    off += data.length;
  }
  const dirs = buildPmDirectories(entries, PmCompression.Gzip);
  const meta = new TextEncoder().encode(JSON.stringify({ name: 'synthetic', vector_layers: [{ id: 'earth' }] }));
  const metaZ = gzipSync(meta);
  const header: PmHeader = {
    rootDirectoryOffset: 127,
    rootDirectoryLength: dirs.root.length,
    metadataOffset: 127 + dirs.root.length,
    metadataLength: metaZ.length,
    leafDirectoryOffset: 127 + dirs.root.length + metaZ.length,
    leafDirectoryLength: dirs.leaves.length,
    tileDataOffset: 127 + dirs.root.length + metaZ.length + dirs.leaves.length,
    tileDataLength: off,
    numAddressedTiles: entries.reduce((s, e) => s + e.runLength, 0),
    numTileEntries: entries.length,
    numTileContents: blobs.length,
    clustered: true,
    internalCompression: PmCompression.Gzip,
    tileCompression: PmCompression.None,
    tileType: 1,
    minZoom: 0,
    maxZoom,
    minLon: -180,
    minLat: -85,
    maxLon: 180,
    maxLat: 85,
    centerZoom: 0,
    centerLon: 0,
    centerLat: 0,
  };
  return Buffer.concat([encodePmHeader(header), dirs.root, metaZ, dirs.leaves, ...blobs]);
}

function memory(buf: Uint8Array): RangeSource & { asked: number } {
  const src = {
    asked: 0,
    read: async (o: number, l: number) => {
      src.asked++;
      return buf.slice(o, Math.min(buf.length, o + l));
    },
  };
  return src;
}

async function extractToBytes(src: RangeSource, sel: Parameters<typeof planExtract>[1]) {
  const plan = await planExtract(src, sel);
  const parts: Uint8Array[] = [];
  const r = await writeExtract(src, plan, { write: async (b) => void parts.push(b.slice()) }, { concurrency: 3 });
  return { plan, out: Buffer.concat(parts), ...r };
}

test('extract: the world to a zoom, every tile byte-identical, the sea stored once, the size exact', async () => {
  const buf = synthetic(6);
  const src = memory(buf);
  const { plan, out, bytes } = await extractToBytes(src, { worldMaxZoom: 4, maxZoom: 4 });
  assert.equal(bytes, plan.totalBytes);
  assert.equal(out.length, plan.totalBytes);
  assert.equal(await verifyArchive(memory(out), out.length), undefined);
  const h = readPmHeader(out);
  assert.equal(h.maxZoom, 4);
  assert.equal(h.numAddressedTiles, (4 ** 5 - 1) / 3);
  const srcHeader = readPmHeader(buf);
  const read = (b: Uint8Array) => async (o: number, l: number) => b.slice(o, o + l);
  for (let z = 0; z <= 4; z++)
    for (let x = 0; x < 1 << z; x++)
      for (let y = 0; y < 1 << z; y++)
        assert.deepEqual(await readPmTile(read(out), h, z, x, y), await readPmTile(read(buf), srcHeader, z, x, y));
  assert.equal(await readPmTile(read(out), h, 5, 0, 0), undefined, 'nothing deeper than asked');
  // One sea blob for the many sea tiles.
  assert.ok(h.numTileContents < h.numAddressedTiles);
});

test('extract: an area adds detail inside it only; the world part stays', async () => {
  const buf = synthetic(7);
  const src = memory(buf);
  const area = { west: 0, south: 0, east: 40, north: 40 };
  const { out } = await extractToBytes(src, { worldMaxZoom: 2, maxZoom: 7, bounds: area });
  assert.equal(await verifyArchive(memory(out), out.length), undefined);
  const h = readPmHeader(out);
  const srcHeader = readPmHeader(buf);
  const read = (b: Uint8Array) => async (o: number, l: number) => b.slice(o, o + l);
  for (let z = 3; z <= 7; z++) {
    const r = tileRangeForBounds(area, z);
    for (let x = 0; x < 1 << z; x++)
      for (let y = 0; y < 1 << z; y++) {
        const inside = x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
        const got = await readPmTile(read(out), h, z, x, y);
        if (inside) assert.deepEqual(got, await readPmTile(read(buf), srcHeader, z, x, y), `${z}/${x}/${y}`);
        else assert.equal(got, undefined, `${z}/${x}/${y} outside`);
      }
  }
  assert.ok(await readPmTile(read(out), h, 2, 3, 3), 'the world part is there');
});

test('extract: refuses a bad selection, a cut-short answer, and stops when cancelled', async () => {
  assert.match(selectionProblem({ worldMaxZoom: 5, maxZoom: 3 }) ?? '', /at least the world zoom/);
  assert.match(selectionProblem({ worldMaxZoom: 16, maxZoom: 16 }) ?? '', /0 to 15/);
  assert.match(
    selectionProblem({ worldMaxZoom: 4, maxZoom: 15, bounds: { west: -10, south: 35, east: 60, north: 70 } }) ?? '',
    /too many tiles/,
  );
  const buf = synthetic(5);
  const plan = await planExtract(memory(buf), { worldMaxZoom: 5, maxZoom: 5 });
  const short: RangeSource = { read: async (o, l) => buf.slice(o, o + Math.max(1, l - 1)) };
  await assert.rejects(writeExtract(short, plan, { write: async () => undefined }), /asked for \d+ bytes, got/);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(writeExtract(memory(buf), plan, { write: async () => undefined }, { signal: ac.signal }));
});
