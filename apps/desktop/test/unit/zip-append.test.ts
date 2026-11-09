import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** A zip with one deflated entry, as electron-builder's portable zip holds them. */
function deflatedZip(name: string, text: string): Buffer {
  const n = Buffer.from(name);
  const raw = Buffer.from(text);
  const data = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(n.length, 28);
  const dir = Buffer.concat([central, n]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, dir, end]);
}

/** Every entry, read the way an unzip tool does: end record → central directory → local header. */
function readAll(zip: Buffer): Array<{ name: string; text: string }> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  assert.equal(at + zip.readUInt32LE(eocd + 12), eocd, 'the directory ends where the end record starts');
  const out: Array<{ name: string; text: string }> = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const csize = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    assert.equal(zip.readUInt32LE(local), 0x04034b50, `${name}: local header where the directory says`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const stored = zip.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(stored) : stored;
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out.push({ name, text: data.toString('utf8') });
    at += 46 + skip;
  }
  return out;
}

test('zip append: the data folder and its note go in beside what was there, every entry still reads', async () => {
  const { appendStoredEntries } = await import('../../scripts/zip-append.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'opcb-zip-append-'));
  try {
    const file = path.join(dir, 'OP-CB-Portable-0.0.0.zip');
    writeFileSync(file, deflatedZip('OP-CB.exe', 'MZ'.repeat(500)));
    const added = appendStoredEntries(file, [
      { name: 'OP-CB-data/' },
      { name: 'OP-CB-data/READ-ME.txt', data: 'This folder makes this copy of OP-CB portable.\r\n' },
    ]);
    assert.deepEqual(added, ['OP-CB-data/', 'OP-CB-data/READ-ME.txt']);
    const entries = readAll(readFileSync(file));
    assert.deepEqual(
      entries.map((e) => e.name),
      ['OP-CB.exe', 'OP-CB-data/', 'OP-CB-data/READ-ME.txt'],
    );
    assert.equal(entries[0]!.text, 'MZ'.repeat(500), 'the existing entry is untouched');
    assert.equal(entries[2]!.text, 'This folder makes this copy of OP-CB portable.\r\n');
    assert.throws(
      () => appendStoredEntries(path.join(dir, 'missing.zip'), [{ name: 'x' }]),
      /ENOENT/,
      'no zip, nothing written',
    );
    writeFileSync(path.join(dir, 'text.zip'), 'not a zip at all, long enough to search through');
    assert.throws(() => appendStoredEntries(path.join(dir, 'text.zip'), [{ name: 'x' }]), /not a zip file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
