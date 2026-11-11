import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBearing, sonarPicture, SONAR_MAX_CONTACTS } from './sonar.js';

const o = (id: string, latitude: number, longitude: number, type = 'vessel', freshness = 'LIVE') => ({
  id,
  type,
  freshness,
  position: { latitude, longitude },
});

test('range and bearing: due east, due north, across 180°', () => {
  const e = rangeBearing({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
  assert.ok(Math.abs(e.bearingDeg - 90) < 1e-9);
  assert.ok(Math.abs(e.distanceM - 111_195) < 2);
  assert.ok(Math.abs(rangeBearing({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }).bearingDeg) < 1e-9);
  const w = rangeBearing({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 });
  assert.ok(Math.abs(w.bearingDeg - 90) < 1e-6 && w.distanceM < 23_000, 'east across the antimeridian');
});

test('the scope: contacts within the outer ring, nearest first, not the centre, shown types only', () => {
  // Rings 50 km apart: the scope reaches 200 km.
  const p = sonarPicture(
    [
      o('self', 0, 0),
      o('near', 0, 0.5), // ~55.6 km east
      o('far', 1, 0), // ~111 km north
      o('out', 0, 2), // ~222 km: outside
      o('plane', -0.4, 0, 'aircraft', 'STALE'), // ~44.5 km south
      o('hidden', 0.1, 0.1, 'camera'),
      o('gust', 0.1, 0, 'wind'),
      { id: 'area', type: 'weather-alert' },
    ],
    { latitude: 0, longitude: 0 },
    50_000,
    { excludeId: 'self', onSelection: true, visibleTypes: new Set(['vessel', 'aircraft', 'wind', 'weather-alert']) },
  )!;
  assert.equal(p.rangeM, 200_000);
  assert.equal(p.onSelection, true);
  assert.deepEqual(
    p.contacts.map((c) => c.id),
    ['plane', 'near', 'far'],
  );
  const near = p.contacts.find((c) => c.id === 'near')!;
  assert.ok(Math.abs(near.bearingDeg - 90) < 1e-6);
  assert.ok(Math.abs(near.range - 0.278) < 0.001);
  assert.equal(p.contacts.find((c) => c.id === 'plane')!.live, false);
  assert.ok(Math.abs(p.contacts.find((c) => c.id === 'plane')!.bearingDeg - 180) < 1e-6);
});

test('the scope keeps the nearest few, and needs a centre and a spacing', () => {
  const many = Array.from({ length: 100 }, (_, i) => o(`v${i}`, 0, (i + 1) * 0.001));
  const p = sonarPicture(many, { latitude: 0, longitude: 0 }, 50_000)!;
  assert.equal(p.contacts.length, SONAR_MAX_CONTACTS);
  assert.equal(p.contacts[0]!.id, 'v0');
  assert.equal(sonarPicture(many, undefined, 50_000), undefined);
  const odd = sonarPicture(many, { latitude: 0, longitude: 0 }, 50_000, {
    keep: (x) => Number(x.id.slice(1)) % 2 === 1,
  })!;
  assert.equal(odd.contacts[0]!.id, 'v1', 'what the map leaves out by object, the scope leaves out');
  assert.equal(sonarPicture(many, { latitude: 0, longitude: 0 }, undefined), undefined);
  // Near a pole the longitude box opens up rather than missing contacts.
  const polar = sonarPicture([o('a', 89.5, 120)], { latitude: 89.5, longitude: -60 }, 50_000)!;
  assert.equal(polar.contacts.length, 1);
});

test('the scope draws a blip at each contact’s bearing and range, dimmer when stale', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { SonarScope } = await import('./sonar-scope.js');
  const picture = {
    rangeM: 200_000,
    rings: 4,
    onSelection: true,
    contacts: [
      { id: 'east', type: 'vessel', bearingDeg: 90, range: 0.5, live: true },
      { id: 'south', type: 'aircraft', bearingDeg: 180, range: 1, live: false },
    ],
  };
  const html = renderToStaticMarkup(createElement(SonarScope, { picture }));
  // Centre 74, radius 68: half way east is x 108; the edge due south is y 142.
  assert.match(html, /class="wv-sonar__blip" cx="108" cy="74"/);
  assert.match(html, /class="wv-sonar__blip wv-sonar__blip--stale" cx="74(\.0+\d*)?" cy="142"/);
  assert.equal((html.match(/<circle/g) ?? []).length, 4 + 2, 'four rings and two blips');
  assert.match(html, /R 200 KM · SEL · 2/);
});
