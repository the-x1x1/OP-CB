import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The entry names of a zip file, from its central directory alone: the end-of-central-directory
 * record is found in the last 64 KiB, the directory read from where it points, each entry's
 * name decoded. Nothing is inflated. Enough to say what a release zip holds; not a zip reader.
 * A zip64 archive (one the 32-bit fields cannot describe) is read through its zip64 locator.
 */
export function zipEntryNames(file: string, maxEntries = 100_000): string[] {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65_536 + 22);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
    let entries = tail.readUInt16LE(eocd + 10);
    let dirSize = tail.readUInt32LE(eocd + 12);
    let dirOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
      // zip64: the locator sits just before the record and names the zip64 record.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 archive without its locator');
      const z64At = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = Buffer.alloc(56);
      readSync(fd, z64, 0, 56, z64At);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 end-of-central-directory record not found');
      entries = Number(z64.readBigUInt64LE(32));
      dirSize = Number(z64.readBigUInt64LE(40));
      dirOffset = Number(z64.readBigUInt64LE(48));
    }
    if (entries > maxEntries) throw new Error(`zip holds ${entries} entries; more than ${maxEntries}`);
    if (dirSize > 256 * 1024 * 1024) throw new Error('central directory larger than expected');
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);
    const names: string[] = [];
    let at = 0;
    for (let i = 0; i < entries; i++) {
      if (at + 46 > dir.length || dir.readUInt32LE(at) !== 0x02014b50)
        throw new Error(`central directory entry ${i} is not where the record says`);
      const nameLen = dir.readUInt16LE(at + 28);
      const extraLen = dir.readUInt16LE(at + 30);
      const commentLen = dir.readUInt16LE(at + 32);
      const flags = dir.readUInt16LE(at + 8);
      const raw = dir.subarray(at + 46, at + 46 + nameLen);
      // Bit 11: the name is UTF-8; otherwise CP437, which is ASCII for the names checked here.
      names.push(flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1'));
      at += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

/**
 * What the portable zip must hold to be portable as unzipped (apps/desktop/scripts/package.mjs
 * puts the data folder in after electron-builder): the exe at the root, the data folder's note
 * beside it. The problems found, none when it is right.
 */
export function portableZipProblems(names: readonly string[], exe = 'OP-CB.exe', dataDir = 'OP-CB-data'): string[] {
  const problems: string[] = [];
  const normal = names.map((n) => n.replace(/\\/g, '/'));
  if (!normal.includes(exe)) {
    const elsewhere = normal.find((n) => n.endsWith(`/${exe}`));
    problems.push(
      elsewhere
        ? `${exe} is at ${elsewhere}, not at the root of the zip`
        : `${exe} is not in the zip (${normal.length} entries)`,
    );
  }
  if (!normal.includes(`${dataDir}/READ-ME.txt`))
    problems.push(`${dataDir}/READ-ME.txt is not in the zip: the copy would not be portable as unzipped`);
  return problems;
}
