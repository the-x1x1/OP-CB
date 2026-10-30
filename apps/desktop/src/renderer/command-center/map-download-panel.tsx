import { useEffect, useState } from 'react';
import type { MapDownloadRequest } from '@worldview/ipc-contract';
import { Button } from '@worldview/ui';
import { useAppSlice } from '../store/store.js';
import { useCC } from './use-cc.js';

/** What each level of detail shows, in the words of what can be seen on it. */
const WORLD_ZOOMS: ReadonlyArray<[number, string]> = [
  [3, 'Continents, countries, capitals (smallest)'],
  [4, 'Countries and the largest cities'],
  [5, 'Countries, big cities, motorways'],
  [6, 'Cities and main roads'],
  [7, 'Towns and major roads'],
  [8, 'Towns and more roads'],
  [9, 'Smaller places, most roads'],
  [10, 'Most streets in towns'],
];

const AREA_ZOOMS: ReadonlyArray<[number, string]> = [
  [12, 'Streets'],
  [13, 'Streets and paths'],
  [14, 'Streets, paths and buildings'],
  [15, 'Full detail'],
];

const ACTIVE = ['planning', 'downloading', 'verifying', 'installing'];
const NONE: readonly never[] = Object.freeze([]);

export function bytesText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

export function etaText(done: number, total: number, rate?: number): string {
  if (!rate || rate <= 0) return '';
  const s = (total - done) / rate;
  if (s < 90) return ` · about ${Math.ceil(s)} s left`;
  if (s < 5400) return ` · about ${Math.ceil(s / 60)} min left`;
  return ` · about ${(s / 3600).toFixed(1)} h left`;
}

/**
 * Download an offline map: the world down to a chosen detail, the world plus an area in full
 * detail, or the whole planet. "Check the size" reads the newest build's index and says exactly
 * how big it is and whether it fits; only then can it be downloaded.
 */
export function MapDownloadPanel() {
  const [cc, store] = useCC();
  const view = useAppSlice((s) => s.world.view);
  const vaults = useAppSlice((s) => s.offline.status?.vaults) ?? NONE;
  const offline = cc.mode?.chosen === 'offline';
  const [kind, setKind] = useState<'world' | 'area' | 'planet'>('world');
  const [worldZoom, setWorldZoom] = useState(6);
  const [areaZoom, setAreaZoom] = useState(14);
  const [name, setName] = useState('');
  const [vaultId, setVaultId] = useState('');
  const st = cc.mapDownload;
  const active = ACTIVE.includes(st.phase);
  useEffect(() => {
    void store.refreshMap();
  }, [store]);
  const ready = vaults.filter((v) => v.state === 'ready');
  const bounds = view.bounds;

  const request = (): MapDownloadRequest | null => {
    const target = vaultId ? { vaultId } : {};
    if (kind === 'planet') return { kind: 'planet', worldMaxZoom: 15, maxZoom: 15, ...target };
    if (kind === 'world') return { kind: 'extract', worldMaxZoom: worldZoom, maxZoom: worldZoom, ...target };
    if (!bounds) return null;
    return {
      kind: 'extract',
      worldMaxZoom: Math.min(worldZoom, areaZoom),
      maxZoom: areaZoom,
      bounds: {
        west: Math.max(-180, bounds.west),
        south: Math.max(-85, bounds.south),
        east: Math.min(180, bounds.east),
        north: Math.min(85, bounds.north),
      },
      name: name.trim() || 'Area',
      ...target,
    };
  };
  const req = request();
  const fits =
    st.phase === 'planned' && st.sizeBytes !== undefined && st.target?.freeBytes !== undefined
      ? st.target.freeBytes > st.sizeBytes + 1e9
      : undefined;

  return (
    <div className="wv-cc-mapdl">
      <div className="wv-cc-modeswitch" role="group" aria-label="What to download">
        {(
          [
            ['world', 'The world'],
            ['area', 'The world plus this area'],
            ['planet', 'Whole planet, full detail'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`wv-cc-seg${kind === k ? ' wv-cc-seg--on' : ''}`}
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            disabled={active}
          >
            {label}
          </button>
        ))}
      </div>
      {kind !== 'planet' ? (
        <label className="wv-cc-field">
          World detail
          <select
            className="wv-input"
            value={worldZoom}
            onChange={(e) => setWorldZoom(Number(e.target.value))}
            disabled={active}
          >
            {WORLD_ZOOMS.map(([z, label]) => (
              <option key={z} value={z}>
                Zoom {z} — {label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="wv-cc-muted">
          The whole Protomaps build: every zoom to 15 everywhere, about 140 GB. If it stops — a dropped connection, the
          laptop shut, WorldView closed — Check the size and Download again carry on from where it was.
        </p>
      )}
      {kind === 'area' ? (
        <div className="wv-cc-inline">
          <label className="wv-cc-field">
            Area detail
            <select
              className="wv-input"
              value={areaZoom}
              onChange={(e) => setAreaZoom(Number(e.target.value))}
              disabled={active}
            >
              {AREA_ZOOMS.map(([z, label]) => (
                <option key={z} value={z}>
                  Zoom {z} — {label}
                </option>
              ))}
            </select>
          </label>
          <input
            className="wv-input"
            placeholder="Name of the area (O'ahu, home…)"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            disabled={active}
          />
          <p className="wv-cc-muted">
            {bounds
              ? `The area on the map now: ${bounds.west.toFixed(2)}°, ${bounds.south.toFixed(2)}° to ${bounds.east.toFixed(2)}°, ${bounds.north.toFixed(2)}°. Move the map first to change it (Show the map, then come back).`
              : 'Open the map once to choose the area.'}
          </p>
        </div>
      ) : null}
      <label className="wv-cc-field">
        Save to
        <select className="wv-input" value={vaultId} onChange={(e) => setVaultId(e.target.value)} disabled={active}>
          <option value="">This computer</option>
          {ready.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label} (external drive{v.freeBytes !== undefined ? `, ${bytesText(v.freeBytes)} free` : ''})
            </option>
          ))}
        </select>
      </label>
      <div className="wv-cc-actions">
        <Button size="sm" disabled={active || !req || offline} onClick={() => req && void store.planMap(req)}>
          Check the size
        </Button>
        {st.phase === 'planned' ? (
          <Button
            size="sm"
            variant="primary"
            disabled={fits === false || offline}
            onClick={() => void store.startMap()}
          >
            Download {st.sizeBytes !== undefined ? bytesText(st.sizeBytes) : ''}
          </Button>
        ) : null}
        {active || st.phase === 'planned' ? (
          <Button size="sm" variant="ghost" onClick={() => void store.cancelMap()}>
            {active ? 'Stop' : 'Clear'}
          </Button>
        ) : null}
        {offline ? <span className="wv-cc-muted">Downloading needs Online mode.</span> : null}
      </div>
      <MapDownloadState />
      <p className="wv-cc-muted">
        Map data © OpenStreetMap contributors (ODbL), built by Protomaps. A newer download replaces the older one of the
        same kind.
      </p>
    </div>
  );
}

function MapDownloadState() {
  const [cc] = useCC();
  const st = cc.mapDownload;
  if (st.phase === 'idle') return null;
  const p = st.progress;
  const pct = p && p.bytesTotal ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : 0;
  return (
    <div className="wv-cc-answer" role="status">
      {st.build ? (
        <div className="wv-cc-muted">
          Build {st.build.date} (OpenStreetMap data of that day)
          {st.tiles !== undefined ? ` · ${st.tiles.toLocaleString()} tiles` : ''}
        </div>
      ) : null}
      {st.phase === 'planned' && st.sizeBytes !== undefined ? (
        <p>
          <strong>{bytesText(st.sizeBytes - (st.resumedFrom ?? 0))}</strong> to download to{' '}
          {st.target?.label ?? 'this computer'}
          {st.resumedFrom ? ` (${bytesText(st.resumedFrom)} of ${bytesText(st.sizeBytes)} is already there)` : ''}
          {st.target?.freeBytes !== undefined ? ` (${bytesText(st.target.freeBytes)} free there)` : ''}.
          {st.target?.freeBytes !== undefined && st.target.freeBytes < st.sizeBytes + 1e9
            ? ' Not enough room: choose a lower detail or another drive.'
            : ''}
        </p>
      ) : null}
      {p && (st.phase === 'downloading' || st.phase === 'verifying' || st.phase === 'installing') ? (
        <>
          <div className="wv-cc-bar" aria-hidden="true">
            <span style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <p className="wv-cc-muted">
            {bytesText(p.bytesDone)} of {bytesText(p.bytesTotal)}
            {p.bytesPerSecond ? ` · ${bytesText(p.bytesPerSecond)}/s` : ''}
            {etaText(p.bytesDone, p.bytesTotal, p.bytesPerSecond)}
            {st.resumedFrom ? ` · carried on from ${bytesText(st.resumedFrom)}` : ''}
          </p>
        </>
      ) : null}
      {st.message ? (
        <p className={st.phase === 'failed' ? 'wv-cc-problem' : ''}>
          {st.message.charAt(0).toUpperCase() + st.message.slice(1)}.
        </p>
      ) : null}
    </div>
  );
}
