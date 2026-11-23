import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@opcb/core/node';
import type { PrivateEntry, PrivateStatus } from '@opcb/ipc-contract';

/**
 * The private folder (2026-11-22): the operator's own documents — IDs, deeds, prescriptions,
 * insurance, contacts — kept inside OP-CB's data folder, encrypted, so a lost drive or laptop
 * gives nothing away.
 *
 * - A random 256-bit data key encrypts everything (AES-256-GCM, a fresh 96-bit nonce per
 *   write). The data key itself is stored wrapped (AES-256-GCM) under a key derived from the
 *   passphrase with scrypt; changing the passphrase re-wraps the data key and touches no file.
 * - File names, sizes and dates are in an encrypted index, so the folder shows only random ids.
 * - The passphrase is never stored or logged; the derived keys live only in memory while the
 *   folder is open, and are dropped when it is closed, after `idleMs` unused, or at quit.
 * - There is no way back in without the passphrase. That is the point; the window says so.
 * - Wrong passphrases are slowed down after the fifth in a row (doubling, at most a minute).
 *
 * Every file on disk starts with `OPCBPRV1`, then the 12-byte nonce, the ciphertext and the
 * 16-byte tag. The header (magic and a purpose byte) is authenticated as associated data, so
 * an index cannot be swapped for a file or the other way round.
 */

export const PRIVATE_DIR = 'private';
const MAGIC = Buffer.from('OPCBPRV1', 'ascii');
const KEY_FILE = 'key.json';
const INDEX_FILE = 'index.opcbx';
const FILE_EXT = '.opcbx';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PURPOSE_INDEX = 1;
const PURPOSE_FILE = 2;
export const MIN_PASSPHRASE = 8;
export const MAX_PASSPHRASE = 1024;
/** One file at most (read whole into memory to encrypt). */
export const MAX_PRIVATE_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_PRIVATE_FILES = 2000;
const ID_PATTERN = /^[0-9a-f]{32}$/;
/** scrypt cost for new folders: 2^17 × 8 × 128 B = 128 MiB of memory, about a third of a second. */
export const DEFAULT_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });

export class PrivateStoreError extends Error {
  constructor(
    message: string,
    readonly kind: 'wrong-passphrase' | 'closed' | 'not-set' | 'already-set' | 'invalid' | 'wait' | 'damaged',
  ) {
    super(message);
    this.name = 'PrivateStoreError';
  }

  /** How the IPC router answers it: a wrong or missing passphrase is DENIED, never INTERNAL. */
  get ipcCode(): 'INVALID_REQUEST' | 'DENIED' | 'UNAVAILABLE' {
    if (this.kind === 'wrong-passphrase' || this.kind === 'closed' || this.kind === 'wait') return 'DENIED';
    if (this.kind === 'damaged') return 'UNAVAILABLE';
    return 'INVALID_REQUEST';
  }
}

interface KeyFile {
  formatVersion: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  /** The data key, wrapped: base64 of nonce ‖ ciphertext ‖ tag. */
  wrapped: string;
}

export interface PrivateStoreOptions {
  /** OP-CB's data folder; the private folder is `<dataDir>/private`. */
  dataDir: string;
  now?: () => number;
  /** Closed after this long unused (default 15 minutes; 0 never). */
  idleMs?: number;
  /** For tests: a cheaper scrypt. */
  scrypt?: { N: number; r: number; p: number };
}

function scrypt(pass: string, salt: Buffer, o: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pass.normalize('NFC'), salt, 32, { ...o, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

function seal(key: Buffer, purpose: number, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.concat([MAGIC, Buffer.from([purpose])]));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, nonce, body, c.getAuthTag()]);
}

function open(key: Buffer, purpose: number, sealed: Buffer): Buffer {
  if (sealed.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || !sealed.subarray(0, MAGIC.length).equals(MAGIC))
    throw new PrivateStoreError('not a private-folder file', 'damaged');
  const nonce = sealed.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const body = sealed.subarray(MAGIC.length + NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.concat([MAGIC, Buffer.from([purpose])]));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new PrivateStoreError('the file does not open with this key (damaged or changed)', 'damaged');
  }
}

/** A name kept for a file: its last path part, no control characters, at most 200 characters. */
export function privateName(name: string): string {
  const base = (name.split(/[/\\]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, 200);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

export function passphraseProblem(p: unknown): string | undefined {
  if (typeof p !== 'string') return 'the passphrase must be text';
  if ([...p].length < MIN_PASSPHRASE) return `the passphrase must be at least ${MIN_PASSPHRASE} characters`;
  if (p.length > MAX_PASSPHRASE) return `the passphrase must be at most ${MAX_PASSPHRASE} characters`;
  return undefined;
}

export class PrivateStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly cost: { N: number; r: number; p: number };
  private dataKey: Buffer | undefined;
  private entries: PrivateEntry[] = [];
  private lastUse = 0;
  private failures = 0;
  private waitUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: PrivateStoreOptions) {
    this.dir = path.join(opts.dataDir, PRIVATE_DIR);
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 15 * 60_000;
    this.cost = opts.scrypt ?? DEFAULT_SCRYPT;
  }

  /** Changes take turns: two adds at once never write the index over each other. */
  private inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private expireIfIdle(): void {
    if (!this.dataKey || this.idleMs <= 0) return;
    const elapsed = this.now() - this.lastUse;
    // A clock put back counts as use now, not as never idle.
    if (elapsed < 0) this.lastUse = this.now();
    else if (elapsed >= this.idleMs) this.close();
  }

  private key(): Buffer {
    this.expireIfIdle();
    if (!this.dataKey) throw new PrivateStoreError('the private folder is closed', 'closed');
    this.lastUse = this.now();
    return this.dataKey;
  }

  private async readKeyFile(): Promise<KeyFile | undefined> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.dir, KEY_FILE), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new PrivateStoreError('the private folder’s key file is damaged', 'damaged');
    }
    const k = v as Partial<KeyFile> | null;
    const kdf = k?.kdf;
    const ok =
      k?.formatVersion === 1 &&
      kdf?.name === 'scrypt' &&
      Number.isSafeInteger(kdf.N) &&
      kdf.N >= 2 ** 10 &&
      kdf.N <= 2 ** 20 &&
      (kdf.N & (kdf.N - 1)) === 0 &&
      Number.isSafeInteger(kdf.r) &&
      kdf.r >= 1 &&
      kdf.r <= 32 &&
      Number.isSafeInteger(kdf.p) &&
      kdf.p >= 1 &&
      kdf.p <= 4 &&
      typeof kdf.salt === 'string' &&
      Buffer.from(kdf.salt, 'base64').length === 16 &&
      typeof k.wrapped === 'string' &&
      Buffer.from(k.wrapped, 'base64').length === MAGIC.length + NONCE_BYTES + 32 + TAG_BYTES;
    if (!ok) throw new PrivateStoreError('the private folder’s key file is damaged', 'damaged');
    return k as KeyFile;
  }

  async status(): Promise<PrivateStatus> {
    this.expireIfIdle();
    const set = (await this.readKeyFile().catch(() => ({}) as KeyFile)) !== undefined;
    const wait = Math.max(0, Math.ceil((this.waitUntil - this.now()) / 1000));
    return {
      set,
      open: !!this.dataKey,
      ...(this.dataKey ? { entries: this.entries.map((e) => ({ ...e })) } : {}),
      ...(wait > 0 && !this.dataKey ? { waitSeconds: Math.min(wait, 60) } : {}),
    };
  }

  /** Chooses the passphrase for a new private folder and opens it. */
  setup(passphrase: string): Promise<PrivateStatus> {
    return this.inTurn(async () => {
      const problem = passphraseProblem(passphrase);
      if (problem) throw new PrivateStoreError(problem, 'invalid');
      if (await this.readKeyFile().catch(() => true))
        throw new PrivateStoreError('the private folder is already set up', 'already-set');
      await fs.mkdir(this.dir, { recursive: true });
      const dataKey = randomBytes(32);
      await this.writeKeyFile(passphrase, dataKey);
      this.dataKey = dataKey;
      this.entries = [];
      this.lastUse = this.now();
      await this.writeIndex();
      return this.status();
    });
  }

  private async writeKeyFile(passphrase: string, dataKey: Buffer): Promise<void> {
    const salt = randomBytes(16);
    const kek = await scrypt(passphrase, salt, this.cost);
    const file: KeyFile = {
      formatVersion: 1,
      kdf: { name: 'scrypt', ...this.cost, salt: salt.toString('base64') },
      wrapped: seal(kek, 0, dataKey).toString('base64'),
    };
    kek.fill(0);
    await writeFileAtomic(path.join(this.dir, KEY_FILE), `${JSON.stringify(file, null, 2)}\n`);
  }

  private async unwrap(passphrase: string): Promise<Buffer> {
    const file = await this.readKeyFile();
    if (!file) throw new PrivateStoreError('the private folder has not been set up', 'not-set');
    const wait = this.waitUntil - this.now();
    if (wait > 0 && wait <= 60_000)
      throw new PrivateStoreError(`too many wrong passphrases: wait ${Math.ceil(wait / 1000)} s`, 'wait');
    const kek = await scrypt(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
    try {
      const key = open(kek, 0, Buffer.from(file.wrapped, 'base64'));
      kek.fill(0);
      if (key.length !== 32) throw new PrivateStoreError('damaged', 'damaged');
      this.failures = 0;
      this.waitUntil = 0;
      return key;
    } catch {
      kek.fill(0);
      this.failures++;
      if (this.failures >= 5) this.waitUntil = this.now() + Math.min(60_000, 1000 * 2 ** (this.failures - 5));
      throw new PrivateStoreError('that is not the passphrase', 'wrong-passphrase');
    }
  }

  /** Opens the folder with its passphrase. */
  unlock(passphrase: string): Promise<PrivateStatus> {
    return this.inTurn(async () => {
      if (typeof passphrase !== 'string' || passphrase.length > MAX_PASSPHRASE)
        throw new PrivateStoreError('that is not the passphrase', 'wrong-passphrase');
      const key = await this.unwrap(passphrase);
      const entries = await this.readIndex(key);
      this.dataKey = key;
      this.entries = entries;
      this.lastUse = this.now();
      return this.status();
    });
  }

  /** Closes the folder: the keys are dropped from memory. */
  close(): void {
    this.dataKey?.fill(0);
    this.dataKey = undefined;
    this.entries = [];
  }

  changePassphrase(current: string, next: string): Promise<PrivateStatus> {
    return this.inTurn(async () => {
      const problem = passphraseProblem(next);
      if (problem) throw new PrivateStoreError(problem, 'invalid');
      const key = await this.unwrap(current);
      await this.writeKeyFile(next, key);
      if (!this.dataKey) key.fill(0);
      return this.status();
    });
  }

  private async readIndex(key: Buffer): Promise<PrivateEntry[]> {
    let sealed: Buffer;
    try {
      sealed = await fs.readFile(path.join(this.dir, INDEX_FILE));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let v: unknown;
    try {
      v = JSON.parse(open(key, PURPOSE_INDEX, sealed).toString('utf8'));
    } catch {
      throw new PrivateStoreError('the private folder’s list is damaged', 'damaged');
    }
    if (!Array.isArray(v)) throw new PrivateStoreError('the private folder’s list is damaged', 'damaged');
    const out: PrivateEntry[] = [];
    for (const x of v as Record<string, unknown>[])
      if (
        x &&
        typeof x['id'] === 'string' &&
        ID_PATTERN.test(x['id']) &&
        typeof x['name'] === 'string' &&
        typeof x['sizeBytes'] === 'number' &&
        Number.isSafeInteger(x['sizeBytes']) &&
        typeof x['addedAt'] === 'string'
      )
        out.push({ id: x['id'], name: privateName(x['name']), sizeBytes: x['sizeBytes'], addedAt: x['addedAt'] });
    return out;
  }

  private async writeIndex(): Promise<void> {
    const key = this.key();
    await writeFileAtomic(
      path.join(this.dir, INDEX_FILE),
      seal(key, PURPOSE_INDEX, Buffer.from(JSON.stringify(this.entries))),
    );
  }

  list(): PrivateEntry[] {
    this.key();
    return this.entries.map((e) => ({ ...e }));
  }

  /** Encrypts a file into the folder. */
  add(name: string, data: Uint8Array): Promise<PrivateEntry> {
    return this.inTurn(async () => {
      const key = this.key();
      if (data.length > MAX_PRIVATE_FILE_BYTES)
        throw new PrivateStoreError(
          `a file in the private folder can be at most ${MAX_PRIVATE_FILE_BYTES / 1024 ** 2} MB`,
          'invalid',
        );
      if (this.entries.length >= MAX_PRIVATE_FILES)
        throw new PrivateStoreError(`the private folder holds at most ${MAX_PRIVATE_FILES} files`, 'invalid');
      const id = randomBytes(16).toString('hex');
      const file = path.join(this.dir, `${id}${FILE_EXT}`);
      await writeFileAtomic(file, seal(key, PURPOSE_FILE, Buffer.from(data.buffer, data.byteOffset, data.byteLength)));
      const entry: PrivateEntry = {
        id,
        name: privateName(name),
        sizeBytes: data.length,
        addedAt: new Date(this.now()).toISOString(),
      };
      this.entries.push(entry);
      try {
        await this.writeIndex();
      } catch (err) {
        this.entries = this.entries.filter((e) => e.id !== id);
        await fs.rm(file, { force: true });
        throw err;
      }
      return { ...entry };
    });
  }

  /** A file's contents, decrypted (in memory only). */
  async read(id: string): Promise<{ entry: PrivateEntry; data: Buffer }> {
    const key = this.key();
    const entry = this.entries.find((e) => e.id === id);
    if (!ID_PATTERN.test(id) || !entry) throw new PrivateStoreError('no such file in the private folder', 'invalid');
    const data = open(key, PURPOSE_FILE, await fs.readFile(path.join(this.dir, `${id}${FILE_EXT}`)));
    if (data.length !== entry.sizeBytes)
      throw new PrivateStoreError('the file is not the size it was put in at', 'damaged');
    return { entry: { ...entry }, data };
  }

  /** Takes a file out of the list and deletes its encrypted copy. */
  remove(id: string): Promise<PrivateEntry[]> {
    return this.inTurn(async () => {
      this.key();
      const entry = this.entries.find((e) => e.id === id);
      if (!ID_PATTERN.test(id) || !entry) throw new PrivateStoreError('no such file in the private folder', 'invalid');
      const before = this.entries;
      this.entries = this.entries.filter((e) => e.id !== id);
      try {
        await this.writeIndex();
      } catch (err) {
        this.entries = before;
        throw err;
      }
      await fs.rm(path.join(this.dir, `${id}${FILE_EXT}`), { force: true });
      return this.list();
    });
  }
}
