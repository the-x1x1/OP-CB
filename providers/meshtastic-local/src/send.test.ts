import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing } from '@worldview/provider-sdk';
import { createProvider, TEST_MESSAGE_WAIT_MS, type Timers } from './index.js';
import { nodeNum, readFromRadio, textPacketFrame } from './wire.js';
import { concat, fromRadio, nodeInfo, routingReport, user } from '../test/encode.js';

// Node numbers, names and texts are invented. Field numbers from Meshtastic's published message
// definitions (mesh.proto, config.proto), read outside this repository.
const START = Date.parse('2026-10-30T09:00:00Z');
const ME = 0x0a0b0c0d;
const HIKER = 0xa1b2c3d4;

class ManualTimers implements Timers {
  queue: Array<{ fn: () => void; ms: number; id: number }> = [];
  private n = 1;
  setTimeout(fn: () => void, ms: number) {
    const id = this.n++;
    this.queue.push({ fn, ms, id });
    return id;
  }
  clearTimeout(h: unknown) {
    this.queue = this.queue.filter((t) => t.id !== h);
  }
  run(ms: number) {
    const due = this.queue.filter((t) => t.ms === ms);
    this.queue = this.queue.filter((t) => t.ms !== ms);
    for (const t of due) t.fn();
  }
}

async function connected(lora?: Uint8Array) {
  const timers = new ManualTimers();
  const local = new testing.FixtureLocalAccess();
  const clock = new testing.VirtualClock(START);
  const ctx = testing.createFixtureContext({ providerId: 'meshtastic-local', clock, settings: {} as never, local });
  const p = createProvider({ flushIntervalMs: 0, timers });
  await p.initialize(ctx);
  await p.start();
  await p.subscribe({ signal: new AbortController().signal }, () => undefined);
  const s = local.byteStreams[0]!;
  s.simulateData(
    concat(
      fromRadio.myInfo(ME),
      fromRadio.metadata('2.5.20.4c97351'),
      lora ?? fromRadio.lora({ region: 1, hopLimit: 3 }),
      fromRadio.nodeInfo(nodeInfo({ num: HIKER, user: user({ longName: 'Hiker' }) })),
      fromRadio.configComplete(1),
    ),
  );
  return { p, s, timers, clock };
}

/** The packet id of the last frame written (a ToRadio packet): read back with the reader the node side would use. */
function sentId(written: Uint8Array): number {
  // ToRadio.packet is field 1; re-wrap it as FromRadio.packet (field 2) to read it with readFromRadio.
  const body = written.subarray(4);
  const asFrom = Uint8Array.from([0x12, ...body.subarray(1)]);
  const m = readFromRadio(asFrom);
  assert.equal(m.kind, 'packet');
  return (m as { packet: { id: number } }).packet.id;
}

test('textPacketFrame: one node, want_ack, the text as given; never broadcast, never over 200 bytes', () => {
  const f = textPacketFrame({ to: HIKER, id: 0x01020304, text: 'radio check', channel: 0, hopLimit: 3 });
  assert.deepEqual([...f.subarray(0, 2)], [0x94, 0xc3]);
  const body = f.subarray(4);
  assert.equal(body[0], (1 << 3) | 2, 'ToRadio.packet');
  const read = readFromRadio(Uint8Array.from([0x12, ...body.subarray(1)]));
  assert.equal(read.kind, 'packet');
  if (read.kind !== 'packet') return;
  assert.equal(read.packet.to, HIKER);
  assert.equal(read.packet.id, 0x01020304);
  assert.equal(read.packet.hopLimit, 3);
  assert.equal(read.packet.decoded?.portnum, 1);
  assert.equal(read.packet.decoded?.payload, undefined, 'a text payload is never kept, even read back');
  assert.ok(f.includes(10 << 3), 'want_ack set');
  assert.throws(() => textPacketFrame({ to: 0xffffffff, id: 1, text: 'x', channel: 0, hopLimit: 3 }));
  assert.throws(() => textPacketFrame({ to: HIKER, id: 0, text: 'x', channel: 0, hopLimit: 3 }));
  assert.throws(() => textPacketFrame({ to: HIKER, id: 1, text: 'é'.repeat(101), channel: 0, hopLimit: 3 }));
  assert.equal(nodeNum('!a1b2c3d4'), HIKER);
  assert.equal(nodeNum('a1b2c3d4'), undefined);
});

test('the radio reports its firmware and region; they show in its health line', async () => {
  const { p } = await connected(fromRadio.lora({ region: 1, preset: 0, hopLimit: 3 }));
  assert.equal(p.radio.firmwareVersion, '2.5.20.4c97351');
  assert.deepEqual(p.radio.lora, { region: 1, usePreset: true, modemPreset: 0, hopLimit: 3, txEnabled: true });
  assert.match((await p.health()).message ?? '', /firmware 2\.5\.20\.4c97351, region US, LONG_FAST$/);
});

test('send: accepted, relayed and acknowledged are told apart', async () => {
  const { p, s } = await connected();
  const ac = new AbortController();
  const pending = p.sendTestMessage({ to: '!a1b2c3d4', text: 'radio check', signal: ac.signal });
  const id = sentId(s.written.at(-1)!);
  s.simulateData(fromRadio.queueStatus(id));
  // Another radio repeats it: this radio reports an implicit acknowledgement, from itself.
  s.simulateData(fromRadio.packet(routingReport(ME, ME, id)));
  // A report on someone else's packet is not ours.
  s.simulateData(fromRadio.packet(routingReport(HIKER, ME, id + 1)));
  s.simulateData(fromRadio.packet(routingReport(HIKER, ME, id)));
  const a = await pending;
  assert.equal(a.outcome, 'acknowledged');
  assert.deepEqual(a.evidence, { connected: true, accepted: true, relayed: true, acknowledged: true });
  assert.equal(a.packetId, id);
});

test('send: a routing error ends the wait with its name; silence ends it after a minute', async () => {
  const { p, s, timers, clock } = await connected();
  const failed = p.sendTestMessage({ to: '!a1b2c3d4', text: 'one', signal: new AbortController().signal });
  const id = sentId(s.written.at(-1)!);
  s.simulateData(fromRadio.packet(routingReport(ME, ME, id, 5)));
  const a = await failed;
  assert.equal(a.outcome, 'not-acknowledged');
  assert.equal(a.routingError, 'MAX_RETRANSMIT');
  assert.equal(a.evidence.acknowledged, false);

  const soon = await p.sendTestMessage({ to: '!a1b2c3d4', text: 'two', signal: new AbortController().signal });
  assert.equal(soon.outcome, 'refused');
  assert.match(soon.message, /30 seconds/);

  clock.advance(31_000);
  const quiet = p.sendTestMessage({ to: '!a1b2c3d4', text: 'three', signal: new AbortController().signal });
  s.simulateData(fromRadio.queueStatus(sentId(s.written.at(-1)!)));
  timers.run(TEST_MESSAGE_WAIT_MS);
  const q = await quiet;
  assert.equal(q.outcome, 'accepted');
  assert.match(q.message, /queued it, but nothing shows it was heard/);
});

test('send: refused, with nothing written, without a region, with transmit off, to itself or a broadcast', async () => {
  for (const [lora, why] of [
    [fromRadio.lora({ region: 0 }), /UNSET/],
    [fromRadio.lora({ region: 1, txEnabled: false }), /transmitting is turned off/],
  ] as const) {
    const { p, s } = await connected(lora);
    const before = s.written.length;
    const a = await p.sendTestMessage({ to: '!a1b2c3d4', text: 'x', signal: new AbortController().signal });
    assert.equal(a.outcome, 'refused');
    assert.match(a.message, why);
    assert.equal(s.written.length, before);
  }
  const { p, s } = await connected();
  const before = s.written.length;
  for (const to of ['!0a0b0c0d', '!ffffffff', 'hiker'])
    assert.equal((await p.sendTestMessage({ to, text: 'x', signal: new AbortController().signal })).outcome, 'refused');
  assert.equal(s.written.length, before);
});
