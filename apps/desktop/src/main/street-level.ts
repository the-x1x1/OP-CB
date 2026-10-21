import type { GeoPosition } from '@worldview/world-model';
import type { RequestOf, StreetLevelAnswer, StreetLevelPicture } from '@worldview/ipc-contract';

/**
 * Street-level pictures near a point (`imagery.streetLevel`), asked from the main process on the
 * operator's request from What's here (operator decision 2026-10-20: what God's Eye View has,
 * without its keyed services).
 *
 * Panoramax (panoramax.fr, the federated open street-level imagery project) answers from its
 * STAC meta-catalogue with no key. Each picture carries its own licence — mostly CC BY-SA 4.0,
 * IGN's under Etalab 2.0 — and its producer, both shown with it; the picture is shown live from
 * its own instance and never kept, cached into a pack or exported (ShareAlike would then apply
 * to the copy). Mapillary needs a token and Google a key: neither is asked.
 *
 *  - Never while the map moves: only when the card is open and the operator asks.
 *  - At most one request a second, for the whole application; more than a couple waiting is
 *    refused as `busy` rather than piled up.
 *  - A User-Agent that names the application.
 *  - Answers are cached (an hour; a failure for two minutes); the same point in flight shares
 *    the one request.
 *  - Only this host, over https; the URL is built here. Thumbnails come from the instance that
 *    holds the picture: only the federated instances listed in PANORAMAX_PICTURE_HOSTS, over
 *    https, are offered to the window, so an answer cannot send it anywhere else.
 *
 * Offline (the OS says so), or with online lookups switched off in Settings → Search, nothing
 * is sent.
 */
export const PANORAMAX_HOST = 'api.panoramax.xyz';
export const PANORAMAX_ATTRIBUTION = 'Street-level pictures: Panoramax contributors, each under its own licence';

export const MIN_GAP_MS = 1_100;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;
const HIT_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 2 * 60_000;
const CACHE_MAX = 100;
const MAX_WAITING = 2;
const DEFAULT_RADIUS_M = 150;
const DEFAULT_LIMIT = 6;
/** Points this close (about 10 m) share a cached answer. */
const KEY_DECIMALS = 4;

export interface StreetLevelOptions {
  fetchImpl: typeof fetch;
  userAgent: string;
  isOnline: () => boolean;
  enabled: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  answer: StreetLevelAnswer;
  expires: number;
}

/** The Panoramax search URL for a point: `place_position` is lon,lat; `place_distance` metres. */
export function panoramaxUrl(position: GeoPosition, radiusM: number, limit: number): string {
  const u = new URL(`https://${PANORAMAX_HOST}/api/search`);
  u.searchParams.set('place_position', `${position.longitude.toFixed(6)},${position.latitude.toFixed(6)}`);
  u.searchParams.set('place_distance', `0-${Math.round(radiusM)}`);
  u.searchParams.set('limit', String(limit));
  return u.href;
}

/**
 * The hosts a picture may be shown from: the Panoramax instances the meta-catalogue federates,
 * read from `api.panoramax.xyz/api/instances` (25 on 2026-10-20) once a day and kept in memory
 * — not a fixed list, which goes stale as instances join, and not whatever an answer names,
 * which a hostile or mistaken answer could point anywhere. Until the list has been read, or
 * when it could not be, only the catalogue host itself is allowed. A picture on an instance not
 * listed is left out.
 */
export const INSTANCES_URL = `https://${PANORAMAX_HOST}/api/instances`;
const INSTANCES_TTL_MS = 24 * 3_600_000;
const INSTANCES_RETRY_MS = 10 * 60_000;
const MAX_INSTANCES = 200;

/** The hostnames in the federation answer (each instance's `url`), lower-case; none on an error. */
export function readInstanceHosts(body: unknown): string[] {
  const list = (body as { instances?: unknown } | null)?.instances ?? body;
  if (!Array.isArray(list)) return [];
  const hosts = new Set<string>();
  for (const i of list.slice(0, MAX_INSTANCES)) {
    const url = (i as { url?: unknown } | null)?.url;
    if (typeof url !== 'string') continue;
    try {
      const u = new URL(url);
      if (u.protocol === 'https:') hosts.add(u.hostname.toLowerCase());
    } catch {
      /* not a URL: not an instance */
    }
  }
  return [...hosts];
}

function pictureUrl(v: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (typeof v !== 'string' || v.length > 1024) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return undefined;
    const host = u.hostname.toLowerCase();
    return host === PANORAMAX_HOST || allowed.has(host) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function haversineM(a: GeoPosition, b: GeoPosition): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * The pictures in Panoramax's STAC answer, nearest first; anything not a picture with a place,
 * a licence and an https thumbnail is left out. Exported for the tests.
 */
export function readPanoramax(
  body: unknown,
  at: GeoPosition,
  limit: number,
  allowedHosts: ReadonlySet<string> = new Set(),
): StreetLevelPicture[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: StreetLevelPicture[] = [];
  for (const f of features.slice(0, 50)) {
    const feature = f as {
      id?: unknown;
      geometry?: { coordinates?: unknown };
      properties?: Record<string, unknown>;
      providers?: Array<{ name?: unknown; roles?: unknown }>;
      assets?: { thumb?: { href?: unknown } };
    } | null;
    if (!feature || typeof feature.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(feature.id)) continue;
    const c = feature.geometry?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    if (Math.abs(c[1]) > 90 || Math.abs(c[0]) > 180) continue;
    const thumbUrl = pictureUrl(feature.assets?.thumb?.href, allowedHosts);
    if (!thumbUrl) continue;
    const p = feature.properties ?? {};
    const license = typeof p['license'] === 'string' ? p['license'].slice(0, 40) : '';
    if (!license) continue;
    const position = { latitude: c[1], longitude: c[0] };
    const producer = (feature.providers ?? []).find(
      (x) => Array.isArray(x?.roles) && x.roles.includes('producer') && typeof x.name === 'string',
    );
    const author =
      (producer?.name as string | undefined) ??
      (typeof p['geovisio:producer'] === 'string' ? p['geovisio:producer'] : undefined);
    const azimuth = p['view:azimuth'];
    const taken = typeof p['datetime'] === 'string' ? Date.parse(p['datetime']) : NaN;
    const picture: StreetLevelPicture = {
      id: feature.id,
      position,
      distanceM: Math.round(haversineM(at, position)),
      thumbUrl,
      pageUrl: `https://${PANORAMAX_HOST}/#focus=pic&pic=${feature.id}`,
      license,
      service: 'panoramax',
    };
    if (typeof azimuth === 'number' && Number.isFinite(azimuth)) picture.headingDeg = ((azimuth % 360) + 360) % 360;
    if (Number.isFinite(taken)) picture.takenAt = new Date(taken).toISOString();
    if (author) picture.author = author.slice(0, 80);
    out.push(picture);
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, limit);
}

class Turnstile {
  private next = 0;
  private waiting = 0;
  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}
  async enter(): Promise<boolean> {
    if (this.waiting >= MAX_WAITING) return false;
    this.waiting++;
    try {
      const at = Math.max(this.now(), this.next);
      this.next = at + MIN_GAP_MS;
      const wait = at - this.now();
      if (wait > 0) await this.sleep(wait);
      return true;
    } finally {
      this.waiting--;
    }
  }
}

export class StreetLevel {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<StreetLevelAnswer>>();
  private readonly turn: Turnstile;
  private readonly now: () => number;
  private instances: { hosts: Set<string>; readAt: number; ok: boolean } = { hosts: new Set(), readAt: 0, ok: false };
  readonly stats = { asked: 0, fromCache: 0, sent: 0, refused: 0, failed: 0, instances: 0 };

  constructor(private readonly opts: StreetLevelOptions) {
    this.now = opts.now ?? Date.now;
    this.turn = new Turnstile(this.now, opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))));
  }

  async near(req: RequestOf<'imagery.streetLevel'>, signal?: AbortSignal): Promise<StreetLevelAnswer> {
    this.stats.asked++;
    if (!this.opts.enabled())
      return {
        status: 'disabled',
        pictures: [],
        attribution: '',
        message: 'Online lookups are off (Settings → Search).',
      };
    if (!this.opts.isOnline())
      return { status: 'offline', pictures: [], attribution: '', message: 'Offline — no street-level pictures.' };
    const radiusM = Math.min(2000, Math.max(10, req.radiusM ?? DEFAULT_RADIUS_M));
    const limit = Math.min(12, Math.max(1, req.limit ?? DEFAULT_LIMIT));
    const key = `${req.position.latitude.toFixed(KEY_DECIMALS)},${req.position.longitude.toFixed(KEY_DECIMALS)}|${radiusM}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      this.stats.fromCache++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.answer;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.ask(req.position, radiusM, limit, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    const answer = await work;
    if (answer.status !== 'busy') {
      this.cache.set(key, { answer, expires: this.now() + (answer.status === 'ok' ? HIT_TTL_MS : FAIL_TTL_MS) });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    }
    return answer;
  }

  /** The federation's hosts, read once a day (ten minutes after a failure); never waits on a second reader. */
  private async refreshInstances(): Promise<void> {
    const age = this.now() - this.instances.readAt;
    if (this.instances.readAt && age < (this.instances.ok ? INSTANCES_TTL_MS : INSTANCES_RETRY_MS)) return;
    this.instances.readAt = this.now();
    this.stats.instances++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.opts.fetchImpl(INSTANCES_URL, {
        headers: { accept: 'application/json', 'user-agent': this.opts.userAgent },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('too large');
      const hosts = readInstanceHosts(JSON.parse(text) as unknown);
      if (hosts.length) this.instances = { hosts: new Set(hosts), readAt: this.now(), ok: true };
      else this.instances.ok = false;
    } catch {
      this.instances.ok = false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(
    position: GeoPosition,
    radiusM: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<StreetLevelAnswer> {
    if (!(await this.turn.enter())) {
      this.stats.refused++;
      return { status: 'busy', pictures: [], attribution: '', message: 'Asked too often; try again in a moment.' };
    }
    this.stats.sent++;
    await this.refreshInstances();
    // The request is shared by every caller asking the same point (`inflight`), so one
    // caller's signal must not end it for the others: only the timeout aborts it.
    void signal;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.opts.fetchImpl(panoramaxUrl(position, radiusM, limit), {
        headers: { accept: 'application/geo+json, application/json', 'user-agent': this.opts.userAgent },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new Error('answer larger than expected');
      const pictures = readPanoramax(JSON.parse(text) as unknown, position, limit, this.instances.hosts);
      return { status: 'ok', pictures, attribution: PANORAMAX_ATTRIBUTION };
    } catch (err) {
      this.stats.failed++;
      const why = err instanceof Error ? err.message : String(err);
      return {
        status: 'unavailable',
        pictures: [],
        attribution: '',
        message: `Panoramax did not answer (${why.slice(0, 80)}).`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
