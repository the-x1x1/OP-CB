import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMessage } from '@opcb/provider-sdk';
import { redactFields, redactText } from './logger.js';

/**
 * A secret written into a log line in every way the app and its sources write one: in a
 * URL's query, between a scheme and a host, in a header, in JSON, in a settings line. After
 * redaction no part of it that could be told from noise is left: not the whole secret, and
 * not its first or last half. Secrets are generated from a fixed seed, with the characters
 * real passwords and keys hold.
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

const next = rng(2026);
const ALNUM = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function word(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[Math.floor(next() * ALNUM.length)]!;
  return out;
}
/** Two halves that never occur by chance, joined by what a password or key may hold. */
function secret(joiners: readonly string[]): { text: string; halves: [string, string] } {
  const a = `Qz${word(10)}`;
  const b = `${word(10)}Xj`;
  return { text: `${a}${joiners[Math.floor(next() * joiners.length)]!}${b}`, halves: [a, b] };
}

/** Keys and tokens: what a URL parameter, a header or a JSON string carries as it is. */
const KEY_JOINERS = ['', '-', '_', '.', '~', '+', '/', '=', '%2F', '%40'];
/** Passwords typed into a camera or broker address, as people type them. */
const PASSWORD_JOINERS = ['', '!', '$', '*', '-', '_', '.', '%40', '%3A', '@', ':', '#'];

const WITH_KEY: Array<(s: string) => string> = [
  (s) => `GET https://api.example.org/v1/data?key=${s}&bbox=1,2,3,4 failed`,
  (s) => `https://api.example.org/v1/data?bbox=1,2,3,4&api_key=${s}`,
  (s) => `request to https://firms.example.gov/api/area/csv?MAP_KEY=${s}&source=VIIRS`,
  (s) => `wss://stream.example.io/v0/stream?token=${s}`,
  (s) => `https://tiles.example.com/1/2/3.png?access_token=${s}`,
  (s) => `url=https://x.example/y?sig=${s}&session=${s}`,
  (s) => `Authorization: Bearer ${s}`,
  (s) => `authorization: Basic ${s}`,
  (s) => `headers: {"Authorization":"Bearer ${s}","Accept":"*/*"}`,
  (s) => `x-api-key: ${s}`,
  (s) => `{"apiKey":"${s}","name":"x"}`,
  (s) => `{"client_secret": "${s}"}`,
  (s) => `MQTT_PASSWORD=${s}`,
  (s) => `password: ${s}`,
  (s) => `db_password='${s}' host=db`,
  (s) => `Cookie: sid=${s}; theme=dark`,
  (s) => `Set-Cookie: session=${s}; HttpOnly`,
  (s) => `refresh_token=${s}`,
  (s) => `X-Amz-Signature=${s}&X-Amz-Credential=${s}`,
];
const WITH_PASSWORD: Array<(s: string) => string> = [
  (s) => `opening rtsp://admin:${s}@192.168.1.20:554/stream1`,
  (s) => `mqtt://sensor:${s}@broker.local:1883 refused`,
  (s) => `http://user:${s}@cam.example.org/mjpg/video.mjpg timed out`,
  (s) => `ws://u:${s}@host/path and https://other:${s}@host2/`,
  (s) => `{"url":"rtsps://admin:${s}@10.0.0.5/live"}`,
  (s) => `camera url 'rtsp://admin:${s}@192.168.1.20/' is not reachable`,
];

function leaked(output: string, s: { text: string; halves: [string, string] }): string | undefined {
  if (output.includes(s.text)) return 'the whole secret';
  if (output.includes(s.halves[0])) return 'its first half';
  if (output.includes(s.halves[1])) return 'its last half';
  return undefined;
}

test('a key or token written into a line in any of the usual ways is gone after redaction', () => {
  for (let i = 0; i < 3000; i++) {
    const s = secret(KEY_JOINERS);
    const line = WITH_KEY[i % WITH_KEY.length]!(s.text);
    const what = leaked(redactText(line), s);
    assert.equal(
      what,
      undefined,
      `${what} is left in ${JSON.stringify(redactText(line))} (from ${JSON.stringify(line)})`,
    );
    // And in a source's error message, which has its own copy of the patterns.
    assert.equal(
      leaked(sanitizeMessage(line), s),
      undefined,
      `sanitizeMessage left it in ${JSON.stringify(sanitizeMessage(line))}`,
    );
  }
});

test('a password between a scheme and a host is gone after redaction, whatever it holds', () => {
  for (let i = 0; i < 3000; i++) {
    const s = secret(PASSWORD_JOINERS);
    const line = WITH_PASSWORD[i % WITH_PASSWORD.length]!(s.text);
    const out = redactText(line);
    const what = leaked(out, s);
    assert.equal(what, undefined, `${what} is left in ${JSON.stringify(out)} (from ${JSON.stringify(line)})`);
    assert.equal(
      leaked(sanitizeMessage(line), s),
      undefined,
      `sanitizeMessage left it in ${JSON.stringify(sanitizeMessage(line))}`,
    );
    // The host is still there: the line says what could not be reached.
    assert.ok(/192\.168\.1\.20|broker\.local|cam\.example\.org|host|10\.0\.0\.5/.test(out), out);
  }
});

test('a secret under a secret-sounding field name is gone, at any depth, and the rest is kept', () => {
  for (let i = 0; i < 500; i++) {
    const s = secret(KEY_JOINERS);
    const out = JSON.stringify(
      redactFields({
        providerId: 'x',
        apiKey: s.text,
        nested: {
          deeper: { password: s.text, list: [{ token: s.text }, `Bearer ${s.text}`, `https://h/?key=${s.text}`] },
        },
        note: 'kept as written',
      }),
    );
    assert.equal(leaked(out, s), undefined, out);
    assert.ok(out.includes('kept as written') && out.includes('"providerId":"x"'));
  }
});

test('redaction of text with nothing secret in it changes nothing, and long input takes no time', () => {
  for (const line of [
    'polled https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson in 212 ms',
    'object aircraft:opensky:a00001 at 21.3,-157.8',
    'ratio 3:4 at 12:30:00, see http://example.org/a:b@c',
    'the key to the map is on the right; a token gesture',
    '',
  ])
    if (!line.includes('@')) assert.equal(redactText(line), line);
  const started = performance.now();
  redactText(`https://${'a'.repeat(200_000)}`);
  redactText(`${'x:'.repeat(100_000)}@`);
  redactText(`password=${'"'.repeat(100_000)}`);
  assert.ok(performance.now() - started < 1500, `${Math.round(performance.now() - started)} ms`);
});
