import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REJECT_ZONE_ONLY, normalizeNwsAlerts, toGeometry } from './normalize.js';

/**
 * Three alerts of the live active-alerts answer, recorded 2026-11-09 through the operator's
 * browser (fixtures/weather/recorded, provenance in alerts-active.meta.json). The contract
 * fixtures were written in-repo; these check the reader against what NWS actually sends.
 */
const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'weather',
  'recorded',
  'alerts-active.json',
);
const answer = JSON.parse(readFileSync(file, 'utf8')) as unknown;
const NOW = Date.parse('2026-11-09T04:45:04Z'); // the answer's `updated`
const opts = { receivedAt: new Date(NOW).toISOString(), nowMs: NOW };

test('recorded alerts: polygons admitted, the zone-only advisory reported with its zone', () => {
  const result = normalizeNwsAlerts(answer, opts);
  assert.equal(result.total, 3);
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.rejected, [{ index: 2, reason: REJECT_ZONE_ONLY }]);
  assert.deepEqual(result.zonesNeeded, ['forecast/PZZ455']);
  assert.equal(result.fromZones, 0);
  assert.equal(result.updatedAt, '2026-11-09T04:45:04.000Z');

  const [ffw, advisory] = result.observations;
  assert.equal(ffw?.externalId, 'urn:oid:2.49.0.1.840.0.7678805471a91ed0e23873125a2b98f0b41caa49.001.1');
  // Local offsets (-06:00) read as UTC; onset and ends bound the alert.
  assert.equal(ffw?.payload['sent'], '2026-11-09T01:46:00.000Z');
  assert.equal(ffw?.payload['ends'], '2026-11-09T06:00:00.000Z');
  assert.equal(ffw?.payload['alertKind'], 'flash-flood-warning', 'CONSIDERABLE is not the emergency tier');
  assert.equal(ffw?.payload['damageThreat'], 'CONSIDERABLE');
  assert.equal(ffw?.payload['messageType'], 'Update');
  assert.deepEqual(ffw?.payload['references'], [
    'urn:oid:2.49.0.1.840.0.01008b96dac39f7a04ddcc53eb85874a9b3b68cb.001.1',
    'urn:oid:2.49.0.1.840.0.14cb88d7f5d4dc20f4b2849f6feee863d74dc2d7.002.1',
  ]);
  assert.deepEqual(ffw?.payload['sameCodes'], ['048137', '048271', '048465']);
  assert.deepEqual(ffw?.payload['ugcCodes'], ['TXC137', 'TXC271', 'TXC465']);
  assert.equal(ffw?.payload['geometrySource'], 'alert');

  // `ends: null` — the alert runs to `expires`; an empty `references` list adds nothing.
  assert.equal(advisory?.payload['event'], 'Flood Advisory');
  assert.equal('ends' in (advisory?.payload ?? {}), false);
  assert.equal(advisory?.payload['expires'], '2026-11-09T14:30:00.000Z');
  assert.equal('references' in (advisory?.payload ?? {}), false);
  assert.equal(advisory?.payload['nwsSeverity'], 'Minor');
});

test('recorded zone-only advisory: drawn from its marine zone once that zone is known', () => {
  // A stand-in outline: the test is about the alert, not the zone's real shape.
  const outline = toGeometry({
    type: 'Polygon',
    coordinates: [
      [
        [-124.4, 40.4],
        [-123.7, 40.4],
        [-123.7, 38.9],
        [-124.4, 38.9],
        [-124.4, 40.4],
      ],
    ],
  });
  assert.ok(outline && typeof outline !== 'string');
  const result = normalizeNwsAlerts(answer, {
    ...opts,
    zoneGeometry: (id) => (id === 'forecast/PZZ455' ? outline : undefined),
  });
  assert.equal(result.observations.length, 3);
  assert.equal(result.fromZones, 1);
  const sca = result.observations[2];
  assert.equal(sca?.payload['event'], 'Small Craft Advisory');
  assert.deepEqual(sca?.payload['zones'], ['forecast/PZZ455']);
  assert.equal(sca?.payload['onset'], '2026-11-09T05:00:00.000Z');
  assert.equal(sca?.payload['ends'], '2026-11-10T05:00:00.000Z');
});
