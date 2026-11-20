import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_FRESHNESS_POLICY,
  assertSchema,
  freshnessPolicyFor,
  ownEntry,
  compareFeedTime,
  deepFreeze,
  isBasemapOverlay,
  isJsonObject,
  isoToMs,
  isValidTimeRange,
  makeEventId,
  positionToGeometry,
  precisionFactor,
  regionBounds,
  regionContains,
  s,
  solarEcliptic,
  subsolarPoint,
  timeRangeContains,
  toIso,
  utmCentralMeridian,
  wrap180Deg,
  type GeoRegion,
} from './index.js';

/** Equal to `digits` decimal places. */
function close(actual: number, expected: number, digits: number): void {
  assert.ok(Math.abs(actual - expected) < 0.5 * 10 ** -digits, `${actual} is not close to ${expected}`);
}

describe('time helpers', () => {
  it('toIso and isoToMs are inverses to the millisecond', () => {
    for (const ms of [0, 1, 1_767_225_600_123, 253_402_300_799_999]) {
      assert.equal(isoToMs(toIso(ms)), ms);
      assert.equal(toIso(new Date(ms)), toIso(ms));
    }
    assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  });

  it('a range contains both of its ends and nothing outside', () => {
    const range = { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
    assert.equal(timeRangeContains(range, range.start), true);
    assert.equal(timeRangeContains(range, range.end), true);
    assert.equal(timeRangeContains(range, '2026-01-01T12:00:00.500Z'), true);
    assert.equal(timeRangeContains(range, '2025-12-31T23:59:59.999Z'), false);
    assert.equal(timeRangeContains(range, '2026-01-02T00:00:00.001Z'), false);
  });

  it('an unreadable time is in no range, and an unreadable range holds nothing', () => {
    const range = { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
    assert.equal(timeRangeContains(range, 'yesterday'), false);
    assert.equal(timeRangeContains({ start: 'x', end: 'y' }, '2026-01-01T00:00:00Z'), false);
  });

  it('a valid range has two timestamps in order; an instant is a range', () => {
    const t = '2026-01-01T00:00:00Z';
    assert.equal(isValidTimeRange({ start: t, end: t }), true);
    assert.equal(isValidTimeRange({ start: t, end: '2026-01-01T00:00:00.001Z' }), true);
    assert.equal(isValidTimeRange({ start: '2026-01-02T00:00:00Z', end: t }), false);
    assert.equal(isValidTimeRange({ start: '2026-01-01', end: t }), false);
    assert.equal(isValidTimeRange({} as never), false);
  });
});

describe('json helpers', () => {
  it('isJsonObject is true for plain objects only', () => {
    assert.equal(isJsonObject({}), true);
    assert.equal(isJsonObject({ a: [1] }), true);
    for (const v of [null, undefined, [], [{}], 'x', 0, true]) assert.equal(isJsonObject(v), false);
  });

  it('deepFreeze freezes every level, returns the same value and survives a cycle', () => {
    const value = { a: { b: [{ c: 1 }] }, n: 1 };
    assert.equal(deepFreeze(value), value);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.a.b), true);
    assert.equal(Object.isFrozen(value.a.b[0]), true);
    const loop: { self?: unknown } = {};
    loop.self = loop;
    assert.doesNotThrow(() => deepFreeze(loop));
    assert.equal(deepFreeze(5), 5);
    assert.equal(deepFreeze(null), null);
  });
});

describe('small world-model helpers', () => {
  it('precisionFactor steps at 50 m, 500 m and 5 km, and is 0.5 when unreported', () => {
    assert.equal(precisionFactor(0), 1);
    assert.equal(precisionFactor(50), 1);
    assert.equal(precisionFactor(50.01), 0.8);
    assert.equal(precisionFactor(500), 0.8);
    assert.equal(precisionFactor(500.01), 0.6);
    assert.equal(precisionFactor(5000), 0.6);
    assert.equal(precisionFactor(5000.01), 0.4);
    assert.equal(precisionFactor(undefined), 0.5);
    assert.equal(precisionFactor(Number.NaN), 0.5);
    assert.equal(precisionFactor(Number.POSITIVE_INFINITY), 0.5);
  });

  it('makeEventId joins its parts in order', () => {
    assert.equal(makeEventId('earthquake', 'usgs', 'us7000abcd'), 'event:earthquake:usgs:us7000abcd');
  });

  it('compareFeedTime puts the newest first, then the lower id, and an unreadable time last', () => {
    const at = (id: string, time: string) => ({ id, at: time, severity: 'MINOR' as const });
    const older = at('a', '2026-01-01T00:00:00Z');
    const newer = at('b', '2026-01-01T00:00:01Z');
    const unreadable = at('c', 'not a time');
    assert.ok(compareFeedTime(newer, older) < 0);
    assert.ok(compareFeedTime(older, newer) > 0);
    assert.equal(compareFeedTime(older, at('a', older.at)), 0);
    assert.ok(compareFeedTime(at('a', older.at), at('b', older.at)) < 0);
    assert.ok(compareFeedTime(older, unreadable) < 0);
    assert.deepEqual(
      [unreadable, older, newer].sort(compareFeedTime).map((e) => e.id),
      ['b', 'a', 'c'],
    );
    // Two unreadable times order by id, so a sort is stable whatever order it starts from.
    assert.ok(compareFeedTime(at('x', '?'), at('y', '??')) < 0);
  });

  it('positionToGeometry keeps altitude only when there is one, including zero', () => {
    assert.deepEqual(positionToGeometry({ latitude: 21.3, longitude: -157.8 }), {
      type: 'Point',
      coordinates: [-157.8, 21.3],
    });
    assert.deepEqual(positionToGeometry({ latitude: 21.3, longitude: -157.8, altitudeM: 0 }), {
      type: 'Point',
      coordinates: [-157.8, 21.3, 0],
    });
  });

  it('utmCentralMeridian is the middle of each six-degree zone', () => {
    assert.equal(utmCentralMeridian(1), -177);
    assert.equal(utmCentralMeridian(30), -3);
    assert.equal(utmCentralMeridian(31), 3);
    assert.equal(utmCentralMeridian(60), 177);
    for (let zone = 1; zone <= 60; zone++) {
      const west = (zone - 1) * 6 - 180;
      assert.equal(utmCentralMeridian(zone), west + 3);
    }
  });

  it('isBasemapOverlay goes by the role alone', () => {
    const overlay = { id: 'o', title: 'O', kind: 'xyz', url: 'https://example.org/{z}/{x}/{y}.png' };
    assert.equal(isBasemapOverlay({ ...overlay, role: 'basemap' } as never), true);
    assert.equal(isBasemapOverlay({ ...overlay, role: 'overlay' } as never), false);
    assert.equal(isBasemapOverlay(overlay as never), false);
  });

  it('assertSchema returns the parsed value or throws naming the label', () => {
    const schema = s.object({ n: s.number({ min: 0 }) });
    assert.deepEqual(assertSchema(schema, { n: 1 }), { n: 1 });
    assert.throws(() => assertSchema(schema, { n: -1 }, 'settings'), /invalid settings: n: /);
    assert.throws(() => assertSchema(schema, null), /invalid value: /);
  });
});

describe('regionBounds', () => {
  const inside = (region: GeoRegion, p: { latitude: number; longitude: number }) => {
    const b = regionBounds(region)!;
    const lonIn =
      b.west <= b.east
        ? p.longitude >= b.west && p.longitude <= b.east
        : p.longitude >= b.west || p.longitude <= b.east;
    return lonIn && p.latitude >= b.south && p.latitude <= b.north;
  };

  it('gives a bounds region its own bounds, and an admin region its bounds or none', () => {
    const bounds = { west: -10, south: -5, east: 10, north: 5 };
    assert.equal(regionBounds({ kind: 'bounds', bounds }), bounds);
    assert.equal(regionBounds({ kind: 'admin', regionId: 'iso3166-1:US', bounds }), bounds);
    assert.equal(regionBounds({ kind: 'admin', regionId: 'iso3166-1:US' }), undefined);
  });

  it('a circle that reaches a pole takes every longitude', () => {
    const b = regionBounds({ kind: 'circle', center: { latitude: 89.9, longitude: 10 }, radiusM: 50_000 })!;
    assert.deepEqual([b.west, b.east, b.north], [-180, 180, 90]);
    assert.ok(b.south < 89.9);
  });

  it('a circle over the antimeridian has west greater than east', () => {
    const b = regionBounds({ kind: 'circle', center: { latitude: 0, longitude: 179.9 }, radiusM: 50_000 })!;
    assert.ok(b.west > 179);
    assert.ok(b.east < -179);
  });

  it('every point a region contains lies inside its bounds', () => {
    let seed = 20261119;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    let contained = 0;
    for (let i = 0; i < 400; i++) {
      const center = { latitude: random() * 170 - 85, longitude: random() * 360 - 180 };
      const radiusM = 1_000 + random() * 3_000_000;
      const circle: GeoRegion = { kind: 'circle', center, radiusM };
      const reach = radiusM / 111_000;
      const lon0 = center.longitude;
      const ring: Array<[number, number]> = [
        [lon0 - 2, center.latitude - 1],
        [lon0 + 2, center.latitude - 1],
        [lon0 + 3, center.latitude + 1],
        [lon0 - 1, center.latitude + 2],
      ].map(([lon, lat]) => [
        lon! > 180 ? lon! - 360 : lon! < -180 ? lon! + 360 : lon!,
        Math.max(-89, Math.min(89, lat!)),
      ]);
      const polygon: GeoRegion = { kind: 'polygon', polygon: ring };
      for (let k = 0; k < 20; k++) {
        const lat = Math.max(-90, Math.min(90, center.latitude + (random() * 2 - 1) * reach * 1.2));
        let lon =
          center.longitude +
          (random() * 2 - 1) * Math.min(180, (reach * 1.2) / Math.max(0.02, Math.cos((lat * Math.PI) / 180)));
        lon = ((((lon + 180) % 360) + 360) % 360) - 180;
        const p = { latitude: lat, longitude: lon };
        if (regionContains(circle, p)) {
          contained++;
          assert.equal(inside(circle, p), true, `circle ${JSON.stringify(circle)} ${JSON.stringify(p)}`);
        }
        const q = {
          latitude: center.latitude + random() * 3 - 1,
          longitude: ((((lon0 + random() * 5 - 2 + 180) % 360) + 360) % 360) - 180,
        };
        if (q.latitude <= 90 && q.latitude >= -90 && regionContains(polygon, q)) {
          contained++;
          assert.equal(inside(polygon, q), true, `polygon ${JSON.stringify(ring)} ${JSON.stringify(q)}`);
        }
      }
    }
    assert.ok(contained > 1_000);
  });
});

describe('the Sun', () => {
  it('wrap180Deg folds any angle into [-180, 180)', () => {
    assert.equal(wrap180Deg(0), 0);
    assert.equal(wrap180Deg(180), -180);
    assert.equal(wrap180Deg(-180), -180);
    assert.equal(wrap180Deg(190), -170);
    assert.equal(wrap180Deg(-190), 170);
    assert.equal(wrap180Deg(540), -180);
    close(wrap180Deg(725), 5, 9);
  });

  it('is over the equator at an equinox and the tropics at the solstices', () => {
    // March equinox 2026-03-20 14:46 UTC; June solstice 2026-06-21 08:24; December 2026-12-21 20:50.
    assert.ok(Math.abs(subsolarPoint(Date.UTC(2026, 2, 20, 14, 46)).latitude) < 0.01);
    close(subsolarPoint(Date.UTC(2026, 5, 21, 8, 24)).latitude, 23.438, 2);
    close(subsolarPoint(Date.UTC(2026, 11, 21, 20, 50)).latitude, -23.438, 2);
  });

  it('is near the Greenwich meridian at 12:00 UTC, within the equation of time', () => {
    for (let day = 0; day < 365; day += 7) {
      const { longitude } = subsolarPoint(Date.UTC(2026, 0, 1 + day, 12));
      // The equation of time never exceeds about 16.5 minutes, 4.1 degrees.
      assert.ok(Math.abs(longitude) < 4.2);
    }
    // Early November: the Sun is about 16.4 minutes ahead of the clock, so already west of Greenwich at noon.
    close(subsolarPoint(Date.UTC(2026, 10, 3, 12)).longitude, -4.1, 0);
  });

  it('moves west fifteen degrees an hour', () => {
    const a = subsolarPoint(Date.UTC(2026, 6, 1, 6)).longitude;
    const b = subsolarPoint(Date.UTC(2026, 6, 1, 7)).longitude;
    close(wrap180Deg(a - b), 15, 1);
  });

  it('solarEcliptic gives the obliquity of date and a longitude that grows about a degree a day', () => {
    const now = solarEcliptic(Date.UTC(2026, 0, 1));
    const next = solarEcliptic(Date.UTC(2026, 0, 2));
    close((now.epsilon * 180) / Math.PI, 23.437, 2);
    close(((next.lambda - now.lambda) * 180) / Math.PI, 1.019, 2);
    close(next.gmstDeg - now.gmstDeg, 360.98564736629, 6);
  });
});

const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', '__defineGetter__'];

describe('a name every object has is not an entry in a table', () => {
  it('ownEntry reads own entries only', () => {
    const table = { a: 1, zero: 0, 7: 7 };
    assert.equal(ownEntry(table, 'a'), 1);
    assert.equal(ownEntry(table, 'zero'), 0);
    assert.equal(ownEntry(table, 7), 7);
    assert.equal(ownEntry(table, 'missing'), undefined);
    assert.equal(ownEntry(undefined, 'a'), undefined);
    for (const name of INHERITED) assert.equal(ownEntry(table, name), undefined, name);
    assert.equal(ownEntry({ constructor: 'own' }, 'constructor'), 'own');
  });

  it('freshnessPolicyFor gives an object type with such a name the fallback policy', () => {
    for (const name of INHERITED) {
      assert.equal(freshnessPolicyFor(name), FALLBACK_FRESHNESS_POLICY, name);
      assert.equal(freshnessPolicyFor(name, {}), FALLBACK_FRESHNESS_POLICY, name);
    }
    const mine = { liveSeconds: 1, recentSeconds: 2, expireSeconds: 3 };
    assert.equal(freshnessPolicyFor('aircraft', { aircraft: mine }), mine);
    assert.notEqual(freshnessPolicyFor('aircraft'), FALLBACK_FRESHNESS_POLICY);
  });
});
