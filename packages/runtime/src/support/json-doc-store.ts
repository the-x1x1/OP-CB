import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@opcb/core/node';
import { silentLogger, type Logger } from '@opcb/core';

interface Envelope<T> {
  version: 1;
  items: T[];
}

/**
 * A small, atomic, validated list document — collections.json, watchzones.json,
 * lenses.json. Corrupt files are preserved next to the original and replaced with an
 * empty list (same contract the startup validator documents), never silently dropped.
 */
export class JsonDocStore<T extends { id: string }> {
  private items: T[] | undefined;
  private loading: Promise<T[]> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly validate: (value: unknown) => T | undefined,
    private readonly log: Logger = silentLogger,
  ) {}

  /**
   * The list, read from the file the first time it is wanted. Everyone who asks while that
   * first read is under way waits for the same read: each used to start its own, and each
   * read, as it finished, replaced the list the one before had already handed out and been
   * changed through — of forty saves made at once into a new store, one was kept.
   */
  async load(): Promise<T[]> {
    if (this.items) return this.items;
    this.loading ??= this.read().then((items) => {
      this.items = items;
      return items;
    });
    await this.loading;
    // Not the read's own result: a remove or replaceAll since then has put a new list in place.
    return this.items ?? [];
  }

  private async read(): Promise<T[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.preserveCorrupt('not valid JSON');
      return [];
    }
    const envelope = parsed as Partial<Envelope<unknown>>;
    const list = Array.isArray(envelope?.items) ? envelope.items : Array.isArray(parsed) ? parsed : undefined;
    if (!list) {
      await this.preserveCorrupt('not a { version, items } document');
      return [];
    }
    const valid: T[] = [];
    let dropped = 0;
    for (const entry of list) {
      const v = this.validate(entry);
      if (v) valid.push(v);
      else dropped++;
    }
    if (dropped)
      this.log.warn('user document: entries dropped as invalid', { file: path.basename(this.file), dropped });
    return valid;
  }

  async list(): Promise<T[]> {
    await this.load();
    return structuredClone(this.items ?? []);
  }

  async save(item: T): Promise<T[]> {
    // The list is taken after the wait and changed in the same turn. The value `load` gives
    // is the list as it was when `load` was called: several changes asked for together each
    // got the same one, and every removal but the last was undone by the change after it.
    await this.load();
    const items = (this.items ??= []);
    const index = items.findIndex((i) => i.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    await this.persist();
    return structuredClone(items);
  }

  async remove(id: string): Promise<T[]> {
    await this.load();
    const items = this.items ?? [];
    const next = items.filter((i) => i.id !== id);
    this.items = next;
    await this.persist();
    return structuredClone(next);
  }

  /**
   * Replace the whole list in one write. Used where the authoritative copy lives
   * elsewhere in memory (the camera gateways' registries) and this file is a mirror of
   * it, so a per-item save would leave removed entries behind.
   */
  async replaceAll(items: T[]): Promise<T[]> {
    await this.load();
    this.items = structuredClone(items);
    await this.persist();
    return structuredClone(this.items);
  }

  async get(id: string): Promise<T | undefined> {
    await this.load();
    return (this.items ?? []).find((i) => i.id === id);
  }

  /** Serialized writes: a save never races another save on the same file. */
  private async persist(): Promise<void> {
    const snapshot: Envelope<T> = { version: 1, items: this.items ?? [] };
    this.writing = this.writing
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`);
      })
      .catch((err: unknown) => {
        this.log.error('user document write failed', {
          file: path.basename(this.file),
          error: err instanceof Error ? err.message : String(err),
        });
      });
    await this.writing;
  }

  private async preserveCorrupt(reason: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preserved = `${this.file}.corrupt-${stamp}`;
    try {
      await fs.rename(this.file, preserved);
    } catch {
      /* best effort */
    }
    this.log.warn('user document unreadable; preserved and replaced with an empty list', {
      file: path.basename(this.file),
      reason,
      preserved: path.basename(preserved),
    });
  }
}
