/**
 * Two small readers of text that came from somewhere else, each one pass over it.
 *
 * The patterns they replace look harmless and are not: `/<[^>]*>/g` starts again from every
 * `<` when no `>` follows, and `/^(.*?)(\d+)$/` from every digit when the text does not end in
 * one. On 200,000 characters of `<` the first took sixteen seconds; on a megabyte, minutes —
 * for an attribution line or a tile-matrix name a server sent.
 */

/** `text` with every `<…>` taken out (replaced by `replacement`). A `<` with no `>` after it stays as it is. */
export function stripTags(text: string, replacement = ''): string {
  let out = '';
  let from = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    const gt = lt < 0 ? -1 : text.indexOf('>', lt + 1);
    if (gt < 0) break;
    out += text.slice(from, lt) + replacement;
    from = gt + 1;
  }
  return out + text.slice(from);
}

/** A text that ends in digits, as what comes before them and the digits; undefined when it does not end in one. */
export function splitTrailingDigits(text: string): { prefix: string; digits: string } | undefined {
  let i = text.length;
  while (i > 0) {
    const c = text.charCodeAt(i - 1);
    if (c < 0x30 || c > 0x39) break;
    i--;
  }
  return i === text.length ? undefined : { prefix: text.slice(0, i), digits: text.slice(i) };
}
