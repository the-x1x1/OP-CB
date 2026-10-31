import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Data written before the rename to OP-CB (0.7.2, the operator's decision of 2026-10-30: the
 * name, the executable, the files and the hidden application id all became OP-CB). The new
 * application id makes the installed program a new one, and its data folder a new folder, so a
 * start of OP-CB carries what the old program left behind:
 *
 *  1. **A portable folder.** `WorldView-data` beside the executable is renamed `OP-CB-data`.
 *     A portable copy never touches the computer's own data folder (step 2 is skipped).
 *  2. **The usual folder.** `<appData>/@worldview/desktop` (Windows `%APPDATA%`, Linux
 *     `~/.config`) is *moved* — renamed on the same drive, nothing copied — into
 *     `<appData>/OP-CB`. A `data-location.json` in it (the data kept on a drive) comes along.
 *     It goes first to `@worldview/desktop.moving-to-opcb` in one atomic rename, then into
 *     place; a start interrupted between the two finishes the move on the next start.
 *  3. **A drive folder's marker.** `worldview-data.json` there is renamed `opcb-data.json`
 *     (data-location.ts reads either).
 *
 * "OP-CB has no data yet" is judged by OP-CB's own files (settings, keys, history, packs …),
 * not by the folder being empty: Chromium writes its profile files there at every start, and
 * those are replaced by the old program's (its `Local State` holds the key the Windows keys are
 * encrypted with). If the old program is still running its files are in use: nothing is moved
 * and the start says so (main.ts), without letting Chromium write into the new folder.
 */

export const LEGACY_USUAL_PARTS: readonly string[] = Object.freeze(['@worldview', 'desktop']);
export const LEGACY_PORTABLE_DIR_NAME = 'WorldView-data';
export const LEGACY_MARKER_FILE = 'worldview-data.json';
export const STAGING_SUFFIX = '.moving-to-opcb';
/** OP-CB's own files: any of them in the new folder means OP-CB already has data there. */
export const OWN_DATA_ENTRIES: readonly string[] = Object.freeze([
  'settings.json',
  'credentials.json',
  'data-location.json',
  'collections.json',
  'history',
  'worldpacks',
  'library',
]);

export type LegacyFs = Pick<
  typeof fs,
  'existsSync' | 'statSync' | 'readdirSync' | 'renameSync' | 'rmdirSync' | 'rmSync' | 'readlinkSync' | 'readFileSync'
>;

export interface LegacyResult {
  /** What was moved, for the log. */
  moved: string[];
  /** Set when old data exists but could not be moved because the old program has it open. */
  busy?: string;
  /** Anything else that went wrong, for the log; the start goes on. */
  problems: string[];
}

function isDir(f: LegacyFs, p: string): boolean {
  try {
    return f.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether OP-CB already keeps data in a folder (its own files, not Chromium's). */
export function holdsOwnData(f: LegacyFs, dir: string): boolean {
  return OWN_DATA_ENTRIES.some((name) => f.existsSync(path.join(dir, name)));
}

/** What is running under a pid, for the Linux check (its command line), or undefined. */
function linuxCmdline(f: LegacyFs, pid: number): string | undefined {
  try {
    return String(f.readFileSync(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
  } catch {
    return undefined;
  }
}

/**
 * Linux: Chromium's SingletonLock is a symlink `host-pid`. The old program runs when that host is
 * this computer and that pid is a WorldView process — a stale lock left by a crash, whose pid a
 * later process reused, does not count.
 */
function linuxOldAppRunning(
  f: LegacyFs,
  dir: string,
  host: string,
  cmdline: (pid: number) => string | undefined,
): boolean {
  try {
    const target = f.readlinkSync(path.join(dir, 'SingletonLock'));
    const cut = target.lastIndexOf('-');
    const pid = Number(target.slice(cut + 1));
    if (target.slice(0, cut) !== host || !Number.isInteger(pid) || pid <= 0) return false;
    return /worldview/i.test(cmdline(pid) ?? '');
  } catch {
    return false;
  }
}

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** Move every entry of `from` into `to` (made if missing); an entry already in `to` is replaced. */
function moveEntries(f: LegacyFs, from: string, to: string): void {
  if (!f.existsSync(to)) {
    f.renameSync(from, to);
    return;
  }
  for (const name of f.readdirSync(from)) {
    const target = path.join(to, name);
    if (f.existsSync(target)) f.rmSync(target, { recursive: true, force: true });
    f.renameSync(path.join(from, name), target);
  }
  f.rmdirSync(from);
}

export function migrateLegacyData(opts: {
  appData: string;
  newUsual: string;
  exeDir: string;
  dev: boolean;
  platform?: NodeJS.Platform;
  f?: LegacyFs;
  hostname?: string;
  cmdline?: (pid: number) => string | undefined;
}): LegacyResult {
  const f = opts.f ?? fs;
  const platform = opts.platform ?? process.platform;
  const result: LegacyResult = { moved: [], problems: [] };

  // 1. Portable folder beside the executable (never in development, like data-location.ts).
  let portable = false;
  if (!opts.dev) {
    const oldPortable = path.join(opts.exeDir, LEGACY_PORTABLE_DIR_NAME);
    const newPortable = path.join(opts.exeDir, 'OP-CB-data');
    if (isDir(f, oldPortable) && !f.existsSync(newPortable)) {
      try {
        f.renameSync(oldPortable, newPortable);
        result.moved.push(`${oldPortable} → ${newPortable}`);
      } catch (err) {
        if (BUSY_CODES.has(errCode(err) ?? '')) result.busy = oldPortable;
        else result.problems.push(`could not rename ${oldPortable}: ${errText(err)}`);
        return result;
      }
    }
    portable = isDir(f, newPortable);
  }

  // 2. The usual folder — not from a portable copy, which leaves the computer's data alone.
  if (!portable) {
    const oldUsual = path.join(opts.appData, ...LEGACY_USUAL_PARTS);
    const staging = `${oldUsual}${STAGING_SUFFIX}`;
    const ownData = holdsOwnData(f, opts.newUsual);
    if (isDir(f, staging)) {
      // An earlier start renamed the old folder and stopped before it was in place.
      try {
        moveEntries(f, staging, opts.newUsual);
        result.moved.push(`${staging} → ${opts.newUsual} (finished)`);
      } catch (err) {
        result.problems.push(`finishing the move of ${staging}: ${errText(err)}`);
      }
    } else if (isDir(f, oldUsual) && ownData) {
      result.problems.push(`${oldUsual} left as it is: ${opts.newUsual} already holds OP-CB data`);
    } else if (isDir(f, oldUsual)) {
      if (
        platform === 'linux' &&
        linuxOldAppRunning(f, oldUsual, opts.hostname ?? os.hostname(), opts.cmdline ?? ((pid) => linuxCmdline(f, pid)))
      ) {
        result.busy = oldUsual;
        return result;
      }
      // One atomic rename first: on Windows it fails while any file in the folder is open, which
      // is exactly when the old program runs, and then nothing at all has moved.
      try {
        f.renameSync(oldUsual, staging);
      } catch (err) {
        if (BUSY_CODES.has(errCode(err) ?? '')) result.busy = oldUsual;
        else result.problems.push(`could not move ${oldUsual}: ${errText(err)}`);
        return result;
      }
      try {
        moveEntries(f, staging, opts.newUsual);
        result.moved.push(`${oldUsual} → ${opts.newUsual}`);
      } catch (err) {
        result.problems.push(`moving ${oldUsual} stopped part way (finished at the next start): ${errText(err)}`);
      }
    }
    // The empty `@worldview` parent goes too, when nothing else is in it.
    try {
      const parent = path.dirname(oldUsual);
      if (f.readdirSync(parent).length === 0) f.rmdirSync(parent);
    } catch {
      /* not empty or not there */
    }
  }

  // 3. The marker of a folder the data was moved to (the pointer now sits in the new folder).
  try {
    const pointer = path.join(opts.newUsual, 'data-location.json');
    if (f.existsSync(pointer)) {
      const named = (JSON.parse(String(f.readFileSync(pointer, 'utf8'))) as { path?: unknown }).path;
      if (typeof named === 'string' && path.isAbsolute(named)) {
        const oldMarker = path.join(named, LEGACY_MARKER_FILE);
        const newMarker = path.join(named, 'opcb-data.json');
        if (f.existsSync(oldMarker) && !f.existsSync(newMarker)) {
          f.renameSync(oldMarker, newMarker);
          result.moved.push(`${oldMarker} → ${newMarker}`);
        }
      }
    }
  } catch (err) {
    result.problems.push(`could not rename the drive folder's marker: ${errText(err)}`);
  }

  return result;
}
