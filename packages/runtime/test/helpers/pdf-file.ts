import { deflateSync } from 'node:zlib';

/**
 * A small PDF for tests: one page per string, Helvetica, WinAnsi, compressed content.
 * Lines within a page are separated by `\n`.
 */
export function buildPdf(pages: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = [];
  const streams: Map<number, Buffer> = new Map();
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page: page object, content stream.
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Resources << /Font << /F1 3 0 R >> >> >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((text, i) => {
    const content = `BT /F1 11 Tf 14 TL 72 720 Td ${text
      .split('\n')
      .map((l, k) => `${k ? 'T* ' : ''}(${esc(l)}) Tj`)
      .join(' ')} ET`;
    const z = deflateSync(Buffer.from(content, 'latin1'));
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Filter /FlateDecode /Length ${z.length} >>`;
    streams.set(5 + i * 2, z);
  });
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  for (let k = 1; k < objs.length; k++) {
    const s = streams.get(k);
    parts.push(Buffer.from(`${k} 0 obj\n${objs[k]}\n`, 'latin1'));
    if (s) parts.push(Buffer.from('stream\n'), s, Buffer.from('\nendstream\n'));
    parts.push(Buffer.from('endobj\n'));
  }
  parts.push(Buffer.from(`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
