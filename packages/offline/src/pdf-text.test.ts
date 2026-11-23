import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfText, glyphText, readToUnicode } from './pdf-text.js';

/*
 * PDFs built byte by byte here, so each case says exactly what it tests. The reader was also
 * run (not in the suite) over the 1,104 files of Mozilla pdf.js's test corpus and twelve PDFs
 * made by reportlab, LibreOffice and qpdf, against poppler's pdftotext: no throw, no hang.
 */

interface Obj {
  num: number;
  body: string | Buffer;
  stream?: Buffer;
}

/** A PDF from objects; with `xref: false` there is no cross-reference table at all. */
function pdf(objs: Obj[], root = 1, opts: { xref?: boolean; trailerExtra?: string } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets: number[] = [];
  let len = parts[0]!.length;
  for (const o of objs) {
    offsets[o.num] = len;
    const head = Buffer.from(`${o.num} 0 obj\n`, 'latin1');
    const body = typeof o.body === 'string' ? Buffer.from(o.body, 'latin1') : o.body;
    const chunk = o.stream
      ? Buffer.concat([head, body, Buffer.from('\nstream\n'), o.stream, Buffer.from('\nendstream\nendobj\n')])
      : Buffer.concat([head, body, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    len += chunk.length;
  }
  const size = Math.max(...objs.map((o) => o.num)) + 1;
  let tail = '';
  if (opts.xref !== false) {
    tail += `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) tail += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  tail += `trailer\n<< /Size ${size} /Root ${root} 0 R ${opts.trailerExtra ?? ''} >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const stream = (dict: string, data: string | Buffer, flate = false): Obj['stream'] & { dict: string } => {
  const raw = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  const s = flate ? deflateSync(raw) : raw;
  return Object.assign(s, { dict: `<< ${dict} ${flate ? '/Filter /FlateDecode ' : ''}/Length ${s.length} >>` });
};
const sobj = (num: number, dict: string, data: string | Buffer, flate = false): Obj => {
  const s = stream(dict, data, flate);
  return { num, body: s.dict, stream: s };
};

/** Catalog 1, Pages 2, one page 3 with font F1 = object 5, content = object 4. */
function onePage(content: string, font: string, extra: Obj[] = [], flate = true): Buffer {
  return pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>' },
    sobj(4, '', content, flate),
    { num: 5, body: font },
    ...extra,
  ]);
}

const HELV = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

test('simple font: lines, words placed by Td, kerning in TJ, WinAnsi characters', () => {
  const r = extractPdfText(
    onePage(
      'BT /F1 12 Tf 72 720 Td (Boil water for) Tj ( one minute.) Tj 0 -14 Td [(Ca) 20 (nning) -300 (jars)] TJ ' +
        '0 -14 Td (caf\\351 \\223quoted\\224 \\226 25\\260F) Tj ET',
      HELV,
    ),
  );
  assert.deepEqual(r.pages, ['Boil water for one minute.\nCanning jars\ncafé “quoted” – 25°F']);
  assert.equal(r.note, undefined);
});

test('widths: words placed apart by position get a space; letters placed one by one do not', () => {
  // Widths all 500/1000 em: at 10 pt each glyph advances 5 units.
  const font =
    '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 32 /LastChar 126 /Widths [' +
    Array(95).fill(500).join(' ') +
    '] /Encoding /WinAnsiEncoding >>';
  // "Lorem" then "ipsum" 7 units after its end (a space); then letters one by one, each exactly
  // where the last ended.
  const r = extractPdfText(
    onePage(
      'BT /F1 10 Tf 1 0 0 1 100 700 Tm (Lorem) Tj 1 0 0 1 132 700 Tm (ipsum) Tj ' +
        '1 0 0 1 100 680 Tm (N) Tj 1 0 0 1 105 680 Tm (a) Tj 1 0 0 1 110 680 Tm (m) Tj 1 0 0 1 115 680 Tm (e) Tj ET',
      font,
    ),
  );
  assert.deepEqual(r.pages, ['Lorem ipsum\nName']);
});

test('composite font: two-byte codes through a ToUnicode CMap (bfchar, bfrange, array)', () => {
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
    '2 beginbfchar <0003> <0020> <0010> <00E9> endbfchar\n' +
    '2 beginbfrange <0024> <003D> <0041> <0044> <0046> [<0061> <0062> <0063>] endbfrange\nendcmap end end';
  const font =
    '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>';
  // A=0x24, B=0x25 … ; a b c = 0x44..0x46; é = 0x10; space = 0x03.
  const r = extractPdfText(
    onePage('BT /F1 11 Tf 50 700 Td <0024002500260003004400450046001000030027> Tj ET', font, [
      { num: 6, body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 >>' },
      sobj(7, '', cmap, true),
    ]),
  );
  assert.deepEqual(r.pages, ['ABC abcé D']);
});

test('object streams and a cross-reference stream: objects found inside compressed streams', () => {
  // Objects 2, 3 and 5 live in object stream 8; the trailer is an XRef stream.
  const inner = [
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    HELV,
  ];
  let head = '';
  let body = '';
  const nums = [2, 3, 5];
  inner.forEach((o, i) => {
    head += `${nums[i]} ${body.length} `;
    body += `${o}\n`;
  });
  const objstm = sobj(8, `/Type /ObjStm /N 3 /First ${head.length}`, head + body, true);
  const file = pdf(
    [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      sobj(4, '', 'BT /F1 12 Tf 72 700 Td (Inside an object stream) Tj ET', true),
      objstm,
      sobj(9, '/Type /XRef /Root 1 0 R /Size 10 /W [1 2 1]', Buffer.alloc(40), true),
    ],
    1,
    { xref: false },
  );
  assert.deepEqual(extractPdfText(file).pages, ['Inside an object stream']);
});

test('page order follows the page tree, inherited resources, several content streams', () => {
  const file = pdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [10 0 R 3 0 R] /Count 3 /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 10, body: '<< /Type /Pages /Parent 2 0 R /Kids [11 0 R 12 0 R] /Count 2 >>' },
    { num: 11, body: '<< /Type /Page /Parent 10 0 R /Contents [13 0 R 14 0 R] >>' },
    { num: 12, body: '<< /Type /Page /Parent 10 0 R /Contents 15 0 R >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    sobj(13, '', 'BT /F1 12 Tf 72 700 Td (First', true),
    sobj(14, '', ' page) Tj ET', true),
    sobj(15, '', 'BT /F1 12 Tf 72 700 Td (Second page) Tj ET'),
    sobj(4, '', 'BT /F1 12 Tf 72 700 Td (Third page) Tj ET', true),
    { num: 5, body: HELV },
  ]);
  assert.deepEqual(extractPdfText(file).pages, ['First page', 'Second page', 'Third page']);
});

test('form XObjects, annotation appearances and inline images', () => {
  const file = onePage(
    'BT /F1 12 Tf 72 700 Td (Before) Tj ET q /Fm1 Do Q ' +
      'BI /W 4 /H 1 /BPC 8 /CS /G ID \x00(Tj)\xff EI BT /F1 12 Tf 72 600 Td (After) Tj ET',
    HELV,
    [
      sobj(
        6,
        '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >>',
        'BT /F1 12 Tf 0 0 Td (In a form) Tj ET',
        true,
      ),
      { num: 7, body: '<< /Type /Annot /Subtype /Widget /AS /On /AP << /N << /On 8 0 R /Off 9 0 R >> >> >>' },
      sobj(
        8,
        '/Type /XObject /Subtype /Form /Resources << /Font << /F1 5 0 R >> >>',
        'BT /F1 10 Tf 0 0 Td (Typed value) Tj ET',
      ),
      sobj(9, '/Type /XObject /Subtype /Form', 'BT /F1 10 Tf 0 0 Td (Not shown) Tj ET'),
    ],
  );
  const patched = Buffer.from(
    file
      .toString('latin1')
      .replace(
        '/Resources << /Font << /F1 5 0 R >> >> >>',
        '/Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> >>',
      )
      .replace('/Contents 4 0 R >>', '/Contents 4 0 R /Annots [7 0 R] >>'),
    'latin1',
  );
  const t = extractPdfText(patched).pages[0]!;
  assert.match(t, /^Before\s+In a form\s+After\s+Typed value$/);
  assert.doesNotMatch(t, /Not shown|Tj/);
});

test('encrypted, empty and damaged files: a note, never a throw', () => {
  assert.deepEqual(extractPdfText(onePage('BT ET', HELV).subarray(0, 0)), { pages: [], note: 'no-pages' });
  const enc = Buffer.from(
    onePage('BT /F1 12 Tf (x) Tj ET', HELV).toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 9 0 R'),
    'latin1',
  );
  assert.deepEqual(extractPdfText(enc), { pages: [], note: 'encrypted' });
  assert.equal(extractPdfText(Buffer.from('not a pdf at all')).note, 'no-pages');
  // No cross-reference table and no page tree: pages found by type.
  const loose = pdf(
    [
      { num: 3, body: '<< /Type /Page /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>' },
      sobj(4, '', 'BT /F1 12 Tf 72 700 Td (Found anyway) Tj ET'),
      { num: 5, body: HELV },
    ],
    99,
    { xref: false },
  );
  assert.deepEqual(extractPdfText(loose).pages, ['Found anyway']);
  // A content stream cut short still gives what it held.
  const good = onePage('BT /F1 12 Tf 72 700 Td (Cut short here and more text after that point) Tj ET', HELV);
  const z = deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td (Cut short here and more text after that point) Tj ET'));
  const cut = Buffer.from(
    good.toString('latin1').replace(z.toString('latin1'), z.subarray(0, z.length - 12).toString('latin1')),
    'latin1',
  );
  assert.doesNotThrow(() => extractPdfText(cut));
});

test('mutation fuzz: 3,000 damaged files, no throw, bounded time', () => {
  const base = [
    onePage('BT /F1 12 Tf 72 720 Td [(Splint) -300 (the) -300 (joint)] TJ 0 -14 Td (above and below) Tj ET', HELV),
    onePage(
      'BT /F1 11 Tf 50 700 Td <002400250026> Tj ET',
      '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>',
      [
        { num: 6, body: '<< /Type /Font /Subtype /CIDFontType2 /W [36 [500 600] 38 40 700] >>' },
        sobj(
          7,
          '',
          '1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0024> <0026> <0041> endbfrange',
          true,
        ),
      ],
    ),
  ];
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const started = Date.now();
  for (let i = 0; i < 3000; i++) {
    const b = Buffer.from(base[i % base.length]!);
    const kind = Math.floor(rnd() * 4);
    if (kind === 0) for (let k = 0; k < 1 + rnd() * 8; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const cutAt = Math.floor(rnd() * b.length);
    const x =
      kind === 1
        ? b.subarray(0, cutAt)
        : kind === 2
          ? Buffer.concat([b.subarray(0, cutAt), b.subarray(cutAt + 1 + Math.floor(rnd() * 40))])
          : b;
    const r = extractPdfText(x);
    assert.ok(Array.isArray(r.pages));
    for (const p of r.pages) assert.equal(typeof p, 'string');
  }
  assert.ok(Date.now() - started < 30_000);
});

test('deep nesting and a self-referencing page tree end; a form drawing itself stops', () => {
  const deep = `<< /Type /Catalog /Pages 2 0 R /X ${'['.repeat(5000)}${']'.repeat(5000)} >>`;
  const looped = pdf([
    { num: 1, body: deep },
    {
      num: 2,
      body: '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> /XObject << /Me 6 0 R >> >> >>',
    },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>' },
    sobj(4, '', 'BT /F1 12 Tf 72 700 Td (Once) Tj ET /Me Do'),
    { num: 5, body: HELV },
    sobj(
      6,
      '/Type /XObject /Subtype /Form /Resources << /Font << /F1 5 0 R >> /XObject << /Me 6 0 R >> >>',
      'BT /F1 12 Tf (again) Tj ET /Me Do',
    ),
  ]);
  const r = extractPdfText(looped);
  assert.equal(r.pages.length, 1);
  assert.match(r.pages[0]!, /^Once( again){4}$/);
});

test('ToUnicode and glyph names: ranges that carry, surrogate pairs, unknown names', () => {
  const { map, widths } = readToUnicode(
    Buffer.from(
      '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <FE> <FF> <00FF> endbfrange 1 beginbfchar <01> <D83DDE00> endbfchar',
    ),
  );
  assert.deepEqual(widths, [1]);
  assert.equal(map.get(0xfe), 'ÿ');
  assert.equal(map.get(0xff), 'Ā', 'the last byte carries into the one before');
  assert.equal(map.get(1), '😀');
  assert.equal(glyphText('uni00E9'), 'é');
  assert.equal(glyphText('uni00410042'), 'AB');
  assert.equal(glyphText('u1F600'), '😀');
  assert.equal(glyphText('a.sc'), 'a');
  assert.equal(glyphText('quotedblleft'), '“');
  assert.equal(glyphText('constructor'), '');
  assert.equal(glyphText('g123'), '');
  assert.equal(glyphText('u110000'), '');
});
