import { promises as fs } from 'node:fs';
import { silentLogger, type CredentialResolver, type Logger } from '@opcb/core';
import { readFileRetrying, writeFileAtomic } from '@opcb/core/node';

/**
 * CredentialStore — API keys and camera credentials, encrypted at rest with
 * Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on
 * Linux). Only the main process can decrypt; the renderer sees `has` and never a
 * value (ADR-004). Injected `SafeStorageLike` lets tests use a fake.
 *
 * File: <userData>/credentials.json  { version: 1, entries: { key: { cipher: base64, updatedAt } } }
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /**
   * Linux only (Electron): which secret store backs the encryption key —
   * `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`, or `basic_text` / `unknown`.
   */
  getSelectedStorageBackend?(): string;
}

/**
 * Linux backends that are not a secret store. `basic_text` is Chromium's fallback when no
 * Secret Service (GNOME Keyring, KWallet) answers: the key it encrypts with is a constant
 * compiled into Chromium, so a file "encrypted" with it is plain text to anyone who reads
 * it. Electron reports isEncryptionAvailable() = false in that state today, but that is a
 * default which Electron has changed before; OP-CB checks the backend itself.
 */
export const INSECURE_LINUX_BACKENDS: ReadonlySet<string> = new Set(['basic_text', 'unknown']);

/**
 * The `--password-store` switch OP-CB gives Chromium on Linux, or undefined to leave it be.
 *
 * Chromium chooses the secret store from XDG_CURRENT_DESKTOP: GNOME, Unity, Cinnamon, Pantheon,
 * Deepin and XFCE get libsecret, KDE gets KWallet, and every other desktop — sway, i3, Hyprland,
 * LXQt, a bare X session — gets `basic_text`, even with GNOME Keyring (or KeePassXC's Secret
 * Service) running. OP-CB refuses basic_text, so on those desktops keys could never be saved
 * however the keyring was set up. Asking for libsecret everywhere but KDE uses a Secret Service
 * when one exists; when none does, Chromium still ends up on basic_text and the store refuses it.
 * An explicit `--password-store` from the user always wins.
 *
 * Changing the store makes keys saved under another one unreadable (they are kept, and reported
 * as unreadable); before this, those desktops could not have saved any.
 */
export function linuxPasswordStore(
  env: Record<string, string | undefined>,
  switchGiven: boolean,
): 'gnome-libsecret' | undefined {
  if (switchGiven) return undefined;
  const desktop = `${env['XDG_CURRENT_DESKTOP'] ?? ''}:${env['DESKTOP_SESSION'] ?? ''}`.toLowerCase();
  if (/kde|plasma/.test(desktop)) return undefined; // KWallet, Chromium's own choice there
  return 'gnome-libsecret';
}

/** Why credentials are refused on this system, for Diagnostics and the startup check. */
export function encryptionUnavailableReason(platform: string, backend: string | undefined): string {
  if (platform === 'linux')
    return backend && INSECURE_LINUX_BACKENDS.has(backend)
      ? `no Secret Service keyring answered (Electron backend "${backend}"); make sure GNOME Keyring, KWallet or another Secret Service is running and unlocked in this desktop session — see docs/cyberdeck/LINUX.md`
      : 'the desktop keyring (Secret Service) could not be used — see docs/cyberdeck/LINUX.md';
  return 'the OS keychain/DPAPI could not be used';
}

export type CredentialErrorCode =
  | 'ENCRYPTION_UNAVAILABLE'
  | 'INVALID_KEY'
  | 'INVALID_VALUE'
  | 'CORRUPT'
  | 'WRITE_FAILED';

export class CredentialStoreError extends Error {
  /** How the window is told, wherever the error is thrown from (a key stored by a draft too). */
  readonly ipcCode: 'UNAVAILABLE' | 'INVALID_REQUEST';
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialStoreError';
    this.ipcCode = code === 'INVALID_KEY' || code === 'INVALID_VALUE' ? 'INVALID_REQUEST' : 'UNAVAILABLE';
  }
}

interface CredentialFile {
  version: 1;
  entries: Record<string, { cipher: string; updatedAt: string }>;
}

export const CREDENTIAL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
export const MAX_CREDENTIAL_LENGTH = 4096;

export const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secure storage is not available on this system (the OS keychain/DPAPI could not be used), so the key was not saved. OP-CB never stores credentials unencrypted.';

export interface CredentialStoreOptions {
  file: string;
  safeStorage: SafeStorageLike;
  logger?: Logger;
  now?: () => number;
  /** process.platform; decides whether the Linux backend check applies. */
  platform?: string;
}

export class CredentialStore implements CredentialResolver {
  private entries: CredentialFile['entries'] = {};
  private readonly logger: Logger;
  private readonly now: () => number;
  private loaded = false;
  /** Set when a damaged file could not be set aside: nothing is written over it. */
  private notSetAside: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CredentialStoreOptions) {
    this.logger = opts.logger ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  get encryptionAvailable(): boolean {
    try {
      if (!this.opts.safeStorage.isEncryptionAvailable()) return false;
      if (this.opts.platform === 'linux') {
        const backend = this.storageBackend;
        // An Electron without the call, or a backend that is not a secret store: refuse.
        if (backend === undefined || INSECURE_LINUX_BACKENDS.has(backend)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The Linux secret-store backend Electron chose, when it says; undefined elsewhere. */
  get storageBackend(): string | undefined {
    if (this.opts.platform !== 'linux') return undefined;
    try {
      return this.opts.safeStorage.getSelectedStorageBackend?.();
    } catch {
      return undefined;
    }
  }

  /** One line for the startup check and the log when encryptionAvailable is false. */
  unavailableReason(): string {
    return encryptionUnavailableReason(this.opts.platform ?? process.platform, this.storageBackend);
  }

  async load(): Promise<{ status: 'loaded' | 'fresh' | 'corrupt'; keys: number }> {
    let raw: string;
    try {
      raw = await readFileRetrying(this.opts.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = {};
        this.loaded = true;
        return { status: 'fresh', keys: 0 };
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CredentialFile>;
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null)
        throw new Error('unexpected shape');
      const entries: CredentialFile['entries'] = {};
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (CREDENTIAL_KEY_PATTERN.test(k) && v && typeof v.cipher === 'string' && typeof v.updatedAt === 'string')
          entries[k] = { cipher: v.cipher, updatedAt: v.updatedAt };
      }
      this.entries = entries;
      this.loaded = true;
      return { status: 'loaded', keys: Object.keys(entries).length };
    } catch (err) {
      // Kept beside before anything is stored: the warning says the file is kept, and the
      // first key stored used to be written over it.
      const aside = `${this.opts.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      try {
        await fs.rename(this.opts.file, aside);
        this.notSetAside = undefined;
      } catch (e) {
        this.notSetAside = (e as NodeJS.ErrnoException).code ?? 'unknown error';
      }
      this.logger.error('credential file unreadable; starting empty (file preserved)', {
        error: err instanceof Error ? err.message : String(err),
        ...(this.notSetAside ? { setAside: `failed (${this.notSetAside}); nothing is written over it` } : {}),
      });
      this.entries = {};
      this.loaded = true;
      return { status: 'corrupt', keys: 0 };
    }
  }

  keys(): string[] {
    return Object.keys(this.entries).sort();
  }

  /**
   * Whether a key is stored *and can be read here*. A key encrypted on another computer, or —
   * on Linux — under the program's name before the rename to OP-CB (the keyring files the
   * encryption key under that name), cannot be decrypted: it counts as not there, so the
   * operator is asked for it again instead of being shown a key no source can use.
   */
  async has(key: string): Promise<boolean> {
    await this.ensureLoaded();
    const entry = this.entries[validKey(key)];
    if (!entry) return false;
    if (!this.encryptionAvailable) return true;
    try {
      this.opts.safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
      return true;
    } catch {
      return false;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureLoaded();
    this.refuseOverDamaged();
    const k = validKey(key);
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH)
      throw new CredentialStoreError('INVALID_VALUE', `credential value must be 1–${MAX_CREDENTIAL_LENGTH} characters`);
    if (!this.encryptionAvailable) {
      this.logger.warn('refusing to store credential: OS encryption unavailable', { key: k });
      throw new CredentialStoreError('ENCRYPTION_UNAVAILABLE', ENCRYPTION_UNAVAILABLE_MESSAGE);
    }
    const cipher = this.opts.safeStorage.encryptString(value).toString('base64');
    this.entries[k] = { cipher, updatedAt: new Date(this.now()).toISOString() };
    await this.persist();
    this.logger.info('credential stored', { key: k });
  }

  /** Main-process only. Never route the result to the renderer. */
  async get(key: string): Promise<string | undefined> {
    await this.ensureLoaded();
    const entry = this.entries[validKey(key)];
    if (!entry) return undefined;
    if (!this.encryptionAvailable) {
      this.logger.warn('cannot decrypt credential: OS encryption unavailable', { key });
      return undefined;
    }
    try {
      return this.opts.safeStorage.decryptString(Buffer.from(entry.cipher, 'base64'));
    } catch (err) {
      this.logger.error('credential decrypt failed (different user/machine?)', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureLoaded();
    this.refuseOverDamaged();
    const k = validKey(key);
    if (!(k in this.entries)) return;
    delete this.entries[k];
    await this.persist();
    this.logger.info('credential deleted', { key: k });
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** A damaged file that was not set aside is not written over: no change is made. */
  private refuseOverDamaged(): void {
    if (this.notSetAside)
      throw new CredentialStoreError(
        'CORRUPT',
        `the damaged key file could not be set aside (${this.notSetAside}); no key is stored until it can be. Restart OP-CB to try again`,
      );
  }

  private persist(): Promise<void> {
    const doc: CredentialFile = { version: 1, entries: { ...this.entries } };
    const run = async () => {
      // Owner-only on POSIX: the entries are ciphertext, but who holds which keys is nobody
      // else's business either (0600; Windows ignores the mode and the profile ACL applies).
      try {
        await writeFileAtomic(this.opts.file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
      } catch (err) {
        // The change is held here and written with the next that succeeds; said as that, not as
        // an internal error.
        const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
        this.logger.error('credential file write failed', { code });
        throw new CredentialStoreError(
          'WRITE_FAILED',
          `the key file could not be saved (${code}): the change is in use, and is saved with the next one that saves`,
        );
      }
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }
}

function validKey(key: string): string {
  if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key))
    throw new CredentialStoreError('INVALID_KEY', 'credential key must be 1–128 characters of [a-z0-9._-]');
  return key;
}
