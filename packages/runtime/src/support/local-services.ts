import {
  DEFAULT_SERVICE_PORTS,
  LOCAL_SERVICE_IDS,
  type AiTestAnswer,
  type AiTestRequest,
  type AppSettings,
  type LocalServiceId,
  type LocalServiceStatus,
  type LibraryHit,
  type LibrarySearchAnswer,
} from '@worldview/ipc-contract';

/**
 * The operator's local services (the Command Center, 2026-10-30): a local AI runner (Ollama),
 * an offline library (kiwix-serve) and a learning platform (Kolibri), each the operator's own
 * install. WorldView asks each over loopback only — `http://127.0.0.1:<port>` — when the shell
 * asks, never installs, starts or stops one, and never searches the network for them.
 *
 * The answer shapes come from each project's own documentation and tests, read 2026-10-30, not
 * from a running copy (none could be run where this was written):
 *  - Ollama `docs/api.md`: `GET /api/version` → `{ version }`; `GET /api/tags` → `{ models: [{
 *    name, size, details: { family, parameter_size } }] }`; `POST /api/generate` with
 *    `stream: false` → `{ response, done, eval_count, eval_duration (ns) }`.
 *  - kiwix-serve (`kiwix-tools/docs/kiwix-serve.rst`, libkiwix `test/library_server.cpp`):
 *    `GET /catalog/v2/entries?count=-1` → an OPDS (Atom) feed of `<entry>` with `<id>urn:uuid:…`,
 *    `<title>`, `<language>` and `<name>` (the book's name, before its `<author><name>`).
 *  - Kolibri (`kolibri/core/device/utils.py` `get_device_info`, routed at `/api/public/info/`):
 *    `{ application: "kolibri", kolibri_version, device_name, … }`.
 * Each reader takes only those fields and calls anything else "not this service".
 */

const NAMES: Record<LocalServiceId, string> = {
  ollama: 'Ollama (local AI models)',
  kiwix: 'Kiwix library server',
  kolibri: 'Kolibri learning platform',
};

const PROBE_TIMEOUT_MS = 2_500;
/** A small model on a laptop CPU can take minutes for its first answer (the model loads first). */
const AI_TIMEOUT_MS = 180_000;
const MAX_PROMPT = 2_000;
const MAX_ANSWER = 4_000;
const MAX_BODY = 4 * 1024 * 1024;

export interface LocalServicesDeps {
  fetchImpl: typeof fetch;
  settings: () => AppSettings;
  now: () => number;
}

export function servicePort(settings: AppSettings, id: LocalServiceId): number {
  return settings.services?.ports?.[id] ?? DEFAULT_SERVICE_PORTS[id];
}

export function serviceOrigin(settings: AppSettings, id: LocalServiceId): string {
  return `http://127.0.0.1:${servicePort(settings, id)}`;
}

class NotThisService extends Error {}

/** What a probe adds to the status when the service answered as itself. */
type Found = Omit<LocalServiceStatus, 'id' | 'name' | 'endpoint' | 'checkedAt'>;

export class LocalServices {
  constructor(private readonly deps: LocalServicesDeps) {}

  /** Every known service, asked now, side by side. */
  async statusAll(signal?: AbortSignal): Promise<LocalServiceStatus[]> {
    return Promise.all(LOCAL_SERVICE_IDS.map((id) => this.status(id, signal)));
  }

  async status(id: LocalServiceId, signal?: AbortSignal): Promise<LocalServiceStatus> {
    const endpoint = serviceOrigin(this.deps.settings(), id);
    const base = { id, name: NAMES[id], endpoint, checkedAt: new Date(this.deps.now()).toISOString() };
    try {
      switch (id) {
        case 'ollama':
          return { ...base, ...(await this.ollama(endpoint, signal)) };
        case 'kiwix':
          return { ...base, ...(await this.kiwix(endpoint, signal)) };
        case 'kolibri':
          return { ...base, ...(await this.kolibri(endpoint, signal)) };
      }
    } catch (err) {
      if (err instanceof NotThisService)
        return { ...base, state: 'other', detail: `something else answers on this port: ${err.message}` };
      if (err instanceof HttpStatusError) return { ...base, state: 'error', detail: `answered ${err.status}` };
      return { ...base, state: 'not-found', detail: 'nothing answered on this port' };
    }
  }

  private async ollama(origin: string, signal?: AbortSignal): Promise<Found> {
    const version = readOllamaVersion(await this.getJson(`${origin}/api/version`, signal));
    const models = readOllamaModels(await this.getJson(`${origin}/api/tags`, signal));
    return {
      state: 'running',
      version,
      models,
      detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'} installed` : 'no models yet',
    };
  }

  private async kiwix(origin: string, signal?: AbortSignal): Promise<Found> {
    const text = await this.getText(`${origin}/catalog/v2/entries?count=-1`, signal);
    const books = readKiwixCatalog(text);
    return {
      state: 'running',
      books,
      detail: books.length ? `${books.length} book${books.length === 1 ? '' : 's'} in the library` : 'empty library',
    };
  }

  private async kolibri(origin: string, signal?: AbortSignal): Promise<Found> {
    const info = readKolibriInfo(await this.getJson(`${origin}/api/public/info/`, signal));
    return { state: 'running', version: info.version, ...(info.device ? { detail: `device ${info.device}` } : {}) };
  }

  /**
   * A full-text search of one book in the operator's kiwix-serve (`/search?…&format=xml`).
   * The hits' links are paths on that server, opened in the browser through `services.open`.
   */
  async librarySearch(book: string, pattern: string, signal?: AbortSignal): Promise<LibrarySearchAnswer> {
    const origin = serviceOrigin(this.deps.settings(), 'kiwix');
    const q = new URLSearchParams({
      pattern: pattern.slice(0, 200),
      'books.name': book,
      format: 'xml',
      pageLength: '20',
    });
    try {
      const text = await this.getText(`${origin}/search?${q.toString()}`, signal);
      return { ok: true, book, pattern, hits: readKiwixSearch(text) };
    } catch (err) {
      const message =
        err instanceof HttpStatusError
          ? `the library answered ${err.status} (is "${book}" one of its books?)`
          : err instanceof NotThisService
            ? `the answer was not a library search: ${err.message}`
            : 'the library server did not answer on its port';
      return { ok: false, book, pattern, hits: [], message };
    }
  }

  /**
   * The offline inference test: one prompt, one installed model, `stream: false`. Nothing of
   * WorldView's data goes in; the answer is labelled the model's own (`grounded: false`).
   */
  async aiTest(request: AiTestRequest, signal?: AbortSignal): Promise<AiTestAnswer> {
    const started = this.deps.now();
    const at = () => new Date(this.deps.now()).toISOString();
    const base = { model: request.model, grounded: false as const };
    const prompt = request.prompt.slice(0, MAX_PROMPT);
    const origin = serviceOrigin(this.deps.settings(), 'ollama');
    try {
      const body = await this.postJson(
        `${origin}/api/generate`,
        { model: request.model, prompt, stream: false },
        AI_TIMEOUT_MS,
        signal,
      );
      const answer = readOllamaGenerate(body);
      return {
        ...base,
        ok: true,
        text: answer.text.slice(0, MAX_ANSWER),
        elapsedMs: this.deps.now() - started,
        ...(answer.tokensPerSecond !== undefined ? { tokensPerSecond: answer.tokensPerSecond } : {}),
        at: at(),
      };
    } catch (err) {
      const message =
        err instanceof HttpStatusError
          ? err.status === 404
            ? `Ollama has no model called ${request.model}`
            : `Ollama answered ${err.status}`
          : err instanceof NotThisService
            ? `the answer was not Ollama's: ${err.message}`
            : (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError'
              ? 'no answer in time (a first answer can take minutes while the model loads)'
              : 'Ollama did not answer on its port';
      return { ...base, ok: false, message, elapsedMs: this.deps.now() - started, at: at() };
    }
  }

  private async request(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await this.deps.fetchImpl(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    if (!res.ok) throw new HttpStatusError(res.status);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new NotThisService('the answer is too large');
    return text;
  }

  private getText(url: string, signal?: AbortSignal): Promise<string> {
    return this.request(url, { method: 'GET' }, PROBE_TIMEOUT_MS, signal);
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    return parseJson(await this.getText(url, signal));
  }

  private async postJson(url: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return parseJson(
      await this.request(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs,
        signal,
      ),
    );
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new NotThisService('not JSON');
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function readOllamaVersion(body: unknown): string {
  const v = obj(body)?.['version'];
  if (typeof v !== 'string' || !v || v.length > 64) throw new NotThisService('no version');
  return v;
}

export function readOllamaModels(body: unknown): NonNullable<LocalServiceStatus['models']> {
  const list = obj(body)?.['models'];
  if (!Array.isArray(list)) throw new NotThisService('no model list');
  const out: NonNullable<LocalServiceStatus['models']> = [];
  for (const m of list.slice(0, 200)) {
    const r = obj(m);
    const name = r?.['name'];
    if (typeof name !== 'string' || !name || name.length > 200) continue;
    const details = obj(r?.['details']);
    const size = r?.['size'];
    const parameterSize = details?.['parameter_size'];
    const family = details?.['family'];
    out.push({
      name,
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { sizeBytes: size } : {}),
      ...(typeof parameterSize === 'string' && parameterSize.length <= 32 ? { parameterSize } : {}),
      ...(typeof family === 'string' && family.length <= 64 ? { family } : {}),
    });
  }
  return out;
}

export function readOllamaGenerate(body: unknown): { text: string; tokensPerSecond?: number } {
  const r = obj(body);
  const text = r?.['response'];
  if (typeof text !== 'string') throw new NotThisService('no response text');
  const count = r?.['eval_count'];
  const ns = r?.['eval_duration'];
  const tokensPerSecond =
    typeof count === 'number' && typeof ns === 'number' && ns > 0 && count >= 0
      ? Math.round((count / (ns / 1e9)) * 10) / 10
      : undefined;
  return { text, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(amp|lt|gt|quot|apos);/g, (_m, e: string) => XML_ENTITIES[e] ?? '')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .trim();
}
function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? xmlText(m[1]!) : undefined;
}

/** kiwix-serve's OPDS catalogue: each `<entry>`'s id, title, book name and language. */
export function readKiwixCatalog(text: string): NonNullable<LocalServiceStatus['books']> {
  if (!/<feed[\s>]/.test(text) || !text.includes('http://www.w3.org/2005/Atom'))
    throw new NotThisService('not an OPDS catalogue');
  const out: NonNullable<LocalServiceStatus['books']> = [];
  for (const m of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    if (out.length >= 500) break;
    const block = m[1]!;
    const id = tag(block, 'id')?.replace(/^urn:uuid:/, '');
    const title = tag(block, 'title');
    if (!id || !title || id.length > 100 || title.length > 300) continue;
    // The book's own <name> comes before <author><name>: read only what precedes the author.
    const name = tag(block.split('<author>')[0]!, 'name');
    const language = tag(block, 'language');
    out.push({
      id,
      title,
      ...(name && name.length <= 200 ? { name } : {}),
      ...(language && language.length <= 32 ? { language } : {}),
    });
  }
  return out;
}

export function readKolibriInfo(body: unknown): { version: string; device?: string } {
  const r = obj(body);
  if (r?.['application'] !== 'kolibri') throw new NotThisService('not Kolibri');
  const version = r['kolibri_version'];
  if (typeof version !== 'string' || version.length > 64) throw new NotThisService('no version');
  const device = r['device_name'];
  return { version, ...(typeof device === 'string' && device.length <= 100 ? { device } : {}) };
}

/**
 * kiwix-serve's search results as XML (libkiwix `test/server_search.cpp`): an RSS channel of
 * `<item>` with `<title>`, `<link>` (a path on the server), `<description>` (the snippet, with
 * `<b>` marks) and `<book><title>`. Only a link under `/content/` is kept.
 */
export function readKiwixSearch(text: string): LibraryHit[] {
  if (!/<rss[\s>]/.test(text)) throw new NotThisService('not search results');
  const out: LibraryHit[] = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    if (out.length >= 50) break;
    const block = m[1]!;
    const bookBlock = /<book>([\s\S]*?)<\/book>/.exec(block)?.[1];
    const own = block.replace(/<book>[\s\S]*?<\/book>/, '');
    const title = tag(own, 'title');
    const link = tag(own, 'link');
    if (!title || !link) continue;
    const path = libraryPath(link);
    if (!path) continue;
    const snippet = tag(own, 'description')?.replace(/<[^>]*>/g, '');
    const bookTitle = bookBlock ? tag(bookBlock, 'title') : undefined;
    out.push({
      title: title.slice(0, 300),
      path,
      ...(snippet ? { snippet: snippet.slice(0, 600) } : {}),
      ...(bookTitle ? { book: bookTitle.slice(0, 300) } : {}),
    });
  }
  return out;
}

/**
 * A path on the library server WorldView may open: `/content/…` only, after any root prefix
 * the server was started with, with no `..`, no scheme and no host. Undefined otherwise.
 */
export function libraryPath(link: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) return undefined;
  const at = link.indexOf('/content/');
  if (at < 0) return undefined;
  const path = link.slice(at);
  if (path.length > 1000 || /[\s\\]/.test(path)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return undefined;
  return path;
}
