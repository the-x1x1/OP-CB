import { isIpcError, PRIVATE_PASSPHRASE_MIN } from '@opcb/ipc-contract';

/**
 * Words for the private folder card (private-folder-card.tsx), kept apart from the card so
 * they can be tested without React.
 */

/** A failed request, in a sentence; never echoes what was typed. */
export function requestErrorText(err: unknown): string {
  const message = isIpcError(err) ? err.message : err instanceof Error ? err.message : '';
  const text = message.trim() || 'that did not work';
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * A word on a passphrase being chosen: too short, or short and of one kind of character.
 * Advice only — anything of the minimum length is accepted.
 */
export function passphraseHint(p: string): string | undefined {
  const n = [...p].length;
  if (!n) return undefined;
  if (n < PRIVATE_PASSPHRASE_MIN) return `At least ${PRIVATE_PASSPHRASE_MIN} characters.`;
  if (n < 16 && !/\s/.test(p))
    return 'Longer is stronger: four or five ordinary words with spaces are easy to remember and hard to guess.';
  return undefined;
}
