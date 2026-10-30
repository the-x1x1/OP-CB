/**
 * The library reader's addresses and answers (library-reader.ts has the window and session).
 * Kept free of Electron so it can be tested on its own.
 */

export const READER_SCHEME = 'wvzim';
/** No `persist:` prefix: nothing the reader does is written to disk. */
export const READER_PARTITION = 'wv-library-reader';

export const READER_CSP = [
  "default-src 'none'",
  `img-src ${READER_SCHEME}: data:`,
  `media-src ${READER_SCHEME}:`,
  `style-src ${READER_SCHEME}: 'unsafe-inline'`,
  `font-src ${READER_SCHEME}: data:`,
  "script-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The address of an entry: `wvzim://<book id>/<key>`, each path segment percent-encoded. */
export function readerUrl(bookId: string, key: string): string {
  return `${READER_SCHEME}://${bookId}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Book id and key from a reader address, or undefined for anything else. */
export function parseReaderUrl(raw: string): { bookId: string; key: string } | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== `${READER_SCHEME}:` || !/^[0-9a-f]{32}$/.test(u.hostname)) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(u.pathname.slice(1));
  } catch {
    return undefined;
  }
  if (key.length > 2000 || key.includes('\0')) return undefined;
  return { bookId: u.hostname, key };
}

export function isReaderUrl(raw: string): boolean {
  return parseReaderUrl(raw) !== undefined;
}

export type ReaderLookup =
  | { kind: 'item'; item: { mimeType: string; data: Uint8Array } }
  | { kind: 'redirect'; key: string }
  | { kind: 'missing' };

export interface ReaderSource {
  lookup(bookId: string, key: string): Promise<ReaderLookup>;
  mainKey(bookId: string): Promise<string | undefined>;
}

const baseHeaders = {
  'Content-Security-Policy': READER_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

/** The answer for one reader request (exported for tests). */
export async function readerResponse(deps: ReaderSource, rawUrl: string): Promise<Response> {
  const at = parseReaderUrl(rawUrl);
  const notFound = (why: string) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>Not in this book</title><p>${why}</p>`, {
      status: 404,
      headers: { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  if (!at) return notFound('That is not a page of a book in the library.');
  try {
    if (!at.key) {
      const main = await deps.mainKey(at.bookId);
      return main
        ? new Response(null, { status: 302, headers: { ...baseHeaders, Location: readerUrl(at.bookId, main) } })
        : notFound('This book names no start page.');
    }
    const r = await deps.lookup(at.bookId, at.key);
    if (r.kind === 'redirect')
      return new Response(null, { status: 302, headers: { ...baseHeaders, Location: readerUrl(at.bookId, r.key) } });
    if (r.kind === 'missing') return notFound('That page is not in this book.');
    // Only the type itself from the file: its parameters are not passed on.
    const type = /^[\w.+-]+\/[\w.+-]+/.exec(r.item.mimeType)?.[0].toLowerCase() ?? 'application/octet-stream';
    return new Response(r.item.data as unknown as BodyInit, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type },
    });
  } catch (err) {
    return notFound(
      `OP-CB could not read this page: ${(err instanceof Error ? err.message : String(err)).replace(/[<>&]/g, ' ')}`,
    );
  }
}
