/**
 * Sizes for the starter collection card (library-collection-panel.tsx), kept apart from the
 * panel so they can be tested without React.
 *
 * A drive's size as sold is in decimal gigabytes (a "256 GB" drive holds about 256 × 10⁹
 * bytes before formatting, and less after it), so the choices are decimal, and a share is kept
 * back for the file system and for OP-CB's own data and maps.
 */

export type BudgetChoice = 'free' | '32' | '64' | '128' | '256' | '512' | '1000' | '2000';

export const BUDGET_CHOICES: readonly { id: BudgetChoice; label: string }[] = Object.freeze([
  { id: 'free', label: 'The free space on this drive' },
  { id: '32', label: 'A 32 GB drive' },
  { id: '64', label: 'A 64 GB drive' },
  { id: '128', label: 'A 128 GB drive' },
  { id: '256', label: 'A 256 GB drive' },
  { id: '512', label: 'A 512 GB drive' },
  { id: '1000', label: 'A 1 TB drive' },
  { id: '2000', label: 'A 2 TB drive' },
]);

/** Kept back on a drive of a given size: formatting and OP-CB's own data. */
const SIZED_SHARE = 0.1;
/** Kept free on the drive the library is on (as the downloads themselves keep 1 GiB spare). */
export const FREE_MARGIN_BYTES = 2_000_000_000;

/** The bytes the collection may take for a choice; undefined when the free space is not known. */
export function budgetBytes(choice: BudgetChoice, freeBytes: number | undefined): number | undefined {
  if (choice === 'free') {
    if (freeBytes === undefined || !Number.isFinite(freeBytes)) return undefined;
    return Math.max(0, Math.floor(freeBytes - FREE_MARGIN_BYTES));
  }
  const gb = Number(choice);
  return Math.floor(gb * 1e9 * (1 - SIZED_SHARE));
}

/** "12.4 GB of 230 GB" for a plan's use of its budget. */
export function shareText(bytes: number, budget: number, text: (n: number) => string): string {
  if (budget <= 0) return 'no room';
  const pct = Math.min(100, Math.round((bytes / budget) * 100));
  return `${text(bytes)} of ${text(budget)} (${pct}%)`;
}

/** What a plan comes to, in a sentence, and whether its "too big" list is worth showing. */
export function planSummary(
  plan: { picks: unknown[]; have: string[]; tooBig: unknown[]; missing: unknown[]; bytes: number; budgetBytes: number },
  choice: BudgetChoice,
  text: (n: number) => string,
): { line: string; listTooBig: boolean } {
  if (plan.budgetBytes <= 0)
    return {
      line:
        choice === 'free'
          ? `No room: this drive has less than ${text(FREE_MARGIN_BYTES)} free, which OP-CB keeps spare. Choose a drive size, or free some space.`
          : 'No room.',
      listTooBig: false,
    };
  if (plan.picks.length)
    return { line: `${plan.picks.length} books, ${shareText(plan.bytes, plan.budgetBytes, text)}.`, listTooBig: true };
  if (plan.tooBig.length) return { line: 'Nothing left to fetch fits in this room.', listTooBig: true };
  if (plan.have.length && !plan.missing.length)
    return { line: 'Everything chosen is already in the library.', listTooBig: false };
  if (plan.missing.length) return { line: 'Nothing chosen is in the catalogue now.', listTooBig: false };
  return { line: 'Nothing to fetch.', listTooBig: false };
}

/** "30 minutes", "2 hours", "12 hours". */
export function shareMinutesText(m: number): string {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

/** "Until 21:30" in this computer's time (a bad or missing time: "Until it is stopped"). */
export function shareUntilText(iso: string | undefined, locale?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'Until it is stopped';
  return `Until ${new Date(t).toLocaleTimeString(locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
