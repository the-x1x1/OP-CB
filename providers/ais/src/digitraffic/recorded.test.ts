import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locationToDraft, parseLocations, parseVessels, vesselStatic, type VesselStatic } from './normalize.js';

/**
 * A few rows of the live service, recorded 2026-11-09 through the operator's browser
 * (fixtures/digitraffic-ais/recorded, provenance in the .meta.json files). The other
 * fixtures were invented from the OpenAPI before the API could be read; these check the
 * reader against what Fintraffic actually sends.
 */
const recorded = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'digitraffic-ais',
  'recorded',
);
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(recorded, name), 'utf8'));
const NOW = Date.parse('2026-11-09T04:35:14Z'); // the answer's dataUpdatedTime
const opts = { receivedAt: new Date(NOW).toISOString(), nowMs: NOW };

function statics(): Map<string, VesselStatic> {
  const rows = parseVessels(load('vessels.json'));
  assert.ok(Array.isArray(rows));
  const out = new Map<string, VesselStatic>();
  for (const row of rows) {
    const s = vesselStatic(row);
    assert.ok(s, 'every recorded static row has a usable MMSI');
    out.set(s.mmsi, s.fields);
  }
  return out;
}

test('recorded static rows: names, sizes and the packed ETA read; not-available values left out', () => {
  const s = statics();
  assert.equal(s.size, 4);
  assert.deepEqual(s.get('230358000'), {
    name: 'RAUTARUUKKI',
    callSign: 'OJHM',
    imo: '8418174',
    shipType: 70,
    shipTypeText: 'cargo',
    destination: 'SELLA',
    eta: { month: 11, day: 9, hour: 6, minute: 0 },
    draughtM: 7.1,
    lengthM: 167,
    beamM: 27,
  });
  assert.deepEqual(s.get('311001866')?.['eta'], { month: 10, day: 25, hour: 7, minute: 0 });
  assert.equal(s.get('311001866')?.['lengthM'], 183);
  assert.equal(s.get('230980000')?.['shipTypeText'], 'passenger');
  assert.equal(s.get('230980000')?.['eta'], undefined, 'ETA 1596 is month 0, day 0, hour 24, minute 60');
  // IMO 0, ship type 0, reference points 0, ETA 1596 and an empty destination: all "not available".
  assert.deepEqual(s.get('230941570'), { name: 'MERIKUOKKA', callSign: 'OI2932', draughtM: 2 });
});

test('recorded positions: every feature becomes a ship, with the static data folded in', () => {
  const features = parseLocations(load('locations.json'));
  assert.ok(Array.isArray(features));
  assert.equal(features.length, 5);
  const known = statics();
  const drafts = features.map((f) => {
    const r = locationToDraft(f, known, opts);
    assert.equal(r.kind, 'observation', JSON.stringify(f));
    return r.kind === 'observation' ? r.draft : undefined!;
  });

  const underWay = drafts[0]!;
  assert.equal(underWay.externalId, '230358000');
  assert.equal(underWay.observedAt, '2026-11-09T04:35:09.345Z');
  assert.deepEqual(
    [underWay.position?.latitude, underWay.position?.longitude],
    [65.539452, 22.304923],
    'GeoJSON order: longitude first',
  );
  assert.equal(underWay.payload['name'], 'RAUTARUUKKI');
  assert.equal(underWay.payload['speedMps'], 4.22);
  assert.equal(underWay.payload['courseDegrees'], 307);
  assert.equal(underWay.payload['headingDegrees'], 302);
  assert.equal(underWay.payload['navStatus'], 0);
  assert.equal(underWay.quality?.flags, undefined);

  const anchored = drafts[1]!;
  assert.equal(anchored.payload['navStatus'], 1);
  assert.equal(anchored.payload['rateOfTurnDegPerMin'], 11.4, 'ROT 16 → (16 / 4.733)² °/min');

  // Heading 511 and ROT -128 are both "not available": heading from COG, no rate of turn.
  const noHeading = drafts[2]!;
  assert.equal(noHeading.payload['headingDegrees'], 202.3);
  assert.deepEqual(noHeading.quality?.flags, ['heading-from-cog']);
  assert.equal('rateOfTurnDegPerMin' in noHeading.payload, false);
  assert.equal(noHeading.payload['navStatus'], 15);

  const moored = drafts[3]!;
  assert.equal(moored.payload['navStatus'], 5);
  assert.equal(moored.payload['speedMps'], 0);
  assert.equal(moored.payload['shipTypeText'], 'passenger');

  // No static row for this ship in the hour asked: the position alone.
  const bare = drafts[4]!;
  assert.equal(bare.externalId, '265767620');
  assert.equal('name' in bare.payload, false);
  assert.equal(bare.payload['headingDegrees'], 47);
});
