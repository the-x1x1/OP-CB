/**
 * A CSV reader for catalogue-sized files: RFC 4180 quoting (quoted fields, doubled quotes,
 * newlines inside quotes), any single-character delimiter, CRLF or LF, a BOM. Rows become
 * records keyed by the header row (or by `columns` when the file has none); a row with more
 * fields than columns keeps the extras under `_3`, `_4`…; empty cells are absent, and cells
 * that look like numbers stay strings — the mapping's `number` transform decides.
 *
 * `delimiter: "whitespace"` reads a column-aligned text table instead (NDBC's
 * latest_obs.txt): each line split on runs of spaces and tabs, no quoting. `comment` names a
 * character that starts a line to skip (NDBC's two `#` header lines), in either form.
 */
export interface CsvOptions {
  /** One character, or `whitespace` for a column-aligned table. */
  delimiter?: string;
  /** Rows whose first field starts with this character are skipped. */
  comment?: string;
  header?: boolean;
  columns?: string[];
  /** Rows at most (the rest are dropped and counted). */
  maxRows?: number;
}

export interface CsvResult {
  records: Array<Record<string, string>>;
  columns: string[];
  /** Rows beyond `maxRows`. */
  dropped: number;
  /** The file did not parse as CSV at all. */
  malformed?: string;
}

export const MAX_CSV_ROWS = 100_000;
const MAX_FIELDS = 512;

export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const d = delimiter;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === d) {
      row.push(field);
      field = '';
      if (row.length > MAX_FIELDS) throw new Error(`more than ${MAX_FIELDS} fields in a row`);
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (quoted) throw new Error('unterminated quoted field');
  return rows;
}

/** A column-aligned table: each non-blank line split on runs of spaces and tabs. */
export function parseWhitespaceRows(text: string): string[][] {
  const rows: string[][] = [];
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (const line of text.slice(start).split(/\r?\n|\r/)) {
    const t = line.trim();
    if (!t) continue;
    const row = t.split(/[ \t]+/);
    if (row.length > MAX_FIELDS) throw new Error(`more than ${MAX_FIELDS} fields in a row`);
    rows.push(row);
  }
  return rows;
}

export function parseCsv(text: string, opts: CsvOptions = {}): CsvResult {
  let rows: string[][];
  try {
    rows = opts.delimiter === 'whitespace' ? parseWhitespaceRows(text) : parseCsvRows(text, opts.delimiter ?? ',');
  } catch (err) {
    return { records: [], columns: [], dropped: 0, malformed: err instanceof Error ? err.message : String(err) };
  }
  const comment = opts.comment;
  if (comment) rows = rows.filter((r) => !(r[0] ?? '').trimStart().startsWith(comment));
  const header = opts.header ?? true;
  let columns = opts.columns ? [...opts.columns] : [];
  let start = 0;
  if (header) {
    const first = rows[0];
    if (!first) return { records: [], columns, dropped: 0, malformed: 'no header row' };
    if (!opts.columns) columns = first.map((c, i) => (c.trim() === '' ? `_${i}` : c.trim()));
    start = 1;
  }
  if (columns.length === 0)
    return {
      records: [],
      columns,
      dropped: 0,
      malformed: 'no columns: the file has no header and the definition names none',
    };
  const max = opts.maxRows ?? MAX_CSV_ROWS;
  const records: Array<Record<string, string>> = [];
  let dropped = 0;
  for (let r = start; r < rows.length; r++) {
    if (records.length >= max) {
      dropped++;
      continue;
    }
    const row = rows[r]!;
    const rec: Record<string, string> = {};
    row.forEach((cell, i) => {
      if (cell === '') return;
      rec[columns[i] ?? `_${i}`] = cell;
    });
    records.push(rec);
  }
  return { records, columns, dropped };
}
