import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildObservation } from '@opcb/provider-sdk';
import { observationSchema } from '@opcb/world-model';
import {
  PUBLIC_CAMERAS_MANIFEST,
  PUBLIC_CAMERA_PACKS,
  SINGAPORE_CAMERA_PACKS,
  UNVERIFIED_CAMERA_PACKS,
  isOnHost,
} from '../../src/index.js';
import type { CatalogPack } from '../../src/packs/types.js';

/**
 * A camera catalogue is a list of addresses written by someone else, and the app then shows
 * pictures from those addresses. Each pack pins where its pictures and video may come from.
 * This gives every pack its recorded catalogue changed a few thousand ways — addresses
 * swapped for other hosts and other schemes, values for other kinds of value, members
 * removed, text cut — and holds it to that pin: a camera that comes out names a picture on
 * the pack's own hosts and nothing else, and is an observation the world model accepts.
 * Changes are generated from a fixed seed.
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

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'cctv-public',
);
const files = [
  ...readdirSync(dir).map((f) => path.join(dir, f)),
  ...readdirSync(path.join(dir, 'unverified')).map((f) => path.join(dir, 'unverified', f)),
].filter((f) => /\.(json|geojson|xml)$/.test(f));

/** Where a hostile catalogue would point a picture. */
const ELSEWHERE = [
  'https://evil.example/x.jpg',
  'http://evil.example/x.jpg',
  '//evil.example/x.jpg',
  'https://evil.example/',
  'https://user:pw@evil.example/x.jpg',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:image/jpeg;base64,AAAA',
  'http://127.0.0.1:8080/x.jpg',
  'http://169.254.169.254/latest/meta-data/',
  'https://[::1]/x.jpg',
  'rtsp://evil.example/stream',
  '\\\\evil.example\\share\\x.jpg',
  'https://evil.example/x.m3u8',
  ' https://evil.example/x.jpg',
];
const AWKWARD: unknown[] = [
  null,
  true,
  0,
  -1,
  91,
  181,
  1e308,
  Number.MAX_SAFE_INTEGER,
  '',
  ' ',
  'x',
  'N',
  'constructor',
  '__proto__',
  '../../etc/passwd',
  'x'.repeat(3000),
  [],
  [null],
  {},
  { lat: 500, lon: 500 },
];

type Path = Array<string | number>;
function places(node: unknown, at: Path = [], out: Path[] = []): Path[] {
  out.push(at);
  if (Array.isArray(node)) node.forEach((child, i) => places(child, [...at, i], out));
  else if (node && typeof node === 'object')
    for (const [key, child] of Object.entries(node)) places(child, [...at, key], out);
  return out;
}

/** The hosts a pack pins, to dress a hostile address as one of them. */
function lookalikes(pack: CatalogPack): string[] {
  const host = (pack.frameHosts[0] ?? 'cams.example').split('/')[0]!;
  return [
    `https://${host}.evil.example/x.jpg`,
    `https://evil.example/${host}/x.jpg`,
    `https://${host}@evil.example/x.jpg`,
    `https://evil.example#${host}/x.jpg`,
    `https://evil.example?${host}/x.jpg`,
    `https://${host}:8443/x.jpg`,
    `http://${host}/x.jpg`,
    `https://${host}/../../x.jpg`,
    `https://${host.toUpperCase()}/x.jpg`,
    `https://${host}./x.jpg`,
    `https://evil.example\\@${host}/x.jpg`,
  ];
}

function changedJson(good: unknown, next: () => number, pack: CatalogPack): unknown {
  const doc = structuredClone(good);
  const all = places(doc).filter((p) => p.length > 0);
  const hostile = [...ELSEWHERE, ...lookalikes(pack)];
  const times = 1 + Math.floor(next() * 4);
  for (let k = 0; k < times; k++) {
    const at = all[Math.floor(next() * all.length)]!;
    let parent = doc as Record<string | number, unknown> | undefined;
    for (const step of at.slice(0, -1)) {
      const child: unknown = parent?.[step];
      parent = child && typeof child === 'object' ? (child as Record<string | number, unknown>) : undefined;
    }
    if (!parent) continue;
    const key = at[at.length - 1]!;
    const value = parent[key];
    const roll = next();
    if (typeof value === 'string' && /^https?:|\/\//i.test(value) && roll < 0.7)
      parent[key] = hostile[Math.floor(next() * hostile.length)]!;
    else if (roll < 0.15) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (roll < 0.3 && typeof value === 'string') parent[key] = hostile[Math.floor(next() * hostile.length)]!;
    else parent[key] = structuredClone(AWKWARD[Math.floor(next() * AWKWARD.length)]);
  }
  // Now and then every address in the catalogue is moved elsewhere at once.
  if (next() < 0.15)
    for (const at of all) {
      let node = doc as Record<string | number, unknown> | undefined;
      for (const step of at.slice(0, -1)) {
        const child: unknown = node?.[step];
        node = child && typeof child === 'object' ? (child as Record<string | number, unknown>) : undefined;
      }
      const key = at[at.length - 1]!;
      if (node && typeof node[key] === 'string' && /^https?:/i.test(node[key] as string))
        node[key] = hostile[Math.floor(next() * hostile.length)]!;
    }
  return doc;
}

function changedText(good: string, next: () => number, pack: CatalogPack): string {
  const hostile = [...ELSEWHERE, ...lookalikes(pack)];
  let s = good;
  const times = 1 + Math.floor(next() * 4);
  for (let k = 0; k < times; k++) {
    const roll = next();
    if (roll < 0.6) {
      // One of the file's own addresses, replaced.
      const found = [...s.matchAll(/https?:\/\/[^<"'\s]+/g)];
      const m = found[Math.floor(next() * found.length)];
      if (m?.index !== undefined)
        s = s.slice(0, m.index) + hostile[Math.floor(next() * hostile.length)]! + s.slice(m.index + m[0].length);
    } else {
      const at = Math.floor(next() * s.length);
      const len = Math.floor(next() * 60);
      s =
        roll < 0.7
          ? s.slice(0, at)
          : roll < 0.85
            ? s.slice(0, at) + s.slice(at + len)
            : s.slice(0, at) +
              ['<', '>', '&', '</', '<![CDATA[', '999', '-999', 'NaN'][Math.floor(next() * 8)]! +
              s.slice(at + len);
    }
  }
  return s;
}

const opts = {
  observedAt: '2026-09-21T08:05:00.000Z',
  origin: 'live' as const,
  sourceRef: 'fixture',
  hash: (s: string) => 'a'.repeat(63) + (s.length % 10),
};

/** A pack's recorded catalogue: the fixture it reads cameras from, as it would be handed over. */
function recorded(pack: CatalogPack): { name: string; payload: unknown; text?: string } | undefined {
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const isJson = !file.endsWith('.xml');
    if ((pack.format === 'text') === isJson) continue;
    const one: unknown = isJson ? JSON.parse(text) : text;
    for (const payload of pack.moreRequests ? [[one], one] : [one]) {
      try {
        if (pack.normalize(payload, opts).drafts.length > 0)
          return { name: path.basename(file), payload, ...(isJson ? {} : { text }) };
      } catch {
        // Not this pack's catalogue.
      }
    }
  }
  return undefined;
}

const packs = [...PUBLIC_CAMERA_PACKS, ...UNVERIFIED_CAMERA_PACKS, ...SINGAPORE_CAMERA_PACKS];

test('a changed catalogue never moves a camera off its pack’s own hosts', () => {
  const without: string[] = [];
  let cameras = 0;
  let exercised = 0;
  for (const pack of packs) {
    const source = recorded(pack);
    if (!source) {
      without.push(pack.id);
      continue;
    }
    exercised++;
    const next = rng(2026 + exercised);
    let kept = 0;
    for (let i = 0; i < 1500; i++) {
      const wrapped = Array.isArray(source.payload) && pack.moreRequests !== undefined;
      const inner = wrapped ? (source.payload as unknown[])[0] : source.payload;
      const one = source.text !== undefined ? changedText(source.text, next, pack) : changedJson(inner, next, pack);
      const payload = wrapped ? [one] : one;
      let result;
      try {
        result = pack.normalize(payload, opts);
      } catch (error) {
        assert.fail(`${pack.id} threw ${error instanceof Error ? error.stack : String(error)}`);
      }
      for (const draft of result.drafts) {
        const frame = draft.payload['frameUrl'];
        assert.ok(
          typeof frame === 'string' && isOnHost(frame, pack.frameHosts),
          `${pack.id} let a picture through from ${JSON.stringify(frame)}`,
        );
        const stream = draft.payload['streamUrl'];
        if (stream !== undefined)
          assert.ok(
            typeof stream === 'string' && isOnHost(stream, [...(pack.streamHosts ?? []), ...pack.frameHosts]),
            `${pack.id} let video through from ${JSON.stringify(stream)}`,
          );
        // No other address rides along in what the camera carries.
        for (const [key, value] of Object.entries(draft.payload))
          if (
            typeof value === 'string' &&
            /evil\.example|127\.0\.0\.1|169\.254\.|\[::1\]/.test(value) &&
            /url$/i.test(key)
          )
            assert.fail(`${pack.id} carries ${key} = ${value}`);
        const parsed = observationSchema.parse(buildObservation(PUBLIC_CAMERAS_MANIFEST, opts.observedAt, draft));
        assert.ok(parsed.ok, `${pack.id} made what the world model refuses: ${JSON.stringify(parsed).slice(0, 300)}`);
        kept++;
      }
      assert.equal(
        new Set(result.drafts.map((d) => d.externalId)).size,
        result.drafts.length,
        `${pack.id}: an id twice`,
      );
    }
    assert.ok(kept > 0, `${pack.id}: no camera survived any change`);
    cameras += kept;
  }
  // Most packs have a recorded catalogue here; one that has none is named, not passed over.
  assert.ok(exercised >= 15, `${exercised} packs exercised; none recorded for ${without.join(', ')}`);
  assert.ok(cameras > 10_000, `${cameras} cameras checked`);
});
