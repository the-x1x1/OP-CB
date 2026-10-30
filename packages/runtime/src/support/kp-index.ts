/**
 * The planetary K index for the Sky tab (operator decision 2026-10-20; ADR-003 amendment): one
 * number for the whole Earth — how disturbed the geomagnetic field is, 0 to 9, every three hours
 * — from NOAA SWPC, U.S. public domain. It has no place, and every object the world model holds
 * has one, so it is not a provider's observation: the runtime asks for it itself, and only while
 * the Sky tab asks (`sky.overhead`), at most once in KP_REFRESH_MS, never while offline.
 *
 * A reading too old to be the field now is not shown as now: `ageMs` goes with it.
 */
export const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
export const KP_REFRESH_MS = 15 * 60_000;
/** After a failed request, asked again no sooner than this. */
export const KP_RETRY_MS = 5 * 60_000;
/** Older than this, the reading is not offered at all (the product is updated every three hours). */
export const KP_STALE_MS = 9 * 60 * 60_000;
const KP_MAX_BYTES = 256 * 1024;
export const KP_ATTRIBUTION = 'Planetary K index: NOAA Space Weather Prediction Center';

export interface KpReading {
  /** 0–9, to a third. */
  kp: number;
  /** The start of the three hours it is for (UTC). */
  at: string;
  /** NOAA's geomagnetic storm scale for it: G1 at Kp 5 … G5 at 9; absent below 5. */
  storm?: 'G1' | 'G2' | 'G3' | 'G4' | 'G5';
  attribution: string;
}

/** The newest reading in SWPC's answer, or why there is none. */
export function readKp(body: unknown): KpReading | string {
  if (!Array.isArray(body) || body.length === 0) return 'not a list of readings';
  for (let i = body.length - 1; i >= 0; i--) {
    const row = body[i] as Record<string, unknown> | unknown[] | null;
    let time: unknown;
    let value: unknown;
    if (Array.isArray(row)) {
      // The older shape: [["time_tag","Kp",…], ["2026-10-20 21:00:00.000","3.00",…], …].
      [time, value] = row;
    } else if (row && typeof row === 'object') {
      time = row['time_tag'];
      value = row['Kp'] ?? row['kp_index'];
    }
    const kp = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (typeof time !== 'string' || !Number.isFinite(kp) || kp < 0 || kp > 9) continue;
    const iso = time.includes('T') ? time : time.replace(' ', 'T');
    const ms = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (!Number.isFinite(ms)) continue;
    const reading: KpReading = {
      kp: Math.round(kp * 100) / 100,
      at: new Date(ms).toISOString(),
      attribution: KP_ATTRIBUTION,
    };
    const storm = stormLevel(kp);
    if (storm) reading.storm = storm;
    return reading;
  }
  return 'no reading in the answer';
}

function stormLevel(kp: number): KpReading['storm'] {
  if (kp >= 9) return 'G5';
  if (kp >= 8) return 'G4';
  if (kp >= 7) return 'G3';
  if (kp >= 6) return 'G2';
  if (kp >= 5) return 'G1';
  return undefined;
}

export interface KpIndexOptions {
  fetchImpl: typeof fetch;
  now: () => number;
  isOnline: () => boolean;
  userAgent?: string;
  onProblem?: (message: string) => void;
}

/** One reading kept and asked for again when it is old; one request in flight at most. */
export class KpIndex {
  private reading: KpReading | undefined;
  /** When it was last asked, and whether that answer was read; undefined before the first ask. */
  private askedAt: number | undefined;
  private lastOk = false;
  private inflight: Promise<void> | undefined;

  constructor(private readonly opts: KpIndexOptions) {}

  /**
   * The reading to show now, refreshing it in the background when due. The Sky tab asks every
   * few seconds; this answers from what it holds and never makes it wait.
   */
  current(): (KpReading & { ageMs: number }) | undefined {
    const now = this.opts.now();
    const due = this.askedAt === undefined || now - this.askedAt >= (this.lastOk ? KP_REFRESH_MS : KP_RETRY_MS);
    if (due && !this.inflight && this.opts.isOnline())
      this.inflight = this.refresh(now).finally(() => (this.inflight = undefined));
    if (!this.reading) return undefined;
    const ageMs = now - Date.parse(this.reading.at);
    return ageMs > KP_STALE_MS ? undefined : { ...this.reading, ageMs };
  }

  /** For tests and the first ask: wait for a request already under way. */
  async settled(): Promise<void> {
    await this.inflight;
  }

  private async refresh(now: number): Promise<void> {
    this.askedAt = now;
    try {
      const res = await this.opts.fetchImpl(KP_URL, {
        headers: { accept: 'application/json', ...(this.opts.userAgent ? { 'user-agent': this.opts.userAgent } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > KP_MAX_BYTES) throw new Error('the answer is larger than expected');
      const read = readKp(JSON.parse(text) as unknown);
      if (typeof read === 'string') throw new Error(read);
      this.reading = read;
      this.lastOk = true;
    } catch (err) {
      this.lastOk = false;
      this.opts.onProblem?.(err instanceof Error ? err.message : String(err));
    }
  }
}
