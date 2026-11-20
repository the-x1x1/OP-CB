import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, testing } from '@opcb/provider-sdk';
import { HttpClient } from './http.js';
import { LoggerHub, RingBufferSink } from './logger.js';

const { VirtualClock } = testing;
const T0 = Date.parse('2026-11-20T00:00:00Z');
const STALE_MS = 10 * 60_000;

function client(clock: InstanceType<typeof VirtualClock>, answer: () => Response) {
  const hub = new LoggerHub({ level: 'debug', sinks: [new RingBufferSink(50)], now: () => 0 });
  return new HttpClient({
    allowedHosts: ['api.example.org'],
    clock,
    logger: hub.logger('provider', { providerId: 'x' }),
    maxRetries: 0,
    sleep: async () => {},
    staleWhileErrorMs: STALE_MS,
    fetchImpl: (async () => answer()) as typeof fetch,
  });
}

test('an answer kept while the clock read ahead is not served as a recent one after the clock is put right', async () => {
  // The answer is kept while the clock is a year ahead; the clock is then put right. By
  // subtraction that answer reads as "minus a year old" and would be served in place of
  // every failure until the clock passed the old mark again.
  const clock = new VirtualClock(T0 + 365 * 86_400_000);
  let ok = true;
  const http = client(clock, () =>
    ok ? new Response('{"n":1}', { status: 200 }) : new Response('down', { status: 503 }),
  );
  const first = await http.request({ url: 'https://api.example.org/v1/data' });
  assert.equal(first.status, 200);
  ok = false;
  clock.set(T0);
  await assert.rejects(
    http.request({ url: 'https://api.example.org/v1/data' }),
    (e: unknown) => e instanceof ProviderError,
  );
});

test('a kept answer is served in place of a failure inside its time and not after it', async () => {
  const clock = new VirtualClock(T0);
  let ok = true;
  const http = client(clock, () =>
    ok ? new Response('{"n":1}', { status: 200 }) : new Response('down', { status: 503 }),
  );
  await http.request({ url: 'https://api.example.org/v1/data' });
  ok = false;
  clock.set(T0 + STALE_MS - 1);
  const kept = await http.request({ url: 'https://api.example.org/v1/data' });
  assert.equal(kept.stale, true);
  assert.equal(kept.ageMs, STALE_MS - 1);
  clock.set(T0 + STALE_MS + 60 * 60_000);
  await assert.rejects(http.request({ url: 'https://api.example.org/v1/data' }));
});
