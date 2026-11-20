import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConnectorRegistry } from '@opcb/connector-runtime';
import { ProviderError, testing } from '@opcb/provider-sdk';
import { observationSchema, type Observation } from '@opcb/world-model';
import { loadSidecar, sidecarPathFor } from './fixtures.js';

/**
 * Every example source that polls a web address, with the answer its test records changed:
 * JSON with values swapped for other kinds of value and members removed, other text cut,
 * doubled and spliced. Sixteen examples answer here: GeoJSON, CSV, REST, ArcGIS, OGC, STAC,
 * Traccar, transit feeds and the wind grid. A poll may fail as a provider
 * error with a code, or give observations; each observation is one the world model accepts.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NOW = Date.parse('2026-09-23T20:00:00.000Z');

function definitions(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) definitions(full, out);
    else if (entry.name.endsWith('.json') && !entry.name.endsWith('.test.json') && existsSync(sidecarPathFor(full)))
      out.push(full);
  }
  return out.sort();
}

const AWKWARD: unknown[] = [
  null,
  true,
  0,
  -1,
  91,
  181,
  1e308,
  -1e308,
  1_795_000_000,
  9_007_199_254_740_993,
  '',
  ' ',
  'x',
  '1e999',
  'NaN',
  'constructor',
  '__proto__',
  'x'.repeat(3000),
  '2026-13-45T99:99:99Z',
  [],
  [null],
  [[]],
  {},
  { type: 'Point', coordinates: [500, 500] },
  { type: 'Polygon', coordinates: [] },
];

type Path = Array<string | number>;
function places(node: unknown, at: Path = [], out: Path[] = []): Path[] {
  out.push(at);
  if (Array.isArray(node)) node.forEach((child, i) => places(child, [...at, i], out));
  else if (node && typeof node === 'object')
    for (const [key, child] of Object.entries(node)) places(child, [...at, key], out);
  return out;
}

function changedJson(good: unknown, next: () => number): unknown {
  const doc = structuredClone(good);
  const all = places(doc).filter((p) => p.length > 0);
  if (all.length === 0) return AWKWARD[Math.floor(next() * AWKWARD.length)];
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
    const roll = next();
    if (roll < 0.15) {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (roll < 0.25 && Array.isArray(parent[key])) {
      const list = parent[key] as unknown[];
      parent[key] = next() < 0.5 ? [...list, ...list] : [];
    } else if (roll < 0.4 && typeof parent[key] === 'number')
      parent[key] = (parent[key] as number) * [-1, 0, 1e6, 1e-6, 1e300][Math.floor(next() * 5)]!;
    else parent[key] = structuredClone(AWKWARD[Math.floor(next() * AWKWARD.length)]);
  }
  return doc;
}

const BITS = ['', ',', '\n', '"', '<', '>', '</', '&', 'NaN', '-999', '999', '1e999', '{', '}', '[', ']', 'null', ' '];

function changedText(good: string, next: () => number): string {
  let s = good;
  const times = 1 + Math.floor(next() * 3);
  for (let k = 0; k < times; k++) {
    const at = Math.floor(next() * s.length);
    const len = Math.floor(next() * 30);
    const roll = next();
    if (roll < 0.15) s = s.slice(0, at);
    else if (roll < 0.3) s = s.slice(0, at) + s.slice(at + len);
    else if (roll < 0.4) s = s.slice(0, at) + s.slice(at, at + len) + s.slice(at);
    else s = s.slice(0, at) + BITS[Math.floor(next() * BITS.length)]! + s.slice(at + (next() < 0.5 ? 0 : len));
  }
  return s;
}

function changedBody(body: string | Uint8Array, next: () => number): string | Uint8Array {
  if (typeof body !== 'string') {
    const bytes = new Uint8Array(body);
    const times = 1 + Math.floor(next() * 3);
    for (let k = 0; k < times && bytes.length > 0; k++)
      bytes[Math.floor(next() * bytes.length)] = Math.floor(next() * 256);
    return next() < 0.15 ? bytes.subarray(0, Math.floor(next() * bytes.length)) : bytes;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return changedText(body, next);
  }
  return next() < 0.85 ? JSON.stringify(changedJson(parsed, next)) : changedText(body, next);
}

test('every polling example: a changed answer is a provider error or observations the world model accepts', async () => {
  const exercised: string[] = [];
  let observations = 0;
  let failures = 0;
  for (const file of definitions(path.join(root, 'connectors', 'examples'))) {
    const name = path.relative(root, file);
    const validated = defaultConnectorRegistry.validate(JSON.parse(readFileSync(file, 'utf8')));
    assert.ok(validated.ok && validated.definition, `${name} validates`);
    const definition = validated.definition;
    // Sockets, brokers, files and pushed sources have their own tests; this is the poll.
    if (!definition.endpoint || definition.websocket || definition.mqtt || definition.file) continue;
    const fixtures = loadSidecar(sidecarPathFor(file), root);
    const normal = Array.isArray(fixtures.normal) ? fixtures.normal[0]! : fixtures.normal;
    const byPath = Object.entries(fixtures.normalByPath ?? {});
    const poll = async (
      bodyFor: (good: string | Uint8Array) => string | Uint8Array,
    ): Promise<Observation[] | string> => {
      const provider = defaultConnectorRegistry.createProvider(definition);
      const ctx = testing.createFixtureContext({
        providerId: definition.id,
        clock: new testing.VirtualClock(NOW),
        responder: (req) => {
          const pathname = new URL(req.url).pathname;
          const match = byPath.find(([suffix]) => pathname.endsWith(suffix));
          return { status: 200, body: bodyFor(match ? match[1] : normal) };
        },
        credentials: Object.values(definition.credentials ?? {}).map((c) => c.secretRef),
      });
      try {
        await provider.initialize(ctx);
        await provider.start();
        if (typeof provider.query !== 'function') return 'no query';
        return await provider.query({
          signal: new AbortController().signal,
          background: true,
          bounds: { west: -160, south: 18, east: -154, north: 23 },
        });
      } catch (error) {
        assert.ok(
          error instanceof ProviderError && typeof error.code === 'string' && error.code.length > 0,
          `${name} threw ${error instanceof Error ? error.stack : String(error)}`,
        );
        return error.code;
      } finally {
        await provider.stop?.();
      }
    };
    const whole = await poll((good) => good);
    if (typeof whole === 'string' || whole.length === 0) continue; // an example this harness cannot poll as it stands
    exercised.push(name);
    const next = rng(2026 + exercised.length);
    for (let i = 0; i < 250; i++) {
      const result = await poll((good) => changedBody(good, next));
      if (typeof result === 'string') {
        failures++;
        continue;
      }
      for (const observation of result) {
        const parsed = observationSchema.parse(observation);
        assert.ok(
          parsed.ok,
          `${name} admitted what the world model refuses: ${JSON.stringify(parsed).slice(0, 300)} ${JSON.stringify(observation).slice(0, 400)}`,
        );
      }
      assert.equal(new Set(result.map((o) => o.id)).size, result.length, `${name}: an id twice`);
      observations += result.length;
    }
  }
  assert.ok(exercised.length >= 12, `${exercised.length} examples exercised: ${exercised.join(', ')}`);
  assert.ok(observations > 5000 && failures > 200, `${observations} observations, ${failures} failed polls`);
});
