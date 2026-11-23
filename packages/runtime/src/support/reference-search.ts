import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { searchPages, type ReferenceDoc, type ReferenceSearchAnswer } from '@opcb/ipc-contract';
import { extractPdfTextAsync } from '@opcb/offline';
import { writeFileAtomic } from '@opcb/core/node';

/**
 * Searching inside the downloaded emergency references (2026-11-22). Each PDF's text is read
 * once (packages/offline/src/pdf-text.ts) into `<id>.text.json` beside it, tied to the PDF's
 * SHA-256: a PDF downloaded again is read again. Searches read the kept text, never the PDF.
 */

interface TextFile {
  formatVersion: 1;
  sha256: string;
  /** The PDF as it was read: a file changed since (size or time) is read again. */
  stamp: string;
  pages: string[];
  note?: string;
}

const MAX_PAGES = 5000;

export class ReferenceSearch {
  private cache = new Map<string, { sha256: string; stamp: string; pages: string[]; note?: string }>();
  /** One reading per reference at a time. */
  private reading = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly log: {
      info(m: string, f?: Record<string, unknown>): void;
      warn(m: string, f?: Record<string, unknown>): void;
    },
  ) {}

  private textFile(id: string): string {
    return path.join(this.dir, `${id}.text.json`);
  }

  /** Reads a reference's text into its text file (after a download, or when it is stale). */
  async index(id: string, sha256: string, signal?: AbortSignal): Promise<void> {
    const running = this.reading.get(id);
    if (running) return running;
    const job = this.read(id, sha256, signal).finally(() => this.reading.delete(id));
    this.reading.set(id, job);
    return job;
  }

  /** Size and modification time of a reference's PDF, or undefined when it is not there. */
  private async stampOf(id: string): Promise<string | undefined> {
    try {
      const st = await fs.stat(path.join(this.dir, `${id}.pdf`));
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return undefined;
    }
  }

  private async read(id: string, sha256: string, signal?: AbortSignal): Promise<void> {
    const stamp = await this.stampOf(id);
    const bytes = await fs.readFile(path.join(this.dir, `${id}.pdf`));
    // The file on disk is the one recorded: a stale or replaced PDF is not read as another's text.
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error('the file is not the one downloaded');
    const started = Date.now();
    const r = await extractPdfTextAsync(bytes, signal);
    const pages = r.pages.slice(0, MAX_PAGES);
    const doc: TextFile = { formatVersion: 1, sha256, stamp: stamp ?? '', pages, ...(r.note ? { note: r.note } : {}) };
    await writeFileAtomic(this.textFile(id), JSON.stringify(doc));
    this.cache.set(id, { sha256, stamp: stamp ?? '', pages, ...(r.note ? { note: r.note } : {}) });
    this.log.info('library: reference text read', {
      id,
      pages: pages.length,
      chars: pages.reduce((n, p) => n + p.length, 0),
      ms: Date.now() - started,
      ...(r.note ? { note: r.note } : {}),
    });
  }

  private async load(id: string, sha256: string): Promise<{ pages: string[]; note?: string } | undefined> {
    const stamp = await this.stampOf(id);
    if (!stamp) return undefined;
    const c = this.cache.get(id);
    if (c?.sha256 === sha256 && c.stamp === stamp) return c;
    try {
      const v = JSON.parse(await fs.readFile(this.textFile(id), 'utf8')) as Partial<TextFile> | null;
      if (
        v?.formatVersion === 1 &&
        v.sha256 === sha256 &&
        v.stamp === stamp &&
        Array.isArray(v.pages) &&
        v.pages.length <= MAX_PAGES &&
        v.pages.every((p) => typeof p === 'string')
      ) {
        const entry = { sha256, stamp, pages: v.pages, ...(typeof v.note === 'string' ? { note: v.note } : {}) };
        this.cache.set(id, entry);
        return entry;
      }
    } catch {
      /* missing or damaged: read again */
    }
    return undefined;
  }

  /** Every downloaded reference searched; ones not yet read are read first. */
  async search(query: string, refs: readonly ReferenceDoc[], signal?: AbortSignal): Promise<ReferenceSearchAnswer> {
    const docs: { id: string; title: string; pages: string[] }[] = [];
    const unreadable: ReferenceSearchAnswer['unreadable'] = [];
    for (const ref of refs) {
      if (!ref.installed) continue;
      let t = await this.load(ref.id, ref.installed.sha256);
      if (!t) {
        try {
          await this.index(ref.id, ref.installed.sha256, signal);
          t = await this.load(ref.id, ref.installed.sha256);
        } catch (err) {
          if (signal?.aborted) throw err;
          unreadable.push({
            id: ref.id,
            title: ref.title,
            why: err instanceof Error ? err.message : 'could not be read',
          });
          continue;
        }
      }
      if (!t) continue;
      if (t.note === 'encrypted' || (!t.pages.some((p) => p.trim()) && t.pages.length > 0)) {
        unreadable.push({
          id: ref.id,
          title: ref.title,
          why: t.note === 'encrypted' ? 'the file is encrypted' : 'its pages are pictures, with no text to search',
        });
        continue;
      }
      docs.push({ id: ref.id, title: ref.title, pages: t.pages });
    }
    return { hits: searchPages(query, docs), searched: docs.length, unreadable };
  }

  /** A reference removed: its text goes too. */
  async forget(id: string): Promise<void> {
    this.cache.delete(id);
    await fs.rm(this.textFile(id), { force: true });
  }
}
