import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_MINIMUM_APP_VERSION,
  PROTOMAPS_BUILD_BASE,
  PROTOMAPS_BUILDS_LIST,
  httpRangeSource,
  readBuildList,
  WORLDPACK_MANIFEST_PATH,
  WORLDPACK_NOTICES_PATH,
  parseWorldPackManifest,
  planExtract,
  renderNotices,
  selectionProblem,
  verifyArchive,
  writeExtract,
  type ExtractPlan,
  type ExtractSelection,
  type RangeSource,
  type VaultInstallTarget,
  type WorldPackManifest,
  type WorldPackRegistry,
  type WorldPackSourcePolicy,
} from '@worldview/offline';
import type { Logger } from '@worldview/core';
import type { MapBuildInfo, MapDownloadRequest, MapDownloadStatus } from '@worldview/ipc-contract';

/**
 * Offline maps downloaded from inside the app (2026-10-30): the whole world down to a chosen
 * zoom, optionally with more detail in an area, cut from Protomaps' daily planet build by byte
 * ranges and written straight into a world pack — or the whole planet file itself. The licence
 * is the register's `protomaps-builds` record (ODbL, © OpenStreetMap contributors).
 *
 * The build list was read live on 2026-10-30 (`builds.json`: `{ key: "20261029.pmtiles", size,
 * uploaded, version, md5sum (base64), b3sum }`, 61 entries). Only through the gated fetch: in
 * Offline mode nothing is asked and the download says to switch to Online.
 */

export const MAP_PROVIDER_ID = 'protomaps-builds';

/** The source policy every downloaded map carries: the register's record, word for word. */
export const PROTOMAPS_POLICY: WorldPackSourcePolicy = Object.freeze({
  providerId: MAP_PROVIDER_ID,
  license: 'ODbL 1.0 (© OpenStreetMap contributors); Natural Earth layers public domain',
  attribution: 'Protomaps · © OpenStreetMap contributors (ODbL)',
  offlinePackAllowed: true,
  redistributionAllowed: true,
  termsUrl: 'https://docs.protomaps.com/basemaps/downloads',
});

/** Kept free on the drive beyond the map itself. */
export const SPACE_MARGIN_BYTES = 1024 ** 3;
export interface MapDownloadsDeps {
  fetchImpl: typeof fetch;
  registry: () => WorldPackRegistry;
  /** Where to write: a vault's install target, or undefined for the app's own folder. */
  vaultTarget: (vaultId: string) => (VaultInstallTarget & { label: string; path: string }) | undefined;
  appPacksDir: string;
  now: () => number;
  log: Logger;
  onChange: (status: MapDownloadStatus) => void;
  /** Free bytes on the drive holding `dir`. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

async function statfsFree(dir: string): Promise<number | undefined> {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'area'
  );
}

/** The pack id and name a request becomes: one world map per detail level, one per named area. */
export function packIdentity(req: MapDownloadRequest): { id: string; name: string } {
  if (req.kind === 'planet') return { id: 'map-planet', name: 'World map — full detail (whole planet)' };
  if (!req.bounds)
    return { id: `map-world-z${req.worldMaxZoom}`, name: `World map — detail to zoom ${req.worldMaxZoom}` };
  const area = req.name?.trim() || 'Area';
  return {
    id: `map-${slug(area)}-z${req.maxZoom}`,
    name: `${area.slice(0, 60)} — detail to zoom ${req.maxZoom} (world to ${req.worldMaxZoom})`,
  };
}

/**
 * One map download at a time: plan (read the build's directories, so the size is exact), then
 * download into the pack's own folder, verify, and make it live. Cancellable at every stage;
 * nothing half-written is ever made live.
 */
export class MapDownloads {
  private status: MapDownloadStatus = { phase: 'idle' };
  private abort: AbortController | undefined;
  private plan: { req: MapDownloadRequest; build: MapBuildInfo; extract?: ExtractPlan } | undefined;

  constructor(private readonly deps: MapDownloadsDeps) {}

  current(): MapDownloadStatus {
    return structuredClone(this.status);
  }

  private set(next: MapDownloadStatus): void {
    this.status = next;
    this.deps.onChange(this.current());
  }

  private busy(): boolean {
    return ['planning', 'downloading', 'verifying', 'installing'].includes(this.status.phase);
  }

  cancel(): MapDownloadStatus {
    if (this.busy()) this.abort?.abort();
    else if (this.status.phase !== 'idle') {
      this.plan = undefined;
      this.set({ phase: 'idle' });
    }
    return this.current();
  }

  private async latestBuild(signal: AbortSignal): Promise<MapBuildInfo> {
    const res = await this.deps.fetchImpl(PROTOMAPS_BUILDS_LIST, { signal });
    if (!res.ok) throw new Error(`the build list answered ${res.status}`);
    const builds = readBuildList(await res.json());
    const latest = builds[0];
    if (!latest) throw new Error('the build list names no build');
    return latest;
  }

  /** Read the newest build's directories for this request and say exactly how big it is. */
  startPlan(req: MapDownloadRequest): MapDownloadStatus {
    if (this.busy()) return this.current();
    if (req.kind === 'extract') {
      const sel = selectionOf(req);
      const problem = selectionProblem(sel);
      if (problem) {
        this.set({ phase: 'failed', request: req, message: problem });
        return this.current();
      }
    }
    const ac = new AbortController();
    this.abort = ac;
    this.plan = undefined;
    this.set({ phase: 'planning', request: req, message: 'reading the newest map build' });
    void (async () => {
      try {
        const build = await this.latestBuild(ac.signal);
        if (req.kind === 'planet') {
          this.plan = { req, build };
          this.set({ phase: 'planned', request: req, build, sizeBytes: build.sizeBytes, ...(await this.target(req)) });
          return;
        }
        let dirBytes = 0;
        const src = httpRangeSource(this.deps.fetchImpl, PROTOMAPS_BUILD_BASE + build.key);
        const extract = await planExtract(src, selectionOf(req), {
          signal: ac.signal,
          onProgress: (p) => {
            dirBytes = p.directoryBytesRead;
            this.set({
              phase: 'planning',
              request: req,
              build,
              message: `reading the map's index: ${p.directoriesRead} parts, ${(dirBytes / 1e6).toFixed(1)} MB`,
            });
          },
        });
        this.plan = { req, build, extract };
        this.set({
          phase: 'planned',
          request: req,
          build,
          sizeBytes: extract.totalBytes,
          tiles: extract.addressedTiles,
          ...(await this.target(req)),
        });
      } catch (err) {
        this.set(
          ac.signal.aborted
            ? { phase: 'cancelled', request: req, message: 'stopped' }
            : { phase: 'failed', request: req, message: failureText(err) },
        );
      }
    })();
    return this.current();
  }

  private async target(req: MapDownloadRequest): Promise<Pick<MapDownloadStatus, 'target'>> {
    const v = req.vaultId ? this.deps.vaultTarget(req.vaultId) : undefined;
    const dir = v ? v.path : this.deps.appPacksDir;
    const free = await (this.deps.freeBytes ?? statfsFree)(dir);
    return { target: { label: v ? v.label : 'this computer', ...(free !== undefined ? { freeBytes: free } : {}) } };
  }

  /** Download what was planned. */
  start(): MapDownloadStatus {
    const planned = this.plan;
    if (this.busy() || this.status.phase !== 'planned' || !planned) return this.current();
    const { req, build } = planned;
    const size = planned.extract ? planned.extract.totalBytes : build.sizeBytes;
    const free = this.status.target?.freeBytes;
    if (free !== undefined && free < size + SPACE_MARGIN_BYTES) {
      this.set({
        ...this.status,
        phase: 'failed',
        message: `not enough space on ${this.status.target?.label}: ${gb(size)} needed and ${gb(SPACE_MARGIN_BYTES)} to spare, ${gb(free)} free`,
      });
      return this.current();
    }
    const ac = new AbortController();
    this.abort = ac;
    const started = this.deps.now();
    const base = {
      request: req,
      build,
      sizeBytes: size,
      ...(this.status.target ? { target: this.status.target } : {}),
    };
    this.set({
      ...base,
      phase: 'downloading',
      progress: { bytesDone: 0, bytesTotal: size, startedAt: new Date(started).toISOString() },
    });
    void (async () => {
      const { id, name } = packIdentity(req);
      const vault = req.vaultId ? this.deps.vaultTarget(req.vaultId) : undefined;
      const prepared = await this.deps.registry().prepareDownload(id, vault);
      if (!prepared.ok) {
        this.set({ ...base, phase: 'failed', message: prepared.reason });
        return;
      }
      const mapsDir = path.join(prepared.dir, 'maps');
      const file = path.join(mapsDir, 'basemap.pmtiles');
      try {
        await fs.mkdir(mapsDir, { recursive: true });
        let done = 0;
        let lastReport = 0;
        const report = (n: number) => {
          done += n;
          const now = this.deps.now();
          if (now - lastReport < 500 && done < size) return;
          lastReport = now;
          const secs = Math.max(1, (now - started) / 1000);
          this.set({
            ...base,
            phase: 'downloading',
            progress: {
              bytesDone: done,
              bytesTotal: size,
              startedAt: new Date(started).toISOString(),
              bytesPerSecond: Math.round(done / secs),
            },
          });
        };
        const handle = await fs.open(file, 'w');
        let sha256: string;
        try {
          if (planned.extract) {
            const src = httpRangeSource(this.deps.fetchImpl, PROTOMAPS_BUILD_BASE + build.key);
            const r = await writeExtract(
              src,
              planned.extract,
              {
                write: async (b) => {
                  await handle.write(b);
                  report(b.length);
                },
              },
              { signal: ac.signal, concurrency: 4 },
            );
            sha256 = r.sha256;
          } else {
            sha256 = await this.downloadWhole(build, handle, ac.signal, report);
          }
        } finally {
          await handle.close();
        }
        this.set({ ...base, phase: 'verifying', message: 'checking the map file' });
        const st = await fs.stat(file);
        const fh = await fs.open(file, 'r');
        try {
          const problem = await verifyArchive(
            {
              read: async (o, l) => {
                const b = new Uint8Array(l);
                const { bytesRead } = await fh.read(b, 0, l, o);
                return b.subarray(0, bytesRead);
              },
            },
            st.size,
          );
          if (problem) throw new Error(`the downloaded map does not hold together: ${problem}`);
        } finally {
          await fh.close();
        }
        this.set({ ...base, phase: 'installing', message: 'making it live' });
        await this.writeManifest(prepared.dir, id, name, req, build, st.size, sha256);
        const adopted = await this.deps
          .registry()
          .adoptDownload(
            prepared.dir,
            vault ? { ...vault, ...(prepared.device !== undefined ? { device: prepared.device } : {}) } : undefined,
          );
        if (!adopted.installed) throw new Error(adopted.issues.join('; ') || 'the pack was not made live');
        this.deps.log.info('map downloaded', {
          id,
          build: build.key,
          bytes: st.size,
          seconds: Math.round((this.deps.now() - started) / 1000),
        });
        this.plan = undefined;
        this.set({ ...base, phase: 'done', installed: { id, name }, message: `${name} is installed` });
      } catch (err) {
        await fs.rm(prepared.dir, { recursive: true, force: true }).catch(() => undefined);
        this.set(
          ac.signal.aborted
            ? { ...base, phase: 'cancelled', message: 'stopped; nothing was installed' }
            : { ...base, phase: 'failed', message: failureText(err) },
        );
      }
    })();
    return this.current();
  }

  /** The whole planet file, streamed, its MD5 checked against the build list's. */
  private async downloadWhole(
    build: MapBuildInfo,
    handle: FileHandle,
    signal: AbortSignal,
    report: (n: number) => void,
  ): Promise<string> {
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    let at = 0;
    for (let attempt = 0; at < build.sizeBytes; attempt++) {
      signal.throwIfAborted();
      if (attempt > 8) throw new Error('the download kept breaking off');
      try {
        const res = await this.deps.fetchImpl(PROTOMAPS_BUILD_BASE + build.key, {
          headers: at ? { Range: `bytes=${at}-` } : {},
          signal,
        });
        if (at ? res.status !== 206 : res.status !== 200) throw new Error(`the map server answered ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error('no body');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value, 0, value.length, at);
          sha.update(value);
          md5.update(value);
          at += value.length;
          report(value.length);
        }
      } catch (err) {
        if (signal.aborted) throw err;
        this.deps.log.warn('map download interrupted; resuming', { at, error: failureText(err) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (at !== build.sizeBytes) throw new Error(`got ${at} bytes, the build is ${build.sizeBytes}`);
    if (build.md5 && md5.digest('base64') !== build.md5)
      throw new Error('the file does not match the build list (MD5); it was not installed');
    return sha.digest('hex');
  }

  private async writeManifest(
    dir: string,
    id: string,
    name: string,
    req: MapDownloadRequest,
    build: MapBuildInfo,
    size: number,
    sha256: string,
  ): Promise<void> {
    const createdAt = new Date(this.deps.now()).toISOString().replace(/\.\d{3}Z$/, '.000Z');
    const map = {
      path: 'maps/basemap.pmtiles',
      kind: 'pmtiles' as const,
      sizeBytes: size,
      sha256,
      providerId: MAP_PROVIDER_ID,
    };
    const bounds =
      req.kind === 'extract' && req.bounds ? req.bounds : { west: -180, south: -85.05, east: 180, north: 85.05 };
    const notices =
      renderNotices({ id, name, createdAt, bounds, sources: [PROTOMAPS_POLICY], contents: [map] }) +
      `\nDownloaded from the Protomaps daily build ${build.key} (OpenStreetMap data of ${build.date}).\n`;
    const noticeBytes = Buffer.from(notices, 'utf8');
    await fs.mkdir(path.join(dir, path.dirname(WORLDPACK_NOTICES_PATH)), { recursive: true });
    await fs.writeFile(path.join(dir, WORLDPACK_NOTICES_PATH), noticeBytes);
    const noticeSha = createHash('sha256').update(noticeBytes).digest('hex');
    const contents = [
      map,
      { path: WORLDPACK_NOTICES_PATH, kind: 'notices' as const, sizeBytes: noticeBytes.length, sha256: noticeSha },
    ];
    const manifest: WorldPackManifest = {
      formatVersion: 1,
      id,
      name,
      version: `${build.key.slice(0, 4)}.${Number(build.key.slice(4, 6))}.${Number(build.key.slice(6, 8))}`,
      createdAt,
      geographicBounds: bounds,
      contents,
      sourcePolicies: [PROTOMAPS_POLICY],
      minimumAppVersion: DEFAULT_MINIMUM_APP_VERSION,
      checksums: Object.fromEntries(contents.map((c) => [c.path, c.sha256])),
    };
    const parsed = parseWorldPackManifest(JSON.parse(JSON.stringify(manifest)));
    if (!parsed.ok) throw new Error(`the manifest would be invalid: ${parsed.issues.join('; ')}`);
    await fs.writeFile(path.join(dir, WORLDPACK_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function selectionOf(req: MapDownloadRequest): ExtractSelection {
  return {
    worldMaxZoom: req.worldMaxZoom,
    maxZoom: req.bounds ? req.maxZoom : req.worldMaxZoom,
    ...(req.bounds ? { bounds: req.bounds } : {}),
  };
}

function gb(n: number): string {
  return `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;
}

function failureText(err: unknown): string {
  if ((err as { name?: string })?.name === 'WorkingOfflineError')
    return 'WorldView is in Offline mode: switch to Online to download a map';
  return err instanceof Error ? err.message : String(err);
}

/** Read a file's SHA-256 (tests and checks). */
export async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
