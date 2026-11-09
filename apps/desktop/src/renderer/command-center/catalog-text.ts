/**
 * Words for the Kiwix catalogue's results (library-panel.tsx), kept apart from the panel so they
 * can be tested without React.
 *
 * The live catalogue (read 2026-11-08) lists one book in up to three editions with the same
 * title — "Wikipedia" as `maxi` (127 GB), `nopic` (53 GB) and `mini` (14 GB) — told apart only by
 * `<flavour>`. The codes are openZIM's; the panel says what each one means.
 */
const FLAVOURS: Readonly<Record<string, string>> = Object.freeze({
  maxi: 'full, with pictures',
  nopic: 'full text, no pictures',
  mini: 'introductions only',
});

/** What an edition holds, in words; an unknown code is shown as it is; none, nothing. */
export function flavourText(flavour: string | undefined): string | undefined {
  const f = flavour?.trim().toLowerCase();
  if (!f) return undefined;
  return FLAVOURS[f] ?? f;
}

/**
 * How many of the matches are listed, when the catalogue holds more than one page of them
 * (it answers at most `count` entries; 65 matched "wikipedia" in English and 50 came back).
 */
export function catalogCountText(shown: number, total: number | undefined): string | undefined {
  if (total === undefined || total <= shown) return undefined;
  return `${shown} of ${total.toLocaleString('en-US')} matches shown — a narrower search finds the rest.`;
}
