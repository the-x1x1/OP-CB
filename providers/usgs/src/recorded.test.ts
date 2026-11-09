import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureToDraft, normalizeUsgsFeed } from './normalize.js';

/**
 * Five events of the live past-day feed, recorded 2026-11-09 through the operator's browser
 * (fixtures/usgs/recorded, provenance in all_day.meta.json). The contract fixtures were
 * generated in-repo; these check the reader against what USGS actually sends.
 */
const file = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'fixtures',
  'usgs',
  'recorded',
  'all_day.geojson',
);
const feed = JSON.parse(readFileSync(file, 'utf8')) as { features: unknown[] };
const opts = { receivedAt: '2026-11-09T04:44:30.000Z' };

test('recorded feed: every event admitted, the feed time read from metadata.generated', () => {
  const result = normalizeUsgsFeed(feed, opts);
  assert.equal(result.total, 5);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.observations.length, 5);
  assert.equal(result.generatedAt, '2026-11-09T04:44:18.000Z');
});

test('recorded events: magnitudes, intensities, depths and ids as USGS sends them', () => {
  const drafts = feed.features.map((f) => {
    const d = featureToDraft(f, Number.NEGATIVE_INFINITY, opts);
    assert.notEqual(typeof d, 'string', String(d));
    return d as Exclude<typeof d, string>;
  });

  const solomons = drafts[0]!;
  assert.equal(solomons.externalId, 'us7000tx16');
  assert.equal(solomons.observedAt, '2026-11-09T03:34:59.466Z');
  assert.deepEqual(solomons.position, {
    latitude: -10.8669,
    longitude: 165.5616,
    altitudeM: -17000,
    altitudeDatum: 'msl',
  });
  assert.equal(solomons.payload['magnitude'], 6.4);
  assert.equal(solomons.payload['magType'], 'mww');
  assert.equal(solomons.payload['alert'], 'green');
  assert.equal(solomons.payload['mmi'], 6.361);
  assert.equal(solomons.payload['tsunami'], false);
  assert.equal(solomons.payload['significance'], 630);
  assert.equal('felt' in solomons.payload, false, 'felt: null is no value, not zero');
  assert.deepEqual(solomons.payload['aliases'], ['us7000tx16'], 'ids ",us7000tx16," split without the empty ends');
  assert.equal(solomons.payload['detailUrl'], 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000tx16');
  assert.equal(solomons.quality?.flags, undefined, 'reviewed earthquake: no flags');

  const texas = drafts[1]!;
  assert.equal(texas.payload['felt'], 1);
  assert.equal(texas.payload['cdi'], 2.2);
  assert.equal('mmi' in texas.payload, false);
  assert.deepEqual(texas.payload['aliases'], ['tx2026waxmhq', 'us7000tx0y']);
  assert.equal(texas.payload['network'], 'tx');

  // A negative depth is above sea level: the event sits 230 m up, not 230 m down.
  const boron = drafts[2]!;
  assert.equal(boron.payload['depthKm'], -0.23);
  assert.equal(boron.position?.altitudeM, 230);
  assert.deepEqual(boron.quality?.flags, ['automatic']);

  assert.equal(drafts[4]!.payload['magType'], 'mb');
});
