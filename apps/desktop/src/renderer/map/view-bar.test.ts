import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RasterOverlay } from '@opcb/world-model';
import type { ResolvedMapProvider } from '@opcb/render-core';
import { activeMapChoice, basemapLabel, imageryLabel, mapChoices, staleFrameDay } from './view-bar.js';
import { sourceBasemapId } from '../map-providers.js';

const basemap = (id: string, name: string, modes: Array<'2D' | '3D'>, available = true) =>
  ({ id, name, modes, available }) as unknown as ResolvedMapProvider;
const overlay = (providerId: string, name: string, extra: Partial<RasterOverlay> = {}) =>
  ({
    kind: 'xyz',
    id: `${providerId}:x`,
    providerId,
    name,
    attribution: 'a',
    url: 'https://x/{z}/{x}/{y}',
    ...extra,
  }) as RasterOverlay;

test('the Map choices: usable basemaps for the mode, sources’ maps, then imagery layers — no weather', () => {
  const basemaps = [
    basemap('natural-earth', 'Natural Earth II (bundled)', ['3D']),
    basemap('opcb-dark', 'OP-CB dark (offline vector)', ['2D']),
    basemap('esri-world-imagery', 'Esri World Imagery', ['2D', '3D']),
    basemap('cesium-ion-bing', 'Bing Aerial with labels (Cesium ion)', ['3D'], false),
  ];
  const overlays = [
    overlay('gibs-viirs-noaa20-true-colour', 'Corrected Reflectance (True Color)'),
    overlay('gibs-viirs-noaa20-true-colour', 'Corrected Reflectance (True Color)', { id: 'another-frame' }),
    overlay('gibs-goes-east-infrared', 'Clean Infrared'),
    overlay('usgs-topo', 'USGS Topo', { role: 'basemap' }),
    overlay('gibs-black-marble', 'Black Marble (VIIRS, Suomi NPP)'),
  ];
  assert.deepEqual(
    mapChoices(basemaps, overlays, '3D').map((c) => [c.id, c.label]),
    [
      ['basemap:natural-earth', 'Natural Earth'],
      ['basemap:esri-world-imagery', 'Satellite HD'],
      ['imagery:gibs-viirs-noaa20-true-colour', 'True colour · NOAA-20'],
      [`basemap:${sourceBasemapId(overlays[3]!)}`, 'USGS Topo'],
      ['imagery:gibs-black-marble', 'Night lights'],
    ],
  );
  assert.deepEqual(
    mapChoices(basemaps, [], '2D').map((c) => c.label),
    ['Dark', 'Satellite HD'],
  );
});

test('the active Map choice: a chosen imagery layer that is published, else the basemap', () => {
  const choices = [
    { id: 'basemap:esri-world-imagery', label: '', title: '' },
    { id: 'imagery:gibs-viirs-snpp-true-colour', label: '', title: '' },
  ];
  assert.equal(activeMapChoice(choices, 'esri-world-imagery', undefined), 'basemap:esri-world-imagery');
  assert.equal(
    activeMapChoice(choices, 'esri-world-imagery', 'gibs-viirs-snpp-true-colour'),
    'imagery:gibs-viirs-snpp-true-colour',
  );
  assert.equal(activeMapChoice(choices, 'esri-world-imagery', 'gone'), 'basemap:esri-world-imagery');
});

test('labels', () => {
  assert.equal(basemapLabel({ id: 'something-new', name: 'Something New (online)' }), 'Something New');
  assert.equal(imageryLabel({ providerId: 'gibs-viirs-snpp-true-colour', name: 'x' }), 'True colour · Suomi NPP');
});

test('a followed frame more than two days old is said on the bar, as GIBS left Suomi NPP on 2 November', () => {
  const now = Date.parse('2026-11-09T04:00:00Z');
  assert.equal(staleFrameDay('2026-11-02', now), '2 Nov');
  assert.equal(staleFrameDay('2026-11-08', now), undefined, "yesterday's daily mosaic is the newest there can be");
  assert.equal(staleFrameDay('2026-11-07', now), undefined, 'a daily frame counts from the end of its day');
  assert.equal(staleFrameDay('2026-11-06', now), '6 Nov');
  assert.equal(staleFrameDay('2026-11-08T22:30:00Z', now), undefined, 'IMERG, hours behind as usual');
  assert.equal(staleFrameDay('2026-11-06T03:59:00Z', now), '6 Nov');
  assert.equal(staleFrameDay('2025-12-31', now), '31 Dec 2025');
  assert.equal(
    staleFrameDay(undefined, now),
    undefined,
    'a layer that does not follow frames (Night lights) says nothing',
  );
  assert.equal(staleFrameDay('not a time', now), undefined);
  const choices = mapChoices(
    [],
    [
      overlay('gibs-viirs-snpp-true-colour', 'Corrected Reflectance (True Color)', { frame: '2026-11-02' }),
      overlay('gibs-viirs-noaa20-true-colour', 'Corrected Reflectance (True Color)', { frame: '2026-11-09' }),
    ],
    '3D',
    now,
  );
  assert.deepEqual(
    choices.map((c) => c.label),
    ['True colour · Suomi NPP · from 2 Nov', 'True colour · NOAA-20'],
  );
  assert.match(choices[0]!.title, /\(2026-11-02\), the newest picture the service has/);
});
