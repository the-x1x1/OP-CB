import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationSchema, type Observation } from '@opcb/world-model';
import { testing } from '@opcb/provider-sdk';
import { asText } from '../../testing/suite.js';
import { parseMqttDefinition } from './contract.js';
import { MqttProvider } from './mqtt.js';
import { loadSidecarFixtures, messagesOf } from './testing/suite.js';
import { sampleTopic } from './topics.js';

/**
 * Every broker example, sent what a broker can carry: its recorded messages with their
 * payloads cut, spliced and changed, on its own topics and on others — empty, with wildcards
 * in them, a hundred levels deep. Anything on the broker can publish, so a message is passed
 * over or becomes an observation the world model accepts, and the good messages sent among
 * the bad still come through. Changes are generated from a fixed seed.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const dir = path.join(root, 'connectors', 'examples', 'mqtt');
const NOW = Date.parse('2026-09-23T20:00:00.000Z');
const BITS = [
  '',
  '{',
  '}',
  '[',
  ']',
  '"',
  ',',
  ':',
  'null',
  'NaN',
  '1e999',
  '-999',
  '999',
  'true',
  '"__proto__":1,',
  '\u0000',
  ' ',
];
const TOPICS = [
  '',
  '/',
  '#',
  '+',
  'a/#',
  '+/+/+',
  '$SYS/broker/uptime',
  'x'.repeat(2000),
  Array.from({ length: 100 }, () => 'l').join('/'),
  'constructor',
  '__proto__/x',
  'a//b',
  'a/b/',
  '\u0000',
];

function damage(good: string, next: () => number): string {
  let s = good;
  const times = 1 + Math.floor(next() * 3);
  for (let k = 0; k < times; k++) {
    const at = Math.floor(next() * s.length);
    const len = Math.floor(next() * 20);
    const roll = next();
    if (roll < 0.15) s = s.slice(0, at);
    else if (roll < 0.3) s = s.slice(0, at) + s.slice(at + len);
    else s = s.slice(0, at) + BITS[Math.floor(next() * BITS.length)]! + s.slice(at + (next() < 0.5 ? 0 : len));
  }
  return s;
}

test('every broker example: changed messages on any topic are passed over or become observations the world model accepts', async () => {
  let exercised = 0;
  let observations = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.test.json'))) {
    const parsed = parseMqttDefinition(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
    assert.ok(parsed.ok, `${name} validates`);
    const definition = parsed.definition;
    const fixtures = loadSidecarFixtures(path.join(dir, name.replace(/\.json$/, '.test.json')), root);
    const defaultTopic = sampleTopic(definition.mqtt!.topics[0]!.topic);
    const good = (Array.isArray(fixtures.normal) ? fixtures.normal : [fixtures.normal])
      .map(asText)
      .flatMap((body) => messagesOf(body, defaultTopic));
    const run = async (
      send: Array<{ topic: string; payload: string | Uint8Array; retained: boolean }>,
    ): Promise<Observation[]> => {
      const provider = new MqttProvider(definition);
      const broker = new testing.FixtureMqtt();
      const ctx = testing.createFixtureContext({
        providerId: definition.id,
        clock: new testing.VirtualClock(NOW),
        responder: () => ({ status: 404 }),
        credentials: Object.values(definition.credentials ?? {}).map((c) => c.secretRef),
        mqtt: broker,
      });
      await provider.initialize(ctx);
      await provider.start();
      const emitted: Observation[] = [];
      const abort = new AbortController();
      try {
        await provider.subscribe({ signal: abort.signal }, (obs) => emitted.push(...obs));
        const connection = broker.connections[broker.connections.length - 1];
        assert.ok(connection, `${name} opened a connection`);
        connection.simulateOpen();
        for (const m of send) {
          try {
            connection.simulateMessage(m.topic, m.payload, { retained: m.retained });
          } catch (error) {
            assert.fail(
              `${name} threw on ${JSON.stringify(m.topic.slice(0, 60))}: ${error instanceof Error ? error.stack : String(error)}`,
            );
          }
        }
        await new Promise((r) => setTimeout(r, (definition.mqtt!.flushMs ?? 500) + 80));
      } finally {
        abort.abort();
        await provider.stop?.();
      }
      return emitted;
    };
    const whole = await run(good);
    assert.ok(whole.length > 0, `${name}: its recorded messages give observations`);
    exercised++;
    const next = rng(2026 + exercised);
    const bad: Array<{ topic: string; payload: string | Uint8Array; retained: boolean }> = [];
    for (let i = 0; i < 500; i++) {
      const from = good[Math.floor(next() * good.length)]!;
      const roll = next();
      bad.push({
        topic:
          roll < 0.2 ? TOPICS[Math.floor(next() * TOPICS.length)]! : roll < 0.3 ? damage(from.topic, next) : from.topic,
        payload:
          next() < 0.1
            ? Uint8Array.from({ length: Math.floor(next() * 40) }, () => Math.floor(next() * 256))
            : damage(from.payload, next),
        retained: next() < 0.2,
      });
    }
    const emitted = await run([...bad.slice(0, 250), ...good, ...bad.slice(250), ...good]);
    for (const observation of emitted) {
      const checked = observationSchema.parse(observation);
      assert.ok(
        checked.ok,
        `${name} admitted what the world model refuses: ${JSON.stringify(checked).slice(0, 300)} ${JSON.stringify(observation).slice(0, 400)}`,
      );
    }
    for (const id of new Set(whole.map((o) => o.externalId)))
      assert.ok(
        emitted.some((o) => o.externalId === id),
        `${name}: ${id} did not come through among the bad messages`,
      );
    observations += emitted.length;
  }
  assert.ok(exercised >= 4 && observations >= exercised, `${exercised} examples, ${observations} observations`);
});
