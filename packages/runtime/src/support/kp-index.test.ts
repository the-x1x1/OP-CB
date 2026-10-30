import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KP_REFRESH_MS, KP_RETRY_MS, KP_STALE_MS, KP_URL, KpIndex, readKp } from './kp-index.js';

const BODY = [
  { time_tag: '2026-10-20T18:00:00', Kp: 2.67, a_running: 12, station_count: 8 },
  { time_tag: '2026-10-20T21:00:00', Kp: 5.33, a_running: 15, station_count: 8 },
];

test('K index: the newest reading of SWPC’s answer, in either of its shapes, with its storm level', () => {
  assert.deepEqual(readKp(BODY), {
    kp: 5.33,
    at: '2026-10-20T21:00:00.000Z',
    storm: 'G1',
    attribution: 'Planetary K index: NOAA Space Weather Prediction Center',
  });
  const old = readKp([
    ['time_tag', 'Kp', 'a_running', 'station_count'],
    ['2026-10-20 21:00:00.000', '3.00', '15', '8'],
  ]);
  assert.ok(typeof old !== 'string');
  assert.equal(old.kp, 3);
  assert.equal(old.storm, undefined);
  assert.equal(readKp({}), 'not a list of readings');
  assert.equal(readKp([{ time_tag: 'x', Kp: 'y' }]), 'no reading in the answer');
  assert.equal(readKp([{ time_tag: '2026-10-20T21:00:00', Kp: 12 }]), 'no reading in the answer');
});

test('K index: asked while the Sky tab asks, at most every 15 minutes, never offline; an old one is not now', async () => {
  let now = Date.parse('2026-10-20T22:00:00Z');
  let online = true;
  const asked: string[] = [];
  const kp = new KpIndex({
    now: () => now,
    isOnline: () => online,
    fetchImpl: (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(BODY), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(kp.current(), undefined, 'nothing until the first answer');
  await kp.settled();
  assert.deepEqual(asked, [KP_URL]);
  assert.equal(kp.current()?.kp, 5.33);
  assert.equal(kp.current()?.ageMs, 60 * 60_000);
  now += KP_REFRESH_MS - 1;
  kp.current();
  await kp.settled();
  assert.equal(asked.length, 1, 'not again within 15 minutes');
  online = false;
  now += 2;
  kp.current();
  await kp.settled();
  assert.equal(asked.length, 1, 'not while offline');
  now = Date.parse('2026-10-20T21:00:00Z') + KP_STALE_MS + 1;
  assert.equal(kp.current(), undefined, 'over nine hours old is not shown as now');
});

test('K index: a failed request is tried again after five minutes, and said', async () => {
  let now = 0;
  const problems: string[] = [];
  let calls = 0;
  const kp = new KpIndex({
    now: () => now,
    isOnline: () => true,
    onProblem: (m) => problems.push(m),
    fetchImpl: (async () => {
      calls++;
      return new Response('busy', { status: 503 });
    }) as unknown as typeof fetch,
  });
  kp.current();
  await kp.settled();
  assert.deepEqual(problems, ['HTTP 503']);
  now += KP_RETRY_MS - 1;
  kp.current();
  await kp.settled();
  assert.equal(calls, 1);
  now += 1;
  kp.current();
  await kp.settled();
  assert.equal(calls, 2);
});
