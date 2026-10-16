import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldEvent, WorldObject } from '@worldview/world-model';
import { DEFAULT_RULES } from '../engine.js';
import {
  GNSS_CELL_DEG,
  cellSeverity,
  gnssCellOf,
  gnssInterferenceRule,
  navigationDegraded,
} from './gnss-interference.js';

const T0 = Date.parse('2026-10-15T20:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let n = 0;
function aircraft(lat: number, lon: number, props: Record<string, unknown>, sec = 0): WorldObject {
  const id = (++n).toString(16).padStart(6, '0');
  return {
    id: `aircraft:icao24:${id}`,
    type: 'aircraft',
    labels: {},
    position: { latitude: lat, longitude: lon, altitudeM: 10_000 },
    observedAt: at(sec),
    properties: { icao24: id, onGround: false, adsbVersion: 2, ...props },
    confidence: 0.9,
    freshness: 'LIVE',
    sourceRefs: [{ providerId: 'adsb-lol', observationId: `o${id}` }],
    provenance: { providerId: 'adsb-lol', sourceName: 'adsb.lol', origin: 'live', receivedAt: at(sec) },
  } as unknown as WorldObject;
}
const good = (lat: number, lon: number) => aircraft(lat, lon, { navIntegrity: 8, navAccuracy: 9 });
const bad = (lat: number, lon: number) => aircraft(lat, lon, { navIntegrity: 0, navAccuracy: 0 });

function runner() {
  const store = new Map<string, WorldEvent>();
  return {
    store,
    step(objects: WorldObject[], sec: number): WorldEvent[] {
      const out = gnssInterferenceRule.evaluate(objects, {
        now: T0 + sec * 1000,
        nowIso: at(sec),
        existing: () => [...store.values()],
      });
      for (const e of out) store.set(e.id, e);
      return out;
    },
  };
}

test('degraded: NIC below 7, NACp below 8, or a GPS fix lost in the last ten minutes; no integrity, no say', () => {
  assert.equal(navigationDegraded(good(33, 44)), false);
  assert.equal(navigationDegraded(aircraft(33, 44, { navIntegrity: 6, navAccuracy: 9 })), true);
  assert.equal(navigationDegraded(aircraft(33, 44, { navIntegrity: 8, navAccuracy: 7 })), true);
  assert.equal(
    navigationDegraded(aircraft(33, 44, { navIntegrity: 8, navAccuracy: 9, gpsLostAt: at(-300) })),
    true,
    'lost five minutes before the report',
  );
  assert.equal(
    navigationDegraded(aircraft(33, 44, { navIntegrity: 8, navAccuracy: 9, gpsLostAt: at(-3600) })),
    false,
    'lost an hour ago and good since',
  );
  assert.equal(navigationDegraded(aircraft(33, 44, { navIntegrity: 8 })), undefined, 'no NACp');
  assert.equal(navigationDegraded(aircraft(33, 44, { navIntegrity: 0, navAccuracy: 0, adsbVersion: 0 })), undefined);
  assert.equal(
    navigationDegraded(aircraft(33, 44, { navIntegrity: 0, navAccuracy: 0, onGround: true })),
    undefined,
    'on the ground',
  );
});

test('cells are 0.5° by their south-west corner; the bands are gpsjam.org’s', () => {
  assert.deepEqual(gnssCellOf(33.74, 44.26), { south: 33.5, west: 44 });
  assert.deepEqual(gnssCellOf(-0.1, -0.1), { south: -0.5, west: -0.5 });
  assert.deepEqual(gnssCellOf(10, 180), { south: 10, west: -180 }, '180° is -180°');
  assert.equal(GNSS_CELL_DEG, 0.5);
  assert.equal(cellSeverity(1, 2), undefined, 'one degraded aircraft is a faulty unit');
  assert.equal(cellSeverity(2, 100), 'MINOR', '2 %');
  assert.equal(cellSeverity(2, 101), undefined, 'under 2 %');
  assert.equal(cellSeverity(10, 100), 'MINOR', '10 % is still the yellow band');
  assert.equal(cellSeverity(3, 20), 'MODERATE', 'over 10 %');
});

test('a cell with degraded aircraft is raised with its square, kept while it qualifies, ended when it clears', () => {
  const r = runner();
  // Over Baghdad: four of six degraded. Over Honolulu: one of three — a faulty unit.
  const baghdad = [
    bad(33.3, 44.3),
    bad(33.4, 44.2),
    bad(33.2, 44.4),
    bad(33.1, 44.1),
    good(33.3, 44.2),
    good(33.4, 44.4),
  ];
  const honolulu = [bad(21.3, -157.9), good(21.3, -157.8), good(21.4, -157.9)];
  const first = r.step([...baghdad, ...honolulu], 0);
  assert.equal(first.length, 1);
  const e = first[0]!;
  assert.equal(e.id, 'event:gnss-interference:worldview:33.0_44.0');
  assert.equal(e.type, 'gnss-interference');
  assert.equal(e.severity, 'MODERATE');
  assert.equal(e.title, 'GNSS interference likely near 33.25°N 44.25°E');
  assert.deepEqual(e.geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [44, 33],
        [44.5, 33],
        [44.5, 33.5],
        [44, 33.5],
        [44, 33],
      ],
    ],
  });
  assert.equal(e.objectIds.length, 4, 'the degraded aircraft');
  assert.equal(e.properties?.['degradedPercent'], 67);
  assert.equal(e.properties?.['band'], 'high');
  assert.equal(e.confidence, 'LOW');
  assert.match(e.summary ?? '', /^4 of 6 aircraft here \(67 %\) report degraded satellite navigation/);

  const second = r.step(baghdad, 60);
  assert.equal(second[0]!.startAt, at(0), 'an open cell keeps its start');
  assert.equal(second[0]!.endAt, undefined);

  const cleared = r.step([good(33.3, 44.3), good(33.4, 44.2)], 120);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]!.endAt, at(120));
  assert.equal(r.step([], 180).length, 0, 'an ended cell is not ended again');
});

test('MLAT, TIS-B and old aircraft carry no integrity and are not counted', () => {
  const r = runner();
  const out = r.step(
    [
      bad(50.1, 20.1),
      aircraft(50.2, 20.2, {}),
      aircraft(50.3, 20.3, { navIntegrity: 0, navAccuracy: 0, adsbVersion: 0 }),
    ],
    0,
  );
  assert.equal(out.length, 0, 'one degraded aircraft with integrity');
});

test('the rule is one of the engine’s', () => {
  assert.ok(DEFAULT_RULES.includes(gnssInterferenceRule));
});

test('aircraft heard more than ten minutes ago are not counted', () => {
  const r = runner();
  const old = [
    aircraft(40.1, 30.1, { navIntegrity: 0, navAccuracy: 0 }, -700),
    aircraft(40.2, 30.2, { navIntegrity: 0, navAccuracy: 0 }, -700),
  ];
  assert.equal(r.step(old, 0).length, 0);
  const fresh = [
    aircraft(40.1, 30.1, { navIntegrity: 0, navAccuracy: 0 }, -60),
    aircraft(40.2, 30.2, { navIntegrity: 0, navAccuracy: 0 }, -60),
  ];
  assert.equal(r.step(fresh, 0).length, 1);
});
