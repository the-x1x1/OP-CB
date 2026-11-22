/** Node-only helpers (main process, tools): atomic file writes, rotating file log sink, sha256. */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { LogRecord, LogSink } from './logger.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Atomic write: write to a temp file in the same directory, fsync, then rename over the
 * target. A crash mid-write never leaves a truncated settings/collections file.
 */
export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  // pid + time alone collide when two writes of one file start in the same millisecond (two
  // refreshes racing); the random part makes each temporary file its own.
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`,
  );
  // The temporary file is always new, so `mode` (less the umask) is what the target ends up
  // with after the rename. Windows keeps only the read-only bit of it.
  const handle = await fs.open(tmp, 'w', options.mode ?? 0o666);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameOver(tmp, target);
  } catch (err) {
    // A write that failed (a full disk, a target that cannot be replaced) left its temporary
    // file behind, one more each time the save was tried again.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_MS = [10, 25, 50, 100, 200];

/**
 * Rename over the target, trying again for a moment when Windows refuses because something
 * (a virus scanner, the search indexer, a backup tool) has the target open right then.
 */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const wait = RENAME_RETRY_MS[attempt];
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || wait === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Read a file, trying again for a moment when Windows refuses because something (a virus
 * scanner, OneDrive, the search indexer) has it open right then — the same codes and waits as
 * the rename above. A file held at start used to read as unreadable: settings stopped the app
 * starting, and a list or the key file showed empty until the next change re-read it.
 */
export async function readFileRetrying(
  file: string,
  opts: { platform?: NodeJS.Platform; read?: (file: string) => Promise<string> } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const read = opts.read ?? ((f: string) => fs.readFile(f, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    try {
      return await read(file);
    } catch (err) {
      const wait = RENAME_RETRY_MS[attempt];
      const code = (err as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || wait === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function readJsonFile<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFileRetrying(file)) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Size-rotating JSON-lines log sink: app.log, app.log.1 … app.log.N. */
export class RotatingFileSink implements LogSink {
  constructor(
    private readonly file: string,
    private readonly opts: { maxBytes?: number; keep?: number } = {},
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  write(record: LogRecord): void {
    const line = JSON.stringify(record) + '\n';
    try {
      if (existsSync(this.file) && statSync(this.file).size + line.length > (this.opts.maxBytes ?? 5 * 1024 * 1024))
        this.rotate();
      appendFileSync(this.file, line);
    } catch {
      /* never throw from a log sink */
    }
  }
  private rotate(): void {
    const keep = this.opts.keep ?? 3;
    const last = `${this.file}.${keep}`;
    if (existsSync(last)) unlinkSync(last);
    for (let i = keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.file}.${i + 1}`);
    }
    renameSync(this.file, `${this.file}.1`);
  }
}
