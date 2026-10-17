import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORT_COLOURS,
  IMPORTED_LAYER,
  MAX_IMPORTED_SHAPES,
  importedFeatures,
  importedKey,
  importedTarget,
  nameAnchor,
  nextImportColour,
  shapesBounds,
  toBase64,
  type ImportedFile,
} from './imported-files.js';

const file = (id: string, over: Partial<ImportedFile> = {}): ImportedFile => ({
  id,
  name: `${id}.kml`,
  color: IMPORT_COLOURS[0],
  visible: true,
  shapes: [
    { geometry: { type: 'Point', coordinates: [-155.09, 19.72] }, name: 'Hilo' },
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [-155.09, 19.72],
          [-155.83, 19.83],
        ],
      },
    },
    {
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
          [
            [
              [2, 2],
              [3, 2],
              [3, 3],
              [2, 2],
            ],
          ],
        ],
      },
      name: 'Two boxes',
    },
  ],
  issues: [],
  ...over,
});

test('features: a point with its name, a line, each polygon of a multipolygon; the file’s colour; never picked', () => {
  const f = importedFeatures([file('a', { color: '#a3e635' })]);
  assert.deepEqual(
    f.map((x) => [x.id, x.geometry.kind, x.style.label]),
    [
      ['imported:a:0', 'point', 'Hilo'],
      ['imported:a:1', 'line', undefined],
      ['imported:a:2', 'polygon', undefined],
      ['imported:a:2:name', 'point', 'Two boxes'],
      ['imported:a:2:1', 'polygon', undefined],
    ],
  );
  assert.ok(f.every((x) => x.style.color === '#a3e635' && x.layer === IMPORTED_LAYER && !x.interactive));
  assert.deepEqual(importedFeatures([file('b', { visible: false })]), [], 'a hidden file draws nothing');
});

test('features stop at the shape limit', () => {
  const many = file('m', {
    shapes: Array.from({ length: MAX_IMPORTED_SHAPES + 5 }, () => ({
      geometry: { type: 'Point' as const, coordinates: [0, 0] as [number, number] },
    })),
  });
  assert.equal(importedFeatures([many]).length, MAX_IMPORTED_SHAPES);
});

test('the key changes with what is drawn, and not otherwise', () => {
  const a = file('a');
  assert.equal(importedKey([a]), importedKey([{ ...a, issues: ['x'] }]));
  assert.notEqual(importedKey([a]), importedKey([{ ...a, visible: false }]));
  assert.notEqual(importedKey([a]), importedKey([{ ...a, color: '#000000' }]));
  assert.equal(importedKey([]), '');
});

test('colours go round the palette, skipping ones in use', () => {
  assert.equal(nextImportColour([]), IMPORT_COLOURS[0]);
  assert.equal(nextImportColour([file('a', { color: IMPORT_COLOURS[0] })]), IMPORT_COLOURS[1]);
  const all = IMPORT_COLOURS.map((c, i) => file(`f${i}`, { color: c }));
  assert.equal(nextImportColour(all), IMPORT_COLOURS[all.length % IMPORT_COLOURS.length]);
});

test('bounds and where to fly', () => {
  const b = shapesBounds(file('a').shapes);
  assert.deepEqual(b, { west: -155.83, south: 0, east: 3, north: 19.83 });
  assert.equal(shapesBounds([]), undefined);
  // Either side of 180° (Fiji): a box across it, west > east, not one round the world.
  const fiji = shapesBounds([
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [177.4, -17.8],
          [179.9, -16.5],
          [-179.8, -16.2],
        ],
      },
    },
    { geometry: { type: 'Point', coordinates: [-178.5, -18.1] } },
  ]);
  assert.deepEqual(fiji, { west: 177.4, south: -18.1, east: -178.5, north: -16.2 });
  const t = importedTarget({ ...file('a'), bounds: b! });
  assert.deepEqual(t?.bounds, b);
  assert.equal(importedTarget({ ...file('a'), shapes: [] }), undefined);
});

test('base64 of bytes, in chunks', () => {
  assert.equal(toBase64(new TextEncoder().encode('<gpx/>')), 'PGdweC8+');
  const big = new Uint8Array(100_000).fill(65);
  assert.equal(atob(toBase64(big)).length, 100_000);
});

test('a named line or area is named on it: a line at its middle vertex, an area inside its outline', () => {
  const at = (lat: number, lon: number) => ({ latitude: lat, longitude: lon });
  assert.deepEqual(nameAnchor({ kind: 'line', positions: [at(0, 0), at(1, 1), at(2, 2)] }), at(1, 1));
  assert.deepEqual(
    nameAnchor({ kind: 'polygon', rings: [[at(0, 0), at(0, 2), at(2, 2), at(2, 0), at(0, 0)]] }),
    at(1, 1),
    'a box: its middle',
  );
  // A C shape whose average vertex falls in its mouth: the name goes on a corner instead.
  const c = [at(0, 0), at(0, 3), at(1, 3), at(1, 1), at(2, 1), at(2, 3), at(3, 3), at(3, 0), at(0, 0)];
  const anchor = nameAnchor({ kind: 'polygon', rings: [c] })!;
  assert.deepEqual(anchor, at(0, 0));
  assert.equal(nameAnchor({ kind: 'point', position: at(1, 1) }), undefined);
});

test('the limit counts what is drawn: one MultiPoint of many points is many features', () => {
  const many = file('mp', {
    shapes: [
      {
        geometry: {
          type: 'MultiPoint' as const,
          coordinates: Array.from({ length: MAX_IMPORTED_SHAPES + 10 }, () => [0, 0] as [number, number]),
        },
      },
      { geometry: { type: 'Point' as const, coordinates: [1, 1] as [number, number] } },
    ],
  });
  assert.equal(importedFeatures([many]).length, MAX_IMPORTED_SHAPES);
});
