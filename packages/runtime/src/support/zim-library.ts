import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ZimArchive, ZimError, fileZimSource, htmlToText, type ZimEntry } from '@worldview/offline';
import type { Logger } from '@worldview/core';
import type { LibraryBook, LibraryFindAnswer, LibraryFindHit, LibraryFindRequest } from '@worldview/ipc-contract';

/**
 * The operator's ZIM files, read by WorldView itself (2026-10-30): every `.zim` in the library
 * folder (inside WorldView's data folder, so on the SSD when the data is), opened lazily and
 * kept open. Title search across them, articles for the reader window, and plain article text
 * for answers grounded in the library.
 */

export const LIBRARY_DIR_NAME = 'library';
const MAX_BOOKS = 500;
const META_KEYS = ['Title', 'Description', 'Language', 'Date', 'Creator', 'Publisher', 'Name', 'Flavour'] as const;

interface Open {
  file: string;
  size: number;
  mtimeMs: number;
  handle?: FileHandle;
  archive?: ZimArchive;
  book: LibraryBook;
}

export interface ZimItem {
  mimeType: string;
  data: Uint8Array;
}

export type ZimLookup = { kind: 'item'; item: ZimItem } | { kind: 'redirect'; key: string } | { kind: 'missing' };

export class ZimLibrary {
  private readonly open = new Map<string, Open>();
  private scanning: Promise<LibraryBook[]> | undefined;

  constructor(
    readonly dir: string,
    private readonly log: Logger,
  ) {}

  /** Every ZIM file in the folder, read again when files come or go. */
  async books(): Promise<LibraryBook[]> {
    this.scanning ??= this.scan().finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  private async scan(): Promise<LibraryBook[]> {
    await fs.mkdir(this.dir, { recursive: true });
    const names = (await fs.readdir(this.dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && /\.zim$/i.test(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
      .slice(0, MAX_BOOKS);
    const seen = new Set<string>();
    const out: LibraryBook[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      seen.add(file);
      try {
        out.push((await this.load(file)).book);
      } catch (err) {
        this.log.warn('library: a file could not be read', { file: name, error: errText(err) });
      }
    }
    for (const [file, o] of this.open)
      if (!seen.has(file)) {
        await o.handle?.close().catch(() => undefined);
        this.open.delete(file);
      }
    // The same file twice (copied under another name): keep the first.
    const ids = new Set<string>();
    return out.filter((b) => (ids.has(b.id) ? false : (ids.add(b.id), true)));
  }

  private async load(file: string): Promise<Open> {
    const st = await fs.stat(file);
    const known = this.open.get(file);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return known;
    await known?.handle?.close().catch(() => undefined);
    const name = path.basename(file);
    const base: LibraryBook = {
      id: '',
      file: name,
      title: name.replace(/\.zim$/i, ''),
      sizeBytes: st.size,
      entryCount: 0,
      readable: false,
      titleSearch: false,
    };
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(file, 'r');
      const archive = await ZimArchive.open(fileZimSource(handle, st.size));
      const meta = await archive.metadata(META_KEYS);
      const book: LibraryBook = {
        ...base,
        id: archive.header.uuid,
        entryCount: archive.header.entryCount,
        title: clip(meta['Title']) || base.title,
        ...opt('description', meta['Description'], 400),
        ...opt('language', meta['Language'], 32),
        ...opt('date', meta['Date'], 32),
        ...opt('creator', meta['Creator'], 200),
        ...opt('publisher', meta['Publisher'], 200),
        ...opt('name', meta['Name'], 200),
        ...opt('flavour', meta['Flavour'], 64),
        titleSearch: await archive.hasTitleList(),
        readable: true,
      };
      // Read the main page now: a file in the older xz format says so here, not on first click.
      try {
        const main = await archive.mainEntry();
        if (main) await archive.content(main, 8 * 1024 * 1024);
      } catch (err) {
        book.readable = false;
        book.problem = err instanceof ZimError ? err.message : errText(err);
      }
      const o: Open = { file, size: st.size, mtimeMs: st.mtimeMs, handle, archive, book };
      this.open.set(file, o);
      return o;
    } catch (err) {
      await handle?.close().catch(() => undefined);
      const o: Open = {
        file,
        size: st.size,
        mtimeMs: st.mtimeMs,
        book: { ...base, id: `file-${hashName(name)}`, problem: err instanceof ZimError ? err.message : errText(err) },
      };
      this.open.set(file, o);
      return o;
    }
  }

  private async byId(bookId: string): Promise<Open | undefined> {
    for (const o of this.open.values()) if (o.book.id === bookId && o.archive) return o;
    await this.books();
    for (const o of this.open.values()) if (o.book.id === bookId && o.archive) return o;
    return undefined;
  }

  /** The key the reader opens an entry by: its path in new files, `ns/path` in old ones. */
  static keyOf(archive: ZimArchive, e: ZimEntry): string {
    return archive.newNamespaces && e.namespace === 'C' ? e.path : `${e.namespace}/${e.path}`;
  }

  private static parseKey(archive: ZimArchive, key: string): [string, string] {
    if (archive.newNamespaces) return ['C', key];
    const m = /^([A-Za-z-])\/(.*)$/s.exec(key);
    return m ? [m[1]!, m[2]!] : ['A', key];
  }

  /** The main page's key, for opening a book at its start. */
  async mainKey(bookId: string): Promise<string | undefined> {
    const o = await this.byId(bookId);
    if (!o?.archive) return undefined;
    const main = await o.archive.mainEntry();
    return main ? ZimLibrary.keyOf(o.archive, main) : undefined;
  }

  /** One entry for the reader: its bytes, or where a redirect points. */
  async lookup(bookId: string, key: string): Promise<ZimLookup> {
    const o = await this.byId(bookId);
    if (!o?.archive || !o.book.readable) return { kind: 'missing' };
    const a = o.archive;
    const [ns, p] = ZimLibrary.parseKey(a, key);
    const e = await a.find(ns, p);
    if (!e) return { kind: 'missing' };
    if (e.redirectTo !== undefined) return { kind: 'redirect', key: ZimLibrary.keyOf(a, await a.resolve(e)) };
    const { mimeType, data } = await a.content(e);
    return { kind: 'item', item: { mimeType, data } };
  }

  /**
   * Titles starting with the query (and, for a question, with each longer word of it), across
   * the readable books or one. With `withText`, the start of each article as plain text.
   */
  async find(req: LibraryFindRequest): Promise<LibraryFindAnswer> {
    const books = (await this.books()).filter((b) => b.readable && (!req.bookId || b.id === req.bookId));
    const limit = Math.min(Math.max(req.limit ?? 20, 1), 50);
    const notes: string[] = [];
    const q = req.query.trim();
    const prefixes = [q];
    if (q.includes(' '))
      for (const w of q.split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase())))
        if (!prefixes.includes(w)) prefixes.push(w);
    const hits: LibraryFindHit[] = [];
    let searched = 0;
    for (const b of books) {
      if (!b.titleSearch) {
        notes.push(`${b.title} has no title list, so it was not searched`);
        continue;
      }
      const o = await this.byId(b.id);
      if (!o?.archive) continue;
      searched++;
      const seen = new Set<string>();
      for (const p of prefixes.slice(0, 6)) {
        for (const e of await o.archive.titlesStartingWith(p, limit)) {
          const target = await o.archive.resolve(e);
          const key = ZimLibrary.keyOf(o.archive, target);
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ bookId: b.id, bookTitle: b.title, key, title: e.title });
          if (hits.length >= limit * 2) break;
        }
      }
    }
    // Exact title first, then shorter titles (the general article before its sub-topics).
    const lq = q.toLowerCase();
    hits.sort(
      (a, b) =>
        Number(b.title.toLowerCase() === lq) - Number(a.title.toLowerCase() === lq) || a.title.length - b.title.length,
    );
    const out = hits.slice(0, limit);
    if (req.withText)
      for (const h of out.slice(0, 8)) {
        try {
          const r = await this.lookup(h.bookId, h.key);
          if (r.kind === 'item' && r.item.mimeType.startsWith('text/html'))
            h.text = htmlToText(Buffer.from(r.item.data).toString('utf8'), 1200);
        } catch {
          /* text left out */
        }
      }
    if (!books.length) notes.push('no readable ZIM files in the library folder yet');
    return { hits: out, searched, notes };
  }

  async close(): Promise<void> {
    for (const o of this.open.values()) await o.handle?.close().catch(() => undefined);
    this.open.clear();
  }
}

const STOP = new Set([
  'what',
  'when',
  'where',
  'which',
  'with',
  'from',
  'that',
  'this',
  'have',
  'does',
  'should',
  'would',
  'could',
  'there',
  'their',
  'about',
  'into',
  'your',
]);

function clip(s: string | undefined, n = 300): string {
  return (s ?? '').trim().slice(0, n);
}

function opt<K extends string>(k: K, v: string | undefined, n: number): Partial<Record<K, string>> {
  const t = clip(v, n);
  return t ? ({ [k]: t } as Record<K, string>) : {};
}

function hashName(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
