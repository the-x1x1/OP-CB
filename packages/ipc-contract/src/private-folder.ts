/**
 * The private folder (2026-11-22): the operator's own documents, encrypted inside OP-CB's data
 * folder (packages/offline/src/private-store.ts). The passphrase crosses IPC only in
 * `private.setup`, `private.unlock` and `private.changePassphrase`, and is never answered back,
 * stored or logged.
 */

export interface PrivateEntry {
  id: string;
  /** The file's name as added (last path part only). */
  name: string;
  sizeBytes: number;
  addedAt: string;
}

export interface PrivateStatus {
  /** A passphrase has been chosen. */
  set: boolean;
  open: boolean;
  /** Only while open. */
  entries?: PrivateEntry[];
  /** Seconds before another passphrase is tried (after five wrong in a row). */
  waitSeconds?: number;
}

export interface PrivateAddAnswer {
  status: PrivateStatus;
  added?: PrivateEntry;
  cancelled?: true;
}

export interface PrivateExportAnswer {
  path?: string;
  cancelled?: true;
}

export const PRIVATE_PASSPHRASE_MIN = 8;
export const PRIVATE_PASSPHRASE_MAX = 1024;

/** `{ passphrase }` for setup and unlock, or undefined. Only the length is checked here. */
export function readPassphraseRequest(v: unknown): { passphrase: string } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== 1 || typeof r['passphrase'] !== 'string') return undefined;
  const p = r['passphrase'];
  return p.length >= 1 && p.length <= PRIVATE_PASSPHRASE_MAX ? { passphrase: p } : undefined;
}

/** `{ current, next }` for a change of passphrase, or undefined. */
export function readPassphraseChange(v: unknown): { current: string; next: string } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'current' && k !== 'next')) return undefined;
  if (!Object.hasOwn(r, 'current') || !Object.hasOwn(r, 'next')) return undefined;
  const ok = (x: unknown) => typeof x === 'string' && x.length >= 1 && x.length <= PRIVATE_PASSPHRASE_MAX;
  return ok(r['current']) && ok(r['next']) ? { current: r['current'] as string, next: r['next'] as string } : undefined;
}

/** `{ id }` naming a private file, or undefined. */
export function readPrivateId(v: unknown): { id: string } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length === 1 && typeof r['id'] === 'string' && /^[0-9a-f]{32}$/.test(r['id'])
    ? { id: r['id'] }
    : undefined;
}

// ---- sharing the library on the local network (`library.share.*`) ----------------------------

export interface LibraryShareStatus {
  sharing: boolean;
  /** Addresses to open on a phone or tablet on the same network, the code included. */
  urls?: string[];
  code?: string;
  port?: number;
  /** When the share ends by itself (ISO). */
  until?: string;
  /** Answers given since the share began. */
  served?: number;
}

export const SHARE_MINUTES_CHOICES = Object.freeze([30, 120, 480, 720]);

/** `{ minutes }` for `library.share.start`: one of the choices offered. */
export function readShareStartRequest(v: unknown): { minutes: number } | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== 1 || !Object.hasOwn(r, 'minutes')) return undefined;
  const m = r['minutes'];
  return typeof m === 'number' && SHARE_MINUTES_CHOICES.includes(m) ? { minutes: m } : undefined;
}
