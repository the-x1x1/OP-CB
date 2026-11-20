import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observationSchema } from '@opcb/world-model';
import { definitionToManifest, parseDefinition } from './definition.js';
import { compileMapping, type MappingSpec } from './mapping.js';
import { mapRecords } from './records.js';
import { TRANSFORMS } from './transforms.js';

/**
 * A property of every connector: whatever a source's records hold, what the mapping lets
 * through is an observation the world model accepts (observationSchema), and the mapping
 * itself never throws. Records are generated from a fixed seed with every wrong kind of value
 * in every field, under mappings that use each way of reading a position and every transform.
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

const RECEIVED = '2026-11-20T02:00:00.000Z';
const ring = [
  [-158, 21],
  [-157, 21],
  [-157, 22],
  [-158, 21],
];
const VALUES: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  21.3,
  -157.8,
  90,
  -90,
  180,
  -180,
  91,
  181,
  1e308,
  -1e308,
  1e-320,
  1_795_000_000,
  1_795_000_000_000,
  9_007_199_254_740_993,
  '',
  ' ',
  'abc',
  'id-1',
  'two words',
  '21.3',
  '-157.8',
  '1e999',
  'NaN',
  'Infinity',
  '0x10',
  'true',
  'no',
  '2026-11-19T10:00:00Z',
  '2026-11-19 10:00',
  '2026-02-30T00:00:00Z',
  '2099-01-01T00:00:00Z',
  '11/19/2026',
  '1795000000',
  'x'.repeat(5000),
  'tab\there',
  'line\nbreak',
  'constructor',
  '__proto__',
  [],
  [1],
  [21.3, -157.8],
  [-157.8, 21.3],
  [-157.8, 21.3, 500],
  ['a', 'b'],
  [null],
  [[1, 2]],
  {},
  { a: 1 },
  { type: 'Point', coordinates: [-157.8, 21.3] },
  { type: 'Point', coordinates: [500, 500] },
  { type: 'Point', coordinates: [] },
  { type: 'Point' },
  {
    type: 'LineString',
    coordinates: [
      [-158, 21],
      [-157, 22],
    ],
  },
  { type: 'LineString', coordinates: [[-158, 21]] },
  { type: 'LineString', coordinates: 'x' },
  { type: 'Polygon', coordinates: [ring] },
  {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 91],
        [1, 1],
        [0, 0],
      ],
    ],
  },
  { type: 'Polygon', coordinates: [] },
  { type: 'MultiPolygon', coordinates: [[ring], []] },
  { type: 'GeometryCollection', geometries: [] },
  { type: 'Circle', coordinates: [0, 0] },
  { type: 5 },
];
const FIELDS = ['id', 'when', 'lat', 'lon', 'alt', 'geom', 'pair', 'name', 'a', 'b', 'c', 'speed', 'heading'];

function definitionWith(mapping: MappingSpec) {
  const parsed = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'property-source',
    name: 'Property source',
    connector: 'rest-json',
    objectType: 'sensor',
    categories: ['infrastructure'],
    endpoint: { url: 'https://api.example.com/records.json', intervalSeconds: 600 },
    mapping,
    attribution: { text: 'Example' },
    review: 'user-configured',
    enabled: false,
  });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.definition;
}

const transformNames = [
  ...Object.keys(TRANSFORMS),
  'scale:0.5',
  'scale:1e308',
  'offset:-273.15',
  'timestamp:YYYY-MM-DD HH:mm',
];
const properties = (): NonNullable<MappingSpec['properties']> => {
  const out: NonNullable<MappingSpec['properties']> = {
    plainA: 'a',
    plainB: 'b',
    deep: 'c.a',
    index: 'c[0]',
    missing: 'nothing.here',
  };
  transformNames.forEach((transform, i) => {
    out[`t${i}`] = { path: ['a', 'b', 'c', 'lat', 'when'][i % 5]!, transform };
  });
  out['chained'] = { path: 'a', transform: ['trim', 'emptyToNone', 'number', 'scale:2'] } as never;
  out['fallback'] = { path: 'nothing', default: 5 } as never;
  out['literal'] = { literal: 'fixed' } as never;
  return out;
};

const MAPPINGS: Array<[string, MappingSpec]> = [
  [
    'lat and lon',
    {
      externalId: 'id',
      observedAt: 'when',
      position: { lat: 'lat', lon: 'lon', alt: 'alt' },
      labels: { name: 'name' },
      properties: properties(),
    },
  ],
  [
    'a geometry as the position',
    {
      externalId: 'id',
      observedAt: { path: 'when', transform: 'isoTimestamp' },
      position: { geometry: 'geom' },
      geometry: 'geom',
      labels: { name: 'name' },
    },
  ],
  [
    'a lon/lat pair',
    {
      externalId: { path: 'id', transform: 'spacesToUnderscores' },
      position: { lonLat: 'pair' },
      properties: { a: 'a' },
      duplicates: 'number',
    },
  ],
  [
    'a lat/lon pair without altitude',
    {
      externalId: 'id',
      observedAt: { path: 'when', transform: 'unixSeconds' },
      position: { latLon: 'pair', altitude: false },
      motion: { speedMps: 'speed', headingDegrees: 'heading' },
    },
  ],
  [
    'a shape only, filtered',
    {
      externalId: 'id',
      geometry: 'geom',
      filter: [
        { path: 'a', exists: true },
        { path: 'lat', min: -1000, max: 1000 },
      ],
    },
  ],
];

for (const [name, spec] of MAPPINGS)
  test(`mapping property (${name}): every observation let through is one the world model accepts`, () => {
    const definition = definitionWith(spec);
    const manifest = definitionToManifest(definition, 'REST JSON');
    const mapping = compileMapping(definition.mapping);
    const next = rng(name.length * 7919);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
    const records: unknown[] = [null, 5, 'text', [], {}];
    for (let i = 0; i < 3000; i++) {
      const record: Record<string, unknown> = {};
      for (const field of FIELDS) if (next() < 0.9) record[field] = pick(VALUES);
      // Enough well-formed ones that observations do come out.
      if (next() < 0.5)
        Object.assign(record, {
          id: `id-${i % 40}`,
          lat: 21 + next(),
          lon: -158 + next(),
          pair: next() < 0.5 ? [-157.8, 21.3] : [21.3, -157.8],
        });
      if (next() < 0.3)
        record['geom'] = pick([
          { type: 'Point', coordinates: [-157.8, 21.3] },
          { type: 'Polygon', coordinates: [ring] },
          { type: 'LineString', coordinates: ring },
        ]);
      if (next() < 0.3) record['when'] = pick(['2026-11-19T10:00:00Z', 1_795_000_000, '2026-11-19 10:00']);
      records.push(record);
    }
    let result: ReturnType<typeof mapRecords> | undefined;
    assert.doesNotThrow(() => {
      result = mapRecords(records, {
        manifest,
        definition,
        mapping,
        receivedAt: RECEIVED,
        origin: 'live',
        sourceRef: 'https://api.example.com/records.json',
      });
    });
    assert.ok(result);
    const refused: string[] = [];
    const ids = new Set<string>();
    for (const o of result.observations) {
      const parsed = observationSchema.parse(o, '');
      if (!parsed.ok)
        refused.push(
          `${JSON.stringify(o).slice(0, 260)} :: ${parsed.issues
            .map((i) => `${i.path} ${i.message}`)
            .join('; ')
            .slice(0, 200)}`,
        );
      if (ids.has(o.id)) refused.push(`observation id ${o.id} twice`);
      ids.add(o.id);
      if (Date.parse(o.observedAt) > Date.parse(RECEIVED) + 10 * 60_000)
        refused.push(`observed in the future: ${o.observedAt}`);
    }
    assert.deepEqual(
      refused.slice(0, 8),
      [],
      `${refused.length} of ${result.observations.length} observations are not acceptable`,
    );
    assert.ok(result.observations.length > 40, `${result.observations.length} observations came out`);
    assert.ok(result.rejected.length > 0, 'and some records were refused, with reasons');
    for (const r of result.rejected)
      assert.ok(
        typeof r.reason === 'string' && r.reason.length > 0 && r.reason.length < 400,
        JSON.stringify(r).slice(0, 200),
      );
  });
