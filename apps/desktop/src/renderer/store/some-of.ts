/**
 * The first `n` of `items` joined by `sep`, and how many were left out: "a; b; c; and 4 more".
 * For notices that cannot hold every issue a long import or install reports — until 2026-11-11
 * they showed the first few and said nothing of the rest.
 */
export function someOf(items: readonly string[], n: number, sep = '; '): string {
  if (items.length <= n) return items.join(sep);
  const rest = items.length - n;
  return `${items.slice(0, n).join(sep)}${sep}and ${rest} more`;
}
