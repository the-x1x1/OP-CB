import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { silentLogger } from '@opcb/core';
import { systemClock } from '@opcb/world-model';
import type { WorldProvider } from '@opcb/provider-sdk';
import { ConnectorDefinitions, type DefinitionsHost } from './definitions.js';

/**
 * What the operator meets adding a source from an address: the sample is drafted, and a
 * draft that validates is saved and read back. Over generated answers (JSON in many shapes,
 * GeoJSON, CSV, text that is neither): every refusal says why in words the window shows (an
 * error the IPC layer passes on, not one it turns into "internal error"), and every draft the
 * window would let the operator save is saved, and loads from the folder without a problem.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Host implements DefinitionsHost {
  readonly registered = new Map<string, boolean>();
  register(provider: WorldProvider, opts: { enabled?: boolean }): void {
    this.registered.set(provider.manifest.id, opts.enabled ?? false);
  }
  async unregister(id: string): Promise<boolean> {
    return this.registered.delete(id);
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (this.registered.has(id)) this.registered.set(id, enabled);
  }
  list() {
    return [...this.registered].map(([id, enabled]) => ({ manifest: { id }, enabled }));
  }
}

function samples(r: () => number): () => { body: string; type: string } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const latNames = ['lat', 'latitude', 'Latitude', 'LAT', 'y', 'lat_dd'];
  const lonNames = ['lon', 'lng', 'longitude', 'Longitude', 'LON', 'x', 'long'];
  const idNames = ['id', 'station_id', 'ID', 'uuid', 'name'];
  const value = (): unknown =>
    pick([
      () => -90 + r() * 180,
      () => Math.round(r() * 1000),
      () => pick(['A', 'Station "Nord"', 'Café, Ōahu', '', '=1+1', 'line\nbreak']),
      () => null,
      () => r() < 0.5,
      () => '2026-11-21T19:00:00Z',
      () => ({ nested: r() }),
    ])();
  const row = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    if (r() < 0.85) o[pick(latNames)] = -80 + r() * 160;
    if (r() < 0.85) o[pick(lonNames)] = -179 + r() * 358;
    if (r() < 0.8) o[pick(idNames)] = `s${Math.floor(r() * 1e6)}`;
    const extra = Math.floor(r() * 5);
    for (let i = 0; i < extra; i++)
      o[pick(['name', 'value', 'kind', 'updated', 'speed', 'notes', '__proto__x'])] = value();
    return o;
  };
  const rows = () => Array.from({ length: 1 + Math.floor(r() * 6) }, row);
  const csvCell = (v: unknown) => {
    const t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return () => {
    const kind = Math.floor(r() * 9);
    if (kind === 0) return { body: JSON.stringify(rows()), type: 'application/json' };
    if (kind === 1)
      return { body: JSON.stringify({ data: { items: rows() } }), type: 'application/json; charset=utf-8' };
    if (kind === 2) return { body: JSON.stringify({ a: { b: { c: { d: rows() } } } }), type: 'application/json' };
    if (kind === 3)
      return {
        body: JSON.stringify({
          type: 'FeatureCollection',
          features: rows().map((p) => ({
            type: 'Feature',
            geometry:
              r() < 0.9
                ? { type: 'Point', coordinates: [-179 + r() * 358, -80 + r() * 160] }
                : pick([null, { type: 'Polygon', coordinates: [] }, { type: 'Point', coordinates: [] }]),
            properties: r() < 0.9 ? p : null,
          })),
        }),
        type: pick(['application/geo+json', 'application/json']),
      };
    if (kind === 4) {
      const list = rows();
      const cols = [...new Set(list.flatMap((x) => Object.keys(x)))];
      const text = [cols.join(','), ...list.map((x) => cols.map((c) => csvCell(x[c])).join(','))].join('\n');
      return { body: text, type: pick(['text/csv', 'text/plain', '']) };
    }
    if (kind === 5)
      return { body: pick(['<html><body>Not here</body></html>', 'just text', '', '   ']), type: 'text/html' };
    if (kind === 6)
      return { body: pick(['{"a":', '[1,2,', 'null', '42', '"text"', '{}', '[]']), type: 'application/json' };
    if (kind === 7) return { body: JSON.stringify({ count: 3, results: 'none' }), type: 'application/json' };
    return { body: '"a","b"\n"1"', type: 'text/csv' };
  };
}

for (const seed of [1, 2, 3]) {
  test(`definitions: drafts from generated answers refuse in words or save and load cleanly (seed ${seed})`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wv-draft-prop-'));
    try {
      const r = rng(seed);
      const next = samples(r);
      let current = { body: '', type: '' };
      const fetchImpl = (async () =>
        new Response(current.body, {
          status: 200,
          headers: current.type ? { 'content-type': current.type } : {},
        })) as typeof fetch;
      const host = new Host();
      const persisted: Record<string, boolean> = {};
      const defs = new ConnectorDefinitions({
        host,
        userDir: dir,
        reservedIds: () => ['usgs-earthquakes'],
        enabledSetting: (id) => persisted[id],
        persistEnabled: async (id, enabled) => {
          persisted[id] = enabled;
        },
        logger: silentLogger,
        clock: systemClock,
        fetchImpl,
      });
      let saved = 0;
      let refused = 0;
      for (let i = 0; i < 60; i++) {
        current = next();
        let draft;
        try {
          draft = await defs.draft(`https://feed${i}.example.org/data`);
        } catch (err) {
          refused++;
          const code = (err as { ipcCode?: string }).ipcCode;
          assert.ok(
            code,
            `sample ${i} (${current.type}): refused with a reason the window is shown, got ${String(err)}`,
          );
          assert.ok((err as Error).message.length > 0);
          continue;
        }
        if (!draft.validation.ok) continue;
        const id = `draft-${seed}-${i}`;
        const { file, listing } = await defs.save(id, draft.definition);
        saved++;
        const entry = listing.files.find((f) => f.file === file);
        assert.ok(entry, `sample ${i}: ${file} is listed`);
        assert.deepEqual(entry.problems, [], `sample ${i}: a saved draft loads (${entry.problems.join('; ')})`);
        assert.equal(entry.id, id);
        assert.ok(host.registered.has(id), `sample ${i}: and becomes a source`);
        assert.equal(host.registered.get(id), false, 'switched off until the operator switches it on');
      }
      assert.ok(saved > 5 && refused > 5, `both kinds were met (saved ${saved}, refused ${refused})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
