import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@opcb/world-model';
import { csvCell, toCsv } from './handlers.js';

test('CSV export: numbers as numbers, west and south included; text that could run as a formula is not', () => {
  assert.equal(csvCell(-157.86), '-157.86');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(Number.NaN), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-1 day'), `"'-1 day"`, 'text starting with a minus is still guarded');
  assert.equal(csvCell('Honolulu'), '"Honolulu"');
  const o = {
    id: 'wind:noaa-gfs-wind:21N158W',
    type: 'wind',
    observedAt: '2026-11-11T03:00:00.000Z',
    updatedAt: '2026-11-11T03:00:00.000Z',
    freshness: 'LIVE',
    confidence: 0.9,
    position: { latitude: -21.3, longitude: -157.86, altitudeM: -12 },
    labels: { name: 'Wind at 21°S 158°W' },
    properties: {},
    provenance: {
      providerId: 'noaa-gfs-wind',
      sourceName: 'GFS',
      origin: 'live',
      receivedAt: '2026-11-11T03:00:00.000Z',
    },
  } as unknown as WorldObject;
  const [header, row] = toCsv([o]).split('\n');
  const cols = header!.split(',');
  const cells = row!.split(',');
  const at = (c: string) => cells[cols.indexOf(c)];
  assert.equal(at('latitude'), '-21.3');
  assert.equal(at('longitude'), '-157.86');
  assert.equal(at('altitudeM'), '-12');
  assert.equal(at('label'), '"Wind at 21°S 158°W"');
});
