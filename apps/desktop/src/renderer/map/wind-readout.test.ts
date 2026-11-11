import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windAt, windPoints, windReadout, WIND_REACH_KM } from './wind-readout.js';

const pt = (latitude: number, longitude: number, u: number, v: number) => ({ latitude, longitude, u, v });

test('wind at a grid point is that point’s wind, from where it blows', () => {
  // u 5, v 0: blowing to the east, so a westerly — from 270°.
  const r = windAt([pt(10, 20, 5, 0), pt(20, 20, 0, 9)], { latitude: 10, longitude: 20 });
  assert.equal(r!.speedMps, 5);
  assert.equal(r!.fromDeg, 270);
  assert.equal(windReadout(r), 'FROM 270° 5.0 M/S');
});

test('between points the components are weighted by distance; opposite winds cancel', () => {
  const r = windAt([pt(0, -5, 4, 0), pt(0, 5, 0, 4)], { latitude: 0, longitude: 0 });
  assert.ok(Math.abs(r!.speedMps - Math.hypot(2, 2)) < 1e-9);
  assert.ok(Math.abs(r!.fromDeg! - 225) < 1e-9, 'half a westerly and half a southerly: from the south-west');
  assert.equal(windReadout(windAt([pt(0, -5, 4, 0), pt(0, 5, -4, 0)], { latitude: 0, longitude: 0 })), 'CALM');
});

test('across the antimeridian, nearest four only, and nothing out of reach', () => {
  const r = windAt([pt(0, 179, 3, 0), pt(0, -179, 3, 0), pt(0, 0, -30, 0)], { latitude: 0, longitude: 180 });
  assert.equal(Math.round(r!.speedMps * 10) / 10, 3, 'the point half a world away is not in reach');
  assert.equal(windAt([pt(0, 0, 3, 0)], { latitude: 0, longitude: WIND_REACH_KM / 100 }), undefined);
  assert.equal(windAt([], { latitude: 0, longitude: 0 }), undefined);
  assert.equal(windReadout(undefined), undefined);
  const many = [pt(0, 1, 1, 0), pt(0, -1, 1, 0), pt(1, 0, 1, 0), pt(-1, 0, 1, 0), pt(0, 3, -100, 0)];
  assert.equal(windAt(many, { latitude: 0, longitude: 0 })!.speedMps, 1, 'the fifth, farthest point is left out');
});

test('the wind layer’s points are its objects with u and v', () => {
  const ps = windPoints([
    { type: 'wind', position: { latitude: 1, longitude: 2 }, properties: { uMps: 1, vMps: 2 } },
    { type: 'wind', position: { latitude: 1, longitude: 2 }, properties: { uMps: 1 } },
    { type: 'aircraft', position: { latitude: 1, longitude: 2 }, properties: { uMps: 1, vMps: 2 } },
  ]);
  assert.deepEqual(ps, [{ latitude: 1, longitude: 2, u: 1, v: 2 }]);
});
