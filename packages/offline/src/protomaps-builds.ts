import type { MapBuildInfo } from '@worldview/ipc-contract';
import type { RangeSource } from './pmtiles-extract.js';

/**
 * Protomaps' daily planet builds: the list of them and a build read by byte ranges. The list's
 * shape was read live on 2026-10-30 (`builds.json`: `{ key: "20261029.pmtiles", size,
 * uploaded, version, md5sum (base64), b3sum }`). Shared by the app's map download
 * (runtime support/map-download.ts) and `pnpm basemap:extract`. Licence: the register's
 * `protomaps-builds` record (ODbL, © OpenStreetMap contributors).
 */

export const PROTOMAPS_BUILDS_LIST = 'https://build-metadata.protomaps.dev/builds.json';
export const PROTOMAPS_BUILD_BASE = 'https://build.protomaps.com/';
const RANGE_TIMEOUT_MS = 60_000;
const RETRIES = 4;

export function readBuildList(body: unknown): MapBuildInfo[] {
  if (!Array.isArray(body)) throw new Error('the build list is not a list');
  const out: MapBuildInfo[] = [];
  for (const b of body) {
    if (typeof b !== 'object' || b === null) continue;
    const r = b as Record<string, unknown>;
    if (typeof r['key'] !== 'string' || !/^\d{8}\.pmtiles$/.test(r['key'])) continue;
    if (typeof r['size'] !== 'number' || !Number.isSafeInteger(r['size']) || r['size'] <= 0) continue;
    const md5 = typeof r['md5sum'] === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(r['md5sum']) ? r['md5sum'] : undefined;
    out.push({
      key: r['key'],
      date: `${r['key'].slice(0, 4)}-${r['key'].slice(4, 6)}-${r['key'].slice(6, 8)}`,
      sizeBytes: r['size'],
      version: typeof r['version'] === 'string' ? r['version'].slice(0, 20) : '',
      ...(md5 ? { md5 } : {}),
    });
  }
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

/** A remote archive read by `Range` requests: only a 206 with exactly the bytes asked is taken. */
export function httpRangeSource(fetchImpl: typeof fetch, url: string, onBytes?: (n: number) => void): RangeSource {
  return {
    async read(offset, length, signal) {
      let lastError: unknown;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        signal?.throwIfAborted();
        try {
          const timeout = AbortSignal.timeout(RANGE_TIMEOUT_MS);
          const res = await fetchImpl(url, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            redirect: 'follow',
          });
          if (res.status !== 206) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`the map server answered ${res.status} to a byte range`);
          }
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
          if (!range || Number(range[1]) !== offset) throw new Error('the map server sent another range');
          const bytes = new Uint8Array(await res.arrayBuffer());
          // Short only at the end of the file (the first 16 KiB of a small archive).
          const atEnd = Number(range[2]) + 1 === Number(range[3]);
          if (bytes.length !== length && !(atEnd && bytes.length === Number(range[2]) - offset + 1))
            throw new Error(`asked for ${length} bytes, got ${bytes.length}`);
          onBytes?.(bytes.length);
          return bytes;
        } catch (err) {
          if (signal?.aborted) throw err;
          if ((err as { name?: string })?.name === 'WorkingOfflineError') throw err;
          lastError = err;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}
