import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, type WorldGeometry, type WorldObject } from '@opcb/world-model';
import { worldGeometryParts, worldGeometryToRender } from './contract.js';
import { autoGraphicsQuality, resolveGraphicsQuality } from './graphics.js';
import { ICON_IDS, isIconId } from './icons.js';
import { toPresentationInput } from './presentation-worker.js';
import { descendingPath, effectiveMode, fillAltitudes, satelliteMotion, type RenderingRule } from './presentation.js';
import { isTerrainCapable } from './renderer-host.js';
import { satelliteCategoryLabel, satelliteCategoryPurpose } from './satellite-category.js';
import { FrameCoalescer, ManualScheduler, createFrameScheduler } from './scheduler.js';
import { geodesicCircle } from './shapes.js';
import { CYCLONE_CATEGORIES, cycloneRank, isTornadoReport } from './storm-style.js';
import { DARK_THEME, desaturate, themeEntry } from './theme.js';

test('worldGeometryToRender: each kind, longitude and latitude the right way round, altitude kept', () => {
  assert.deepEqual(worldGeometryToRender({ type: 'Point', coordinates: [-157.8, 21.3] }), {
    kind: 'point',
    position: { latitude: 21.3, longitude: -157.8 },
  });
  assert.deepEqual(worldGeometryToRender({ type: 'Point', coordinates: [-157.8, 21.3, 100] }), {
    kind: 'point',
    position: { latitude: 21.3, longitude: -157.8, altitudeM: 100 },
  });
  assert.deepEqual(
    worldGeometryToRender({
      type: 'LineString',
      coordinates: [
        [0, 1],
        [2, 3],
      ],
    }),
    {
      kind: 'line',
      positions: [
        { latitude: 1, longitude: 0 },
        { latitude: 3, longitude: 2 },
      ],
    },
  );
  const ring: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  const ringOut = ring.map(([longitude, latitude]) => ({ latitude, longitude }));
  assert.deepEqual(worldGeometryToRender({ type: 'Polygon', coordinates: [ring] }), {
    kind: 'polygon',
    rings: [ringOut],
  });
  assert.deepEqual(
    worldGeometryToRender({
      type: 'MultiPoint',
      coordinates: [
        [5, 6],
        [7, 8],
      ],
    }),
    { kind: 'point', position: { latitude: 6, longitude: 5 } },
  );
  assert.equal(worldGeometryToRender({ type: 'MultiPoint', coordinates: [] }), undefined);
  assert.equal(worldGeometryToRender({ type: 'MultiPolygon', coordinates: [] }), undefined);
  const multi: WorldGeometry = { type: 'MultiPolygon', coordinates: [[ring], [], [ring, ring]] };
  assert.deepEqual(
    worldGeometryToRender(multi),
    { kind: 'polygon', rings: [ringOut] },
    'the one-shape form keeps the first part',
  );
  assert.deepEqual(worldGeometryParts(multi), [
    { kind: 'polygon', rings: [ringOut] },
    { kind: 'polygon', rings: [ringOut, ringOut] },
  ]);
  const lines: WorldGeometry = {
    type: 'MultiLineString',
    coordinates: [
      [
        [0, 0],
        [1, 1],
      ],
      [[9, 9]],
      [
        [5, 5],
        [6, 6],
      ],
    ],
  };
  assert.equal(worldGeometryParts(lines).length, 2, 'a part of one point is no line');
  assert.deepEqual(worldGeometryParts({ type: 'Point', coordinates: [1, 2] }), [
    { kind: 'point', position: { latitude: 2, longitude: 1 } },
  ]);
  assert.deepEqual(worldGeometryParts({ type: 'MultiPoint', coordinates: [] }), []);
});

test('graphics quality on Auto, icon ids, terrain capability', () => {
  assert.equal(autoGraphicsQuality('discrete'), 'high');
  assert.equal(autoGraphicsQuality('software'), 'low');
  assert.equal(autoGraphicsQuality('integrated'), 'balanced');
  assert.equal(autoGraphicsQuality('unknown'), 'balanced');
  for (const q of ['high', 'balanced', 'low'] as const)
    assert.equal(resolveGraphicsQuality(q, 'SwiftShader'), q, 'a chosen quality is kept whatever the GPU');
  assert.equal(resolveGraphicsQuality(undefined, undefined), 'balanced');

  for (const id of ICON_IDS) assert.equal(isIconId(id), true, id);
  for (const id of ['', 'Aircraft', 'constructor', 'toString', 'aircraft ']) assert.equal(isIconId(id), false, id);
  assert.equal(new Set(ICON_IDS).size, ICON_IDS.length, 'no icon id twice');

  type R = Parameters<typeof isTerrainCapable>[0];
  assert.equal(isTerrainCapable({ setTerrain() {} } as unknown as R), true);
  assert.equal(isTerrainCapable({} as unknown as R), false);
  assert.equal(isTerrainCapable({ setTerrain: true } as unknown as R), false);
});

test('toPresentationInput: only what the request names, and the visible types as a set', () => {
  const view = { center: { latitude: 0, longitude: 0 } } as unknown as Parameters<
    typeof toPresentationInput
  >[0]['view'];
  assert.deepEqual(Object.keys(toPresentationInput({ objects: [], view })), ['objects', 'view']);
  const full = toPresentationInput({
    objects: [],
    view,
    events: [],
    rules: [],
    visibleTypes: ['aircraft', 'aircraft', 'vessel'],
    selectedId: null,
    hoveredId: 'h',
    selectedTrack: [],
    maxFeatures: 0,
    detail: 0,
  });
  assert.deepEqual([...full.visibleTypes!], ['aircraft', 'vessel']);
  assert.equal(full.selectedId, null, 'no selection is said, not left out');
  assert.deepEqual([full.hoveredId, full.maxFeatures, full.detail], ['h', 0, 0]);
  assert.ok('events' in full && 'rules' in full && 'selectedTrack' in full && !('selectedRoute' in full));
});

test('effectiveMode: the governor only ever makes a mode cheaper, and never hides or counts what was drawn', () => {
  const cost = ['hidden', 'density', 'points', 'markers', 'icons'] as const;
  for (const authored of cost) {
    const rule = {
      lod: { global: authored, continental: authored, regional: authored, local: authored },
    } as unknown as RenderingRule;
    assert.equal(effectiveMode(rule, 'local', 0), authored);
    for (const detail of [1, 2] as const) {
      const got = effectiveMode(rule, 'regional', detail);
      assert.ok(cost.indexOf(got) <= cost.indexOf(authored), `${authored} at ${detail} -> ${got}`);
      if (authored === 'hidden' || authored === 'density') assert.equal(got, authored);
      else assert.ok(got !== 'hidden' && got !== 'density', `${authored} at ${detail} -> ${got}`);
    }
  }
  const icons = {
    lod: { global: 'points', continental: 'markers', regional: 'icons', local: 'icons' },
  } as unknown as RenderingRule;
  assert.deepEqual(
    [
      effectiveMode(icons, 'local', 1),
      effectiveMode(icons, 'local', 2),
      effectiveMode(icons, 'continental', 1),
      effectiveMode(icons, 'continental', 2),
    ],
    ['markers', 'points', 'markers', 'points'],
  );
});

test('descendingPath and fillAltitudes', () => {
  const path = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 },
    { latitude: 0, longitude: 3 },
    { latitude: 0, longitude: 4 },
  ];
  const down = descendingPath(path, 4000);
  assert.deepEqual(
    down.map((p) => p.altitudeM),
    [4000, 3000, 1000, 0],
  );
  assert.deepEqual(
    down.map((p) => p.longitude),
    [0, 1, 3, 4],
  );
  assert.ok(!('altitudeM' in path[0]!), 'the path given is not written to');
  assert.deepEqual(descendingPath([path[0]!], 1234.6), [{ latitude: 0, longitude: 0, altitudeM: 1235 }]);
  assert.deepEqual(
    descendingPath([path[0]!, path[0]!], 500).map((p) => p.altitudeM),
    [500, 500],
    'no length: the height is kept',
  );
  assert.deepEqual(descendingPath([], 500), []);

  const p = (altitudeM?: number) => ({ latitude: 0, longitude: 0, ...(altitudeM !== undefined ? { altitudeM } : {}) });
  assert.deepEqual(
    fillAltitudes([p(), p(100), p(), p(Number.NaN), p(300), p()])!.map((x) => x.altitudeM),
    [100, 100, 100, 100, 300, 300],
  );
  assert.equal(fillAltitudes([p(), p(Number.NaN)]), undefined);
  assert.equal(fillAltitudes([]), undefined);
  const whole = [p(1), p(2)];
  assert.deepEqual(fillAltitudes(whole), whole);
});

test('satelliteMotion: one short step forward to a place on the globe, or nothing', () => {
  const at = '2026-11-19T10:00:00.000Z';
  const fromMs = Date.parse(at);
  const sat = (next: unknown, propagatedAt: unknown = at, extra: Record<string, unknown> = {}) =>
    ({
      id: 's',
      type: 'satellite',
      position: { latitude: 0, longitude: 0 },
      properties: { nextPosition: next, propagatedAt },
      ...extra,
    }) as unknown as WorldObject;
  assert.deepEqual(satelliteMotion(sat([10, 20, 400_000, fromMs + 60_000])), {
    to: { latitude: 10, longitude: 20, altitudeM: 400_000 },
    fromMs,
    toMs: fromMs + 60_000,
  });
  assert.ok(satelliteMotion(sat([-90, 180, 0, fromMs + 120_000])));
  for (const [why, object] of [
    ['not a satellite', sat([10, 20, 400_000, fromMs + 60_000], at, { type: 'aircraft' })],
    ['no position now', sat([10, 20, 400_000, fromMs + 60_000], at, { position: undefined })],
    ['no next position', sat(undefined)],
    ['three values', sat([10, 20, 400_000])],
    ['five values', sat([10, 20, 400_000, fromMs + 60_000, 1])],
    ['text for a number', sat(['10', 20, 400_000, fromMs + 60_000])],
    ['no time', sat([10, 20, 400_000, fromMs + 60_000], null)],
    ['a time that is not one', sat([10, 20, 400_000, fromMs + 60_000], 'soon')],
    ['backwards', sat([10, 20, 400_000, fromMs - 1])],
    ['no step', sat([10, 20, 400_000, fromMs])],
    ['too long a step', sat([10, 20, 400_000, fromMs + 120_001])],
    ['latitude off the globe', sat([91, 20, 400_000, fromMs + 60_000])],
    ['longitude off the globe', sat([10, -181, 400_000, fromMs + 60_000])],
    ['latitude not a number at all', sat([Number.NaN, 20, 400_000, fromMs + 60_000])],
    ['longitude not a number at all', sat([10, Number.NaN, 400_000, fromMs + 60_000])],
    ['altitude not a number at all', sat([10, 20, Number.NaN, fromMs + 60_000])],
    ['altitude without end', sat([10, 20, Infinity, fromMs + 60_000])],
    ['a time without end', sat([10, 20, 400_000, Infinity])],
  ] as Array<[string, WorldObject]>)
    assert.equal(satelliteMotion(object), undefined, why);
});

test('satellite categories: a label and a purpose for the ones known, nothing for a name every object has', () => {
  assert.equal(typeof satelliteCategoryLabel('starlink'), 'string');
  for (const other of ['constructor', 'toString', '__proto__', 'STARLINK', '', 5, null, undefined]) {
    assert.equal(satelliteCategoryLabel(other), undefined, String(other));
    assert.equal(satelliteCategoryPurpose(other), undefined, String(other));
  }
  assert.equal(satelliteCategoryPurpose('other'), undefined, 'not otherwise classified implies no purpose');
});

test('frame scheduling: one run per frame however often asked, and a cancelled frame never runs', async () => {
  const manual = new ManualScheduler();
  let runs = 0;
  const coalescer = new FrameCoalescer(manual, () => runs++);
  coalescer.schedule();
  coalescer.schedule();
  coalescer.schedule();
  assert.equal(manual.pendingCount, 1);
  assert.equal(coalescer.scheduled, true);
  assert.equal(manual.flush(), 1);
  assert.deepEqual([runs, coalescer.scheduled, manual.now()], [1, false, 16]);
  coalescer.schedule();
  manual.flush(4);
  assert.deepEqual([runs, manual.now()], [2, 20]);
  const cancelled = manual.request(() => assert.fail('cancelled'));
  manual.cancel(cancelled);
  assert.equal(manual.flush(), 0);
  // A callback queued during a flush waits for the next one.
  let late = 0;
  manual.request(() => manual.request(() => late++));
  manual.flush();
  assert.equal(late, 0);
  manual.flush();
  assert.equal(late, 1);

  // Without requestAnimationFrame (Node, a hidden window) a timer stands in.
  const scheduler = createFrameScheduler(1);
  const before = scheduler.now();
  const stamp = await new Promise<number>((resolve) => scheduler.request(resolve));
  assert.ok(Number.isFinite(stamp) && stamp >= before);
  let ran = false;
  const handle = scheduler.request(() => (ran = true));
  assert.equal(typeof handle, 'number');
  scheduler.cancel(handle);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(ran, false);
});

test('geodesicCircle: a closed ring, every point the radius from the centre, also across the 180th meridian and a pole', () => {
  for (const center of [
    { latitude: 21.3, longitude: -157.8 },
    { latitude: 0, longitude: 179.9 },
    { latitude: 89.5, longitude: 10 },
    { latitude: -45, longitude: 0 },
  ]) {
    for (const radiusM of [100, 50_000, 2_000_000]) {
      const ring = geodesicCircle(center, radiusM);
      assert.equal(ring.length, 65);
      assert.deepEqual(ring[0], ring[64]);
      for (const p of ring) {
        assert.ok(Math.abs(p.latitude) <= 90 && p.longitude >= -180 && p.longitude < 180, JSON.stringify(p));
        const d = haversineMeters(center, p);
        assert.ok(Math.abs(d - radiusM) < Math.max(1, radiusM * 1e-6), `${JSON.stringify(center)} r=${radiusM} d=${d}`);
      }
    }
  }
  assert.equal(geodesicCircle({ latitude: 0, longitude: 0 }, 1000, 8).length, 9);
  for (const segments of [0, 1, 2, -5, Number.NaN]) {
    const ring = geodesicCircle({ latitude: 0, longitude: 0 }, 1000, segments);
    assert.ok(
      ring.length >= 4 && ring.every((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude)),
      String(segments),
    );
  }
  assert.equal(geodesicCircle({ latitude: 0, longitude: 0 }, 1000, 12.7).length, 13);
});

test('cyclone rank, tornado reports, desaturate, and a theme entry by its own name only', () => {
  assert.deepEqual(CYCLONE_CATEGORIES.map(cycloneRank), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(isTornadoReport({ type: 'weather-alert', properties: { reportType: 'Tornado' } }), true);
  assert.equal(isTornadoReport({ type: 'weather-alert', properties: { reportType: 'Hail' } }), false);
  assert.equal(isTornadoReport({ type: 'weather-alert', properties: {} }), false);
  assert.equal(isTornadoReport({ type: 'storm', properties: { reportType: 'Tornado' } }), false);

  const c = { r: 1, g: 0, b: 0, a: 0.5 };
  assert.deepEqual(desaturate(c, 0), c);
  const grey = desaturate(c, 1);
  for (const v of [grey.r, grey.g, grey.b]) assert.ok(Math.abs(v - 0.299) < 1e-12);
  assert.equal(grey.a, 0.5);
  const half = desaturate(c, 0.5);
  assert.ok(Math.abs(half.r - 0.6495) < 1e-12 && Math.abs(half.g - 0.1495) < 1e-12);

  const [known] = Object.keys(DARK_THEME.entries) as [string];
  assert.equal(themeEntry(known), DARK_THEME.entries[known]);
  assert.equal(
    themeEntry(`${known}.cluster.deeper`),
    DARK_THEME.entries[known],
    'a suffix inherits its parent’s entry',
  );
  for (const name of [
    'no-such-class',
    '',
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
    'no-such-class.constructor',
    'valueOf.x',
  ])
    assert.equal(themeEntry(name), DARK_THEME.fallback, name);
});
