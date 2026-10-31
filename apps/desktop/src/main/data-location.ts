import fs from 'node:fs';
import path from 'node:path';

/**
 * Where OP-CB keeps everything it writes — settings, history, packs, keys, logs (2026-10-30,
 * the operator's "put it all on the 2 TB SSD"). Decided before the app is ready, because
 * Electron's `userData` must be set before anything uses it. Three ways, first that applies:
 *
 *  1. **Portable**: a folder named `OP-CB-data` next to the OP-CB executable (the
 *     portable copy unzipped onto an external drive). Everything lives there and travels with the
 *     drive. Made by the operator, never created by the app.
 *  2. **Moved**: `data-location.json` in the usual folder names another folder (Command Center
 *     → Resources → "Keep all OP-CB data on a drive"). That folder must carry the marker
 *     file OP-CB wrote there: an unplugged drive's mount point is an empty folder on the
 *     internal disk, and OP-CB must never start writing into it. When the marker is not
 *     there the start says so and offers this computer's own data instead (main.ts).
 *  3. **Usual**: the operating system's application-data folder.
 *
 * The keys in `credentials.json` are encrypted by the operating system for one user on one
 * computer: on another computer they cannot be read and are asked for again.
 */

export const PORTABLE_DIR_NAME = 'OP-CB-data';
export const POINTER_FILE = 'data-location.json';
export const MARKER_FILE = 'opcb-data.json';
/** The marker's name before the rename to OP-CB (0.7.2); read, never written. */
export const LEGACY_MARKER_FILE = 'worldview-data.json';

export type DataLocationKind = 'usual' | 'portable' | 'moved';

export interface DataLocation {
  root: string;
  kind: DataLocationKind;
  /** The usual folder, where the pointer lives. */
  usualRoot: string;
  /** Set when a moved location could not be used: the folder named, and why. */
  missing?: { path: string; reason: string };
}

type Fs = Pick<typeof fs, 'statSync' | 'readFileSync' | 'existsSync'>;

function isDir(f: Fs, p: string): boolean {
  try {
    return f.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The folder the pointer names, or undefined when there is no usable pointer. */
export function readPointer(f: Fs, usualRoot: string): string | undefined {
  const file = path.join(usualRoot, POINTER_FILE);
  if (!f.existsSync(file)) return undefined;
  try {
    const v = JSON.parse(f.readFileSync(file, 'utf8')) as { path?: unknown };
    return typeof v.path === 'string' && path.isAbsolute(v.path) && !v.path.includes('\0') ? v.path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a folder carries OP-CB's data marker — or the one a folder set up before the rename
 * (0.7.2) carries, `worldview-data.json`; the first start renames that one (legacy-data.ts), but a
 * drive that was out then still has it.
 */
export function hasMarker(f: Fs, dir: string): boolean {
  for (const file of [MARKER_FILE, LEGACY_MARKER_FILE]) {
    try {
      const v = JSON.parse(f.readFileSync(path.join(dir, file), 'utf8')) as { kind?: unknown };
      if (v.kind === 'opcb-data' || v.kind === 'worldview-data') return true;
    } catch {
      /* not this one */
    }
  }
  return false;
}

export function resolveDataLocation(opts: { usualRoot: string; exeDir: string; dev: boolean; f?: Fs }): DataLocation {
  const f = opts.f ?? fs;
  const usual: DataLocation = { root: opts.usualRoot, kind: 'usual', usualRoot: opts.usualRoot };
  if (!opts.dev) {
    const portable = path.join(opts.exeDir, PORTABLE_DIR_NAME);
    if (isDir(f, portable)) return { root: portable, kind: 'portable', usualRoot: opts.usualRoot };
  }
  const named = readPointer(f, opts.usualRoot);
  if (!named) return usual;
  if (!isDir(f, named))
    return { ...usual, missing: { path: named, reason: 'the folder is not there (is the drive plugged in?)' } };
  if (!hasMarker(f, named))
    return {
      ...usual,
      missing: { path: named, reason: 'the folder is not the one OP-CB marked (the drive may not be mounted)' },
    };
  return { root: named, kind: 'moved', usualRoot: opts.usualRoot };
}

/** Small files worth carrying to a new data folder; history, packs and caches stay put. */
export const CARRIED_FILES: readonly string[] = Object.freeze([
  'settings.json',
  'credentials.json',
  'collections.json',
  'watchzones.json',
  'lenses.json',
  'cameras.json',
  'guides.json',
  'preparedness.json',
]);

/**
 * Make `target` OP-CB's data folder from the next start: mark it, carry the small files
 * across when it holds no OP-CB data yet (an already-marked folder — the drive set up on
 * another computer — is used as it is), then write the pointer. Returns what was done or why not.
 */
export async function moveDataTo(
  target: string,
  from: string,
  usualRoot: string,
): Promise<{ ok: true; carried: string[]; adopted: boolean } | { ok: false; reason: string }> {
  if (!path.isAbsolute(target)) return { ok: false, reason: 'choose a folder' };
  const resolved = path.resolve(target);
  if (resolved === path.resolve(from)) return { ok: false, reason: 'that is already where the data is' };
  if (resolved.startsWith(path.resolve(from) + path.sep) || path.resolve(from).startsWith(resolved + path.sep))
    return { ok: false, reason: 'choose a folder outside the current data folder' };
  const p = fs.promises;
  try {
    await p.mkdir(resolved, { recursive: true });
    const probe = path.join(resolved, `.write-test-${process.pid}`);
    await p.writeFile(probe, 'x');
    await p.rm(probe);
  } catch (err) {
    return {
      ok: false,
      reason: `the folder cannot be written to (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const adopted = hasMarker(fs, resolved);
  const carried: string[] = [];
  if (!adopted) {
    const existing = (await p.readdir(resolved)).filter((n) => !n.startsWith('.'));
    if (existing.length) return { ok: false, reason: 'choose an empty folder (or one OP-CB already uses)' };
    for (const name of CARRIED_FILES) {
      try {
        await p.copyFile(path.join(from, name), path.join(resolved, name));
        carried.push(name);
      } catch {
        /* not there: nothing to carry */
      }
    }
    await p.writeFile(
      path.join(resolved, MARKER_FILE),
      `${JSON.stringify({ kind: 'opcb-data', createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  await p.mkdir(usualRoot, { recursive: true });
  await p.writeFile(path.join(usualRoot, POINTER_FILE), `${JSON.stringify({ path: resolved }, null, 2)}\n`);
  return { ok: true, carried, adopted };
}

/** Back to the usual folder from the next start; the moved folder is left as it is. */
export async function backToUsualData(usualRoot: string): Promise<void> {
  await fs.promises.rm(path.join(usualRoot, POINTER_FILE), { force: true });
}
