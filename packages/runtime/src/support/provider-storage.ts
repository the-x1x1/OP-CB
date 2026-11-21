import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { silentLogger, type Logger } from '@opcb/core';
import { readJsonFile, writeFileAtomic } from '@opcb/core/node';
import { ownEntry, type Clock, type JsonValue, elapsedMs } from '@opcb/world-model';
import type {
  ByteStreamEvents,
  ByteStreamHandle,
  LineStreamEvents,
  LineStreamHandle,
  ProviderCache,
  ProviderSettings,
  ProviderLocalAccess,
  Unsubscribe,
} from '@opcb/provider-sdk';
import { ProviderError } from '@opcb/provider-sdk';
import { UnavailableError } from '../validate.js';
import { createOgr2ogrAccess, readGrantedFile, statGrantedFile, type Ogr2ogrHostOptions } from './granted-folder.js';
import { openSerialStream, type SerialStreamOptions } from './serial-stream.js';

/**
 * Per-provider storage the ProviderHost injects: a small JSON cache, provider-scoped
 * settings and the granted-file / loopback-probe surface. All three fail closed:
 * a provider whose data policy forbids caching gets a no-op cache, a provider without
 * a granted directory cannot read files, and probes are limited to loopback hosts that
 * the manifest already allowlists.
 */

interface CacheEntry {
  value: JsonValue;
  storedAt: string;
  expiresAt?: number;
}
interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    'value' in e &&
    e['value'] !== undefined &&
    typeof e['storedAt'] === 'string' &&
    (e['expiresAt'] === undefined || typeof e['expiresAt'] === 'number')
  );
}

const MAX_CACHE_ENTRIES = 256;

/** File-backed JSON cache under `<dataDir>/cache/<providerId>.json`. */
export class FileProviderCache implements ProviderCache {
  private entries: Record<string, CacheEntry> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly clock: Clock,
    private readonly enabled: boolean,
    private readonly log: Logger = silentLogger,
  ) {}

  async get<T extends JsonValue>(key: string): Promise<{ value: T; storedAt: string } | undefined> {
    if (!this.enabled) return undefined;
    const entries = await this.read();
    const entry = entries[key];
    if (!entry) return undefined;
    // An entry with a life that was kept at a time the clock now reads as ahead would last
    // for as long as the clock had been fast on top of its own life; it counts as run out.
    const now = this.clock.now();
    if (entry.expiresAt !== undefined && (entry.expiresAt < now || Date.parse(entry.storedAt) > now)) {
      delete entries[key];
      void this.flush();
      return undefined;
    }
    return { value: entry.value as T, storedAt: entry.storedAt };
  }

  async set(key: string, value: JsonValue, ttlMs?: number): Promise<void> {
    if (!this.enabled) return; // dataPolicy.cacheAllowed === false
    const entries = await this.read();
    entries[key] = {
      value,
      storedAt: new Date(this.clock.now()).toISOString(),
      ...(ttlMs !== undefined ? { expiresAt: this.clock.now() + ttlMs } : {}),
    };
    const keys = Object.keys(entries);
    if (keys.length > MAX_CACHE_ENTRIES) {
      const sorted = keys.sort((a, b) => Date.parse(entries[a]!.storedAt) - Date.parse(entries[b]!.storedAt));
      for (const k of sorted.slice(0, keys.length - MAX_CACHE_ENTRIES)) delete entries[k];
    }
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    if (!this.enabled) return;
    const entries = await this.read();
    if (entries[key] === undefined) return;
    delete entries[key];
    await this.flush();
  }

  /**
   * The table, read from the file once. Callers that arrive while that read is under way wait
   * for the same one: each used to start its own, and a later read finishing replaced the
   * table an earlier caller had already written an entry into.
   */
  private read(): Promise<Record<string, CacheEntry>> {
    if (this.entries) return Promise.resolve(this.entries);
    this.reading ??= this.readFile();
    return this.reading;
  }

  private reading: Promise<Record<string, CacheEntry>> | undefined;

  private async readFile(): Promise<Record<string, CacheEntry>> {
    const doc = await readJsonFile<CacheFile>(this.file).catch(() => undefined);
    // A table with no inherited members, so a key is only ever an entry: on a plain object a
    // key of `constructor` read as a hit and one of `__proto__` was never stored. What the file
    // holds is kept only where it has the shape of an entry.
    const entries = Object.create(null) as Record<string, CacheEntry>;
    const stored: unknown = doc && typeof doc === 'object' ? doc.entries : undefined;
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      for (const [key, entry] of Object.entries(stored as Record<string, unknown>))
        if (isCacheEntry(entry)) entries[key] = entry;
    this.entries = entries;
    return this.entries;
  }

  private async flush(): Promise<void> {
    const snapshot: CacheFile = { version: 1, entries: this.entries ?? {} };
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(snapshot));
      })
      .catch((err: unknown) => {
        this.log.debug('provider cache write failed', {
          file: path.basename(this.file),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    await this.writing;
  }
}

/** No-op cache for providers whose data policy forbids caching. */
export const deniedProviderCache: ProviderCache = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

/**
 * Provider-scoped settings backed by an injected key-value document, so the desktop can
 * persist them and tests can hold them in memory. `onChange` fires when the runtime
 * writes new settings for this provider (`sources.settings.set`).
 */
export class ProviderSettingsView implements ProviderSettings {
  private readonly listeners = new Set<(settings: Record<string, JsonValue>) => void>();

  constructor(private readonly read: () => Record<string, JsonValue>) {}

  async get(): Promise<Record<string, JsonValue>> {
    return { ...this.read() };
  }

  onChange(listener: (settings: Record<string, JsonValue>) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called by the runtime after a settings write. */
  notify(settings: Record<string, JsonValue>): void {
    for (const l of [...this.listeners]) {
      try {
        l({ ...settings });
      } catch {
        /* a provider listener must not break the write */
      }
    }
  }
}

/** Persistent per-provider settings document: `<dataDir>/provider-settings.json`. */
export class ProviderSettingsStore {
  private data: Record<string, Record<string, JsonValue>> = {};
  private readonly views = new Map<string, ProviderSettingsView>();
  private writing: Promise<void> = Promise.resolve();
  /**
   * Why the file did not read at the last load, when it is there (held by another program, a
   * refused read, a folder in its place) or damaged and not set aside: every source's settings
   * read as none, and nothing is written over the file until it reads.
   */
  private unreadable: string | undefined;

  constructor(
    private readonly file: string,
    private readonly log: Logger = silentLogger,
  ) {}

  async load(): Promise<void> {
    this.unreadable = undefined;
    let doc: { version: 1; providers: Record<string, Record<string, JsonValue>> } | undefined;
    try {
      doc = await readJsonFile(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined) {
        this.unreadable = `could not be read (${code})`;
        this.log.warn('provider settings could not be read; nothing is written over them', { code });
      } else {
        // Not JSON: kept beside, as the other documents are, so the next write is not its end.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          await fs.rename(this.file, `${this.file}.corrupt-${stamp}`);
          this.log.warn('provider settings unreadable; preserved and started empty', {});
        } catch (e) {
          this.unreadable = `is damaged and could not be set aside (${(e as NodeJS.ErrnoException).code ?? 'unknown error'})`;
        }
      }
    }
    this.data =
      doc && typeof doc === 'object' && doc.providers && typeof doc.providers === 'object' ? { ...doc.providers } : {};
  }

  get(providerId: string): Record<string, JsonValue> {
    return { ...(ownEntry(this.data, providerId) ?? {}) };
  }

  view(providerId: string): ProviderSettingsView {
    let v = this.views.get(providerId);
    if (!v) {
      // Own entries: a source may be named `constructor`, and its settings are not Object's members.
      v = new ProviderSettingsView(() => ownEntry(this.data, providerId) ?? {});
      this.views.set(providerId, v);
    }
    return v;
  }

  async set(providerId: string, settings: Record<string, JsonValue>): Promise<void> {
    // A file that did not read is read again first (the hold may be over); still unread, the
    // change is refused rather than written over every other source's settings.
    if (this.unreadable) await this.load();
    if (this.unreadable)
      throw new UnavailableError(`${path.basename(this.file)} ${this.unreadable}; nothing was changed`);
    this.data[providerId] = { ...settings };
    await this.persist();
    this.views.get(providerId)?.notify(this.data[providerId]!);
  }

  private async persist(): Promise<void> {
    const snapshot = { version: 1 as const, providers: this.data };
    const write = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
    });
    this.writing = write.catch(() => undefined);
    try {
      await write;
    } catch (err) {
      this.log.error('provider settings write failed', { error: err instanceof Error ? err.message : String(err) });
      // Answered as saved, the setting was gone at the next start.
      throw new UnavailableError(
        `${path.basename(this.file)} could not be written (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`,
      );
    }
  }
}

export interface LocalAccessOptions {
  /**
   * Absolute directory this provider may read from, or a function answering the current one
   * (the folder the user named in the manifest's `grantedFolderSetting`, which can change
   * while the provider runs). Nothing → reads are refused.
   */
  grantDir?: string | (() => string | undefined);
  /**
   * Offer GDAL's ogr2ogr on the granted folder (ADR-003 amendment): only for a provider that
   * declares a `grantedFolderSetting`. `true` looks for it on PATH; an options object is for
   * tests (a stand-in program, a filtered environment). Absent → no `ogr2ogr` on the access.
   */
  ogr2ogr?: boolean | Omit<Ogr2ogrHostOptions, 'folder'>;
  /** Hosts from the provider manifest; only loopback entries are probeable. */
  allowedHosts: string[];
  /** The host the user named in the provider's `trustedHostSetting` (probeable too). */
  trustedHosts?: () => readonly string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /** Injectable for tests; defaults to `node:net`'s `createConnection`. */
  connect?: (opts: { host: string; port: number }) => net.Socket;
  /** Lines a stream may deliver per second; past it they are dropped (default 500). */
  maxLinesPerSecond?: number;
  /** Bytes a byte stream may deliver per second; past it they are dropped (default 256 KiB). */
  maxBytesPerSecond?: number;
  /** The largest single write to a byte stream (default 1,024 bytes). */
  maxWriteBytes?: number;
  /** Writes a byte stream may make per minute (default 60). */
  maxWritesPerMinute?: number;
  /** Tests: serial stream hooks (a pseudo-terminal as the device, no `stty`). */
  serial?: Partial<Pick<SerialStreamOptions, 'isAllowedPath' | 'isAllowedDevice' | 'configure' | 'platform'>>;
}

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

/**
 * Granted-folder reads and loopback probing. A path is checked by the SDK's rule, resolved
 * against the folder's real path and compared as real paths (granted-folder.ts), so `../`,
 * absolute paths and links out of the folder can never escape it.
 */
export function createLocalAccess(opts: LocalAccessOptions): ProviderLocalAccess {
  const currentGrant = (): string | undefined =>
    typeof opts.grantDir === 'function' ? opts.grantDir() : opts.grantDir;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
  // A stream goes to loopback in the manifest, or exactly the host the user named (ADR-003).
  const streamHostAllowed = (host: string): boolean => {
    const named = (opts.trustedHosts?.() ?? []).some((t) => t.toLowerCase() === host);
    return named || (isLoopbackHost(host) && allowed.has(host));
  };
  return {
    readGrantedFile: (file, readOpts) =>
      readGrantedFile(currentGrant(), file, Math.min(readOpts?.maxBytes ?? maxBytes, maxBytes)),
    statGrantedFile: (file) => statGrantedFile(currentGrant(), file),
    ...(opts.ogr2ogr
      ? {
          ogr2ogr: createOgr2ogrAccess({
            ...(typeof opts.ogr2ogr === 'object' ? opts.ogr2ogr : {}),
            folder: currentGrant,
          }),
        }
      : {}),
    openLineStream: (target, events, streamOpts) =>
      openLineStream(target, events, {
        allowed: streamHostAllowed,
        connect: opts.connect ?? ((o) => net.createConnection(o)),
        maxLineBytes: streamOpts?.maxLineBytes ?? 1024,
        connectTimeoutMs: streamOpts?.connectTimeoutMs ?? 5000,
        maxLinesPerSecond: opts.maxLinesPerSecond ?? 500,
      }),
    openByteStream: (target, events, streamOpts) =>
      openByteStream(target, events, {
        allowed: streamHostAllowed,
        connect: opts.connect ?? ((o) => net.createConnection(o)),
        connectTimeoutMs: streamOpts?.connectTimeoutMs ?? 5000,
        maxBytesPerSecond: opts.maxBytesPerSecond ?? 256 * 1024,
        maxWriteBytes: opts.maxWriteBytes ?? 1024,
        maxWritesPerMinute: opts.maxWritesPerMinute ?? 60,
      }),
    openSerialStream: (target, events) =>
      openSerialStream(target, events, {
        maxBytesPerSecond: opts.maxBytesPerSecond ?? 256 * 1024,
        maxWriteBytes: opts.maxWriteBytes ?? 1024,
        maxWritesPerMinute: opts.maxWritesPerMinute ?? 60,
        ...(opts.serial ?? {}),
      }),
    async probeLocal(url, probeOpts) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { reachable: false };
      }
      const host = parsed.hostname.toLowerCase();
      const named = (opts.trustedHosts?.() ?? []).some((t) => t.toLowerCase() === host);
      if (!named && (!isLoopbackHost(host) || !allowed.has(host))) return { reachable: false };
      const impl = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), probeOpts?.timeoutMs ?? 2000);
      try {
        const res = await impl(parsed.toString(), { method: 'GET', signal: controller.signal, redirect: 'manual' });
        return { reachable: res.status < 500, status: res.status };
      } catch {
        return { reachable: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * A TCP connection read as lines (ADR-003, `ProviderLocalAccess.openLineStream`): only to a host
 * `allowed` accepts, outbound only. Resolves once connected; rejects TIMEOUT, OFFLINE (refused:
 * nothing listening), DNS or NETWORK. Lines are split on LF with a trailing CR removed; one
 * longer than `maxLineBytes` is dropped up to its line end, and so is every line past
 * `maxLinesPerSecond` in a second — a receiver in a busy port must not flood the main process.
 */
function openLineStream(
  target: { host: string; port: number },
  events: LineStreamEvents,
  o: {
    allowed: (host: string) => boolean;
    connect: (opts: { host: string; port: number }) => net.Socket;
    maxLineBytes: number;
    connectTimeoutMs: number;
    maxLinesPerSecond: number;
  },
): Promise<LineStreamHandle> {
  const checked = streamTarget(target, o.allowed);
  if (checked instanceof ProviderError) return Promise.reject(checked);
  const { host, port } = checked;
  return new Promise((resolve, reject) => {
    const socket = o.connect({ host, port });
    let open = false;
    let closedByUs = false;
    let dropped = 0;
    let buffer = '';
    let overlong = false;
    let windowStart = Date.now();
    let inWindow = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProviderError('TIMEOUT', `no answer from ${host}:${port} within ${o.connectTimeoutMs} ms`));
    }, o.connectTimeoutMs);
    const handle: LineStreamHandle = {
      close: () => {
        closedByUs = true;
        socket.destroy();
      },
      get dropped() {
        return dropped;
      },
    };
    socket.setEncoding('latin1');
    socket.on('connect', () => {
      clearTimeout(timer);
      open = true;
      resolve(handle);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (overlong) overlong = false;
        else deliver(line);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > o.maxLineBytes) {
        buffer = '';
        overlong = true;
        dropped++;
      }
    });
    const deliver = (line: string) => {
      if (line.length > o.maxLineBytes) {
        dropped++;
        return;
      }
      const now = Date.now();
      if (elapsedMs(now, windowStart) >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > o.maxLinesPerSecond) {
        dropped++;
        return;
      }
      events.onLine(line);
    };
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const pe = socketFailure(err, host, port);
      if (!open) reject(pe);
      else events.onError?.(pe);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (open) events.onClose?.(closedByUs ? 'closed' : 'the device closed the connection');
    });
  });
}

/** A stream's target, normalised, or why it may not be dialled (HOST_NOT_ALLOWED). */
function streamTarget(
  target: { host: string; port: number },
  allowed: (host: string) => boolean,
): { host: string; port: number } | ProviderError {
  const host = String(target?.host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const port = Number(target?.port);
  if (!host || !allowed(host))
    return new ProviderError(
      'HOST_NOT_ALLOWED',
      `${host || '(no host)'} is not loopback or the host named for this source`,
      {
        retryable: false,
      },
    );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return new ProviderError('HOST_NOT_ALLOWED', `port ${String(target?.port)} is not a TCP port`, {
      retryable: false,
    });
  return { host, port };
}

/** A socket error as the provider is told it: refused is OFFLINE (nothing listening). */
function socketFailure(err: NodeJS.ErrnoException, host: string, port: number): ProviderError {
  const code = err.code ?? '';
  return code === 'ECONNREFUSED'
    ? new ProviderError('OFFLINE', `nothing is listening at ${host}:${port}`)
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      ? new ProviderError('DNS', `${host} does not resolve`)
      : code === 'ETIMEDOUT'
        ? new ProviderError('TIMEOUT', `${host}:${port} timed out`)
        : new ProviderError('NETWORK', `${host}:${port}: ${err.message}`);
}

/**
 * A TCP connection carrying bytes both ways (ADR-003 amendment 2026-10-05,
 * `ProviderLocalAccess.openByteStream`): the same hosts as a line stream, outbound only. What
 * the device sends is handed over as read, up to `maxBytesPerSecond` (the rest dropped and
 * counted — a device on a busy link must not flood the main process; a framed protocol finds
 * its next frame). What the provider sends is limited to `maxWriteBytes` a write and
 * `maxWritesPerMinute`: a request now and then (Meshtastic's "send me your node list", a
 * heartbeat), never a channel for anything bulkier.
 */
function openByteStream(
  target: { host: string; port: number },
  events: ByteStreamEvents,
  o: {
    allowed: (host: string) => boolean;
    connect: (opts: { host: string; port: number }) => net.Socket;
    connectTimeoutMs: number;
    maxBytesPerSecond: number;
    maxWriteBytes: number;
    maxWritesPerMinute: number;
  },
): Promise<ByteStreamHandle> {
  const checked = streamTarget(target, o.allowed);
  if (checked instanceof ProviderError) return Promise.reject(checked);
  const { host, port } = checked;
  return new Promise((resolve, reject) => {
    const socket = o.connect({ host, port });
    let open = false;
    let closed = false;
    let closedByUs = false;
    let dropped = 0;
    let readWindowStart = Date.now();
    let readInWindow = 0;
    const writes: number[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProviderError('TIMEOUT', `no answer from ${host}:${port} within ${o.connectTimeoutMs} ms`));
    }, o.connectTimeoutMs);
    const handle: ByteStreamHandle = {
      write: (bytes) => {
        if (!open || closed || !(bytes instanceof Uint8Array) || bytes.length === 0) return false;
        if (bytes.length > o.maxWriteBytes) return false;
        const now = Date.now();
        while (writes.length && now - writes[0]! >= 60_000) writes.shift();
        if (writes.length >= o.maxWritesPerMinute) return false;
        writes.push(now);
        socket.write(Buffer.from(bytes));
        return true;
      },
      close: () => {
        closedByUs = true;
        closed = true;
        socket.destroy();
      },
      get dropped() {
        return dropped;
      },
    };
    socket.on('connect', () => {
      clearTimeout(timer);
      open = true;
      resolve(handle);
    });
    socket.on('data', (chunk: Buffer) => {
      const now = Date.now();
      if (elapsedMs(now, readWindowStart) >= 1000) {
        readWindowStart = now;
        readInWindow = 0;
      }
      const room = Math.max(0, o.maxBytesPerSecond - readInWindow);
      const take = Math.min(room, chunk.length);
      readInWindow += take;
      dropped += chunk.length - take;
      if (take > 0) events.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, take).slice());
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const pe = socketFailure(err, host, port);
      if (!open) reject(pe);
      else events.onError?.(pe);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      closed = true;
      if (open) events.onClose?.(closedByUs ? 'closed' : 'the device closed the connection');
    });
  });
}
