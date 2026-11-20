import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservation } from '@opcb/provider-sdk';
import { observationSchema } from '@opcb/world-model';
import { AivdmAssembler, decodeMessage, nmeaChecksum } from './aivdm.js';
import { AIS_LOCAL_MANIFEST } from './manifest.js';
import { StaticStore, messageToDraft } from './normalize.js';

/**
 * AIS messages made of random bits. Anything within radio range can transmit, a receiver
 * passes on what it hears, and every field has values that mean "not available" beside
 * values that mean nothing at all. A message is decoded or refused with a reason; a ship
 * that comes out of it is an observation the world model accepts. Bits are generated from a
 * fixed seed.
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

const NOW = Date.parse('2026-11-20T00:00:00Z');
const TYPES = [1, 2, 3, 4, 5, 9, 18, 19, 21, 24, 27, 0, 6, 8, 63];
const LENGTHS = [0, 37, 38, 96, 148, 149, 160, 168, 301, 312, 424, 426, 1000];

function randomBits(next: () => number): Uint8Array {
  const length = next() < 0.7 ? LENGTHS[Math.floor(next() * LENGTHS.length)]! : Math.floor(next() * 500);
  const bits = new Uint8Array(length);
  // All ones and all zeroes are the "not available" patterns of most fields; lean on them.
  const fill = next();
  for (let i = 0; i < length; i++) bits[i] = fill < 0.15 ? 1 : fill < 0.3 ? 0 : next() < 0.5 ? 1 : 0;
  const type = TYPES[Math.floor(next() * TYPES.length)]!;
  for (let i = 0; i < 6 && i < length; i++) bits[i] = (type >> (5 - i)) & 1;
  return bits;
}

function check(draft: Parameters<typeof buildObservation>[2]): void {
  const parsed = observationSchema.parse(buildObservation(AIS_LOCAL_MANIFEST, new Date(NOW).toISOString(), draft));
  assert.ok(parsed.ok, `refused: ${JSON.stringify(parsed).slice(0, 300)} ${JSON.stringify(draft).slice(0, 500)}`);
}

test('a message of random bits is decoded or refused, and a ship made from it is one the world model accepts', () => {
  const next = rng(2026);
  const store = new StaticStore();
  let decoded = 0;
  let refused = 0;
  let ships = 0;
  for (let i = 0; i < 40_000; i++) {
    const message = decodeMessage(randomBits(next));
    if (typeof message === 'string') {
      assert.ok(message.length > 0);
      refused++;
      continue;
    }
    decoded++;
    const outcome = messageToDraft(message, store, { receivedMs: NOW, sourceRef: 'fixture' });
    if (outcome.kind === 'position') {
      check(outcome.draft);
      ships++;
    } else if (outcome.kind === 'skipped') assert.ok(outcome.reason.length > 0);
  }
  assert.ok(decoded > 5000 && refused > 5000 && ships > 500, `${decoded} decoded, ${refused} refused, ${ships} ships`);
});

test('sentences of random payload with a good checksum go through the assembler without a throw', () => {
  const next = rng(7);
  const assembler = new AivdmAssembler();
  const store = new StaticStore();
  const armour = '0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVW`abcdefghijklmnopqrstuvw';
  const tally: Record<string, number> = {};
  for (let i = 0; i < 20_000; i++) {
    const count = next() < 0.7 ? 1 : 1 + Math.floor(next() * 3);
    const index = next() < 0.85 ? 1 + Math.floor(next() * count) : Math.floor(next() * 5);
    const length = next() < 0.6 ? 28 + Math.floor(next() * 42) : Math.floor(next() * 70);
    // Often a type this reader decodes (1, 2, 3, 5, 18, 19, 24 as their armour characters).
    let payload = next() < 0.6 ? '1235BCH'[Math.floor(next() * 7)]! : '';
    for (let k = 0; k < length; k++)
      payload += next() < 0.97 ? armour[Math.floor(next() * armour.length)]! : 'xyz~!,*'[Math.floor(next() * 7)]!;
    const body = `AIVD${next() < 0.9 ? 'M' : 'O'},${count},${index},${next() < 0.5 ? '' : Math.floor(next() * 10)},${'AB12 '[Math.floor(next() * 5)]!.trim()},${payload},${Math.floor(next() * 7)}`;
    const sum = nmeaChecksum(body).toString(16).toUpperCase().padStart(2, '0');
    const line = `${next() < 0.05 ? '\\s:station,c:1795000000*00\\' : ''}!${body}*${next() < 0.95 ? sum : '00'}`;
    const result = assembler.push(line, NOW + i * 50);
    tally[result.kind] = (tally[result.kind] ?? 0) + 1;
    if (result.kind === 'message') {
      const outcome = messageToDraft(result.message, store, { receivedMs: NOW });
      if (outcome.kind === 'position') check(outcome.draft);
    }
  }
  assert.ok((tally['message'] ?? 0) > 500 && (tally['invalid'] ?? 0) > 500, JSON.stringify(tally));
});
