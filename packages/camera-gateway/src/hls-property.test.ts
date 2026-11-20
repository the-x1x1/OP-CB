import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlsBaseFor, resolveContained, rewritePlaylist } from './hls.js';

/**
 * A playlist comes from the camera's server, and the player follows whatever it names. What
 * the relay hands the player must name the relay and nothing else, and what the relay is
 * then asked for must be inside the directory the camera was registered with — whatever a
 * playlist says: another host, a way up out of the directory, a reference dressed as a tag,
 * a line ending that is not one. Playlists are generated from a fixed seed.
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

const PLAYLIST = 'https://cams.example.org/live/cam7/index.m3u8';
const BASE = hlsBaseFor(PLAYLIST);
const INSIDE = `${BASE.origin}${BASE.dir}`;
const RELAY = 'http://127.0.0.1:49152/cam/c7/tok';

const HONEST = [
  'seg1.ts',
  'hi/seg-002.ts',
  'chunk.m4s?token=abc&n=2',
  'low/index.m3u8',
  'key.bin',
  'a%20b.ts',
  'init.mp4',
];
const HOSTILE = [
  'https://evil.example/x.ts',
  'http://cams.example.org/live/cam7/x.ts',
  'https://cams.example.org:8443/live/cam7/x.ts',
  'https://user:pw@cams.example.org/live/cam7/x.ts',
  'https://cams.example.org.evil.example/live/cam7/x.ts',
  'https://cams.example.org@evil.example/live/cam7/x.ts',
  '//evil.example/live/cam7/x.ts',
  '\\\\evil.example\\live\\cam7\\x.ts',
  '/\\evil.example/x.ts',
  '../cam8/index.m3u8',
  '../../admin/config',
  'hi/../../cam8/seg.ts',
  '%2e%2e/cam8/seg.ts',
  '%2E%2E%2Fcam8%2Fseg.ts',
  'hi/%2e%2e/%2e%2e/secret',
  '..%2f..%2fsecret',
  '..%5c..%5csecret',
  '....//secret',
  '/live/cam8/seg.ts',
  '/etc/passwd',
  'file:///etc/passwd',
  'data:video/mp2t;base64,AAAA',
  'javascript:alert(1)',
  'blob:https://evil.example/1',
  ' https://evil.example/x.ts',
  '\thttps://evil.example/x.ts',
  'https:evil.example/x.ts',
  'https:/evil.example/x.ts',
  'HTTPS://EVIL.EXAMPLE/x.ts',
  'seg.ts#https://evil.example',
  '?next=https://evil.example',
  '%09//evil.example/x.ts',
  '%5C%5Cevil.example/x.ts',
  '%2F%2Fevil.example/x.ts',
  'x/%2F%2Fevil.example/x.ts',
  'https%3A%2F%2Fevil.example%2Fx.ts',
  '%00',
  '.',
  '..',
  './',
  '',
];
const TAGS = ['#EXTINF:4.0,', '#EXT-X-STREAM-INF:BANDWIDTH=800000', '#EXT-X-DISCONTINUITY', '#EXT-X-BYTERANGE:100@0'];
const ENDINGS = ['\n', '\n', '\n', '\r\n', '\r'];

/** The relay's own reading of the path it is asked for (relay.ts `decodeRel`). */
function decodeRel(rel: string): string {
  return rel
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

/** Why a rewritten playlist is not safe to hand the player; undefined when it is. */
function unsafe(output: string): string | undefined {
  if (output.includes('\r')) return 'a carriage return left in';
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const references: string[] = [];
    if (line.startsWith('#')) {
      // Every URI a tag carries, quoted or not: a player may read either.
      for (const m of line.matchAll(/URI=("[^"]*"|[^,]*)/gi)) {
        const value = m[1]!;
        if (!value.startsWith('"') || !value.endsWith('"')) return `an unquoted URI in a tag: ${line}`;
        references.push(value.slice(1, -1));
      }
    } else references.push(line);
    for (const reference of references) {
      if (!reference.startsWith(`${RELAY}/r/`)) return `names something that is not the relay: ${line}`;
      // What the relay does when the player follows it.
      const asked = new URL(reference);
      if (asked.origin !== new URL(RELAY).origin) return `leaves the relay: ${reference}`;
      const marker = '/cam/c7/tok/r/';
      if (!asked.pathname.startsWith(marker)) return `leaves the camera's own path on the relay: ${reference}`;
      const target = resolveContained(decodeRel(asked.pathname.slice(marker.length)) + asked.search, BASE);
      if (target !== undefined) {
        const u = new URL(target);
        if (u.origin !== BASE.origin || !u.pathname.startsWith(BASE.dir) || u.username || u.password)
          return `the relay would fetch ${target} for ${reference}`;
        if (u.pathname.split('/').includes('..')) return `a way up left in ${target}`;
      }
    }
  }
  return undefined;
}

test('whatever a playlist names, the player is given the relay and the relay stays in the camera directory', () => {
  const next = rng(2026);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  let kept = 0;
  for (let i = 0; i < 4000; i++) {
    let text = `#EXTM3U${pick(ENDINGS)}#EXT-X-VERSION:6${pick(ENDINGS)}#EXT-X-TARGETDURATION:4${pick(ENDINGS)}`;
    const lines = 1 + Math.floor(next() * 8);
    for (let k = 0; k < lines; k++) {
      const reference = next() < 0.4 ? pick(HONEST) : pick(HOSTILE);
      const roll = next();
      if (roll < 0.5) text += `${pick(TAGS)}${pick(ENDINGS)}${reference}${pick(ENDINGS)}`;
      else if (roll < 0.65)
        text += `#EXT-X-KEY:METHOD=AES-128,URI="${reference.replace(/"/g, '')}",IV=0x1${pick(ENDINGS)}`;
      else if (roll < 0.75) text += `#EXT-X-MAP:URI="${reference.replace(/"/g, '')}"${pick(ENDINGS)}`;
      else if (roll < 0.85) text += `#EXT-X-KEY:METHOD=AES-128,URI=${reference},IV=0x1${pick(ENDINGS)}`;
      else if (roll < 0.9) text += `#EXT-X-MEDIA:TYPE=AUDIO,uri="${reference.replace(/"/g, '')}"${pick(ENDINGS)}`;
      else if (roll < 0.95) text += `  ${reference}  ${pick(ENDINGS)}`;
      else text += `#EXTINF:4.0, ${reference}${pick(ENDINGS)}`;
    }
    const output = rewritePlaylist(text, PLAYLIST, BASE, RELAY);
    const why = unsafe(output);
    assert.equal(why, undefined, `${why}\nfrom ${JSON.stringify(text)}\nto ${JSON.stringify(output)}`);
    if (output.includes(`${RELAY}/r/`)) kept++;
  }
  // Honest references did come through: a rewrite that dropped everything would pass the rest.
  assert.ok(kept > 2000, `${kept} playlists kept a reference`);
});

test('an honest reference comes back as the address it named', () => {
  for (const reference of HONEST) {
    const output = rewritePlaylist(`#EXTM3U\n#EXTINF:4.0,\n${reference}\n`, PLAYLIST, BASE, RELAY);
    const line = output.split('\n').find((l) => l.startsWith(RELAY));
    assert.ok(line, `${reference} was dropped: ${output}`);
    const asked = new URL(line);
    const target = resolveContained(decodeRel(asked.pathname.slice('/cam/c7/tok/r/'.length)) + asked.search, BASE);
    assert.equal(target, new URL(reference, INSIDE).toString(), reference);
  }
});
