import { createHash, type Hash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Logger } from '@worldview/core';
import type {
  CatalogAnswer,
  CatalogEntry,
  CatalogRequest,
  LibraryDownloadRequest,
  LibraryDownloadStatus,
  ReferenceDoc,
} from '@worldview/ipc-contract';
import { REFERENCES } from './references.js';

/**
 * Downloads into the library (2026-10-30): books from the Kiwix catalogue and the public-domain
 * emergency references. One at a time, through the gated fetch (nothing in Offline mode).
 *
 * The catalogue's answer shape is libkiwix's own (test/library_server.cpp, test/library.cpp,
 * read 2026-10-30): an Atom feed of `<entry>` with `<id>urn:uuid:…</id>`, `<title>`,
 * `<summary>`, `<language>`, `<name>`, `<flavour>`, `<category>`, `<articleCount>`,
 * `<mediaCount>`, `<dc:issued>` and `<link rel="http://opds-spec.org/acquisition/open-access"
 * type="application/x-zim" href="…/x.zim.meta4" length="…"/>`. The `.meta4` is a Metalink 4
 * file (RFC 5854): `<file name><size><hash type="sha-256"><url priority>`. The live catalogue
 * was not reachable from where this was written; the first real download is the check.
 *
 * A book is checked three ways before it is put in the library: its size against the
 * catalogue, its SHA-256 against the Metalink file when that gives one, and the MD5 every ZIM
 * file ends with (computed while downloading, so no second pass). An unfinished download is
 * kept and continued — after a cancel, a failure or a restart.
 */

export const KIWIX_CATALOG = 'https://library.kiwix.org/catalog/v2/entries';
const KIWIX_DOWNLOAD_HOST = 'download.kiwix.org';
const ACQUISITION = 'http://opds-spec.org/acquisition/open-access';
const MAX_REFERENCE_BYTES = 150 * 1024 * 1024;
const PARTS_DIR = '.downloads';
export const REFERENCES_DIR = 'references';
const REFERENCES_FILE = 'references.json';
/** Kept free on the drive beyond the file itself. */
const SPACE_MARGIN_BYTES = 1024 ** 3;

export interface LibraryDownloadsDeps {
  fetchImpl: typeof fetch;
  /** The library folder (ZIM files go straight in). */
  dir: string;
  now: () => number;
  log: Logger;
  freeBytes?: (dir: string) => Promise<number | undefined>;
  /** Called when a book or reference has been put in the library. */
  onAdded?: () => void;
}

// ---- reading the catalogue and Metalink files -------------------------------------------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => ENT[e] ?? '')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .trim();
}
function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? xmlText(m[1]!) : undefined;
}
function attr(el: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(el);
  return m ? xmlText(m[1]!) : undefined;
}
function int(s: string | undefined): number | undefined {
  if (!s || !/^\d{1,16}$/.test(s.trim())) return undefined;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The download link a catalogue entry may carry: only on download.kiwix.org, made https. */
export function kiwixDownloadUrl(href: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.hostname !== KIWIX_DOWNLOAD_HOST) return undefined;
  if (!/^\/zim\/[A-Za-z0-9._/-]+\.zim(\.meta4)?$/.test(u.pathname) || u.pathname.includes('..')) return undefined;
  u.protocol = 'https:';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function readCatalog(text: string): { entries: CatalogEntry[]; total?: number } {
  if (!/<feed[\s>]/.test(text) || !text.includes('http://www.w3.org/2005/Atom'))
    throw new Error('not an OPDS catalogue');
  const entries: CatalogEntry[] = [];
  for (const m of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (entries.length >= 200) break;
    const block = m[1]!;
    const own = block.replace(/<author>[\s\S]*?<\/author>/g, '').replace(/<publisher>[\s\S]*?<\/publisher>/g, '');
    const id = tag(own, 'id')?.replace(/^urn:uuid:/, '');
    const title = tag(own, 'title');
    const name = tag(own, 'name');
    const link = [...own.matchAll(/<link\b[^>]*>/g)].map((x) => x[0]).find((l) => attr(l, 'rel') === ACQUISITION);
    const url = link ? kiwixDownloadUrl(attr(link, 'href') ?? '') : undefined;
    if (!id || !title || !name || !url || id.length > 100 || title.length > 300 || name.length > 200) continue;
    const e: CatalogEntry = { id, name, title, url };
    const put = <K extends keyof CatalogEntry>(k: K, v: CatalogEntry[K] | undefined) => {
      if (v !== undefined && v !== '') e[k] = v;
    };
    put('summary', tag(own, 'summary')?.slice(0, 600));
    put('language', tag(own, 'language')?.slice(0, 32));
    put('flavour', tag(own, 'flavour')?.slice(0, 64));
    put('category', tag(own, 'category')?.slice(0, 64));
    put('articleCount', int(tag(own, 'articleCount')));
    put('mediaCount', int(tag(own, 'mediaCount')));
    put('issued', tag(own, 'dc:issued')?.slice(0, 10));
    put('sizeBytes', int(link ? attr(link, 'length') : undefined));
    entries.push(e);
  }
  const total = int(tag(text.split('<entry>')[0]!, 'totalResults'));
  return { entries, ...(total !== undefined ? { total } : {}) };
}

export interface Metalink {
  name: string;
  size?: number;
  sha256?: string;
  /** https only, in priority order. */
  urls: string[];
}

/** A Metalink 4 file's first `<file>`; piece hashes are ignored. */
export function readMetalink(text: string): Metalink {
  if (!/<metalink[\s>]/.test(text)) throw new Error('not a Metalink file');
  const file = /<file\s[^>]*>([\s\S]*?)<\/file>/.exec(text);
  if (!file) throw new Error('the Metalink file names no file');
  const name = attr(file[0].slice(0, file[0].indexOf('>') + 1), 'name') ?? '';
  const body = file[1]!.replace(/<pieces[\s\S]*?<\/pieces>/g, '');
  let sha256: string | undefined;
  for (const h of body.matchAll(/<hash\s+type="([^"]+)"\s*>([^<]*)<\/hash>/g))
    if (h[1]!.toLowerCase() === 'sha-256' && /^[0-9a-f]{64}$/i.test(h[2]!.trim())) sha256 = h[2]!.trim().toLowerCase();
  const urls = [...body.matchAll(/<url\b([^>]*)>([^<]+)<\/url>/g)]
    .map((u) => ({ href: xmlText(u[2]!), priority: Number(attr(u[1]!, 'priority') ?? '999') || 999 }))
    .filter((u) => u.href.startsWith('https://'))
    .sort((a, b) => a.priority - b.priority)
    .map((u) => u.href)
    .slice(0, 8);
  const size = int(tag(body, 'size'));
  return { name, ...(size !== undefined ? { size } : {}), ...(sha256 ? { sha256 } : {}), urls };
}

/** A safe file name for a ZIM: the download's own name, nothing else. */
export function zimFileName(url: string): string | undefined {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').replace(/\.meta4$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.zim$/.test(base) ? base : undefined;
}

// ---- the downloads ----------------------------------------------------------------------------

interface PartInfo {
  url: string;
  size: number;
  sha256?: string;
}

async function statfsFree(dir: string): Promise<number | undefined> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

async function hashFile(file: string, upTo: number, hashes: Hash[], signal: AbortSignal): Promise<void> {
  if (upTo <= 0) return;
  for await (const chunk of createReadStream(file, { start: 0, end: upTo - 1, highWaterMark: 4 * 1024 * 1024 })) {
    signal.throwIfAborted();
    for (const h of hashes) h.update(chunk as Buffer);
  }
}

export class LibraryDownloads {
  private status: LibraryDownloadStatus = { phase: 'idle' };
  private abort: AbortController | undefined;

  constructor(private readonly deps: LibraryDownloadsDeps) {}

  get referencesDir(): string {
    return path.join(this.deps.dir, REFERENCES_DIR);
  }

  current(): LibraryDownloadStatus {
    return structuredClone(this.status);
  }

  private set(s: LibraryDownloadStatus): void {
    this.status = s;
  }

  private busy(): boolean {
    return this.status.phase === 'downloading' || this.status.phase === 'verifying';
  }

  cancel(): LibraryDownloadStatus {
    if (this.busy()) this.abort?.abort();
    else this.set({ phase: 'idle' });
    return this.current();
  }

  /** The references with what is on disk for each. */
  async references(): Promise<ReferenceDoc[]> {
    const installed = await this.readInstalled();
    const out: ReferenceDoc[] = [];
    for (const r of REFERENCES) {
      const i = installed[r.id];
      let ok = false;
      if (i)
        try {
          ok = (await fs.stat(path.join(this.referencesDir, `${r.id}.pdf`))).size === i.sizeBytes;
        } catch {
          ok = false;
        }
      out.push({ ...r, urls: [...r.urls], ...(i && ok ? { installed: i } : {}) });
    }
    return out;
  }

  referenceFile(id: string): string | undefined {
    return REFERENCES.some((r) => r.id === id) ? path.join(this.referencesDir, `${id}.pdf`) : undefined;
  }

  private async readInstalled(): Promise<Record<string, NonNullable<ReferenceDoc['installed']>>> {
    try {
      const v = JSON.parse(await fs.readFile(path.join(this.referencesDir, REFERENCES_FILE), 'utf8')) as unknown;
      if (!v || typeof v !== 'object') return {};
      const out: Record<string, NonNullable<ReferenceDoc['installed']>> = {};
      for (const [k, x] of Object.entries(v as Record<string, Record<string, unknown>>))
        if (
          typeof x?.['sizeBytes'] === 'number' &&
          typeof x['sha256'] === 'string' &&
          typeof x['downloadedAt'] === 'string' &&
          typeof x['from'] === 'string'
        )
          out[k] = { sizeBytes: x['sizeBytes'], sha256: x['sha256'], downloadedAt: x['downloadedAt'], from: x['from'] };
      return out;
    } catch {
      return {};
    }
  }

  /** Search the Kiwix catalogue (online). */
  async catalog(req: CatalogRequest, signal?: AbortSignal): Promise<CatalogAnswer> {
    const u = new URL(KIWIX_CATALOG);
    u.searchParams.set('count', String(Math.min(Math.max(req.count ?? 40, 1), 100)));
    if (req.language) u.searchParams.set('lang', req.language);
    if (req.query?.trim()) u.searchParams.set('q', req.query.trim());
    try {
      const res = await this.deps.fetchImpl(u.toString(), signal ? { signal } : {});
      if (!res.ok) return { ok: false, entries: [], message: `the Kiwix catalogue answered ${res.status}` };
      const read = readCatalog(await res.text());
      return { ok: true, ...read };
    } catch (err) {
      return { ok: false, entries: [], message: failureText(err) };
    }
  }

  start(req: LibraryDownloadRequest): LibraryDownloadStatus {
    if (this.busy()) return this.current();
    const ac = new AbortController();
    this.abort = ac;
    if (req.kind === 'zim') {
      const url = kiwixDownloadUrl(req.entry.url);
      const name = url ? zimFileName(url) : undefined;
      if (!url || !name) {
        this.set({ phase: 'failed', message: 'that catalogue entry has no download on download.kiwix.org' });
        return this.current();
      }
      this.set({ phase: 'downloading', item: req.entry.title, message: 'asking for the file' });
      void this.runZim(url, name, req.entry, ac.signal);
    } else {
      const ids = req.ids?.length ? req.ids : REFERENCES.map((r) => r.id);
      const unknown = ids.filter((id) => !REFERENCES.some((r) => r.id === id));
      if (unknown.length) {
        this.set({ phase: 'failed', message: `not a reference OP-CB knows: ${unknown.join(', ')}` });
        return this.current();
      }
      this.set({ phase: 'downloading', item: 'emergency references', step: { done: 0, total: ids.length } });
      void this.runReferences(ids, ac.signal);
    }
    return this.current();
  }

  // ---- one book --------------------------------------------------------------------------------

  private async runZim(url: string, name: string, entry: CatalogEntry, signal: AbortSignal): Promise<void> {
    const item = entry.title;
    const finalFile = path.join(this.deps.dir, name);
    const partsDir = path.join(this.deps.dir, PARTS_DIR);
    const part = path.join(partsDir, `${name}.part`);
    const partInfo = `${part}.json`;
    try {
      await fs.mkdir(partsDir, { recursive: true });
      if (await exists(finalFile)) {
        this.set({ phase: 'done', item, message: `${name} is already in the library` });
        return;
      }
      // What to fetch: the Metalink file when the catalogue points at one.
      let meta: Metalink = { name, urls: [] };
      const direct = url.replace(/\.meta4$/, '');
      if (url.endsWith('.meta4')) {
        try {
          const res = await this.deps.fetchImpl(url, { signal });
          if (res.ok) meta = readMetalink(await res.text());
          else this.deps.log.warn('library: the Metalink file was not available', { status: res.status });
        } catch (err) {
          if (signal.aborted) throw err;
          this.deps.log.warn('library: the Metalink file could not be read', { error: failureText(err) });
        }
      }
      if (meta.name && meta.name !== name) throw new Error(`the Metalink file is for ${meta.name}, not ${name}`);
      const size = meta.size ?? entry.sizeBytes;
      if (!size) throw new Error('the catalogue does not say how big the file is');
      if (entry.sizeBytes && meta.size && entry.sizeBytes !== meta.size)
        throw new Error('the catalogue and the Metalink file disagree on the size');
      const free = await (this.deps.freeBytes ?? statfsFree)(this.deps.dir);
      // An earlier, unfinished download of the same file is continued.
      let at = 0;
      const prev = await readPart(partInfo);
      if (prev && prev.size === size && prev.sha256 === meta.sha256 && (await exists(part)))
        at = Math.min((await fs.stat(part)).size, size);
      else await fs.rm(part, { force: true });
      if (free !== undefined && free < size - at + SPACE_MARGIN_BYTES)
        throw new Error(
          `not enough space: ${gb(size - at)} more needed and ${gb(SPACE_MARGIN_BYTES)} to spare, ${gb(free)} free`,
        );
      await fs.writeFile(partInfo, JSON.stringify({ url, size, ...(meta.sha256 ? { sha256: meta.sha256 } : {}) }));
      const sha = createHash('sha256');
      const md5 = createHash('md5');
      const md5Upto = size - 16;
      if (at > 0) {
        this.set({ phase: 'verifying', item, resumedFrom: at, message: `checking the ${gb(at)} already downloaded` });
        await hashFile(part, at, [sha], signal);
        await hashFile(part, Math.min(at, md5Upto), [md5], signal);
      }
      const tail: Buffer[] = [];
      const sources = [...meta.urls, direct];
      const handle = await fs.open(part, at > 0 ? 'r+' : 'w');
      const started = this.deps.now();
      const startAt = at;
      let lastReport = 0;
      try {
        let failures = 0;
        let source = 0;
        while (at < size) {
          signal.throwIfAborted();
          const from = sources[source % sources.length]!;
          try {
            const res = await this.deps.fetchImpl(from, { headers: at ? { Range: `bytes=${at}-` } : {}, signal });
            if (at ? res.status !== 206 : res.status !== 200) throw new Error(`the server answered ${res.status}`);
            const reader = res.body?.getReader();
            if (!reader) throw new Error('no body');
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (at + value.length > size) throw new Error('the server sent more than the file holds');
              await handle.write(value, 0, value.length, at);
              sha.update(value);
              const md5Part = Math.max(0, Math.min(value.length, md5Upto - at));
              if (md5Part > 0) md5.update(value.subarray(0, md5Part));
              if (md5Part < value.length) tail.push(Buffer.from(value.subarray(md5Part)));
              at += value.length;
              failures = 0;
              const now = this.deps.now();
              if (now - lastReport >= 500 || at === size) {
                lastReport = now;
                const secs = Math.max(1, (now - started) / 1000);
                this.set({
                  phase: 'downloading',
                  item,
                  ...(startAt ? { resumedFrom: startAt } : {}),
                  progress: { bytesDone: at, bytesTotal: size, bytesPerSecond: Math.round((at - startAt) / secs) },
                });
              }
            }
          } catch (err) {
            if (signal.aborted) throw err;
            failures++;
            source++;
            if (failures > 12) throw new Error(`the download kept breaking off (${failureText(err)})`);
            this.deps.log.warn('library download interrupted; continuing', { at, error: failureText(err) });
            await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal);
          }
        }
      } finally {
        await handle.close();
      }
      this.set({ phase: 'verifying', item, message: 'checking the file' });
      if ((await fs.stat(part)).size !== size) throw new Error('the file is not the size the catalogue gives');
      const digest = sha.digest('hex');
      if (meta.sha256 && digest !== meta.sha256) {
        await fs.rm(part, { force: true });
        throw new Error('the file does not match its SHA-256 from download.kiwix.org; it was removed');
      }
      // The ZIM file's own MD5: over every byte before the last 16, which hold it.
      const last16 = Buffer.concat(tail).subarray(-16);
      const fh = await fs.open(part, 'r');
      let fileTail: Buffer;
      try {
        fileTail = Buffer.alloc(16);
        await fh.read(fileTail, 0, 16, size - 16);
      } finally {
        await fh.close();
      }
      if (last16.length === 16 && !last16.equals(fileTail)) throw new Error('the file changed while it was written');
      if (md5.digest('hex') !== fileTail.toString('hex')) {
        await fs.rm(part, { force: true });
        throw new Error('the file does not match the checksum it ends with; it was removed');
      }
      await fs.rename(part, finalFile);
      await fs.rm(partInfo, { force: true });
      this.deps.log.info('library: book downloaded', { name, bytes: size, sha256: digest });
      this.deps.onAdded?.();
      this.set({ phase: 'done', item, message: `${entry.title} is in the library` });
    } catch (err) {
      this.set(
        signal.aborted
          ? { phase: 'cancelled', item, message: 'stopped; what was downloaded is kept and continues next time' }
          : { phase: 'failed', item, message: failureText(err) },
      );
    }
  }

  // ---- the references ---------------------------------------------------------------------------

  private async runReferences(ids: string[], signal: AbortSignal): Promise<void> {
    const problems: string[] = [];
    const installed = await this.readInstalled();
    await fs.mkdir(this.referencesDir, { recursive: true });
    let done = 0;
    try {
      for (const id of ids) {
        signal.throwIfAborted();
        const ref = REFERENCES.find((r) => r.id === id)!;
        this.set({ phase: 'downloading', item: ref.title, step: { done, total: ids.length } });
        const file = path.join(this.referencesDir, `${id}.pdf`);
        let got = false;
        const why: string[] = [];
        for (const url of ref.urls) {
          try {
            const res = await this.deps.fetchImpl(url, { signal });
            if (!res.ok) throw new Error(`answered ${res.status}`);
            const type = res.headers.get('content-type') ?? '';
            if (/text\/html/i.test(type)) throw new Error('answered with a web page, not the document');
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length > MAX_REFERENCE_BYTES) throw new Error('larger than expected');
            if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
            await fs.writeFile(`${file}.part`, bytes);
            await fs.rename(`${file}.part`, file);
            installed[id] = {
              sizeBytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              downloadedAt: new Date(this.deps.now()).toISOString(),
              from: url,
            };
            await fs.writeFile(
              path.join(this.referencesDir, REFERENCES_FILE),
              `${JSON.stringify(installed, null, 2)}\n`,
            );
            this.deps.log.info('library: reference downloaded', {
              id,
              from: new URL(url).hostname,
              bytes: bytes.length,
            });
            got = true;
            break;
          } catch (err) {
            if (signal.aborted) throw err;
            why.push(`${new URL(url).hostname}: ${failureText(err)}`);
          }
        }
        if (!got) problems.push(`${ref.title} — ${why.join('; ')}`);
        done++;
      }
      this.deps.onAdded?.();
      this.set({
        phase: problems.length === ids.length ? 'failed' : 'done',
        item: 'emergency references',
        step: { done, total: ids.length },
        message:
          problems.length === 0
            ? `${ids.length} references are in the library`
            : `${ids.length - problems.length} of ${ids.length} references are in the library`,
        ...(problems.length ? { problems } : {}),
      });
    } catch (err) {
      this.set(
        signal.aborted
          ? { phase: 'cancelled', item: 'emergency references', step: { done, total: ids.length }, message: 'stopped' }
          : { phase: 'failed', item: 'emergency references', message: failureText(err) },
      );
    }
  }
}

async function readPart(file: string): Promise<PartInfo | undefined> {
  try {
    const v = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof v['url'] !== 'string' || typeof v['size'] !== 'number') return undefined;
    return { url: v['url'], size: v['size'], ...(typeof v['sha256'] === 'string' ? { sha256: v['sha256'] } : {}) };
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

function gb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

function failureText(err: unknown): string {
  if ((err as { name?: string })?.name === 'WorkingOfflineError')
    return 'OP-CB is in Offline mode: switch to Online to download';
  return err instanceof Error ? err.message : String(err);
}
