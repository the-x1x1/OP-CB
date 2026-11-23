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
export const FREE_MARGIN_BYTES = 2 * 1024 ** 3;

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
export function useText(bytes: number, budget: number, text: (n: number) => string): string {
  if (budget <= 0) return 'no room';
  const pct = Math.min(100, Math.round((bytes / budget) * 100));
  return `${text(bytes)} of ${text(budget)} (${pct}%)`;
}
