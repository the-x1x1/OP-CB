import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderError } from '@opcb/provider-sdk';
import type { StateChange } from '@opcb/state-engine';
import type { WorldObject } from '@opcb/world-model';
import { findOnPath, resolveGrantedPath } from './support/granted-folder.js';
import { zimFileName } from './support/library-downloads.js';
import {
  readKolibriInfo,
  readOllamaModels,
  readOllamaVersion,
  serviceOrigin,
  servicePort,
} from './support/local-services.js';
import { fileSha256, selectionOf } from './support/map-download.js';
import {
  MAX_PACKET_BYTES,
  PacketReader,
  decode,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodeSubscribe,
  isValidTopicFilter,
  type DecodedPacket,
} from './support/mqtt-packets.js';
import {
  SubscriptionRegistry,
  deltaFor,
  diffObjectSets,
  filterObjects,
  matchesSubscription,
} from './support/subscriptions.js';
import {
  InvalidRequestError,
  requireCollection,
  requireLens,
  requireWatchZone,
  validateCollection,
  validateLens,
  validateRegion,
  validateStoredCamera,
  validateWatchZone,
} from './validate.js';

const T = '2026-11-19T10:00:00.000Z';

// ---- validate --------------------------------------------------------------------------

test('validateRegion: each kind as it must be, and nothing a region cannot be', () => {
  const box = { west: -160, south: 18, east: -154, north: 23 };
  assert.deepEqual(validateRegion({ kind: 'bounds', bounds: { ...box, extra: 1 } }), { kind: 'bounds', bounds: box });
  assert.ok(
    validateRegion({ kind: 'bounds', bounds: { west: 170, south: -20, east: -170, north: -10 } }),
    'across the 180th meridian',
  );
  for (const bounds of [
    { ...box, south: 23.1 },
    { ...box, north: 91 },
    { ...box, south: -91 },
    { ...box, west: Number.NaN },
    { ...box, east: '1' },
    { west: 1, south: 1, east: 2 },
    null,
    [1, 2, 3, 4],
  ])
    assert.equal(validateRegion({ kind: 'bounds', bounds }), undefined, JSON.stringify(bounds));

  const centre = { latitude: 21.3, longitude: -157.8 };
  assert.deepEqual(validateRegion({ kind: 'circle', center: { ...centre, altitudeM: 5, junk: 1 }, radiusM: 500 }), {
    kind: 'circle',
    center: { ...centre, altitudeM: 5 },
    radiusM: 500,
  });
  for (const circle of [
    { center: centre, radiusM: 0 },
    { center: centre, radiusM: -1 },
    { center: centre, radiusM: Infinity },
    { center: centre, radiusM: '500' },
    { center: { latitude: 91, longitude: 0 }, radiusM: 5 },
    { center: { latitude: '21', longitude: 0 }, radiusM: 5 },
    { radiusM: 5 },
  ])
    assert.equal(validateRegion({ kind: 'circle', ...circle }), undefined, JSON.stringify(circle));

  const ring = [
    [-158, 21],
    [-157, 21, 99],
    [-157, 22],
  ];
  assert.deepEqual(validateRegion({ kind: 'polygon', polygon: ring }), {
    kind: 'polygon',
    polygon: [
      [-158, 21],
      [-157, 21],
      [-157, 22],
    ],
  });
  for (const polygon of [
    ring.slice(0, 2),
    [...ring, [1]],
    [...ring, ['a', 1]],
    [...ring, [0, 91]],
    [...ring, [Infinity, 0]],
    'ring',
    [...ring, null],
  ])
    assert.equal(validateRegion({ kind: 'polygon', polygon }), undefined, JSON.stringify(polygon));

  assert.deepEqual(validateRegion({ kind: 'admin', regionId: ' US-HI ' }), { kind: 'admin', regionId: 'US-HI' });
  assert.deepEqual(validateRegion({ kind: 'admin', regionId: 'US-HI', bounds: box }), {
    kind: 'admin',
    regionId: 'US-HI',
    bounds: box,
  });
  assert.deepEqual(validateRegion({ kind: 'admin', regionId: 'US-HI', bounds: { ...box, north: 99 } }), {
    kind: 'admin',
    regionId: 'US-HI',
  });
  for (const admin of [{}, { regionId: '' }, { regionId: '  ' }, { regionId: 'x'.repeat(129) }, { regionId: 5 }])
    assert.equal(validateRegion({ kind: 'admin', ...admin }), undefined, JSON.stringify(admin));
  for (const other of [null, undefined, 'bounds', [], {}, { kind: 'sphere' }, { kind: 'constructor' }])
    assert.equal(validateRegion(other), undefined);
});

test('validateCollection: the collection and each item it can keep; a bad item is left out, not the collection', () => {
  const item = { id: 'i1', kind: 'location', title: 'Home', createdAt: T, updatedAt: T };
  const full = {
    ...item,
    id: 'i2',
    position: { latitude: 21.3, longitude: -157.8 },
    objectId: 'o1',
    eventId: 'e1',
    watchZoneId: 'z1',
    lensId: 'l1',
    note: 'n'.repeat(5000),
    tags: ['a', '', 5, 'b'],
    junk: true,
  };
  const c = validateCollection({
    id: ' c1 ',
    name: 'Places',
    createdAt: T,
    updatedAt: T,
    junk: 1,
    items: [
      item,
      full,
      null,
      'x',
      { ...item, id: '' },
      { ...item, kind: 'planet' },
      { ...item, kind: 'constructor' },
      { ...item, title: 5 },
      { ...item, createdAt: 'yesterday' },
      { ...item, updatedAt: '1' },
      { ...item, id: 'i3', title: '', position: { latitude: 99, longitude: 0 } },
    ],
  })!;
  assert.deepEqual(Object.keys(c), ['id', 'name', 'createdAt', 'updatedAt', 'items']);
  assert.equal(c.id, 'c1');
  assert.deepEqual(
    c.items.map((i) => i.id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(c.items[0], item);
  const kept = c.items[1]!;
  assert.equal(kept.note!.length, 4000);
  assert.deepEqual(kept.tags, ['a', 'b']);
  assert.deepEqual([kept.objectId, kept.eventId, kept.watchZoneId, kept.lensId], ['o1', 'e1', 'z1', 'l1']);
  assert.ok(!('junk' in kept));
  assert.ok(!('position' in c.items[2]!), 'a position off the globe is left off the item');

  const base = { id: 'c', name: 'n', createdAt: T, updatedAt: T };
  assert.deepEqual(validateCollection(base)!.items, []);
  assert.deepEqual(validateCollection({ ...base, items: 'x' })!.items, []);
  assert.equal(
    validateCollection({ ...base, items: Array.from({ length: 2500 }, (_, i) => ({ ...item, id: `i${i}` })) })!.items
      .length,
    2000,
  );
  assert.equal(validateCollection({ ...base, name: 'n'.repeat(300) })!.name.length, 200);
  for (const bad of [
    null,
    [],
    'c',
    { ...base, id: undefined },
    { ...base, name: '' },
    { ...base, name: 5 },
    { ...base, createdAt: 'Tue 5' },
    { ...base, createdAt: '1' },
    { ...base, updatedAt: 1_700_000_000_000 },
    { ...base, updatedAt: '2026-13-45T00:00:00Z' },
  ])
    assert.equal(validateCollection(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(requireCollection(base), { ...base, items: [] });
  assert.throws(
    () => requireCollection({}),
    (e: unknown) => e instanceof InvalidRequestError && e.ipcCode === 'INVALID_REQUEST',
  );
});

test('validateWatchZone: severities by name only, quiet hours as clock times, on unless turned off', () => {
  const base = {
    id: 'z1',
    name: 'Oahu',
    geometry: { kind: 'circle', center: { latitude: 21.4, longitude: -157.9 }, radiusM: 40_000 },
    eventTypes: ['earthquake', 5, ''],
    notifications: { inApp: true, desktop: 'yes' },
    createdAt: T,
  };
  const zone = validateWatchZone(base)!;
  assert.deepEqual(zone.eventTypes, ['earthquake']);
  assert.deepEqual(zone.notifications, { inApp: true, desktop: false });
  assert.equal(zone.enabled, true);
  assert.ok(!('minimumSeverity' in zone) && !('quietHours' in zone));
  assert.equal(validateWatchZone({ ...base, enabled: false })!.enabled, false);
  assert.equal(validateWatchZone({ ...base, enabled: 0 })!.enabled, true);

  const set = validateWatchZone({
    ...base,
    minimumSeverity: 'SEVERE',
    desktopMinimumSeverity: 'EXTREME',
    quietHours: { start: '22:00', end: '06:30' },
  })!;
  assert.deepEqual(
    [set.minimumSeverity, set.desktopMinimumSeverity, set.quietHours],
    ['SEVERE', 'EXTREME', { start: '22:00', end: '06:30' }],
  );
  for (const name of ['severe', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '', 3]) {
    const z = validateWatchZone({ ...base, minimumSeverity: name, desktopMinimumSeverity: name })!;
    assert.ok(!('minimumSeverity' in z) && !('desktopMinimumSeverity' in z), String(name));
  }
  for (const quietHours of [
    { start: '24:00', end: '06:00' },
    { start: '9:00', end: '10:00' },
    { start: '22:00', end: '22:00' },
    { start: '22:60', end: '23:00' },
    { start: '22:00' },
    'night',
  ])
    assert.ok(!('quietHours' in validateWatchZone({ ...base, quietHours })!), JSON.stringify(quietHours));

  for (const bad of [
    { ...base, id: '' },
    { ...base, name: '' },
    { ...base, geometry: { kind: 'circle' } },
    { ...base, eventTypes: 'earthquake' },
    { ...base, notifications: null },
    { ...base, notifications: [] },
    { ...base, createdAt: 'never' },
  ])
    assert.equal(validateWatchZone(bad), undefined, JSON.stringify(bad));
  assert.equal(requireWatchZone(base).id, 'z1');
  assert.throws(() => requireWatchZone({ ...base, geometry: null }), InvalidRequestError);
});

test('validateLens: lists of names, rules that are at least objects, built-in only when it says so', () => {
  const base = { id: 'l1', name: 'Air', objectTypes: ['aircraft'], eventTypes: [], visiblePanels: ['inspector'] };
  assert.deepEqual(validateLens(base), { ...base, renderingRules: [] });
  const lens = validateLens({
    ...base,
    description: 'd'.repeat(600),
    providerPreferences: ['a', 7],
    builtIn: 'true',
    renderingRules: [{ objectTypes: ['aircraft'], styleClass: 'aircraft' }, null, 'rule', 5, [1]],
    junk: 1,
  })!;
  assert.equal(lens.description!.length, 500);
  assert.deepEqual(lens.providerPreferences, ['a']);
  assert.ok(!('builtIn' in lens) && !('junk' in lens));
  assert.deepEqual(lens.renderingRules, [{ objectTypes: ['aircraft'], styleClass: 'aircraft' }]);
  assert.equal(validateLens({ ...base, builtIn: true })!.builtIn, true);
  assert.equal(
    validateLens({ ...base, objectTypes: Array.from({ length: 100 }, (_, i) => `t${i}`) })!.objectTypes.length,
    64,
  );
  assert.equal(
    validateLens({ ...base, renderingRules: Array.from({ length: 100 }, () => ({})) })!.renderingRules.length,
    64,
  );
  for (const bad of [
    null,
    { ...base, id: 5 },
    { ...base, name: '' },
    { ...base, objectTypes: 'aircraft' },
    { ...base, eventTypes: undefined },
    { ...base, visiblePanels: {} },
  ])
    assert.equal(validateLens(bad), undefined, JSON.stringify(bad));
  assert.equal(requireLens(base).id, 'l1');
  assert.throws(() => requireLens(null), InvalidRequestError);
});

test('validateStoredCamera: a fetchable address with no credential in it, or it is not loaded', () => {
  const base = {
    cameraId: '0123456789ab',
    objectId: 'camera:0123456789ab',
    name: ' Gate ',
    url: 'https://cam.example/snap.jpg',
    kind: 'snapshot',
    registeredAt: T,
  };
  assert.deepEqual(validateStoredCamera(base), { ...base, id: base.cameraId, name: 'Gate' });
  assert.equal(
    validateStoredCamera({ ...base, cameraId: undefined, id: base.cameraId })!.cameraId,
    base.cameraId,
    'the id as the store keys it',
  );
  const more = validateStoredCamera({
    ...base,
    kind: 'rtsp',
    url: 'rtsp://10.0.0.5:554/stream',
    credentialKey: 'camera.0123456789ab.credential',
    position: { latitude: 21.3, longitude: -157.8, altitudeM: 9 },
    headingDegrees: -90,
  })!;
  assert.equal(more.credentialKey, 'camera.0123456789ab.credential');
  assert.deepEqual(more.position, { latitude: 21.3, longitude: -157.8 });
  assert.equal(more.headingDegrees, 270);
  assert.equal(validateStoredCamera({ ...base, headingDegrees: 725 })!.headingDegrees, 5);
  const dropped = validateStoredCamera({
    ...base,
    credentialKey: 'provider.token',
    position: { latitude: 99, longitude: 0 },
    headingDegrees: Number.NaN,
  })!;
  assert.ok(!('credentialKey' in dropped) && !('position' in dropped) && !('headingDegrees' in dropped));
  for (const bad of [
    null,
    { ...base, cameraId: '0123456789AB' },
    { ...base, cameraId: '0123456789abc' },
    { ...base, name: '   ' },
    { ...base, objectId: '' },
    { ...base, registeredAt: 'soon' },
    { ...base, kind: 'webrtc' },
    { ...base, kind: 'constructor' },
    { ...base, url: 'not a url' },
    { ...base, url: 'file:///etc/passwd' },
    { ...base, url: 'javascript:alert(1)' },
    { ...base, url: 'data:image/jpeg;base64,AAAA' },
    { ...base, url: 'https://user:pass@cam.example/snap.jpg' },
    { ...base, url: 'rtsp://admin@10.0.0.5/stream' },
  ])
    assert.equal(validateStoredCamera(bad), undefined, JSON.stringify(bad));
});

// ---- subscriptions ---------------------------------------------------------------------

function obj(id: string, type: string, latitude?: number, longitude?: number, stamp = T): WorldObject {
  return {
    id,
    type,
    observedAt: stamp,
    updatedAt: stamp,
    freshness: 'LIVE',
    ...(latitude !== undefined && longitude !== undefined ? { position: { latitude, longitude } } : {}),
  } as unknown as WorldObject;
}

test('subscriptions: type and bounds both have to hold, a pinned id always does, and a client sees only its own', () => {
  const hawaii = { west: -161, south: 18, east: -154, north: 23 };
  const plane = obj('a1', 'aircraft', 21, -158);
  const far = obj('a2', 'aircraft', 51, 0);
  const ship = obj('v1', 'vessel', 21, -157);
  const nowhere = obj('s1', 'satellite');
  assert.equal(matchesSubscription(plane, {}), true);
  assert.equal(matchesSubscription(nowhere, {}), true);
  assert.equal(matchesSubscription(plane, { objectTypes: [] }), true, 'an empty list of types is no restriction');
  assert.equal(matchesSubscription(plane, { objectTypes: ['vessel'] }), false);
  assert.equal(matchesSubscription(plane, { bounds: hawaii }), true);
  assert.equal(matchesSubscription(far, { bounds: hawaii }), false);
  assert.equal(matchesSubscription(nowhere, { bounds: hawaii }), false, 'no position is in no box');
  assert.equal(matchesSubscription(ship, { bounds: hawaii, objectTypes: ['aircraft'] }), false);
  assert.equal(matchesSubscription(far, { bounds: hawaii, objectTypes: ['vessel'], pinnedIds: ['a2'] }), true);

  const all = [plane, far, ship, nowhere];
  assert.deepEqual(
    filterObjects(all, { bounds: hawaii }).map((o) => o.id),
    ['a1', 'v1'],
  );
  assert.deepEqual(
    filterObjects(all, {}, 3).map((o) => o.id),
    ['a1', 'a2', 'v1'],
  );
  assert.deepEqual(filterObjects(all, { objectTypes: ['none'] }), []);
  let read = 0;
  const counted = (function* () {
    for (const o of all) {
      read++;
      yield o;
    }
  })();
  assert.equal(filterObjects(counted, {}, 1).length, 1);
  assert.equal(read, 1, 'stops reading at the limit');

  const registry = new SubscriptionRegistry();
  assert.deepEqual(registry.set('w1', { bounds: hawaii }), { clientId: 'w1', bounds: hawaii });
  registry.set('w2', {});
  registry.set('w1', { objectTypes: ['vessel'] });
  assert.equal(registry.size, 2);
  assert.deepEqual(
    registry.get('w1'),
    { clientId: 'w1', objectTypes: ['vessel'] },
    'a new subscription replaces the old one whole',
  );
  assert.equal(registry.get('nobody'), undefined);
  registry.remove('w1');
  registry.remove('w1');
  assert.deepEqual(
    registry.all().map((s) => s.clientId),
    ['w2'],
  );
});

test('deltaFor: what moved out of a client’s view is a removal for it; nothing to say is nothing sent', () => {
  const hawaii = { west: -161, south: 18, east: -154, north: 23 };
  const world = new Map<string, WorldObject>([
    ['in-new', obj('in-new', 'aircraft', 21, -158)],
    ['out-new', obj('out-new', 'aircraft', 51, 0)],
    ['in-moved', obj('in-moved', 'aircraft', 22, -157)],
    ['left', obj('left', 'aircraft', 40, -120)],
    ['fresh-in', obj('fresh-in', 'aircraft', 20, -156)],
    ['fresh-out', obj('fresh-out', 'aircraft', 0, 0)],
  ]);
  const change: StateChange = {
    added: ['in-new', 'out-new', 'ghost-added'],
    updated: ['in-moved', 'left', 'ghost-updated'],
    removed: ['gone'],
    refreshed: ['fresh-in', 'fresh-out', 'ghost-fresh'],
    at: T,
    objectCount: 6,
  };
  const delta = deltaFor(change, { bounds: hawaii }, (id) => world.get(id))!;
  assert.deepEqual(delta.added, ['in-new']);
  assert.deepEqual(delta.updated, ['in-moved']);
  assert.deepEqual(delta.removed, ['gone', 'left', 'ghost-updated']);
  assert.deepEqual(delta.refreshed, ['fresh-in']);
  assert.deepEqual(delta.freshness, [{ id: 'fresh-in', freshness: 'LIVE' }]);
  assert.deepEqual(
    delta.objects.map((o) => o.id),
    ['in-new', 'in-moved'],
  );
  assert.deepEqual([delta.at, delta.objectCount], [T, 6]);
  assert.deepEqual(change.removed, ['gone'], 'the change itself is not written to');

  const elsewhere: StateChange = {
    added: ['out-new'],
    updated: [],
    removed: [],
    refreshed: ['fresh-out'],
    at: T,
    objectCount: 6,
  };
  assert.equal(
    deltaFor(elsewhere, { bounds: hawaii }, (id) => world.get(id)),
    undefined,
  );
  assert.ok(deltaFor(elsewhere, {}, (id) => world.get(id)));
});

test('diffObjectSets: added, removed, and updated when either time moved', () => {
  const later = '2026-11-19T10:00:05.000Z';
  const before = new Map([
    ['same', obj('same', 'x')],
    ['seen', obj('seen', 'x')],
    ['touched', obj('touched', 'x')],
    ['gone', obj('gone', 'x')],
  ]);
  const after = new Map([
    ['same', obj('same', 'x')],
    ['seen', obj('seen', 'x', undefined, undefined, later)],
    ['touched', { ...obj('touched', 'x'), updatedAt: later }],
    ['new', obj('new', 'x')],
  ]);
  assert.deepEqual(diffObjectSets(before, after, later), {
    added: ['new'],
    updated: ['seen', 'touched'],
    removed: ['gone'],
    refreshed: [],
    at: later,
    objectCount: 4,
  });
  assert.deepEqual(diffObjectSets(new Map(), new Map(), T), {
    added: [],
    updated: [],
    removed: [],
    refreshed: [],
    at: T,
    objectCount: 0,
  });
});

// ---- MQTT packets ----------------------------------------------------------------------

function publish(topic: string, payload: Uint8Array, flags = 0, packetId?: number): Uint8Array {
  const name = new TextEncoder().encode(topic);
  const body = [
    name.length >> 8,
    name.length & 0xff,
    ...name,
    ...(packetId !== undefined ? [packetId >> 8, packetId & 0xff] : []),
  ];
  const length = body.length + payload.length;
  const header = [0x30 | flags];
  let x = length;
  do {
    let byte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) byte |= 0x80;
    header.push(byte);
  } while (x > 0);
  const out = new Uint8Array(header.length + length);
  out.set(header, 0);
  out.set(body, header.length);
  out.set(payload, header.length + body.length);
  return out;
}

test('MQTT encoders: byte for byte', () => {
  assert.deepEqual([...encodePuback(0x1234)], [0x40, 2, 0x12, 0x34]);
  assert.deepEqual([...encodePingreq()], [0xc0, 0]);
  assert.deepEqual([...encodeDisconnect()], [0xe0, 0]);
  assert.deepEqual([...encodeSubscribe(1, [{ topic: 'a/#', qos: 1 }])], [0x82, 8, 0, 1, 0, 3, 0x61, 0x2f, 0x23, 1]);
  const connect = encodeConnect({ clientId: 'c', keepAliveSeconds: 300, username: 'u', password: 'p' });
  assert.deepEqual(
    [...connect],
    [0x10, 19, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0xc2, 1, 44, 0, 1, 0x63, 0, 1, 0x75, 0, 1, 0x70],
  );
  assert.equal(encodeConnect({ clientId: 'c', keepAliveSeconds: 60, cleanSession: false })[9], 0);
  // A body of 128 bytes or more takes a second length byte.
  const long = encodeConnect({ clientId: 'c'.repeat(200), keepAliveSeconds: 60 });
  assert.deepEqual([long[1], long[2]], [0x80 | (212 % 128), 1]);
  assert.equal(long.length, 3 + 212);
  assert.throws(() => encodeConnect({ clientId: 'c'.repeat(70_000), keepAliveSeconds: 60 }), /65535/);
});

test('MQTT decode: each packet read, and each truncated one refused', () => {
  assert.deepEqual(decode(0x20, Uint8Array.of(1, 5)), { type: 'connack', sessionPresent: true, returnCode: 5 });
  assert.deepEqual(decode(0x40, Uint8Array.of(0x12, 0x34)), { type: 'puback', packetId: 0x1234 });
  assert.deepEqual(decode(0x90, Uint8Array.of(0, 7, 1, 0x80)), { type: 'suback', packetId: 7, returnCodes: [1, 0x80] });
  assert.deepEqual(decode(0xd0, new Uint8Array(0)), { type: 'pingresp' });
  assert.deepEqual(decode(0xb0, Uint8Array.of(0, 1)), { type: 'other', packetType: 11 });
  const plain = decode(0x31, publish('t/x', Uint8Array.of(9, 8)).subarray(2));
  assert.deepEqual(plain, {
    type: 'publish',
    topic: 't/x',
    payload: Uint8Array.of(9, 8),
    qos: 0,
    retained: true,
    dup: false,
  });
  const acked = decode(0x3a, publish('t', Uint8Array.of(7), 0x0a, 513).subarray(2));
  assert.deepEqual(acked, {
    type: 'publish',
    topic: 't',
    payload: Uint8Array.of(7),
    qos: 1,
    retained: false,
    dup: true,
    packetId: 513,
  });
  for (const [flags, body, message] of [
    [0x20, [0], /CONNACK truncated/],
    [0x40, [1], /PUBACK truncated/],
    [0x90, [], /SUBACK truncated/],
    [0x30, [0], /string truncated/],
    [0x30, [0, 5, 0x61], /string truncated/],
    [0x32, [0, 1, 0x61, 0], /PUBLISH truncated/],
    [0x36, [0, 1, 0x61, 0, 1], /QoS 3/],
  ] as Array<[number, number[], RegExp]>)
    assert.throws(() => decode(flags, Uint8Array.from(body)), message);
});

test('PacketReader: the same packets however the bytes are cut, payloads that stay what they were, and limits kept', () => {
  const payloadA = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  const payloadB = Uint8Array.from({ length: 5 }, (_, i) => 200 + i);
  const stream = new Uint8Array([
    ...publish('a/b', payloadA),
    0xd0,
    0,
    ...publish('c', payloadB, 0x02, 9),
    0x20,
    2,
    0,
    0,
    ...publish('empty', new Uint8Array(0)),
  ]);
  const read = (cuts: number[]): DecodedPacket[] => {
    const reader = new PacketReader();
    const out: DecodedPacket[] = [];
    let at = 0;
    for (const cut of [...cuts, stream.length]) {
      // Each chunk is its own memory, as a socket's are.
      out.push(...reader.push(stream.slice(at, cut)));
      at = cut;
    }
    return out;
  };
  const whole = read([]);
  assert.deepEqual(
    whole.map((p) => p.type),
    ['publish', 'pingresp', 'publish', 'connack', 'publish'],
  );
  assert.deepEqual(whole[0], { type: 'publish', topic: 'a/b', payload: payloadA, qos: 0, retained: false, dup: false });
  assert.deepEqual(whole[2], {
    type: 'publish',
    topic: 'c',
    payload: payloadB,
    qos: 1,
    retained: false,
    dup: false,
    packetId: 9,
  });
  assert.equal((whole[4] as { payload: Uint8Array }).payload.length, 0);
  // Byte by byte, in pairs, and cut at every single place.
  assert.deepEqual(read(Array.from({ length: stream.length - 1 }, (_, i) => i + 1)), whole);
  assert.deepEqual(read(Array.from({ length: Math.floor(stream.length / 2) - 1 }, (_, i) => (i + 1) * 2)), whole);
  for (let cut = 1; cut < stream.length; cut++) assert.deepEqual(read([cut]), whole, `cut at ${cut}`);
  for (let cut = 2; cut < stream.length; cut += 7)
    assert.deepEqual(read([cut - 1, cut, Math.min(cut + 3, stream.length)]), whole);

  // Nothing comes out until a packet is whole; an empty push is nothing.
  const reader = new PacketReader();
  assert.deepEqual(reader.push(new Uint8Array(0)), []);
  assert.deepEqual(reader.push(Uint8Array.of(0xd0)), []);
  assert.deepEqual(reader.push(Uint8Array.of(0)), [{ type: 'pingresp' }]);
  assert.deepEqual(reader.push(new Uint8Array(0)), []);

  // A payload handed out is not written over by what arrives next.
  const keeper = new PacketReader();
  const first = keeper.push(publish('k', Uint8Array.of(1, 2, 3)))[0] as { payload: Uint8Array };
  const kept = [...first.payload];
  keeper.push(publish('k', Uint8Array.of(9, 9, 9)));
  assert.deepEqual([...first.payload], kept);

  // The largest packet is read, one byte more is refused from its header alone, and a fifth length byte is malformed.
  const big = new PacketReader().push(publish('big', new Uint8Array(MAX_PACKET_BYTES - 5)));
  assert.equal((big[0] as { payload: Uint8Array }).payload.length, MAX_PACKET_BYTES - 5);
  assert.throws(
    () => new PacketReader().push(publish('big', new Uint8Array(MAX_PACKET_BYTES - 4)).subarray(0, 5)),
    /exceeds/,
  );
  assert.throws(() => new PacketReader().push(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01)), /malformed|exceeds/);
});

test('PacketReader: a 4 MB message in network-sized pieces is copied once, not once per piece', () => {
  const payload = new Uint8Array(MAX_PACKET_BYTES - 16).fill(7);
  const message = publish('big/one', payload);
  const reader = new PacketReader();
  const started = Date.now();
  let got: DecodedPacket[] = [];
  for (let at = 0; at < message.length; at += 512)
    got = reader.push(message.subarray(at, Math.min(at + 512, message.length)));
  const took = Date.now() - started;
  assert.equal(got.length, 1);
  const packet = got[0] as { topic: string; payload: Uint8Array };
  assert.equal(packet.topic, 'big/one');
  assert.equal(packet.payload.length, payload.length);
  assert.ok(packet.payload.every((b) => b === 7));
  assert.ok(took < 1500, `${took} ms`);
});

test('isValidTopicFilter', () => {
  for (const ok of ['a', 'a/b', '#', '+', 'a/+/b', 'a/#', '+/+/#', '/', 'a//b', '$SYS/#'])
    assert.equal(isValidTopicFilter(ok), true, ok);
  for (const bad of ['', '#/a', 'a/#/b', 'a+', '+a/b', 'a/b#', 'a/\0', 'x'.repeat(1025)])
    assert.equal(isValidTopicFilter(bad), false, bad.slice(0, 20));
});

// ---- small readers ---------------------------------------------------------------------

test('zimFileName: the download’s own name or nothing, and never a throw', () => {
  assert.equal(
    zimFileName('https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_2026-01.zim'),
    'wikipedia_en_all_2026-01.zim',
  );
  assert.equal(zimFileName('https://download.kiwix.org/zim/x/book.zim.meta4'), 'book.zim');
  assert.equal(zimFileName('https://download.kiwix.org/zim/x/book%2Ezim?x=1#frag'), 'book.zim');
  for (const bad of [
    'https://download.kiwix.org/zim/x/',
    'https://download.kiwix.org/zim/x/book.zip',
    'https://download.kiwix.org/zim/x/.hidden.zim',
    'https://download.kiwix.org/zim/x/a%2Fb.zim',
    'https://download.kiwix.org/zim/x/..%5Cup.zim',
    'https://download.kiwix.org/zim/x/sp ace.zim',
    `https://download.kiwix.org/zim/x/${'a'.repeat(250)}.zim`,
    'https://download.kiwix.org/zim/x/bad%ZZ.zim',
    'https://download.kiwix.org/zim/x/bad%.zim',
    'not a url',
    '',
  ])
    assert.equal(zimFileName(bad), undefined, bad.slice(0, 60));
});

test('local service ports, and the Ollama and Kolibri answers', () => {
  const none = {} as Parameters<typeof servicePort>[0];
  const own = { services: { ports: { ollama: 11500 } } } as unknown as Parameters<typeof servicePort>[0];
  assert.equal(servicePort(own, 'ollama'), 11500);
  assert.equal(serviceOrigin(own, 'ollama'), 'http://127.0.0.1:11500');
  assert.match(serviceOrigin(none, 'ollama'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(servicePort(none, 'kiwix'), servicePort(none, 'ollama'));

  assert.equal(readOllamaVersion({ version: '0.5.7' }), '0.5.7');
  for (const bad of [null, [], {}, { version: '' }, { version: 5 }, { version: 'v'.repeat(65) }])
    assert.throws(() => readOllamaVersion(bad));
  assert.deepEqual(
    readOllamaModels({
      models: [
        { name: 'llama3.2:3b', size: 2_019_393_189, details: { parameter_size: '3.2B', family: 'llama' } },
        { name: 'bare' },
        { name: 'odd', size: -1, details: { parameter_size: 5, family: 'f'.repeat(65) } },
        { name: '' },
        { size: 5 },
        null,
        { name: 'n'.repeat(201) },
      ],
    }),
    [
      { name: 'llama3.2:3b', sizeBytes: 2_019_393_189, parameterSize: '3.2B', family: 'llama' },
      { name: 'bare' },
      { name: 'odd' },
    ],
  );
  assert.equal(readOllamaModels({ models: Array.from({ length: 300 }, (_, i) => ({ name: `m${i}` })) }).length, 200);
  assert.deepEqual(readOllamaModels({ models: [] }), []);
  for (const bad of [null, {}, { models: {} }, 'x']) assert.throws(() => readOllamaModels(bad));

  assert.deepEqual(readKolibriInfo({ application: 'kolibri', kolibri_version: '0.17.2', device_name: 'Shelf' }), {
    version: '0.17.2',
    device: 'Shelf',
  });
  assert.deepEqual(
    readKolibriInfo({ application: 'kolibri', kolibri_version: '0.17.2', device_name: 'd'.repeat(101) }),
    { version: '0.17.2' },
  );
  for (const bad of [
    null,
    {},
    { application: 'other', kolibri_version: '1' },
    { application: 'kolibri' },
    { application: 'kolibri', kolibri_version: '' },
    { application: 'kolibri', kolibri_version: 'v'.repeat(65) },
  ])
    assert.throws(() => readKolibriInfo(bad), JSON.stringify(bad));
});

test('selectionOf: a box at its own zoom over the world layer; with no box, the world layer alone', () => {
  const bounds = { west: -161, south: 18, east: -154, north: 23 };
  type Req = Parameters<typeof selectionOf>[0];
  assert.deepEqual(selectionOf({ worldMaxZoom: 5, maxZoom: 12, bounds } as Req), {
    worldMaxZoom: 5,
    maxZoom: 12,
    bounds,
  });
  assert.deepEqual(selectionOf({ worldMaxZoom: 5, maxZoom: 12 } as Req), { worldMaxZoom: 5, maxZoom: 5 });
});

// ---- files -----------------------------------------------------------------------------

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wv-helpers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fileSha256: the digest of the bytes, of none, and of more than one read', async (t) => {
  const dir = tempDir(t);
  const empty = path.join(dir, 'empty');
  const large = path.join(dir, 'large');
  const bytes = Buffer.alloc(300_000, 'abc');
  writeFileSync(empty, '');
  writeFileSync(large, bytes);
  assert.equal(await fileSha256(empty), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await fileSha256(large), createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(fileSha256(path.join(dir, 'missing')), /ENOENT/);
});

test('findOnPath: the first directory that holds a runnable file of that name', async (t) => {
  const dir = tempDir(t);
  const [a, b, c] = ['a', 'b', 'c'].map((name) => {
    mkdirSync(path.join(dir, name));
    return path.join(dir, name);
  }) as [string, string, string];
  mkdirSync(path.join(a, 'tool'));
  writeFileSync(path.join(b, 'tool'), '#!/bin/sh\n');
  writeFileSync(path.join(c, 'tool'), '#!/bin/sh\n');
  chmodSync(path.join(c, 'tool'), 0o755);
  writeFileSync(path.join(c, 'tool.exe'), '');
  const posixPath = [a, path.join(dir, 'missing'), '', b, c].join(':');
  if (process.platform !== 'win32') {
    chmodSync(path.join(b, 'tool'), 0o644);
    assert.deepEqual(
      await findOnPath('tool', posixPath, 'linux'),
      { command: path.join(c, 'tool'), args: [] },
      'a folder of that name and a file that cannot be run are passed over',
    );
  }
  assert.deepEqual(
    await findOnPath('tool', [a, b, c].join(';'), 'win32'),
    { command: path.join(c, 'tool.exe'), args: [] },
    'on Windows only an .exe',
  );
  assert.equal(await findOnPath('absent', posixPath, 'linux'), undefined);
  assert.equal(await findOnPath('tool', undefined), undefined);
  assert.equal(await findOnPath('tool', ''), undefined);
});

test('resolveGrantedPath: inside the granted folder by its real path, or a typed refusal', async (t) => {
  const outer = tempDir(t);
  const folder = path.join(outer, 'granted');
  mkdirSync(path.join(folder, 'sub'), { recursive: true });
  writeFileSync(path.join(folder, 'sub', 'data.csv'), 'a,b\n');
  writeFileSync(path.join(outer, 'secret.txt'), 'secret');
  const ok = await resolveGrantedPath(folder, 'sub/data.csv');
  assert.ok(ok.real.endsWith(path.join('sub', 'data.csv')) && ok.stat.isFile() && ok.stat.size === 4);
  assert.equal((await resolveGrantedPath(folder, 'sub', { allowDirectory: true })).stat.isDirectory(), true);
  const refused = async (rel: string, code: string, ...where: [dir?: string | undefined]) => {
    const dir = where.length ? where[0] : folder;
    return;
    assert.rejects(
      resolveGrantedPath(dir, rel),
      (e: unknown) =>
        e instanceof ProviderError && e.code === code && e.retryable === false && !e.message.includes(outer),
      `${rel} -> ${code}`,
    );
  };
  await refused('sub', 'UNSUPPORTED');
  await refused('sub/missing.csv', 'UNSUPPORTED');
  await refused('../secret.txt', 'HOST_NOT_ALLOWED');
  await refused('sub/../../secret.txt', 'HOST_NOT_ALLOWED');
  await refused(path.join(outer, 'secret.txt'), 'HOST_NOT_ALLOWED');
  await refused('', 'HOST_NOT_ALLOWED');
  await refused('sub/data.csv', 'UNSUPPORTED', undefined);
  await refused('sub/data.csv', 'UNSUPPORTED', '   ');
  await refused('sub/data.csv', 'UNSUPPORTED', path.join(outer, 'no-such-folder'));
  await refused('data.csv', 'UNSUPPORTED', path.join(folder, 'sub', 'data.csv'));
  if (process.platform !== 'win32') {
    symlinkSync(path.join(outer, 'secret.txt'), path.join(folder, 'link.txt'));
    symlinkSync(path.join(folder, 'loop-b'), path.join(folder, 'loop-a'));
    symlinkSync(path.join(folder, 'loop-a'), path.join(folder, 'loop-b'));
    symlinkSync(path.join(folder, 'sub', 'data.csv'), path.join(folder, 'inside.csv'));
    symlinkSync(path.parse(outer).root, path.join(outer, 'root-link'));
    await refused('etc', 'UNSUPPORTED', path.join(outer, 'root-link'));
    await refused('sub/data.csv', 'UNSUPPORTED', path.parse(outer).root);
    await refused('link.txt', 'HOST_NOT_ALLOWED');
    await refused('loop-a', 'HOST_NOT_ALLOWED');
    assert.ok((await resolveGrantedPath(folder, 'inside.csv')).real.endsWith(path.join('sub', 'data.csv')));
  }
});
