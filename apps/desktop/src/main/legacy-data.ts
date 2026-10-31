import fs from 'node:fs';
import path from 'node:path';

/**
 * Data written before the rename to OP-CB (0.7.2, the operator's decision of 2026-10-30: the
 * name, the executable, the files and the hidden application id all became OP-CB). The new
 * application id makes the installed program a new one, and its data folder a new folder, so the
 * first start of OP-CB carries what the old program left behind:
 *
 *  1. **The usual folder.** `<appData>/@worldview/desktop` (Windows `%APPDATA%`, Linux
 *     `~/.config`) is *moved* — renamed, on the same drive, so nothing is copied and nothing
 *     doubles — to `<appData>/OP-CB`. A `data-location.json` in it (the data kept on a drive)
 *     comes along and keeps working.
 *  2. **A portable folder.** `WorldView-data` beside the executable is renamed `OP-CB-data`.
 *  3. **A drive folder's marker.** `worldview-data.json` there is renamed `opcb-data.json`
 *     (data-location.ts reads either).
 *
 * All of it happens before the single-instance lock and before Electron writes anything, and
 * only when the new place holds no OP-CB data yet. If the old program is still running its
 * files are in use: nothing is moved and the start says so (main.ts), because a half-moved
 * folder would split the operator's data in two.
 */

export const LEGACY_USUAL_PARTS: readonly string[] = Object.freeze(['@worldview', 'desktop']);
export const LEGACY_PORTABLE_DIR_NAME = 'WorldView-data';
export const LEGACY_MARKER_FILE = 'worldview-data.json';
/** Files Electron or OP-CB may have written to the new folder before anything of value. */
const IGNORABLE_IN_NEW = new Set(['Crashpad', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);

export type LegacyFs = Pick<
  typeof fs,
  'existsSync' | 'statSync' | 'readdirSync' | 'renameSync' | 'rmdirSync' | 'readlinkSync' | 'readFileSync'
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

/** Whether a folder holds nothing but what Electron writes on its own at start. */
function holdsNoData(f: LegacyFs, dir: string): boolean {
  if (!f.existsSync(dir)) return true;
  try {
    return f.readdirSync(dir).every((n) => IGNORABLE_IN_NEW.has(n));
  } catch {
    return false;
  }
}

/** Linux: Chromium's SingletonLock is a symlink `host-pid`; a live pid means the old app runs. */
function linuxOldAppRunning(f: LegacyFs, dir: string, alive: (pid: number) => boolean): boolean {
  try {
    const target = f.readlinkSync(path.join(dir, 'SingletonLock'));
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    return Number.isInteger(pid) && pid > 0 && alive(pid);
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM';
  }
}

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function migrateLegacyData(opts: {
  appData: string;
  newUsual: string;
  exeDir: string;
  dev: boolean;
  platform?: NodeJS.Platform;
  f?: LegacyFs;
  alive?: (pid: number) => boolean;
}): LegacyResult {
  const f = opts.f ?? fs;
  const platform = opts.platform ?? process.platform;
  const result: LegacyResult = { moved: [], problems: [] };

  // 2. Portable folder beside the executable (never in development, like data-location.ts).
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
  }

  // 1. The usual folder.
  const oldUsual = path.join(opts.appData, ...LEGACY_USUAL_PARTS);
  if (isDir(f, oldUsual) && holdsNoData(f, opts.newUsual)) {
    if (platform === 'linux' && linuxOldAppRunning(f, oldUsual, opts.alive ?? pidAlive)) {
      result.busy = oldUsual;
      return result;
    }
    // One atomic rename first: on Windows it fails while any file in the folder is open, which
    // is exactly when the old program runs, and then nothing at all has moved.
    const staging = `${oldUsual}.moving-to-opcb`;
    try {
      f.renameSync(oldUsual, staging);
    } catch (err) {
      if (BUSY_CODES.has(errCode(err) ?? '')) result.busy = oldUsual;
      else result.problems.push(`could not move ${oldUsual}: ${errText(err)}`);
      return result;
    }
    try {
      if (!f.existsSync(opts.newUsual)) {
        f.renameSync(staging, opts.newUsual);
      } else {
        // Electron already made the new folder (crash reporter): move the old contents into it.
        for (const name of f.readdirSync(staging)) {
          const to = path.join(opts.newUsual, name);
          if (f.existsSync(to)) continue;
          f.renameSync(path.join(staging, name), to);
        }
        try {
          f.rmdirSync(staging);
        } catch {
          result.problems.push(`left over: ${staging} (only what OP-CB already had)`);
        }
      }
      result.moved.push(`${oldUsual} → ${opts.newUsual}`);
    } catch (err) {
      result.problems.push(`moving ${oldUsual} stopped part way: ${errText(err)}; the rest is in ${staging}`);
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
