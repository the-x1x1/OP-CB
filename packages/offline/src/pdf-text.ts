import { inflateSync } from 'node:zlib';

/**
 * The text of a PDF, page by page, for searching the emergency references offline
 * (2026-11-22). Written here rather than taken from a package, as the ZIM and PMTiles readers
 * are: it reads what the U.S. federal manuals use — classic and cross-reference-stream files,
 * object streams, Flate/ASCIIHex/ASCII85 streams, simple fonts (WinAnsi, MacRoman, Standard,
 * `/Differences`) and composite fonts through their `/ToUnicode` maps, text inside form
 * XObjects — and gives up cleanly on anything else (encrypted files, LZW, images of text).
 *
 * It finds objects by scanning for `n g obj`, not by trusting the cross-reference table, so a
 * file with a damaged table still reads. Every size is bounded: a stream decompresses to at most
 * 64 MiB, the text of a file to at most 32 MiB, a form nests at most 4 deep. It never throws on a
 * damaged file: it returns what it could read, with a note.
 */

export interface PdfText {
  /** One string per page, in page order; words separated by spaces, lines by `\n`. */
  pages: string[];
  /** Why the text is missing or partial, when it is. */
  note?: 'encrypted' | 'no-pages' | 'truncated' | 'damaged';
}

const MAX_STREAM = 64 * 1024 * 1024;
const MAX_TEXT = 32 * 1024 * 1024;
const MAX_FORM_DEPTH = 4;
const MAX_OPS_PER_PAGE = 2_000_000;

// ---- objects --------------------------------------------------------------------------------

type PdfValue =
  | null
  | boolean
  | number
  | string // a name, without its slash, is { name }
  | PdfName
  | PdfString
  | PdfRef
  | PdfValue[]
  | PdfDict;
interface PdfName {
  kind: 'name';
  name: string;
}
interface PdfString {
  kind: 'str';
  bytes: Uint8Array;
}
interface PdfRef {
  kind: 'ref';
  num: number;
}
interface PdfDict {
  kind: 'dict';
  map: Map<string, PdfValue>;
  /** For a stream: the raw bytes between `stream` and `endstream`. */
  stream?: Uint8Array;
}

const isName = (v: unknown, n?: string): v is PdfName =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  (v as PdfName).kind === 'name' &&
  (n === undefined || (v as PdfName).name === n);
const isDict = (v: unknown): v is PdfDict =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (v as PdfDict).kind === 'dict';
const isRef = (v: unknown): v is PdfRef =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (v as PdfRef).kind === 'ref';
const isStr = (v: unknown): v is PdfString =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (v as PdfString).kind === 'str';

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

/** A tokenizer over bytes: PDF objects for files and dictionaries, operators for content. */
class Lexer {
  pos = 0;
  constructor(
    readonly b: Uint8Array,
    start = 0,
    readonly end = b.length,
  ) {
    this.pos = start;
  }

  skipSpace(): void {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos]!;
      if (WS[c]) this.pos++;
      else if (c === 37 /* % */) {
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next value, or an operator as `{ op }`, or undefined at the end. */
  next(depth = 0): PdfValue | { op: string } | undefined {
    this.skipSpace();
    if (this.pos >= this.end) return undefined;
    const b = this.b;
    const c = b[this.pos]!;
    if (c === 40 /* ( */) return this.literal();
    if (c === 60 /* < */) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return this.dict(depth);
      }
      return this.hex();
    }
    if (c === 91 /* [ */) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= this.end) return arr;
        if (b[this.pos] === 93) {
          this.pos++;
          return arr;
        }
        const v = depth < 64 ? this.next(depth + 1) : undefined;
        if (v === undefined) return arr;
        if (typeof v === 'object' && v !== null && 'op' in v) {
          if (v.op === 'R' && arr.length >= 2 && typeof arr[arr.length - 2] === 'number') {
            arr.length -= 1;
            arr[arr.length - 1] = { kind: 'ref', num: arr[arr.length - 1] as number };
          }
          continue;
        }
        arr.push(v);
      }
    }
    if (c === 47 /* / */) {
      this.pos++;
      const s = this.pos;
      while (this.pos < this.end && !WS[b[this.pos]!] && !DELIM[b[this.pos]!]) this.pos++;
      return { kind: 'name', name: decodeName(b, s, this.pos) };
    }
    if (c === 41 || c === 62 || c === 93 || c === 125 || c === 123) {
      this.pos++;
      return { op: String.fromCharCode(c) };
    }
    const s = this.pos;
    while (this.pos < this.end && !WS[b[this.pos]!] && !DELIM[b[this.pos]!]) this.pos++;
    const word = latin1(b, s, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { op: word };
  }

  private literal(): PdfString {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = b[this.pos++]!;
      if (c === 92 /* \ */) {
        const d = b[this.pos++];
        if (d === undefined) break;
        if (d === 110) out.push(10);
        else if (d === 114) out.push(13);
        else if (d === 116) out.push(9);
        else if (d === 98) out.push(8);
        else if (d === 102) out.push(12);
        else if (d >= 48 && d <= 55) {
          let n = d - 48;
          for (let i = 0; i < 2 && b[this.pos]! >= 48 && b[this.pos]! <= 55; i++) n = n * 8 + (b[this.pos++]! - 48);
          out.push(n & 255);
        } else if (d === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (d !== 10) out.push(d);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { kind: 'str', bytes: Uint8Array.from(out) };
  }

  private hex(): PdfString {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < this.end) {
      const c = b[this.pos++]!;
      if (c === 62) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return { kind: 'str', bytes: Uint8Array.from(out) };
  }

  private dict(depth: number): PdfDict {
    const map = new Map<string, PdfValue>();
    const b = this.b;
    let key: string | undefined;
    const pending: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.end) break;
      if (b[this.pos] === 62 && b[this.pos + 1] === 62) {
        this.pos += 2;
        break;
      }
      const v = depth < 64 ? this.next(depth + 1) : undefined;
      if (v === undefined) break;
      if (typeof v === 'object' && v !== null && 'op' in v) {
        if (v.op === 'R' && pending.length === 2 && typeof pending[0] === 'number') {
          pending.length = 0;
          if (key !== undefined) map.set(key, { kind: 'ref', num: (pending[0] as number) ?? 0 });
        }
        continue;
      }
      if (key === undefined) {
        if (isName(v)) key = v.name;
        continue;
      }
      // A value; numbers may be the start of `n g R`.
      if (typeof v === 'number') {
        const save = this.pos;
        const g = this.next(depth + 1);
        const r = typeof g === 'number' ? this.next(depth + 1) : undefined;
        if (typeof g === 'number' && typeof r === 'object' && r !== null && 'op' in r && r.op === 'R') {
          map.set(key, { kind: 'ref', num: v });
        } else {
          this.pos = save;
          map.set(key, v);
        }
      } else map.set(key, v);
      key = undefined;
    }
    return { kind: 'dict', map };
  }
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e && i - s < 4096; i++) out += String.fromCharCode(b[i]!);
  return out;
}

function decodeName(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e && i - s < 256; i++) {
    if (b[i] === 35 && i + 2 < e && hexVal(b[i + 1]!) >= 0 && hexVal(b[i + 2]!) >= 0) {
      out += String.fromCharCode(hexVal(b[i + 1]!) * 16 + hexVal(b[i + 2]!));
      i += 2;
    } else out += String.fromCharCode(b[i]!);
  }
  return out;
}

function indexOf(b: Uint8Array, needle: string, from: number, to = b.length): number {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  outer: for (let i = from; i <= to - n; i++) {
    if (b[i] !== first) continue;
    for (let k = 1; k < n; k++) if (b[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

// ---- the file ---------------------------------------------------------------------------------

class PdfFile {
  readonly objects = new Map<number, PdfValue>();
  trailer: PdfDict | undefined;
  truncated = false;

  constructor(readonly b: Uint8Array) {
    this.scan();
  }

  /** Every `n g obj` in the file; a later definition of a number wins (incremental updates). */
  private scan(): void {
    const b = this.b;
    let i = 0;
    const objStreams: PdfDict[] = [];
    while (i < b.length) {
      const at = indexOf(b, 'obj', i);
      if (at < 0) break;
      i = at + 3;
      // `obj` as a word, preceded by "<num> <gen> ".
      if (at + 3 < b.length && !WS[b[at + 3]!] && !DELIM[b[at + 3]!]) continue;
      let p = at - 1;
      while (p >= 0 && WS[b[p]!]) p--;
      let g = p;
      while (g >= 0 && b[g]! >= 48 && b[g]! <= 57) g--;
      if (g === p) continue;
      let q = g;
      while (q >= 0 && WS[b[q]!]) q--;
      if (q === g) continue;
      let n = q;
      while (n >= 0 && b[n]! >= 48 && b[n]! <= 57) n--;
      if (n === q || (n >= 0 && !WS[b[n]!] && !DELIM[b[n]!])) continue;
      const num = Number(latin1(b, n + 1, q + 1));
      if (!Number.isSafeInteger(num)) continue;
      const lx = new Lexer(b, at + 3);
      const v = lx.next();
      if (v === undefined || (typeof v === 'object' && v !== null && 'op' in v)) continue;
      if (isDict(v)) {
        lx.skipSpace();
        if (indexOf(b, 'stream', lx.pos, lx.pos + 6) === lx.pos) {
          let s = lx.pos + 6;
          if (b[s] === 13) s++;
          if (b[s] === 10) s++;
          const len = v.map.get('Length');
          let e = -1;
          if (typeof len === 'number' && len >= 0 && s + len <= b.length) {
            const after = indexOf(b, 'endstream', s + len, Math.min(b.length, s + len + 64));
            if (after >= 0) e = s + len;
          }
          if (e < 0) {
            const es = indexOf(b, 'endstream', s);
            e = es < 0 ? b.length : es;
            while (e > s && (b[e - 1] === 10 || b[e - 1] === 13)) e--;
          }
          v.stream = b.subarray(s, e);
          i = e;
          if (isName(v.map.get('Type'), 'ObjStm')) objStreams.push(v);
          if (isName(v.map.get('Type'), 'XRef')) this.trailer = v;
        }
      }
      this.objects.set(num, v);
    }
    // A classic trailer: the last one in the file.
    const t = this.lastIndexOf('trailer');
    if (t >= 0) {
      const v = new Lexer(b, t + 7).next();
      if (isDict(v)) this.trailer = this.trailer && this.trailer.map.has('Root') ? this.trailer : v;
    }
    for (const os of objStreams) this.readObjStm(os);
  }

  private lastIndexOf(word: string): number {
    const b = this.b;
    for (let i = b.length - word.length; i >= 0; i--) {
      if (b[i] !== word.charCodeAt(0)) continue;
      let ok = true;
      for (let k = 1; k < word.length; k++) if (b[i + k] !== word.charCodeAt(k)) ok = false;
      if (ok) return i;
    }
    return -1;
  }

  private readObjStm(os: PdfDict): void {
    const data = this.decode(os);
    const n = os.map.get('N');
    const first = os.map.get('First');
    if (!data || typeof n !== 'number' || typeof first !== 'number' || n < 0 || n > 1_000_000) return;
    const head = new Lexer(data, 0, Math.min(first, data.length));
    const pairs: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const num = head.next();
      const off = head.next();
      if (typeof num !== 'number' || typeof off !== 'number') break;
      pairs.push([num, off]);
    }
    for (const [num, off] of pairs) {
      // An object defined at top level wins over one in a stream only if it came later; the
      // simple rule here: a stream object never replaces a top-level one already read.
      if (this.objects.has(num)) continue;
      const v = new Lexer(data, first + off).next();
      if (v !== undefined && !(typeof v === 'object' && v !== null && 'op' in v)) this.objects.set(num, v);
    }
  }

  get(v: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (isRef(v) && depth < 16) return this.get(this.objects.get(v.num), depth + 1);
    return v;
  }

  dict(v: PdfValue | undefined): PdfDict | undefined {
    const d = this.get(v);
    return isDict(d) ? d : undefined;
  }

  /** A stream's bytes through its filters, or undefined when a filter is not one this reads. */
  decode(s: PdfDict): Uint8Array | undefined {
    if (!s.stream) return undefined;
    const f = this.get(s.map.get('Filter'));
    const filters = (Array.isArray(f) ? f : f === undefined ? [] : [f]).map((x) => this.get(x));
    let data: Uint8Array = s.stream;
    for (const filter of filters) {
      if (!isName(filter)) return undefined;
      const name = filter.name;
      try {
        if (name === 'FlateDecode' || name === 'Fl') data = inflateLoose(data);
        else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data);
        else if (name === 'ASCII85Decode' || name === 'A85') data = ascii85(data);
        else return undefined;
      } catch {
        return undefined;
      }
    }
    return data;
  }
}

/** Inflate with a bound; a stream cut short gives what it holds. */
function inflateLoose(data: Uint8Array): Uint8Array {
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw err;
    // Truncated or with trailing junk: inflate as much as reads.
    return inflateSync(data, { maxOutputLength: MAX_STREAM, finishFlush: 2 /* Z_SYNC_FLUSH */ });
  }
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 62) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (n: number) => {
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + (group[k] ?? 84);
    for (let k = 0; k < n - 1; k++) out.push((v >>> (24 - 8 * k)) & 255);
    group = [];
  };
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c === 126 /* ~ */) break;
    if (WS[c]) continue;
    if (c === 122 /* z */ && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) flush(5);
  }
  if (group.length > 1) flush(group.length);
  return Uint8Array.from(out);
}

// ---- fonts ------------------------------------------------------------------------------------

interface Font {
  /** Bytes per code: 1 for simple fonts, from the code space for composite ones. */
  widths: number[];
  /** Glyph advance in thousandths of the font size, by code; `dw` when absent. */
  advance: Map<number, number>;
  dw: number;
  map: Map<number, string>;
  /** Simple fonts: the base encoding for codes the map lacks. */
  base?: (code: number) => string;
  composite: boolean;
}

const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};
const winAnsi = (c: number) => WIN_ANSI_HIGH[c] ?? (c >= 32 && c !== 127 ? String.fromCharCode(c) : c === 9 ? ' ' : '');
const STANDARD_DIFF: Record<number, string> = {
  0x27: '’',
  0x60: '‘',
  0xa9: "'",
  0xaa: '“',
  0xba: '”',
  0xb7: '•',
  0xb1: '–',
  0xd0: '—',
  0xae: 'ﬁ',
  0xaf: 'ﬂ',
};
const standard = (c: number) => STANDARD_DIFF[c] ?? (c >= 32 && c < 127 ? String.fromCharCode(c) : '');
const MAC_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const macRoman = (c: number) =>
  c >= 128 ? (MAC_HIGH[c - 128] ?? '') : c >= 32 && c !== 127 ? String.fromCharCode(c) : '';

/** Glyph names the federal manuals' `/Differences` use, beyond `uniXXXX` and single letters. */
const GLYPHS: Record<string, string> = {
  space: ' ',
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  quotesingle: "'",
  quoteright: '’',
  quoteleft: '‘',
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  hyphen: '-',
  minus: '-',
  period: '.',
  slash: '/',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  asciicircum: '^',
  underscore: '_',
  grave: '`',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  bullet: '•',
  endash: '–',
  emdash: '—',
  quotedblleft: '“',
  quotedblright: '”',
  ellipsis: '…',
  degree: '°',
  fi: 'fi',
  fl: 'fl',
  ff: 'ff',
  ffi: 'ffi',
  ffl: 'ffl',
  copyright: '©',
  registered: '®',
  trademark: '™',
  section: '§',
  paragraph: '¶',
  dagger: '†',
  daggerdbl: '‡',
  onehalf: '½',
  onequarter: '¼',
  threequarters: '¾',
  multiply: '×',
  divide: '÷',
  plusminus: '±',
  mu: 'µ',
  nbspace: ' ',
  periodcentered: '·',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  ntilde: 'ñ',
  ccedilla: 'ç',
  odieresis: 'ö',
  udieresis: 'ü',
  adieresis: 'ä',
  germandbls: 'ß',
  oacute: 'ó',
  iacute: 'í',
  uacute: 'ú',
};

export function glyphText(name: string): string {
  if (Object.hasOwn(GLYPHS, name)) return GLYPHS[name]!;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (uni) {
    let out = '';
    for (let i = 3; i < name.length; i += 4) out += String.fromCharCode(parseInt(name.slice(i, i + 4), 16));
    return out;
  }
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) {
    const cp = parseInt(u[1]!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  const base = /^([A-Za-z]+)\.\w+$/.exec(name);
  if (base) return glyphText(base[1]!);
  return '';
}

/** Unicode for a run of bytes as a CMap gives it (UTF-16BE). */
function utf16be(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return out;
}

const bytesToNum = (b: Uint8Array) => {
  let n = 0;
  for (const x of b) n = n * 256 + x;
  return n;
};

/** A `/ToUnicode` CMap: code → text, and the code widths its code space ranges give. */
export function readToUnicode(data: Uint8Array): { map: Map<number, string>; widths: number[] } {
  const map = new Map<number, string>();
  const widths = new Set<number>();
  const lx = new Lexer(data);
  const stack: (PdfValue | { op: string })[] = [];
  let mode: string | undefined;
  for (let guard = 0; guard < 2_000_000; guard++) {
    const t = lx.next();
    if (t === undefined) break;
    if (typeof t === 'object' && t !== null && 'op' in t) {
      const op = t.op;
      if (op === 'begincodespacerange' || op === 'beginbfchar' || op === 'beginbfrange') {
        mode = op;
        stack.length = 0;
      } else if (op === 'endcodespacerange') {
        for (const v of stack) if (isStr(v)) widths.add(v.bytes.length);
        mode = undefined;
      } else if (op === 'endbfchar') {
        for (let k = 0; k + 1 < stack.length; k += 2) {
          const src = stack[k];
          const dst = stack[k + 1];
          if (isStr(src) && isStr(dst)) {
            map.set(bytesToNum(src.bytes), utf16be(dst.bytes));
            widths.add(src.bytes.length);
          } else if (isStr(src) && isName(dst)) map.set(bytesToNum(src.bytes), glyphText(dst.name));
        }
        mode = undefined;
      } else if (op === 'endbfrange') {
        for (let k = 0; k + 2 < stack.length; k += 3) {
          const lo = stack[k];
          const hi = stack[k + 1];
          const dst = stack[k + 2];
          if (!isStr(lo) || !isStr(hi)) continue;
          const a = bytesToNum(lo.bytes);
          const z = bytesToNum(hi.bytes);
          if (z < a || z - a > 65535) continue;
          widths.add(lo.bytes.length);
          if (isStr(dst)) {
            const base = dst.bytes;
            for (let c = a; c <= z; c++) {
              const d = Uint8Array.from(base);
              // Increment the last byte(s) by the offset, as the CMap rules say.
              let carry = c - a;
              for (let i = d.length - 1; i >= 0 && carry > 0; i--) {
                const s = d[i]! + carry;
                d[i] = s & 255;
                carry = s >> 8;
              }
              map.set(c, utf16be(d));
            }
          } else if (Array.isArray(dst)) {
            for (let c = a; c <= z && c - a < dst.length; c++) {
              const d = dst[c - a];
              if (isStr(d)) map.set(c, utf16be(d.bytes));
            }
          }
        }
        mode = undefined;
      }
      continue;
    }
    if (mode) stack.push(t);
  }
  return { map, widths: [...widths].filter((w) => w >= 1 && w <= 4).sort((x, y) => x - y) };
}

// ---- pages and content ------------------------------------------------------------------------

class TextBuilder {
  private parts: string[] = [];
  private size = 0;
  full = false;

  push(s: string): void {
    if (this.full || !s) return;
    this.size += s.length;
    if (this.size > MAX_TEXT) {
      this.full = true;
      return;
    }
    this.parts.push(s);
  }

  space(): void {
    const last = this.parts[this.parts.length - 1];
    if (last && !/\s$/.test(last)) this.push(' ');
  }

  line(): void {
    const last = this.parts[this.parts.length - 1];
    if (last && !last.endsWith('\n')) {
      if (last.endsWith(' ')) this.parts[this.parts.length - 1] = last.trimEnd();
      this.push('\n');
    }
  }

  text(): string {
    return this.parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
}

export function extractPdfText(bytes: Uint8Array): PdfText {
  const run = pagesOf(bytes);
  for (;;) {
    const r = run.next();
    if (r.done) return r.value;
  }
}

/**
 * The same, giving way to other work after each page (a 600-page manual takes a few seconds:
 * nothing else should wait that long).
 */
export async function extractPdfTextAsync(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfText> {
  const run = pagesOf(bytes);
  for (;;) {
    signal?.throwIfAborted();
    const r = run.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function* pagesOf(bytes: Uint8Array): Generator<void, PdfText> {
  let file: PdfFile;
  try {
    file = new PdfFile(bytes);
  } catch {
    return { pages: [], note: 'damaged' };
  }
  if (file.trailer?.map.has('Encrypt')) return { pages: [], note: 'encrypted' };
  const pages = pageList(file);
  if (!pages.length) return { pages: [], note: 'no-pages' };
  const fonts = new Map<number, Font>();
  const out: string[] = [];
  const tb = new TextBuilder();
  let damaged = false;
  for (const page of pages) {
    yield;
    const pageText = new TextBuilder();
    try {
      const contents = file.get(page.dict.map.get('Contents'));
      const streams = (Array.isArray(contents) ? contents : [contents]).map((c) => file.dict(c)).filter(isDict);
      const parts = streams.map((s) => file.decode(s)).filter((x): x is Uint8Array => !!x);
      const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
      let o = 0;
      for (const p of parts) {
        joined.set(p, o);
        o += p.length;
        joined[o++] = 10;
      }
      runContent(file, joined, page.resources, fonts, pageText, 0);
      // What annotations show (filled-in form fields, typed notes): their normal appearance.
      const annots = file.get(page.dict.map.get('Annots'));
      if (Array.isArray(annots)) {
        for (const a of annots.slice(0, 2000)) {
          const ad = file.dict(a);
          const ap = file.dict(ad?.map.get('AP'));
          let n = file.get(ap?.map.get('N'));
          if (isDict(n) && !n.stream) {
            const state = file.get(ad?.map.get('AS'));
            n = isName(state) ? file.get(n.map.get(state.name)) : undefined;
          }
          if (!isDict(n) || !n.stream) continue;
          const inner = file.decode(n);
          if (!inner) continue;
          pageText.space();
          runContent(file, inner, file.dict(n.map.get('Resources')) ?? page.resources, fonts, pageText, 1);
        }
      }
    } catch {
      damaged = true;
    }
    const t = pageText.text();
    tb.push(t);
    out.push(t);
    if (tb.full) return { pages: out, note: 'truncated' };
  }
  return damaged ? { pages: out, note: 'damaged' } : { pages: out };
}

function pageList(file: PdfFile): { dict: PdfDict; resources: PdfDict | undefined }[] {
  const root = file.dict(file.trailer?.map.get('Root'));
  const out: { dict: PdfDict; resources: PdfDict | undefined }[] = [];
  const seen = new Set<PdfDict>();
  const walk = (node: PdfDict | undefined, res: PdfDict | undefined, depth: number) => {
    if (!node || seen.has(node) || depth > 64 || out.length > 100_000) return;
    seen.add(node);
    const r = file.dict(node.map.get('Resources')) ?? res;
    const kids = file.get(node.map.get('Kids'));
    if (Array.isArray(kids)) {
      for (const k of kids) walk(file.dict(k), r, depth + 1);
    } else if (isName(node.map.get('Type'), 'Page') || node.map.has('Contents')) out.push({ dict: node, resources: r });
  };
  walk(file.dict(root?.map.get('Pages')), undefined, 0);
  if (out.length) return out;
  // No usable page tree (damaged): every /Type /Page in the order objects were numbered.
  const nums = [...file.objects.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    const d = file.objects.get(n);
    if (isDict(d) && isName(d.map.get('Type'), 'Page'))
      out.push({ dict: d, resources: file.dict(d.map.get('Resources')) });
  }
  return out;
}

function fontFor(file: PdfFile, ref: PdfValue | undefined, cache: Map<number, Font>): Font {
  const fallback: Font = { widths: [1], map: new Map(), base: winAnsi, composite: false, advance: new Map(), dw: 500 };
  const key = isRef(ref) ? ref.num : -1;
  if (key >= 0 && cache.has(key)) return cache.get(key)!;
  const d = file.dict(ref);
  if (!d) return fallback;
  const composite = isName(d.map.get('Subtype'), 'Type0');
  const font: Font = {
    widths: composite ? [2] : [1],
    map: new Map(),
    composite,
    advance: new Map(),
    dw: composite ? 1000 : 500,
  };
  readAdvances(file, d, font);
  if (!composite) {
    const enc = file.get(d.map.get('Encoding'));
    const encName = isName(enc)
      ? enc.name
      : isDict(enc) && isName(file.get(enc.map.get('BaseEncoding')))
        ? (file.get(enc.map.get('BaseEncoding')) as PdfName).name
        : undefined;
    font.base = encName === 'MacRomanEncoding' ? macRoman : encName === 'StandardEncoding' ? standard : winAnsi;
    if (isDict(enc)) {
      const diffs = file.get(enc.map.get('Differences'));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const x of diffs) {
          const v = file.get(x);
          if (typeof v === 'number') code = v;
          else if (isName(v)) {
            const t = glyphText(v.name);
            if (t) font.map.set(code, t);
            code++;
          }
        }
      }
    }
  }
  const tu = file.dict(d.map.get('ToUnicode'));
  if (tu) {
    const data = file.decode(tu);
    if (data) {
      const cmap = readToUnicode(data);
      for (const [c, t] of cmap.map) font.map.set(c, t);
      if (composite && cmap.widths.length) font.widths = cmap.widths;
    }
  }
  if (key >= 0) cache.set(key, font);
  return font;
}

/** Glyph advances: `/FirstChar` + `/Widths` for simple fonts, `/DW` + `/W` for composite ones. */
function readAdvances(file: PdfFile, d: PdfDict, font: Font): void {
  const num = (v: PdfValue | undefined) => {
    const x = file.get(v);
    return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  };
  if (!font.composite) {
    const first = num(d.map.get('FirstChar')) ?? 0;
    const w = file.get(d.map.get('Widths'));
    if (Array.isArray(w))
      w.slice(0, 65536).forEach((x, i) => {
        const n = num(x);
        if (n !== undefined && n > 0) font.advance.set(first + i, n);
      });
    const desc = file.dict(d.map.get('FontDescriptor'));
    const missing = num(desc?.map.get('MissingWidth'));
    if (missing && missing > 0) font.dw = missing;
    else if (font.advance.size) {
      // Codes outside the table: the table's average.
      let sum = 0;
      for (const x of font.advance.values()) sum += x;
      font.dw = sum / font.advance.size;
    }
    return;
  }
  const descendants = file.get(d.map.get('DescendantFonts'));
  const cid = file.dict(Array.isArray(descendants) ? descendants[0] : undefined);
  if (!cid) return;
  const dw = num(cid.map.get('DW'));
  if (dw && dw > 0) font.dw = dw;
  const w = file.get(cid.map.get('W'));
  if (!Array.isArray(w)) return;
  for (let i = 0; i < w.length && font.advance.size < 200_000;) {
    const c0 = num(w[i]);
    const next = file.get(w[i + 1]);
    if (c0 === undefined) break;
    if (Array.isArray(next)) {
      next.slice(0, 65536).forEach((x, k) => {
        const n = num(x);
        if (n !== undefined) font.advance.set(c0 + k, n);
      });
      i += 2;
    } else {
      const c1 = num(next);
      const n = num(w[i + 2]);
      if (c1 === undefined || n === undefined || c1 < c0) break;
      for (let c = c0; c <= c1 && c - c0 < 65536; c++) font.advance.set(c, n);
      i += 3;
    }
  }
}

/** A string's codes: one byte each for simple fonts; for composite ones by the code widths. */
function codesOf(font: Font, bytes: Uint8Array): number[] {
  if (!font.composite) return [...bytes];
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    let taken = false;
    for (const w of font.widths) {
      if (i + w > bytes.length) continue;
      let c = 0;
      for (let k = 0; k < w; k++) c = c * 256 + bytes[i + k]!;
      if (font.map.has(c) || w === font.widths[font.widths.length - 1]) {
        out.push(c);
        i += w;
        taken = true;
        break;
      }
    }
    if (!taken) i++;
  }
  return out;
}

function decodeString(font: Font, bytes: Uint8Array): string {
  let out = '';
  if (!font.composite) {
    for (const c of bytes) out += font.map.get(c) ?? font.base?.(c) ?? '';
    return out;
  }
  // Composite: shortest code width that maps, else the widest; no map at all → nothing usable.
  let i = 0;
  while (i < bytes.length) {
    let done = false;
    for (const w of font.widths) {
      if (i + w > bytes.length) continue;
      let c = 0;
      for (let k = 0; k < w; k++) c = c * 256 + bytes[i + k]!;
      const t = font.map.get(c);
      if (t !== undefined) {
        out += t;
        i += w;
        done = true;
        break;
      }
    }
    if (!done) i += font.widths[font.widths.length - 1] ?? 2;
  }
  return out;
}

function runContent(
  file: PdfFile,
  data: Uint8Array,
  resources: PdfDict | undefined,
  fonts: Map<number, Font>,
  tb: TextBuilder,
  depth: number,
): void {
  const lx = new Lexer(data);
  const args: PdfValue[] = [];
  const fontDict = file.dict(resources?.map.get('Font'));
  const xobjects = file.dict(resources?.map.get('XObject'));
  // Text state; positions are in the text matrix's space (the current transformation is the
  // same for the glyphs compared, so it is left out).
  let font: Font = { widths: [1], map: new Map(), base: winAnsi, composite: false, advance: new Map(), dw: 500 };
  let fs = 12;
  let tc = 0;
  let tw = 0;
  let th = 1;
  let tl = 0;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  const stack: { font: Font; fs: number; tc: number; tw: number; th: number; tl: number }[] = [];
  const num = (v: PdfValue | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const scale = () => Math.hypot(tm[2]!, tm[3]!) * fs || fs;
  const setLine = (tx: number, ty: number) => {
    tlm = [
      tlm[0]!,
      tlm[1]!,
      tlm[2]!,
      tlm[3]!,
      tx * tlm[0]! + ty * tlm[2]! + tlm[4]!,
      tx * tlm[1]! + ty * tlm[3]! + tlm[5]!,
    ];
    tm = [...tlm];
  };
  const advance = (tx: number) => {
    tm[4] = tm[4]! + tx * tm[0]!;
    tm[5] = tm[5]! + tx * tm[1]!;
  };
  /** Where the last glyph shown ended, and the size it was shown at. */
  let end: { x: number; y: number; size: number } | undefined;
  const show = (bytes: Uint8Array) => {
    const codes = codesOf(font, bytes);
    if (!codes.length) return;
    const size = scale();
    const x = tm[4]!;
    const y = tm[5]!;
    if (end) {
      // The text's own direction: across the line when b is 0 (the usual case).
      const dy = Math.abs(y - end.y);
      const dx = x - end.x;
      const em = Math.max(size, end.size);
      if (dy > em * 0.5) tb.line();
      else if (dx > em * 0.15 || dx < -em * 2) tb.space();
    }
    tb.push(decodeString(font, bytes));
    for (const c of codes) {
      const w = font.advance.get(c) ?? font.dw;
      const isSpace = !font.composite && c === 32;
      advance(((w / 1000) * fs + tc + (isSpace ? tw : 0)) * th);
    }
    end = { x: tm[4]!, y: tm[5]!, size };
  };
  for (let ops = 0; ops < MAX_OPS_PER_PAGE && !tb.full; ops++) {
    const t = lx.next();
    if (t === undefined) break;
    if (!(typeof t === 'object' && t !== null && 'op' in t)) {
      if (args.length < 64) args.push(t);
      continue;
    }
    const op = t.op;
    switch (op) {
      case 'q':
        if (stack.length < 64) stack.push({ font, fs, tc, tw, th, tl });
        break;
      case 'Q': {
        const g = stack.pop();
        if (g) ({ font, fs, tc, tw, th, tl } = g);
        break;
      }
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case 'ET':
        break;
      case 'Tf': {
        const name = args[args.length - 2];
        const sz = num(args[args.length - 1]);
        if (isName(name)) font = fontFor(file, fontDict?.map.get(name.name), fonts);
        if (sz !== undefined && sz !== 0) fs = Math.abs(sz);
        break;
      }
      case 'Tc':
        tc = num(args[0]) ?? 0;
        break;
      case 'Tw':
        tw = num(args[0]) ?? 0;
        break;
      case 'Tz':
        th = (num(args[0]) ?? 100) / 100;
        break;
      case 'TL':
        tl = num(args[0]) ?? 0;
        break;
      case 'Td':
      case 'TD': {
        const tx = num(args[0]);
        const ty = num(args[1]);
        if (tx !== undefined && ty !== undefined) {
          if (op === 'TD') tl = -ty;
          setLine(tx, ty);
        }
        break;
      }
      case 'Tm': {
        const m = args.slice(0, 6).map(num);
        if (m.length === 6 && m.every((x) => x !== undefined)) {
          tlm = m as number[];
          tm = [...tlm];
        }
        break;
      }
      case 'T*':
        setLine(0, -tl);
        break;
      case 'Tj':
        if (isStr(args[0])) show(args[0].bytes);
        break;
      case "'":
        setLine(0, -tl);
        if (isStr(args[0])) show(args[0].bytes);
        break;
      case '"':
        tw = num(args[0]) ?? tw;
        tc = num(args[1]) ?? tc;
        setLine(0, -tl);
        if (isStr(args[2])) show(args[2].bytes);
        break;
      case 'TJ':
        if (Array.isArray(args[0])) {
          for (const x of args[0]) {
            if (isStr(x)) show(x.bytes);
            else if (typeof x === 'number' && Number.isFinite(x)) advance((-x / 1000) * fs * th);
          }
        }
        break;
      case 'Do': {
        const name = args[0];
        if (depth < MAX_FORM_DEPTH && isName(name)) {
          const xo = file.dict(xobjects?.map.get(name.name));
          if (xo && isName(xo.map.get('Subtype'), 'Form')) {
            const inner = file.decode(xo);
            if (inner) {
              tb.space();
              runContent(file, inner, file.dict(xo.map.get('Resources')) ?? resources, fonts, tb, depth + 1);
              // The form's text and what follows are separate runs.
              tb.space();
              end = undefined;
            }
          }
        }
        break;
      }
      case 'BI': {
        // An inline image: skip to EI after the ID data.
        const id = indexOf(data, 'ID', lx.pos);
        const ei = id < 0 ? -1 : indexOf(data, 'EI', id + 3);
        lx.pos = ei < 0 ? data.length : ei + 2;
        break;
      }
      default:
        break;
    }
    args.length = 0;
  }
}
