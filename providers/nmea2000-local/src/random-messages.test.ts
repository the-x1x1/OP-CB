import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservation } from '@opcb/provider-sdk';
import { observationSchema } from '@opcb/world-model';
import { NMEA2000_LOCAL_MANIFEST } from './manifest.js';
import { READ_PGNS, decodePgn } from './pgns.js';
import { OwnVessel, StaticStore, aisDraft, mmsiString, staticInfo } from './vessels.js';
import { FastPacketAssembler, parseYdRawLine } from './wire.js';

/**
 * Messages from the boat's network made of random bytes. Every instrument on the bus writes
 * to it, a field of all ones means "no data", and a gateway passes on a frame whatever is in
 * it. A message is read or passed over; the boat and the ships made from what was read are
 * observations the world model accepts. Bytes are generated from a fixed seed.
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

function check(draft: Parameters<typeof buildObservation>[2]): void {
  const parsed = observationSchema.parse(buildObservation(NMEA2000_LOCAL_MANIFEST, new Date(NOW).toISOString(), draft));
  assert.ok(parsed.ok, `refused: ${JSON.stringify(parsed).slice(0, 300)} ${JSON.stringify(draft).slice(0, 500)}`);
}

test('random bytes under every message number read here give a boat and ships the world model accepts', () => {
  const next = rng(2026);
  const pgns = [...READ_PGNS, 59904, 60928, 126992, 0, 0x1ffff];
  let read = 0;
  let passedOver = 0;
  let boats = 0;
  let ships = 0;
  for (let round = 0; round < 300; round++) {
    const own = new OwnVessel();
    const statics = new StaticStore();
    for (let i = 0; i < 80; i++) {
      const pgn = pgns[Math.floor(next() * pgns.length)]!;
      const length =
        next() < 0.5 ? [0, 1, 7, 8, 26, 27, 28, 43, 75, 223][Math.floor(next() * 10)]! : Math.floor(next() * 90);
      const bytes = new Uint8Array(length);
      const fill = next();
      for (let k = 0; k < length; k++)
        bytes[k] = fill < 0.15 ? 0xff : fill < 0.25 ? 0 : fill < 0.3 ? 0x7f : Math.floor(next() * 256);
      const message = decodePgn(pgn, bytes);
      if (!message) {
        passedOver++;
        continue;
      }
      read++;
      const now = NOW + i * 200;
      if (message.kind === 'ais-static') {
        const mmsi = mmsiString(message.mmsi);
        if (mmsi) statics.merge(mmsi, staticInfo(message));
      } else if (message.kind === 'ais-position') {
        const draft = aisDraft(message, statics, { receivedMs: now, sourceRef: 'fixture' });
        if (draft) {
          check(draft);
          ships++;
        }
      } else own.update(message, Math.floor(next() * 254), now);
      const boat = own.draft(now, { externalId: 'own-vessel', name: 'Boat', sourceRef: 'fixture' });
      if (boat) {
        check(boat);
        boats++;
      }
    }
  }
  assert.ok(
    read > 5000 && passedOver > 1000 && boats > 1000 && ships > 100,
    `${read} read, ${passedOver} passed over, ${boats} boats, ${ships} ships`,
  );
});

test('gateway lines of random text and frames in any order go through without a throw', () => {
  const next = rng(11);
  const assembler = new FastPacketAssembler();
  const hex = '0123456789ABCDEFabcdef';
  const pgns = [...READ_PGNS];
  let frames = 0;
  let whole = 0;
  for (let i = 0; i < 30_000; i++) {
    let id = '';
    if (next() < 0.7) {
      // A message number this reader takes, from one of three devices, so fast packets meet
      // each other's frames in every order.
      const pgn = pgns[Math.floor(next() * pgns.length)]!;
      id = ((3 << 26) | (pgn << 8) | Math.floor(next() * 3)).toString(16).toUpperCase().padStart(8, '0');
    } else {
      const idLength = next() < 0.9 ? 8 : Math.floor(next() * 12);
      for (let k = 0; k < idLength; k++) id += hex[Math.floor(next() * hex.length)]!;
    }
    const count = next() < 0.9 ? Math.floor(next() * 9) : Math.floor(next() * 20);
    const data = Array.from({ length: count }, (_unused, k) =>
      k === 0 && next() < 0.8
        ? ((Math.floor(next() * 2) << 5) | Math.floor(next() * 4)).toString(16).padStart(2, '0')
        : k === 1 && next() < 0.5
          ? Math.floor(next() * 30)
              .toString(16)
              .padStart(2, '0')
          : next() < 0.97
            ? Math.floor(next() * 256)
                .toString(16)
                .padStart(2, '0')
            : ['G1', '', '123', '-1'][Math.floor(next() * 4)]!,
    );
    const line = `${next() < 0.9 ? '17:33:01.107' : 'x'} ${next() < 0.95 ? 'R' : 'T'} ${id} ${data.join(' ')}${next() < 0.1 ? '\r' : ''}`;
    const frame = parseYdRawLine(line);
    if (!frame) continue;
    frames++;
    assert.ok(frame.data.length <= 8 && Number.isInteger(frame.pgn) && frame.pgn >= 0, JSON.stringify(frame));
    const bytes = assembler.push(frame, NOW + i);
    if (bytes) {
      whole++;
      assert.ok(bytes.length <= 223, `${bytes.length} bytes from one fast packet`);
      decodePgn(frame.pgn, bytes);
    }
  }
  assert.ok(frames > 10_000 && whole > 20, `${frames} frames, ${whole} whole messages`);
});
