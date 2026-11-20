import os from 'node:os';
import type { JsonValue } from '@opcb/world-model';
import { redactFields, redactText } from '@opcb/core';

/**
 * Bundle redaction = core secret redaction (keys/tokens/URL credentials) plus
 * user-path redaction: the home directory and any other per-user root becomes `~`
 * so a shared bundle never reveals the account name.
 */
export interface PathRedactionOptions {
  /** Home directory of the current user (os.homedir() by default). */
  homeDir?: string;
  /** Additional roots to collapse (e.g. a custom --data-dir). */
  extraRoots?: string[];
}

/**
 * A Windows account folder's name: anything up to the next separator, quote or line end, spaces
 * included ("Jane Doe"), at most 48 characters. A path that stops at the folder itself can
 * take a few following words with it; that is the safe side to err on.
 */
const WINDOWS_NAME = String.raw`[^\\/"'<>|:*?\r\n\t]{1,48}`;
/** One separator as written in text, or doubled as it is inside a JSON string within a string. */
const SEP = String.raw`(?:\\\\|\\|/)`;

const GENERIC_USER_ROOTS = [
  // C:\Users\name, c:\users\name, C:/Users/name, C:\\Users\\name
  new RegExp(String.raw`[A-Za-z]:${SEP}Users${SEP}${WINDOWS_NAME}`, 'gi'),
  // C:\Documents and Settings\name (profiles carried over from before Windows Vista)
  new RegExp(String.raw`[A-Za-z]:${SEP}Documents and Settings${SEP}${WINDOWS_NAME}`, 'gi'),
  /\/Users\/[^/\s"']+/g, // macOS
  /\/home\/[^/\s"']+/g, // Linux
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactPathsInText(text: string, opts: PathRedactionOptions = {}): string {
  let out = text;
  const roots = [opts.homeDir ?? os.homedir(), ...(opts.extraRoots ?? [])].filter((r) => r && r.length > 1);
  for (const root of roots) {
    // As written, with either slash, and with backslashes doubled (the path inside JSON text
    // inside a log message). A Windows path is the same path in any letter case.
    const windows = /^[A-Za-z]:[\\/]|\\/.test(root);
    const forward = root.replace(/\\/g, '/');
    const back = root.replace(/\//g, '\\');
    const variants = new Set([root, forward, back, back.replace(/\\/g, '\\\\')]);
    for (const v of [...variants].sort((x, y) => y.length - x.length))
      out = out.replace(new RegExp(escapeRegExp(v), windows ? 'gi' : 'g'), '~');
  }
  for (const re of GENERIC_USER_ROOTS) out = out.replace(re, '~');
  return out;
}

export function redactValueDeep(value: JsonValue, opts: PathRedactionOptions = {}): JsonValue {
  if (typeof value === 'string') return redactPathsInText(redactText(value), opts);
  if (Array.isArray(value)) return value.map((v) => redactValueDeep(v, opts));
  if (value && typeof value === 'object') {
    const redactedKeys = redactFields(value);
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(redactedKeys)) {
      // A key can be a path too (a table of files by where they are).
      let key = redactPathsInText(k, opts);
      while (key !== k && Object.hasOwn(out, key)) key = `${key} `;
      // defineProperty, so a key of `__proto__` is an entry and not the object's prototype.
      Object.defineProperty(out, key, {
        value: redactValueDeep(v, opts),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Redacts any JSON-serialisable structure (objects with undefined fields are dropped by JSON semantics). */
export function redactStructure<T>(value: T, opts: PathRedactionOptions = {}): T {
  const json = JSON.stringify(value);
  // undefined, a function or a symbol has no JSON at all.
  if (json === undefined) return undefined as T;
  return redactValueDeep(JSON.parse(json) as JsonValue, opts) as unknown as T;
}
