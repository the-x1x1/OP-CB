/**
 * Adds stored (uncompressed) entries to an existing zip in place, with Node alone: the new
 * entries' local headers are written where the central directory was, followed by the old
 * central directory, the new entries' central records and a new end record. Nothing already in
 * the archive is read or moved. Used by package.mjs to put `OP-CB-data/READ-ME.txt` into the
 * portable zip; the build machine has no 7za on a path package.mjs can find (electron-builder
 * keeps its own in a download cache), which failed the 0.7.4 build.
 *
 * Plain zip only: a zip64 archive (over 4 GiB or 65,535 entries) is refused, never half-written.
 */
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const UTF8_FLAG = 0x800;

/** MS-DOS date and time fields for `date` (local time, as zip tools write them). */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {string} zipPath
 * @param {Array<{ name: string; data?: string | Buffer }>} files  a name ending in `/` is a folder
 * @param {Date} [when]
 * @returns {string[]} the names added
 */
export function appendStoredEntries(zipPath, files, when = new Date()) {
  const fd = openSync(zipPath, 'r+');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65_535 + 22 + 20);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${zipPath} is not a zip file (no end-of-central-directory record)`);
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG)
      throw new Error(`${zipPath} is a zip64 archive; entries are not added to one here`);
    const disk = tail.readUInt16LE(eocd + 4);
    const entries = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0) throw new Error(`${zipPath} spans several disks`);
    if (dirOffset + dirSize > size - tailLen + eocd)
      throw new Error(`${zipPath}: the central directory is not where the end record says`);
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);
    if (dirSize > 0 && dir.readUInt32LE(0) !== CENTRAL_SIG)
      throw new Error(`${zipPath}: no central directory at offset ${dirOffset}`);

    const { time, day } = dosDateTime(when);
    const locals = [];
    const centrals = [];
    let offset = dirOffset;
    for (const f of files) {
      const name = Buffer.from(f.name, 'utf8');
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
      const folder = f.name.endsWith('/');
      if (folder && data.length) throw new Error(`${f.name}: a folder entry holds no data`);
      const crc = data.length ? crc32(data) : 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_SIG, 0);
      local.writeUInt16LE(20, 4); // version needed: 2.0
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(CENTRAL_SIG, 0);
      central.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0 (attributes below are DOS ones)
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(UTF8_FLAG, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(day, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(folder ? 0x10 : 0x20, 38); // DOS directory / archive bit
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, data);
      centrals.push(central, name);
      offset += local.length + name.length + data.length;
    }
    const total = entries + files.length;
    const newDir = Buffer.concat([dir, ...centrals]);
    if (total > 0xfffe || offset + newDir.length > 0xfffffffe)
      throw new Error(`${zipPath} would need zip64 with these entries; nothing was written`);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD_SIG, 0);
    end.writeUInt16LE(total, 8);
    end.writeUInt16LE(total, 10);
    end.writeUInt32LE(newDir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20); // any archive comment is dropped with the old end record
    const out = Buffer.concat([...locals, newDir, end]);
    writeSync(fd, out, 0, out.length, dirOffset);
    ftruncateSync(fd, dirOffset + out.length);
    return files.map((f) => f.name);
  } finally {
    closeSync(fd);
  }
}
