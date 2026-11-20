/**
 * Reading a few named elements out of an XML answer (an OPDS catalogue, a Metalink file,
 * kiwix-serve's search results) without building a tree.
 *
 * Every function here goes through the text once. They replace patterns such as
 * `/<entry>([\s\S]*?)<\/entry>/g`, which start again from every `<entry>` when the text has no
 * `</entry>` to find: 700 kB of start tags with no end tag took twelve seconds, a megabyte
 * half a minute, in the runtime process, on text another server sent. Here a missing end tag
 * is looked for once: after that nothing later can be closed either, and reading stops.
 */

/** Where `<name` begins a start tag at or after `from` (followed by `>`, `/` or white space), or -1. */
function startTagAt(text: string, name: string, from: number): number {
  const open = `<${name}`;
  for (let at = text.indexOf(open, from); at >= 0; at = text.indexOf(open, at + 1)) {
    const next = text[at + open.length];
    if (next === '>' || next === '/' || next === ' ' || next === '\t' || next === '\n' || next === '\r') return at;
  }
  return -1;
}

export interface XmlBlock {
  /** The start tag as written, `<name …>`. */
  startTag: string;
  /** What lies between the start tag and its end tag. */
  body: string;
  /** Where the block starts and where the text after it begins. */
  start: number;
  end: number;
}

/** The `<name>…</name>` blocks of `text`, in order, at most `max`. Blocks of one name are not nested in each other. */
export function xmlBlocks(text: string, name: string, max = Number.POSITIVE_INFINITY): XmlBlock[] {
  const close = `</${name}>`;
  const out: XmlBlock[] = [];
  let from = 0;
  while (out.length < max) {
    const start = startTagAt(text, name, from);
    if (start < 0) break;
    const tagEnd = text.indexOf('>', start);
    if (tagEnd < 0) break;
    // `<name/>` has no body and no end tag.
    if (text[tagEnd - 1] === '/') {
      out.push({ startTag: text.slice(start, tagEnd + 1), body: '', start, end: tagEnd + 1 });
      from = tagEnd + 1;
      continue;
    }
    const bodyEnd = text.indexOf(close, tagEnd + 1);
    if (bodyEnd < 0) break;
    out.push({
      startTag: text.slice(start, tagEnd + 1),
      body: text.slice(tagEnd + 1, bodyEnd),
      start,
      end: bodyEnd + close.length,
    });
    from = bodyEnd + close.length;
  }
  return out;
}

/** The first `<name>…</name>` block, or undefined. */
export function firstXmlBlock(text: string, name: string): XmlBlock | undefined {
  return xmlBlocks(text, name, 1)[0];
}

/** `text` with every `<name>…</name>` block taken out. */
export function withoutXmlBlocks(text: string, name: string): string {
  const blocks = xmlBlocks(text, name);
  if (blocks.length === 0) return text;
  let out = '';
  let from = 0;
  for (const b of blocks) {
    out += text.slice(from, b.start);
    from = b.end;
  }
  return out + text.slice(from);
}

/** The start tags `<name …>` in `text`, in order, at most `max` (for elements read by their attributes). */
export function xmlStartTags(text: string, name: string, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < max) {
    const start = startTagAt(text, name, from);
    if (start < 0) break;
    const tagEnd = text.indexOf('>', start);
    if (tagEnd < 0) break;
    out.push(text.slice(start, tagEnd + 1));
    from = tagEnd + 1;
  }
  return out;
}

const XML_ENTITY = /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * An element's text: CDATA sections unwrapped, the five named entities and numeric references
 * decoded, trimmed. Each reference is decoded once (`&amp;#38;` is the text `&#38;`), and one
 * that names no character (zero, half a surrogate pair, past U+10FFFF) is left out.
 */
export function xmlText(s: string): string {
  let text = s;
  if (text.includes('<![CDATA[')) {
    let out = '';
    let from = 0;
    for (;;) {
      const open = text.indexOf('<![CDATA[', from);
      const end = open < 0 ? -1 : text.indexOf(']]>', open + 9);
      if (end < 0) break;
      out += text.slice(from, open) + text.slice(open + 9, end);
      from = end + 3;
    }
    text = out + text.slice(from);
  }
  if (text.includes('&'))
    text = text.replace(XML_ENTITY, (_whole, ref: string) => {
      if (ref[0] !== '#') return NAMED[ref] ?? '';
      const n = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    });
  return text.trim();
}

/** The text of the first `<name>` element in `block`, or undefined when there is none. */
export function xmlTagText(block: string, name: string): string | undefined {
  const first = firstXmlBlock(block, name);
  return first ? xmlText(first.body) : undefined;
}

/** `text` with its tags removed (a snippet with `<b>` marks). A `<` with no `>` after it stays. */
export function stripXmlTags(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    const gt = lt < 0 ? -1 : text.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += text.slice(from, lt);
    from = gt + 1;
  }
  return out + text.slice(from);
}

export class BodyTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`the answer is larger than ${Math.round(maxBytes / 1024)} kB`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * A response's body as text, refused once it passes `maxBytes`: by its declared length before
 * anything is read, and while reading when the length was not declared or not true. A catalogue
 * or search answer is a few hundred kilobytes; nothing here needs a body it cannot bound.
 */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge(maxBytes);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    // A stand-in response with no stream: its text, held to the same limit.
    const text = await res.text();
    if (text.length > maxBytes) throw new BodyTooLarge(maxBytes);
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
