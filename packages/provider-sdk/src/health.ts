import type { IsoTimestamp } from '@opcb/world-model';

/**
 * `NEEDS_SETUP`: the source cannot run until the operator gives it something only they can —
 * an address, a folder (ADR-003 amendment 2026-09-24). Not a fault: it is left out of the
 * connection summary, not retried, and asked again when its settings change.
 */
export type ProviderStatus =
  | 'DISABLED'
  | 'STARTING'
  | 'LIVE'
  | 'DEGRADED'
  | 'STALE'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'NEEDS_SETUP'
  | 'OFFLINE'
  | 'ERROR';

export type CredentialState = 'not-required' | 'missing' | 'present' | 'invalid';

export interface RateLimitState {
  limited: boolean;
  /** When the client-side or server-declared limit resets (UTC ISO). */
  resetAt?: IsoTimestamp;
  /** Remaining requests if the upstream reports it. */
  remaining?: number;
}

export interface ProviderHealth {
  providerId: string;
  status: ProviderStatus;
  lastAttempt?: IsoTimestamp;
  lastSuccess?: IsoTimestamp;
  lastObservation?: IsoTimestamp;
  /** Last successful request latency in ms. */
  latencyMs?: number;
  /** Rolling error rate 0..1 over the recent window. */
  errorRate: number;
  /** Age of the data currently being served, in ms (0 when fresh live data). */
  cacheAgeMs?: number;
  rateLimitState: RateLimitState;
  credentialState: CredentialState;
  /** Human-readable, never contains secrets. */
  message?: string;
  /** Structured last error (sanitized). */
  lastError?: ProviderErrorInfo;
  /** Objects currently sourced from this provider. */
  objectCount?: number;
  /**
   * (additive, 2026-10-08, docs/cyberdeck M5) This computer's own position, for a source that
   * reads a GPS on this computer (a Meshtastic node plugged in by USB): what the field status
   * strip shows without parsing `message`. Ages are worked out by the reader from `fixAt`.
   */
  ownPosition?: OwnPositionHealth;
}

export interface OwnPositionHealth {
  /** As at the health report; `fix` turns STALE by its age, which the reader computes. */
  state: 'fix' | 'stale' | 'unknown-age' | 'no-fix' | 'manual' | 'not-gnss';
  fixAt?: IsoTimestamp;
  satellites?: number;
  fixType?: '2D' | '3D';
  accuracyM?: number;
  /** The node it comes from, by name or id. */
  node?: string;
}

export type ProviderErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'DNS'
  | 'HTTP_4XX'
  | 'HTTP_5XX'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'MALFORMED'
  | 'TOO_LARGE'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'OFFLINE'
  | 'HOST_NOT_ALLOWED'
  | 'INTERNAL';

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  message: string;
  httpStatus?: number;
  retryAfterMs?: number;
  /** The source waits for the operator's setting (an address, a folder); see `NEEDS_SETUP`. */
  setupRequired?: true;
  at: IsoTimestamp;
}

/** Structured provider error. Providers throw these; the runtime maps them to health states. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;
  /** The operator has to set something first (an address, a folder): status `NEEDS_SETUP`. */
  readonly setupRequired: boolean;

  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { httpStatus?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown; setup?: boolean } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryAfterMs = opts.retryAfterMs;
    this.setupRequired = opts.setup === true;
    this.retryable = this.setupRequired ? false : (opts.retryable ?? defaultRetryable(code));
  }

  toInfo(at: IsoTimestamp): ProviderErrorInfo {
    const info: ProviderErrorInfo = { code: this.code, message: sanitizeMessage(this.message), at };
    if (this.httpStatus !== undefined) info.httpStatus = this.httpStatus;
    if (this.retryAfterMs !== undefined) info.retryAfterMs = this.retryAfterMs;
    if (this.setupRequired) info.setupRequired = true;
    return info;
  }
}

function defaultRetryable(code: ProviderErrorCode): boolean {
  switch (code) {
    case 'NETWORK':
    case 'TIMEOUT':
    case 'DNS':
    case 'HTTP_5XX':
    case 'RATE_LIMITED':
    case 'OFFLINE':
      return true;
    default:
      return false;
  }
}

// The same patterns as @opcb/core's redactText (this package does not depend on it; a test in
// the runtime holds the two to the same answers).
const SECRET_NAME = String.raw`(?:x-api-key|api[_-]?key|map[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|x-amz-(?:signature|credential|security-token)|password|passwd|secret|token|signature)`;
const SECRET_PATTERNS = [
  // ?key=… and &token=… in a URL: the short names too, which mean something else in prose.
  /([?&](?:key|api_key|apikey|token|access_token|map_key|mapkey|password|pwd|pass|secret|sig|session)=)[^&\s"']+/gi,
  // name=value, name: value and "name":"value" anywhere, for names that end in a word that is
  // only ever a secret (password, db_password, MQTT_PASSWORD, client_secret).
  new RegExp(
    String.raw`((?:^|[^a-z0-9_.-])["']?[a-z0-9_.-]*${SECRET_NAME}["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"'&,;})\]]+)`,
    'gi',
  ),
  // Authorization: Basic …, Bearer …, or a bare value.
  /(authorization["']?\s*[:=]\s*["']?(?:(?:basic|bearer|digest|token)\s+)?)[^\s"',;]+/gi,
  /(bearer\s+)[a-z0-9._~+/=-]+/gi,
  // Cookie and Set-Cookie, to the end of the line.
  /((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi,
  // user:password@ in a URL of any scheme (http, rtsp, mqtt, ws, ftp…).
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+:[^\s/@"'<>]*@/gi,
];

/** Remove anything that looks like a credential from an error message. */
export function sanitizeMessage(message: string): string {
  let out = message;
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, (whole: string, prefix: string) =>
      whole.slice(prefix.length).startsWith('<redacted>') ? whole : `${prefix}<redacted>`,
    );
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'AbortError')
    return new ProviderError('CANCELLED', 'cancelled', { cause: err });
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'TimeoutError')
    return new ProviderError('TIMEOUT', 'timed out', { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message))
    return new ProviderError('DNS', sanitizeMessage(message), { cause: err });
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|fetch failed|network/i.test(message))
    return new ProviderError('NETWORK', sanitizeMessage(message), { cause: err });
  return new ProviderError('INTERNAL', sanitizeMessage(message), { cause: err });
}
