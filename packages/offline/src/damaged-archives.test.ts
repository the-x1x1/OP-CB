import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { rawZip, tempDir } from '../test/helpers/raw-zip.js';
import {
  PmCompression,
  PmtilesFormatError,
  compressInternal,
  encodePmDirectory,
  encodePmHeader,
  readPmHeader,
  readPmTile,
  zxyToTileId,
  type PmEntry,
  type PmHeader,
} from './pmtiles.js';
import { ZipFormatError, ZipReader } from './zip.js';

/**
 * A map archive and a pack, each damaged a few thousand ways (bytes changed, cut short),
 * then read as the app reads them. A reader may refuse the file with its own error or read
 * what is there; it may not throw anything else, take seconds, or ask for memory a file of
 * that size could not account for. Damage is generated from a fixed seed.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AWKWARD = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x02, 0x08, 0x10, 0x1f, 0x8b, 0x50, 0x4b];

function damage(good: Uint8Array, next: () => number, headBytes: number): Uint8Array {
  // A copy: a Buffer's own slice is a window on the same bytes.
  let b = new Uint8Array(good);
  const times = 1 + Math.floor(next() * 3);
  for (let k = 0; k < times; k++) {
    const at = next() < 0.4 ? Math.floor(next() * Math.min(b.length, headBytes)) : Math.floor(next() * b.length);
    const roll = next();
    if (roll < 0.1) b = new Uint8Array(b.subarray(0, Math.max(1, at)));
    else if (roll < 0.6) b[at] = AWKWARD[Math.floor(next() * AWKWARD.length)]!;
    else b[at] = Math.floor(next() * 256);
  }
  return b;
}

function pmtiles(internal: PmCompression): Uint8Array {
  const tiles = [
    { z: 0, x: 0, y: 0, data: Buffer.from('tile-0-0-0') },
    { z: 1, x: 0, y: 0, data: Buffer.from('tile-1-0-0-longer') },
    { z: 1, x: 1, y: 1, data: Buffer.from('tile-1-1-1') },
    { z: 2, x: 3, y: 2, data: Buffer.from('tile-2-3-2') },
  ];
  const entries: PmEntry[] = [];
  let offset = 0;
  for (const t of tiles.sort((a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y))) {
    entries.push({ tileId: zxyToTileId(t.z, t.x, t.y), offset, length: t.data.length, runLength: 1 });
    offset += t.data.length;
  }
  const root = compressInternal(encodePmDirectory(entries), internal);
  const data = Buffer.concat(tiles.map((t) => t.data));
  const header: PmHeader = {
    rootDirectoryOffset: 127,
    rootDirectoryLength: root.length,
    metadataOffset: 127 + root.length,
    metadataLength: 0,
    leafDirectoryOffset: 127 + root.length,
    leafDirectoryLength: 0,
    tileDataOffset: 127 + root.length,
    tileDataLength: data.length,
    numAddressedTiles: tiles.length,
    numTileEntries: tiles.length,
    numTileContents: tiles.length,
    clustered: true,
    internalCompression: internal,
    tileCompression: PmCompression.None,
    tileType: 1,
    minZoom: 0,
    maxZoom: 2,
    minLon: -180,
    minLat: -85,
    maxLon: 180,
    maxLat: 85,
    centerZoom: 0,
    centerLon: 0,
    centerLat: 0,
  };
  return Buffer.concat([encodePmHeader(header), root, data]);
}

test('a damaged map archive is refused as one or read; nothing else is thrown', async () => {
  const next = rng(2026);
  let read = 0;
  let refused = 0;
  for (const internal of [PmCompression.Gzip, PmCompression.None]) {
    const good = pmtiles(internal);
    const reader = (b: Uint8Array) => async (offset: number, length: number) => {
      // What a file or a range request gives for a span that is not there: what there is.
      assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0);
      return b.subarray(Math.min(offset, b.length), Math.min(offset + length, b.length));
    };
    assert.equal(Buffer.from((await readPmTile(reader(good), readPmHeader(good), 1, 1, 1))!).toString(), 'tile-1-1-1');
    for (let i = 0; i < 3000; i++) {
      const b = damage(good, next, 127);
      const started = performance.now();
      try {
        const header = readPmHeader(b);
        for (const [z, x, y] of [
          [0, 0, 0],
          [1, 1, 1],
          [2, 3, 2],
          [2, 0, 0],
        ] as const)
          await readPmTile(reader(b), header, z, x, y);
        read++;
      } catch (error) {
        assert.ok(
          error instanceof PmtilesFormatError,
          `threw ${String(error)} on ${Buffer.from(b).toString('hex').slice(0, 300)}`,
        );
        refused++;
      }
      assert.ok(performance.now() - started < 2000);
    }
  }
  assert.ok(read > 500 && refused > 500, `${read} read, ${refused} refused`);
});

test('a damaged pack is refused as a zip or read entry by entry; nothing else is thrown', async () => {
  const dir = await tempDir();
  try {
    const good = rawZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ id: 'pack', files: ['a', 'b'] })) },
      { name: 'data/places.ndjson', data: Buffer.from('{"name":"Honolulu"}\n'.repeat(200)) },
      { name: 'maps/world.pmtiles', data: Buffer.from(pmtiles(PmCompression.Gzip)), method: 0 },
    ]);
    const next = rng(31);
    const file = path.join(dir, 'damaged.zip');
    let opened = 0;
    let refused = 0;
    let entriesRead = 0;
    for (let i = 0; i < 2500; i++) {
      // The end record and the central directory are at the end; lean on them.
      const b = damage(next() < 0.5 ? good : Buffer.from(good).reverse(), next, 200);
      await fs.writeFile(file, i % 2 === 0 || next() < 0.5 ? b : Buffer.from(b).reverse());
      const started = performance.now();
      const before = process.memoryUsage().arrayBuffers;
      let reader: ZipReader | undefined;
      try {
        reader = await ZipReader.open(file);
        opened++;
        for (const entry of reader.entries()) {
          try {
            const bytes = await reader.readEntry(entry.name, { maxBytes: 1024 * 1024 });
            assert.equal(bytes.length, entry.uncompressedSize);
            entriesRead++;
          } catch (error) {
            assert.ok(error instanceof ZipFormatError, `readEntry threw ${String(error)}`);
          }
        }
      } catch (error) {
        assert.ok(error instanceof ZipFormatError, `open threw ${String(error)}`);
        refused++;
      } finally {
        await reader?.close();
      }
      assert.ok(performance.now() - started < 2000);
      const grew = process.memoryUsage().arrayBuffers - before;
      assert.ok(grew < 32 * 1024 * 1024, `held ${Math.round(grew / 1e6)} MB for a ${b.length}-byte file`);
    }
    assert.ok(
      opened > 200 && refused > 200 && entriesRead > 200,
      `${opened} opened, ${refused} refused, ${entriesRead} entries`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
