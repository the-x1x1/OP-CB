/**
 * Time primitives. All internal timestamps are UTC ISO 8601 strings
 * (e.g. 2026-09-21T09:27:01.715Z). Milliseconds since epoch are used only for
 * arithmetic and never persisted.
 */
export type IsoTimestamp = string;

export interface TimeRange {
  start: IsoTimestamp;
  end: IsoTimestamp;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === 'string' && ISO_RE.test(value) && Number.isFinite(Date.parse(value));
}

export function toIso(msOrDate: number | Date): IsoTimestamp {
  const d = typeof msOrDate === 'number' ? new Date(msOrDate) : msOrDate;
  return d.toISOString();
}

export function isoToMs(iso: IsoTimestamp): number {
  return Date.parse(iso);
}

/** Epoch value in seconds or milliseconds → ISO. Rejects non-finite, ≤0 and absurd values. */
export function epochToIso(value: unknown, scale: 'ms' | 's' = 'ms'): IsoTimestamp | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = scale === 's' ? value * 1000 : value;
  if (ms > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

export function ageMs(observedAt: IsoTimestamp, now: number): number {
  return now - Date.parse(observedAt);
}

/**
 * How long ago `then` was, for a wait or a keep-for measured on the wall clock. A `then` ahead
 * of `now` was written by a clock that has since been put back (it ran fast and was corrected
 * by a time sync, or by a second system that keeps the hardware clock differently): taken as
 * it stands, the wait would last as long as the clock had been fast, and a source held off
 * for thirty seconds would be held off for hours. Such a time counts as long ago.
 */
export function elapsedMs(now: number, then: number): number {
  return then > now ? Number.POSITIVE_INFINITY : now - then;
}

export function timeRangeContains(range: TimeRange, at: IsoTimestamp): boolean {
  const t = Date.parse(at);
  return t >= Date.parse(range.start) && t <= Date.parse(range.end);
}

export function isValidTimeRange(range: TimeRange): boolean {
  return isIsoTimestamp(range.start) && isIsoTimestamp(range.end) && Date.parse(range.start) <= Date.parse(range.end);
}

/** Clock abstraction so engines are testable with virtual time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
