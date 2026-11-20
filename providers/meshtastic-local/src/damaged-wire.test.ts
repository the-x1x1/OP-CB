import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservation } from '@opcb/provider-sdk';
import { observationSchema } from '@opcb/world-model';
import { MESHTASTIC_LOCAL_MANIFEST } from './manifest.js';
import { NodeStore } from './nodes.js';
import { PORT_NODEINFO, PORT_POSITION, PORT_TELEMETRY, ProtoError, readFromRadio } from './wire.js';
import { deviceMetrics, environment, fromRadio, nodeInfo, packet, position, telemetry, user } from '../test/encode.js';

/**
 * What a radio says, with its numbers pushed to their ends and its bytes damaged. A node on
 * the mesh can send any position, any time and any float (NaN and the infinities are valid
 * bit patterns), and a serial line can drop or change a byte. The reader may refuse a
 * message with its own error; whatever it does take must leave the node list able to make
 * observations the world model accepts. Every node and value here is generated from a fixed
 * seed; none is real.
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

const NOW = 1_795_000_000;
const FLOATS = [
  0,
  -0,
  1.5,
  -40,
  150,
  1e30,
  -1e30,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e-40,
];
const INTS = [0, 1, 7, 32, 255, 65_535, 0x7fffffff, 0xffffffff, NOW, NOW + 86_400 * 400, NOW - 86_400 * 4000];
const LATS = [0, 21.3, -21.3, 89.9999999, 90, -90, 91, 214.7483647, -214.7483648];
const LONS = [0, -157.8, 179.9999999, 180, -180, 181, 214.7483647, -214.7483648];
const NAMES = ['Base', '', ' ', 'x'.repeat(90), 'a\u0000b', '\u202eevil', 'constructor', '<b>bold</b>'];

/** The bytes inside a frame (the four-byte header taken off). */
const inside = (framed: Uint8Array): Uint8Array => framed.subarray(4);

test('whatever a node says about itself and others, the node list makes observations the world model accepts', () => {
  const next = rng(2026);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const maybe = <T>(make: () => T): T | undefined => (next() < 0.6 ? make() : undefined);
  const aPosition = () =>
    position({
      lat: pick(LATS),
      lon: pick(LONS),
      ...(next() < 0.7 ? { alt: pick([0, 12, -500, 9000, 0x7fffffff, -0x80000000]) } : {}),
      ...(next() < 0.7 ? { time: pick(INTS) } : {}),
      ...(next() < 0.5 ? { fixTime: pick(INTS) } : {}),
      ...(next() < 0.5 ? { precisionBits: pick([0, 1, 10, 13, 32, 33, 255]) } : {}),
      ...(next() < 0.5 ? { source: pick([0, 1, 2, 3, 9]) } : {}),
      ...(next() < 0.3 ? { hdop: pick(INTS), pdop: pick(INTS), sats: pick(INTS), accuracyMm: pick(INTS) } : {}),
    });
  const aUser = () =>
    user({
      id: pick(['!0a1b2c3d', '', 'x', '!zzzzzzzz']),
      longName: pick(NAMES),
      shortName: pick(NAMES),
      hwModel: pick(INTS),
    });
  const aDevice = () =>
    deviceMetrics({
      battery: pick(INTS),
      voltage: pick(FLOATS),
      chUtil: pick(FLOATS),
      airTx: pick(FLOATS),
      uptime: pick(INTS),
    });
  let observations = 0;
  let refused = 0;
  let taken = 0;
  for (let round = 0; round < 400; round++) {
    const store = new NodeStore();
    store.myNodeNum = 1;
    for (let i = 0; i < 25; i++) {
      const from = pick([1, 2, 3, 0x0a1b2c3d, 0, 0xffffffff]);
      let framed: Uint8Array;
      const roll = next();
      if (roll < 0.35)
        framed = fromRadio.nodeInfo(
          nodeInfo({
            num: from,
            ...(next() < 0.8 ? { user: aUser() } : {}),
            ...(next() < 0.8 ? { position: aPosition() } : {}),
            ...(next() < 0.5 ? { snr: pick(FLOATS) } : {}),
            ...(next() < 0.5 ? { lastHeard: pick(INTS) } : {}),
            ...(next() < 0.5 ? { device: aDevice() } : {}),
            ...(next() < 0.3 ? { hopsAway: pick(INTS) } : {}),
          }),
        );
      else {
        const kind = pick(['position', 'user', 'telemetry'] as const);
        const payload =
          kind === 'position'
            ? aPosition()
            : kind === 'user'
              ? aUser()
              : telemetry({
                  ...(next() < 0.7 ? { time: pick(INTS) } : {}),
                  ...(next() < 0.5 ? { device: aDevice() } : {}),
                  ...(next() < 0.5
                    ? {
                        environment: environment({
                          temperature: pick(FLOATS),
                          humidity: pick(FLOATS),
                          pressure: pick(FLOATS),
                        }),
                      }
                    : {}),
                });
        framed = fromRadio.packet(
          packet({
            from,
            portnum: kind === 'position' ? PORT_POSITION : kind === 'user' ? PORT_NODEINFO : PORT_TELEMETRY,
            payload,
            rxTime: maybe(() => pick(INTS)) ?? NOW,
            ...(next() < 0.5 ? { snr: pick(FLOATS), rssi: pick(INTS) } : {}),
            ...(next() < 0.3 ? { hopStart: pick(INTS), hopLimit: pick(INTS) } : {}),
          }),
        );
      }
      // A copy to damage: a third of messages lose or change bytes on the way.
      let bytes = new Uint8Array(inside(framed));
      if (next() < 0.33) {
        const times = 1 + Math.floor(next() * 3);
        for (let k = 0; k < times && bytes.length > 0; k++) {
          const at = Math.floor(next() * bytes.length);
          if (next() < 0.25) bytes = new Uint8Array(bytes.subarray(0, at));
          else bytes[at] = pick([0x00, 0x7f, 0x80, 0xff, Math.floor(next() * 256)]);
        }
      }
      try {
        const message = readFromRadio(bytes);
        taken++;
        if (message.kind === 'node-info') store.nodeInfo(message.node);
        else if (message.kind === 'packet') store.packet(message.packet, NOW);
        else if (message.kind === 'my-info') store.myNodeNum = message.myNodeNum;
      } catch (error) {
        assert.ok(error instanceof ProtoError, `threw ${error instanceof Error ? error.stack : String(error)}`);
        refused++;
      }
    }
    for (const nowSec of [NOW, NOW + 3600]) {
      store.ownFix(nowSec);
      for (const draft of store.drafts(nowSec, 'fixture')) {
        const parsed = observationSchema.parse(
          buildObservation(MESHTASTIC_LOCAL_MANIFEST, new Date(NOW * 1000).toISOString(), draft),
        );
        assert.ok(parsed.ok, `refused: ${JSON.stringify(parsed).slice(0, 300)} ${JSON.stringify(draft).slice(0, 500)}`);
        observations++;
      }
    }
  }
  assert.ok(
    observations > 300 && refused > 200 && taken > 5000,
    `${observations} observations, ${taken} taken, ${refused} refused`,
  );
});
