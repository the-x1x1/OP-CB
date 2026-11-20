import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCollection,
  validateLens,
  validateRegion,
  validateStoredCamera,
  validateWatchZone,
} from './validate.js';

/**
 * The readers of the operator's own documents (collections, watch zones, lenses, cameras),
 * given documents built at random from good and bad parts. Whatever a reader lets through
 * must be something it lets through unchanged the next time the file is read — a document
 * that changed on every load would be rewritten on every start — and must survive being
 * written as JSON. Documents are generated from a fixed seed.
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
const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
const maybe = <T>(good: () => T, bad: readonly unknown[], badOdds = 0.12): unknown =>
  next() < badOdds ? pick(bad) : good();

const JUNK: unknown[] = [
  undefined,
  null,
  '',
  ' ',
  0,
  -1,
  1e308,
  Number.NaN,
  true,
  [],
  {},
  'constructor',
  '__proto__',
  [[]],
  { kind: 'x' },
];
const TEXTS = [
  'Harbour',
  '  padded  ',
  'x'.repeat(119) + ' y',
  'x'.repeat(199) + ' y',
  'x'.repeat(5000),
  '😀'.repeat(150),
  'a\u0000b',
  'constructor',
];
const TIMES = [
  '2026-11-20T00:00:00.000Z',
  '2026-11-20T10:00',
  '2026-11-20T00:00:00-10:00',
  '1',
  'Tue 5',
  '2026-13-45T99:99:99Z',
  '2026-11-20',
];
const IDS = [
  'a',
  'zone-1',
  '  spaced  ',
  'x'.repeat(128),
  'x'.repeat(129),
  'x'.repeat(126) + '  ',
  '0123456789ab',
  'constructor',
];

const position = () => ({
  latitude: pick([21.3, -90, 90, 91, Number.NaN, '21']),
  longitude: pick([-157.8, 180, -180, 181, 1e9]),
  altitudeM: pick([undefined, 5, Number.POSITIVE_INFINITY, 'x']),
});
const boundsOf = () => ({
  west: pick([-160, 170, 1e9, Number.NaN]),
  south: pick([18, -91, 30]),
  east: pick([-154, -170, 0]),
  north: pick([23, 91, 10]),
});
const region = (): unknown =>
  pick([
    () => ({ kind: 'bounds', bounds: maybe(boundsOf, JUNK) }),
    () => ({
      kind: 'circle',
      center: maybe(position, JUNK),
      radiusM: pick([1000, 0, -5, 1e300, Number.POSITIVE_INFINITY, '5']),
    }),
    () => ({
      kind: 'polygon',
      polygon: maybe(
        () =>
          Array.from({ length: Math.floor(next() * 6) }, () =>
            maybe(() => [pick([-158, 181, 1e9]), pick([21, 91, -90]), 7], [[1], ['a', 'b'], null, [Number.NaN, 0]]),
          ),
        JUNK,
      ),
    }),
    () => ({ kind: 'admin', regionId: maybe(() => pick(IDS), JUNK), bounds: maybe(boundsOf, JUNK, 0.5) }),
    () => pick(JUNK),
  ])();

const item = () => ({
  id: maybe(() => pick(IDS), JUNK),
  kind: pick(['location', 'object', 'event', 'watchzone', 'note', 'lens', 'constructor', 5]),
  title: maybe(() => pick(TEXTS), JUNK),
  createdAt: maybe(() => pick(TIMES), JUNK),
  updatedAt: maybe(() => pick(TIMES), JUNK),
  position: maybe(position, JUNK, 0.3),
  objectId: maybe(() => pick(IDS), JUNK, 0.3),
  lensId: pick(['x'.repeat(256), 'x'.repeat(257), '  y  ']),
  note: maybe(() => pick(TEXTS), JUNK, 0.3),
  tags: maybe(() => [pick(TEXTS), '', 5, pick(TEXTS)], JUNK, 0.3),
  extra: 'not kept',
});

function settles<T>(name: string, read: (value: unknown) => T | undefined, make: () => unknown, count: number): number {
  let through = 0;
  for (let i = 0; i < count; i++) {
    const raw = make();
    let first: T | undefined;
    try {
      first = read(raw);
    } catch (error) {
      assert.fail(`${name} threw ${String(error)}`);
    }
    if (first === undefined) continue;
    through++;
    const written = JSON.stringify(first, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        throw new Error(`${name} let a number through that is not one`);
      return value;
    });
    const again = read(JSON.parse(written));
    assert.deepEqual(again, first, `${name} read its own output differently`);
    assert.equal(Object.getPrototypeOf(first), Object.prototype);
  }
  return through;
}

test('a region that is let through reads the same when read again', () => {
  assert.ok(settles('region', validateRegion, region, 6000) > 800);
});

test('a collection that is let through reads the same when read again', () => {
  const through = settles(
    'collection',
    validateCollection,
    () => ({
      id: maybe(() => pick(IDS), JUNK),
      name: maybe(() => pick(TEXTS), JUNK),
      createdAt: maybe(() => pick(TIMES), JUNK, 0.05),
      updatedAt: maybe(() => pick(TIMES), JUNK, 0.05),
      items: maybe(() => Array.from({ length: Math.floor(next() * 6) }, () => maybe(item, JUNK)), JUNK),
    }),
    6000,
  );
  assert.ok(through > 400, `${through} let through`);
});

test('a watch zone that is let through reads the same when read again', () => {
  const through = settles(
    'watch zone',
    validateWatchZone,
    () => ({
      id: maybe(() => pick(IDS), JUNK, 0.05),
      name: maybe(() => pick(TEXTS), JUNK, 0.05),
      geometry: region(),
      eventTypes: maybe(() => [pick(TEXTS), 'earthquake', '', 7], JUNK, 0.05),
      createdAt: maybe(() => pick(TIMES), JUNK, 0.05),
      notifications: maybe(() => ({ inApp: pick([true, false, 'yes']), desktop: pick([true, 1]) }), JUNK, 0.05),
      enabled: pick([true, false, undefined, 'no']),
      minimumSeverity: pick(['minor', 'severe', 'constructor', 5, undefined]),
      desktopMinimumSeverity: pick(['extreme', 'toString', undefined]),
      quietHours: pick([
        { start: '22:00', end: '07:00' },
        { start: '22:00', end: '22:00' },
        { start: '24:00', end: '07:00' },
        'x',
        undefined,
      ]),
    }),
    8000,
  );
  assert.ok(through > 250, `${through} let through`);
});

test('a lens that is let through reads the same when read again', () => {
  const list = () => maybe(() => [pick(TEXTS), 'aircraft', '', 3], JUNK, 0.05);
  const through = settles(
    'lens',
    validateLens,
    () => ({
      id: maybe(() => pick(IDS), JUNK, 0.05),
      name: maybe(() => pick(TEXTS), JUNK, 0.05),
      objectTypes: list(),
      eventTypes: list(),
      visiblePanels: list(),
      renderingRules: maybe(
        () => [{ objectType: 'aircraft', icon: 'constructor' }, 'x', null, [1], { nested: { deep: [1, 2] } }],
        JUNK,
      ),
      description: maybe(() => pick(TEXTS), JUNK, 0.3),
      providerPreferences: list(),
      builtIn: pick([true, false, 'true']),
    }),
    6000,
  );
  assert.ok(through > 800, `${through} let through`);
});

test('a stored camera that is let through reads the same when read again, and never carries a password', () => {
  const urls = [
    'https://cam.example.org/live.m3u8',
    'http://192.168.1.20/mjpg/video.mjpg',
    'rtsp://192.168.1.20:554/stream1',
    'https://user:secret@cam.example.org/live.m3u8',
    'rtsp://admin:secret@192.168.1.20/stream1',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,x',
    'not a url',
    ' https://cam.example.org/x ',
    'HTTPS://CAM.EXAMPLE.ORG/x',
  ];
  let seen = 0;
  const through = settles(
    'camera',
    (value) => {
      const camera = validateStoredCamera(value);
      if (camera) {
        seen++;
        const u = new URL(camera.url);
        assert.ok(['http:', 'https:', 'rtsp:', 'rtsps:'].includes(u.protocol), camera.url);
        assert.equal(u.username + u.password, '', camera.url);
        assert.ok(camera.name.length > 0 && camera.name === camera.name.trim(), JSON.stringify(camera.name));
        if (camera.headingDegrees !== undefined) assert.ok(camera.headingDegrees >= 0 && camera.headingDegrees < 360);
      }
      return camera;
    },
    () => ({
      [pick(['cameraId', 'id'])]: pick(['0123456789ab', '0123456789AB', '0123456789abc', 5]),
      name: maybe(() => pick(TEXTS), JUNK, 0.05),
      url: maybe(() => pick(urls), JUNK, 0.05),
      kind: pick(['mjpeg', 'hls', 'snapshot', 'rtsp', 'rtsp', 'constructor']),
      objectId: maybe(() => pick(IDS), JUNK, 0.05),
      registeredAt: maybe(() => pick(TIMES), JUNK, 0.05),
      credentialKey: pick([undefined, 'camera.0123456789ab.credential', 'camera.x.credential', 5]),
      position: maybe(position, JUNK, 0.3),
      headingDegrees: pick([undefined, 0, 359.5, 360, -90, 725, -0, Number.NaN, 1e308, -1e-320]),
    }),
    8000,
  );
  assert.ok(through > 150 && seen > 150, `${through} let through`);
});
