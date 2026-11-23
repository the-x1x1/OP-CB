import http from 'node:http';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  LibraryBook,
  LibraryFindAnswer,
  LibraryShareStatus,
  ReferenceDoc,
  ReferenceSearchAnswer,
} from '@opcb/ipc-contract';

/**
 * Sharing the library with phones and tablets on the same network (2026-11-22), read-only,
 * for as long as the operator asks and no longer:
 *
 *  - Off until the operator presses Share, off again at the time chosen (at most 12 hours), at
 *    Stop, and when OP-CB closes. Nothing about it is saved: every start of OP-CB starts unshared.
 *  - Every address starts with a code made fresh at each Share (`/k7m2-p9qx-4hwn/`: 12
 *    characters from 31, about 59 bits). A device that asks with a wrong code 20 times is not
 *    answered again until the share ends. Wrong codes get the same plain 404 as a missing page.
 *  - Answers only devices on a private network (10/8, 172.16/12, 192.168/16, 100.64/10,
 *    169.254/16, fc00::/7, fe80::/10, loopback): a computer with a public address does not
 *    serve the internet.
 *  - Asked by this computer's own address and port only (`Host`), so a web page cannot point a
 *    name of its own at it (DNS rebinding).
 *  - GET and HEAD only; books' pages under the reader's Content-Security-Policy (no script, no
 *    frames, nothing from elsewhere), `Referrer-Policy: no-referrer` so a link out of a page
 *    does not carry the code, `no-store`. At most 16 answers at once.
 *  - What it serves: the shelf (titles), each book's pages, each downloaded reference's PDF,
 *    and a search of titles and of the references' pages. Nothing else of OP-CB's data.
 */

export const SHARE_MAX_MINUTES = 12 * 60;
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const MAX_BAD_CODES = 20;
const MAX_IN_FLIGHT = 16;
const MAX_PATH = 2000;

export const SHARE_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export type ShareLookup =
  | { kind: 'item'; item: { mimeType: string; data: Uint8Array } }
  | { kind: 'redirect'; key: string }
  | { kind: 'missing' };

export interface LibraryShareDeps {
  books(): Promise<LibraryBook[]>;
  lookup(bookId: string, key: string): Promise<ShareLookup>;
  mainKey(bookId: string): Promise<string | undefined>;
  references(): Promise<ReferenceDoc[]>;
  referenceFile(id: string): string | undefined;
  findTitles(query: string): Promise<LibraryFindAnswer>;
  searchReferences(query: string): Promise<ReferenceSearchAnswer>;
  now(): number;
  log: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  /** For tests: the addresses to listen on and show. */
  listenHost?: string;
  addresses?: () => string[];
}

/** A fresh share code, `xxxx-xxxx-xxxx`. */
export function newShareCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) s += '-';
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return s;
}

/** Whether a peer address is on a private network (or this computer). */
export function isPrivatePeer(address: string | undefined): boolean {
  if (!address) return false;
  let a = address.toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    if ([p, q, Number(v4[3]), Number(v4[4])].some((x) => x > 255)) return false;
    return (
      p === 10 ||
      p === 127 ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 169 && q === 254) ||
      (p === 100 && q >= 64 && q <= 127)
    );
  }
  if (!a.includes(':')) return false;
  if (a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** This computer's addresses on private networks, IPv4 first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list ?? []) {
      if (n.internal) continue;
      if (n.family === 'IPv4' && isPrivatePeer(n.address) && !n.address.startsWith('169.254.')) out.push(n.address);
    }
  return out.slice(0, 8);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:46rem;padding:1rem;color:#1d1c1a;background:#faf8f3}
h1{font-size:1.3rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:1.4rem 0 .4rem}a{color:#7a5a00}
li{margin:.3rem 0}.m{color:#5f5a50;font-size:.9rem}form{display:flex;gap:.5rem}input{flex:1;font:inherit;padding:.4rem}
button{font:inherit;padding:.4rem .8rem}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

const sizeText = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${Math.round(n / 1e6)} MB`
      : `${Math.max(1, Math.round(n / 1e3))} kB`;

export class LibraryShare {
  private server: http.Server | undefined;
  private code = '';
  private until = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private port = 0;
  private bad = new Map<string, number>();
  private inFlight = 0;
  private served = 0;

  constructor(private readonly deps: LibraryShareDeps) {}

  status(): LibraryShareStatus {
    this.expireIfDue();
    if (!this.server) return { sharing: false };
    const addrs = (this.deps.addresses ?? lanAddresses)();
    return {
      sharing: true,
      urls: addrs.map((a) => `http://${a.includes(':') ? `[${a}]` : a}:${this.port}/${this.code}/`),
      code: this.code,
      port: this.port,
      until: new Date(this.until).toISOString(),
      served: this.served,
    };
  }

  /** The timer ends the share; this is a second check, for a timer held back by a sleeping computer. */
  private expireIfDue(): void {
    const now = this.deps.now();
    // A clock put back before the start says nothing about time passed: the timer decides.
    if (this.server && now >= this.startedAt && now >= this.until) void this.stop();
  }

  /** Shares for `minutes` (1–720); a share already running gets a new code and end time. */
  async start(minutes: number): Promise<LibraryShareStatus> {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SHARE_MAX_MINUTES)
      throw new RangeError(`minutes must be 1 to ${SHARE_MAX_MINUTES}`);
    await this.stop();
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    server.maxHeadersCount = 50;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: this.deps.listenHost ?? '0.0.0.0', port: 0 }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.server = server;
    this.code = newShareCode();
    this.bad.clear();
    this.served = 0;
    this.startedAt = this.deps.now();
    this.until = this.startedAt + minutes * 60_000;
    this.timer = setTimeout(() => void this.stop(), minutes * 60_000);
    this.timer.unref?.();
    this.deps.log.info('library share: started', { port: this.port, minutes });
    return this.status();
  }

  async stop(): Promise<LibraryShareStatus> {
    const s = this.server;
    this.server = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.code = '';
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
      this.deps.log.info('library share: stopped', { served: this.served });
    }
    return { sharing: false };
  }

  private send(
    res: http.ServerResponse,
    status: number,
    type: string,
    body: string | Uint8Array,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Security-Policy': SHARE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      ...extra,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }

  private notFound(res: http.ServerResponse): void {
    this.send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p>Not found.</p>'));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peer = req.socket.remoteAddress;
    if (!this.server || !isPrivatePeer(peer)) {
      req.socket.destroy();
      return;
    }
    this.expireIfDue();
    if (!this.server) {
      req.socket.destroy();
      return;
    }
    // Asked by one of this computer's own addresses, never by a name (a web page that points a
    // name of its own at this computer gets nothing: DNS rebinding).
    if (!this.hostAllowed(req.headers.host)) {
      this.send(res, 421, 'text/plain; charset=utf-8', 'Use the address OP-CB shows.');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.send(res, 405, 'text/plain; charset=utf-8', 'Read only.', { Allow: 'GET, HEAD' });
      return;
    }
    const raw = req.url ?? '/';
    if (raw.length > MAX_PATH) {
      this.notFound(res);
      return;
    }
    const prefix = `/${this.code}/`;
    if ((this.bad.get(peer!) ?? 0) >= MAX_BAD_CODES) {
      req.socket.destroy();
      return;
    }
    if (!(raw === `/${this.code}` || raw.startsWith(prefix))) {
      this.bad.set(peer!, (this.bad.get(peer!) ?? 0) + 1);
      if (this.bad.get(peer!) === MAX_BAD_CODES)
        this.deps.log.warn('library share: a device gave a wrong code 20 times');
      this.notFound(res);
      return;
    }
    if (raw === `/${this.code}`) {
      this.send(res, 302, 'text/plain', '', { Location: prefix });
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.send(res, 503, 'text/plain; charset=utf-8', 'Busy: try again.', { 'Retry-After': '2' });
      return;
    }
    this.inFlight++;
    try {
      const u = new URL(raw.slice(prefix.length - 1), 'http://share.invalid');
      await this.route(u, prefix, res);
      this.served++;
    } catch (err) {
      if (!res.headersSent)
        this.send(res, 500, 'text/html; charset=utf-8', page('Could not read', '<p>OP-CB could not read that.</p>'));
      this.deps.log.warn('library share: an answer failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.inFlight--;
    }
  }

  private async route(u: URL, prefix: string, res: http.ServerResponse): Promise<void> {
    const p = u.pathname;
    if (p === '/') return this.index(prefix, res);
    if (p === '/find') return this.find(u.searchParams.get('q') ?? '', prefix, res);
    const ref = /^\/ref\/([a-z0-9-]{1,64})\.pdf$/.exec(p);
    if (ref) return this.reference(ref[1]!, res);
    const book = /^\/book\/([0-9a-f]{32})(?:\/(.*))?$/.exec(p);
    if (book) {
      let key: string;
      try {
        key = decodeURIComponent(book[2] ?? '');
      } catch {
        return this.notFound(res);
      }
      if (key.includes('\0')) return this.notFound(res);
      return this.bookEntry(book[1]!, key, prefix, res);
    }
    this.notFound(res);
  }

  private hostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    const allowed = new Set([
      '127.0.0.1',
      'localhost',
      '[::1]',
      ...(this.deps.addresses ?? lanAddresses)().map((a) => (a.includes(':') ? `[${a}]` : a)),
    ]);
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:]+):(\d+)$/.exec(host);
    return !!m && Number(m[2]) === this.port && allowed.has(m[1]!.toLowerCase());
  }

  /** "Shared from OP-CB for another 27 minutes." (minutes, as a phone's clock may differ). */
  leftText(): string {
    const left = Math.max(0, Math.ceil((this.until - this.deps.now()) / 60_000));
    if (left >= 120) return `Shared from OP-CB for about ${Math.round(left / 60)} more hours.`;
    return `Shared from OP-CB for another ${left} minute${left === 1 ? '' : 's'}.`;
  }

  private async index(prefix: string, res: http.ServerResponse): Promise<void> {
    const [books, refs] = await Promise.all([this.deps.books(), this.deps.references()]);
    const readable = books.filter((b) => b.readable);
    const got = refs.filter((r) => r.installed);
    const body = `<h1>OP-CB library</h1>
<form action="${prefix}find" method="get"><input name="q" type="search" placeholder="Search books and guides" aria-label="Search" maxlength="200"><button>Search</button></form>
<h2>Books</h2>${readable.length ? `<ul>${readable.map((b) => `<li><a href="${prefix}book/${b.id}/">${esc(b.title)}</a> <span class="m">${sizeText(b.sizeBytes)}</span></li>`).join('')}</ul>` : '<p class="m">No books yet.</p>'}
<h2>Emergency guides</h2>${got.length ? `<ul>${got.map((r) => `<li><a href="${prefix}ref/${r.id}.pdf">${esc(r.title)}</a> <span class="m">${esc(r.publisher)}</span></li>`).join('')}</ul>` : '<p class="m">None downloaded yet.</p>'}
<p class="m">${esc(this.leftText())} Read only.</p>`;
    this.send(res, 200, 'text/html; charset=utf-8', page('OP-CB library', body));
  }

  private async find(q: string, prefix: string, res: http.ServerResponse): Promise<void> {
    const query = q.trim().slice(0, 200);
    let body = `<p><a href="${prefix}">← Library</a></p><form action="${prefix}find" method="get"><input name="q" type="search" value="${esc(query)}" aria-label="Search" maxlength="200"><button>Search</button></form>`;
    if (query) {
      const [titles, pages] = await Promise.all([
        this.deps.findTitles(query).catch(() => undefined),
        this.deps.searchReferences(query).catch(() => undefined),
      ]);
      const hits = titles?.hits ?? [];
      body += `<h2>In the books</h2>${
        hits.length
          ? `<ul>${hits
              .slice(0, 50)
              .map(
                (h) =>
                  `<li><a href="${prefix}book/${h.bookId}/${h.key.split('/').map(encodeURIComponent).join('/')}">${esc(h.title)}</a> <span class="m">${esc(h.bookTitle)}</span></li>`,
              )
              .join('')}</ul>`
          : '<p class="m">No article titles match.</p>'
      }`;
      const ph = pages?.hits ?? [];
      body += `<h2>Inside the guides</h2>${ph.length ? `<ul>${ph.map((h) => `<li><a href="${prefix}ref/${h.id}.pdf#page=${h.page}">${esc(h.title)}</a> <span class="m">page ${h.page}</span><br><span class="m">${esc(h.snippet)}</span></li>`).join('')}</ul>` : '<p class="m">No page has every word.</p>'}`;
    }
    this.send(
      res,
      200,
      'text/html; charset=utf-8',
      page(query ? `${query} — OP-CB library` : 'Search — OP-CB library', body),
    );
  }

  private async reference(id: string, res: http.ServerResponse): Promise<void> {
    const refs = await this.deps.references();
    const r = refs.find((x) => x.id === id && x.installed);
    const file = r ? this.deps.referenceFile(id) : undefined;
    if (!file) return this.notFound(res);
    const data = await fs.readFile(file);
    this.send(res, 200, 'application/pdf', data, { 'Content-Disposition': `inline; filename="${id}.pdf"` });
  }

  private async bookEntry(bookId: string, key: string, prefix: string, res: http.ServerResponse): Promise<void> {
    const base = `${prefix}book/${bookId}/`;
    if (!key) {
      const main = await this.deps.mainKey(bookId);
      if (!main) return this.notFound(res);
      return this.send(res, 302, 'text/plain', '', {
        Location: base + main.split('/').map(encodeURIComponent).join('/'),
      });
    }
    const r = await this.deps.lookup(bookId, key);
    if (r.kind === 'missing') return this.notFound(res);
    if (r.kind === 'redirect')
      return this.send(res, 302, 'text/plain', '', {
        Location: base + r.key.split('/').map(encodeURIComponent).join('/'),
      });
    const type = /^[\w.+-]+\/[\w.+-]+/.exec(r.item.mimeType)?.[0].toLowerCase() ?? 'application/octet-stream';
    this.send(res, 200, type.startsWith('text/') ? `${type}; charset=utf-8` : type, r.item.data);
  }
}
