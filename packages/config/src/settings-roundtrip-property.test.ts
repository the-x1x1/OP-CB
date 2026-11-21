import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@opcb/ipc-contract';
import { SettingsStore } from './settings-store.js';

/**
 * Settings changed many times over, with patches of every key from values near and past each
 * limit (and some that are not settings at all). A patch is taken whole or not at all; a key
 * it carries reads back as given (providers merged by id, hidden layers without repeats); and
 * whatever the store holds is what a fresh store reads from the file — a value accepted and
 * then refused on the next start would put the operator back on the defaults, with the file
 * set aside as damaged.
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

type Gen = () => unknown;

function generators(r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const bool: Gen = () => (r() < 0.95 ? r() < 0.5 : pick([0, 'true', null]));
  const num =
    (min: number, max: number, integer = false): Gen =>
    () => {
      const edge = [min, max, min - 1e-9, max + 1e-9, -0, 0, NaN, Infinity, -Infinity, '1'];
      if (r() < 0.25) return pick(edge);
      const v = min + r() * (max - min);
      return integer ? Math.round(v) : v;
    };
  const text = (max: number): string => {
    const parts = ['a', 'Z', '0', '.', '_', '-', ':', '/', ' ', 'é', '\u{1F30D}', '\\', '"', '\u200b'];
    const n = r() < 0.1 ? max + 1 : Math.floor(r() * Math.min(max, 40)) + (r() < 0.1 ? 0 : 1);
    let out = '';
    for (let i = 0; i < n; i++) out += pick(parts);
    return out;
  };
  const id: Gen = () => (r() < 0.8 ? pick(['overview', 'esri-world-imagery', 'a.b_c-d', 'X9']) : text(128));
  const obj =
    (shape: Record<string, Gen>, optional: string[] = []): Gen =>
    () => {
      const o: Record<string, unknown> = {};
      for (const [k, g] of Object.entries(shape)) {
        if (optional.includes(k) && r() < 0.4) continue;
        if (r() < 0.03) continue; // a required key left out
        o[k] = g();
      }
      if (r() < 0.03) o['unexpected'] = 1;
      return o;
    };
  const arr =
    (g: Gen, max: number): Gen =>
    () =>
      Array.from({ length: r() < 0.05 ? max + 1 : Math.floor(r() * Math.min(max, 6)) }, g);
  const time: Gen = () => pick(['2026-11-21T19:00:00.000Z', '2026-11-21T19:00:00Z', '2026-11-21', 'now']);
  const keys: Record<string, Gen> = {
    renderMode: () => pick(['2D', '3D', 'AUTO', 'auto', '']),
    firstRunCompleted: bool,
    basemapId: () => (r() < 0.8 ? pick(['esri-world-imagery', 'source:overlay-1', 'natural-earth']) : text(136)),
    terrainId: id,
    activeLensId: id,
    reducedMotion: bool,
    textScale: num(0.75, 2),
    updater: obj({ automatic: bool, prerelease: bool }),
    cameras: obj({
      go2rtcPath: () => pick(['', '/usr/bin/go2rtc', 'C:\\Tools\\go2rtc.exe', 'go2rtc', '\\\\server\\x', '/a\0b']),
    }),
    demoMode: bool,
    privacy: obj({ telemetry: () => (r() < 0.9 ? false : true) }),
    providers: () => {
      const o: Record<string, unknown> = {};
      const n = Math.floor(r() * 4);
      for (let i = 0; i < n; i++)
        o[pick(['usgs-earthquakes', 'nws-alerts', 'a', 'Bad_ID', '__proto__', 'x-1'])] = obj({ enabled: bool })();
      return o;
    },
    hiddenLayers: arr(() => pick(['aircraft.military-only', 'camera.previews', 'ship', 'ship', 'bad id']), 64),
    tileCache: obj({ maxMB: num(64, 1_048_576, true), preloadWorld: bool }),
    history: obj({ maxMB: num(1024, 1_048_576, true), backend: () => pick(['duckdb-parquet', 'ndjson', 'sqlite']) }, [
      'backend',
    ]),
    reference: obj({ borders: bool, labels: bool }),
    display: obj(
      {
        graphics: () => pick(['auto', 'high', 'balanced', 'low', 'ultra']),
        visualStyle: () => pick(['standard', 'night-vision', 'thermal', 'crt', 'noir', 'sepia']),
        hud: bool,
        dayNight: bool,
        models3d: bool,
        imagery: () => text(128),
        grid: bool,
        hudGrid: () => pick(['none', 'mgrs', 'utm', 'latlon']),
        hudSonar: bool,
        profile: () => pick(['field', 'balanced', 'docked', 'away']),
        fieldStatus: bool,
      },
      ['models3d', 'imagery', 'grid', 'hudGrid', 'hudSonar', 'profile', 'fieldStatus'],
    ),
    martin: obj({
      url: () => text(512),
      trustedHost: () => pick(['', 'nas.local', '[::1]', 'a b']),
      attribution: () => text(500),
    }),
    search: obj({ online: bool, service: () => pick(['nominatim', 'photon', 'google']) }, ['service']),
    network: obj(
      {
        workOffline: bool,
        chosenAt: time,
        localHosts: arr(() => pick(['nas.local', '192.168.1.10', 'fd00::1', '10.0.0.0/8', 'example.com', '']), 16),
      },
      ['chosenAt', 'localHosts'],
    ),
    services: obj(
      {
        ports: obj({ ollama: num(1, 65_535, true), kiwix: num(1, 65_535, true), kolibri: num(1, 65_535, true) }, [
          'ollama',
          'kiwix',
          'kolibri',
        ]),
        aiModel: () => pick(['llama3.2:3b', 'library/qwen:7b', ':bad', 'x'.repeat(201)]),
      },
      ['ports', 'aiModel'],
    ),
    localApi: obj({ enabled: bool, ownPosition: bool }, ['ownPosition']),
    home: obj({
      view: () =>
        r() < 0.2
          ? null
          : obj(
              {
                latitude: num(-90, 90),
                longitude: num(-180, 180),
                altitudeM: num(1, 100_000_000),
                zoom: num(0, 24),
                pitchDegrees: num(-90, 0),
                headingDegrees: num(0, 360),
              },
              ['pitchDegrees', 'headingDegrees'],
            )(),
      flyOnStart: bool,
    }),
    passAlerts: obj({
      satellites: arr(obj({ objectId: () => text(256), name: () => text(200) }), 20),
      leadMinutes: num(1, 60, true),
      visibleOnly: bool,
      desktop: bool,
    }),
  };
  return {
    patch(): Record<string, unknown> {
      const p: Record<string, unknown> = {};
      const names = Object.keys(keys);
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const k = pick(names);
        p[k] = keys[k]!();
      }
      if (r() < 0.02) p['notASetting'] = true;
      return p;
    },
  };
}

/** A key no setting has is dropped where it is not refused (objects not marked strict). */
function withoutUnexpected(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutUnexpected);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'unexpected')
        .map(([k, x]) => [k, withoutUnexpected(x)]),
    );
  return v;
}

/** What JSON keeps (−0 is written as 0; nothing else may differ). */
const asStored = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

for (const seed of [1, 2, 3, 4]) {
  test(`settings: generated patches are kept whole or not at all, and read back the same after a restart (seed ${seed})`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-settings-rt-'));
    const file = path.join(dir, 'settings.json');
    try {
      const r = rng(seed);
      const gen = generators(r);
      const { store } = await SettingsStore.open({ file, schemaVersion: 9 });
      let accepted = 0;
      for (let step = 0; step < 400; step++) {
        const before = store.get();
        const patch = gen.patch();
        let next: AppSettings | undefined;
        try {
          next = await store.patch(patch as Partial<AppSettings>);
        } catch {
          assert.deepEqual(store.get(), before, `step ${step}: a refused patch changes nothing`);
          continue;
        }
        accepted++;
        assert.deepEqual(store.get(), next, 'the answer is what is held');
        for (const [k, v] of Object.entries(patch)) {
          const held: unknown = (next as unknown as Record<string, unknown>)[k];
          if (k === 'providers') {
            for (const [id, cfg] of Object.entries(v as Record<string, unknown>))
              assert.deepEqual(next.providers[id], withoutUnexpected(cfg), `provider ${id} as given`);
          } else if (k === 'hiddenLayers') {
            assert.deepEqual(held, [...new Set(v as string[])]);
          } else {
            assert.deepEqual(held, withoutUnexpected(v), `step ${step}: ${k} reads back as given`);
          }
        }
        // Nothing unchanged by the patch moved.
        for (const k of Object.keys(before))
          if (!(k in patch))
            assert.deepEqual(
              (next as unknown as Record<string, unknown>)[k],
              (before as unknown as Record<string, unknown>)[k],
              `step ${step}: ${k} untouched`,
            );
        if (step % 20 === 0 || step === 399) {
          const { store: again, report } = await SettingsStore.open({ file, schemaVersion: 9 });
          assert.equal(report.status, 'loaded', `step ${step}: the file loads (${report.error ?? ''})`);
          assert.deepEqual(asStored(again.get()), asStored(store.get()), `step ${step}: the next start reads the same`);
        }
      }
      assert.ok(accepted > 100, `enough patches were accepted to mean something (${accepted})`);
      // A copy handed out cannot change the store.
      const copy = store.get();
      copy.hiddenLayers.push('mutated');
      copy.display.hud = !copy.display.hud;
      assert.notDeepEqual(store.get().hiddenLayers, copy.hiddenLayers);
      assert.notEqual(store.get().display.hud, copy.display.hud);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
