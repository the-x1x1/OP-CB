import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildList } from '@worldview/offline';
import { MAP_PROVIDER_ID, PROTOMAPS_POLICY, packIdentity } from './map-download.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test("the downloaded map carries the licence register's own record for protomaps-builds", () => {
  const reg = JSON.parse(readFileSync(path.join(root, 'config', 'licenses', 'providers.json'), 'utf8')) as unknown;
  const list = (Array.isArray(reg) ? reg : ((reg as { records?: unknown[] }).records ?? [])) as Array<{
    providerId: string;
    dataPolicy: Record<string, unknown>;
  }>;
  const rec = list.find((r) => r.providerId === MAP_PROVIDER_ID);
  assert.ok(rec, 'protomaps-builds is in the register');
  assert.equal(PROTOMAPS_POLICY.attribution, rec.dataPolicy['attributionText']);
  assert.equal(PROTOMAPS_POLICY.offlinePackAllowed, rec.dataPolicy['offlinePackAllowed']);
  assert.equal(PROTOMAPS_POLICY.redistributionAllowed, rec.dataPolicy['redistributionAllowed']);
  assert.equal(PROTOMAPS_POLICY.termsUrl, rec.dataPolicy['termsUrl']);
});

test('the build list: entries as read live on 2026-10-30, newest first; anything else skipped', () => {
  const builds = readBuildList([
    { key: '20230918.pmtiles', size: 114683195425, uploaded: '2023-09-18T11:02:48.409Z', version: '0.0.0' },
    {
      key: '20261029.pmtiles',
      size: 139191612225,
      md5sum: 'UlMMWorRPNJaab2SpWKcPA==',
      b3sum: '4c08fa256bc18104bf761eb7a8d4eeaed37d9e033b10e59e5efde6ffae321a28',
      uploaded: '2026-10-29T09:03:31.773Z',
      version: '4.15.2',
    },
    { key: '../etc/passwd', size: 1 },
    { key: '20261030.pmtiles', size: -1 },
  ]);
  assert.deepEqual(builds, [
    {
      key: '20261029.pmtiles',
      date: '2026-10-29',
      sizeBytes: 139191612225,
      version: '4.15.2',
      md5: 'UlMMWorRPNJaab2SpWKcPA==',
    },
    { key: '20230918.pmtiles', date: '2023-09-18', sizeBytes: 114683195425, version: '0.0.0' },
  ]);
  assert.throws(() => readBuildList({}));
});

test('pack names: one world map per detail level, one per named area, one planet', () => {
  assert.deepEqual(packIdentity({ kind: 'extract', worldMaxZoom: 7, maxZoom: 7 }), {
    id: 'map-world-z7',
    name: 'World map — detail to zoom 7',
  });
  assert.equal(
    packIdentity({
      kind: 'extract',
      worldMaxZoom: 6,
      maxZoom: 14,
      bounds: { west: -158, south: 21, east: -157, north: 22 },
      name: "O'ahu",
    }).id,
    'map-o-ahu-z14',
  );
  assert.equal(packIdentity({ kind: 'planet', worldMaxZoom: 15, maxZoom: 15 }).id, 'map-planet');
});
