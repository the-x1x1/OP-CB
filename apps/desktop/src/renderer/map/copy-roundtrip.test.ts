import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCoordinates } from '@opcb/query-engine';
import { formatDecimal, formatDms, formatGridReference } from './hud-format.js';

/**
 * What the HUD and What's here show to copy, pasted back into the search box, lands where it
 * was: decimal to about a metre, DMS to a tenth of a second, a grid reference within its
 * metre square. Points spread over the globe, the poles' grids and the 180° line included.
 */
function points(): Array<[number, number]> {
  const out: Array<[number, number]> = [
    [21.307, -157.858306],
    [0, 0],
    [-0.00001, 179.99999],
    [89.9, -179.9],
    [-85.5, 12.3],
    [84.5, 30],
    [-79.9, -60.25],
  ];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  for (let i = 0; i < 400; i++) out.push([rand() * 179.8 - 89.9, rand() * 359.8 - 179.9]);
  return out;
}

function lonGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

test('copied coordinates read back to the same place', () => {
  for (const [lat, lon] of points()) {
    for (const [name, text, tolDeg] of [
      ['decimal', formatDecimal(lat, lon), 1e-5],
      ['DMS', formatDms(lat, lon), 1 / 36_000],
    ] as const) {
      const p = parseCoordinates(text.trim());
      assert.ok(p && p.kind !== 'unsupported', `${name} not read back: "${text}"`);
      assert.ok(Math.abs(p.latitude - lat) <= tolDeg + 1e-9, `${name} "${text}" latitude ${p.latitude} vs ${lat}`);
      const lonTol = Math.abs(lat) > 89.99 ? 360 : tolDeg + 1e-9;
      assert.ok(lonGap(p.longitude, lon) <= lonTol, `${name} "${text}" longitude ${p.longitude} vs ${lon}`);
    }
  }
});

test('a copied grid reference reads back within its metre square', () => {
  for (const [lat, lon] of points()) {
    for (const kind of ['mgrs', 'utm'] as const) {
      const text = formatGridReference(lat, lon, kind).trim();
      if (text === '—') continue;
      const p = parseCoordinates(text);
      assert.ok(p && p.kind !== 'unsupported', `${kind} not read back: "${text}" (${lat}, ${lon})`);
      // Metres apart, roughly: a metre square's far corner is 1.42 m away; the reader puts the
      // point in the square's middle, so within a metre or so of where it was.
      const dy = (p.latitude - lat) * 111_320;
      const dx = lonGap(p.longitude, lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      assert.ok(Math.hypot(dx, dy) < 1.5, `${kind} "${text}" is ${Math.hypot(dx, dy).toFixed(2)} m off`);
    }
  }
});
