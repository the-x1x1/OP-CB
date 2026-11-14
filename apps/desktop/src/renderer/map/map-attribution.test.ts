import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MapAttribution, mapAttributionLead } from './map-attribution.js';

test('folded, the basemap keeps its "Powered by" lead; nothing else is kept', () => {
  assert.equal(
    mapAttributionLead('Powered by Esri — Source: Esri, Maxar, Earthstar Geographics and the GIS User Community'),
    'Powered by Esri',
  );
  assert.equal(mapAttributionLead('© OpenStreetMap contributors'), undefined);
  assert.equal(mapAttributionLead(undefined), undefined);
});

test('unfolded by default, every credit shown with a button to fold them; nothing at all without credits', () => {
  const html = renderToStaticMarkup(
    createElement(MapAttribution, { credits: ['Powered by Esri — Source: Esri', 'NASA GIBS'] }),
  );
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Powered by Esri — Source: Esri · NASA GIBS/);
  assert.equal(renderToStaticMarkup(createElement(MapAttribution, { credits: [] })), '');
});

test('credits: every source with something drawn, once — not the first three found', async () => {
  const { sourceCredits } = await import('./map-attribution.js');
  const obj = (id: string, type: string, providerId: string, extra: Record<string, unknown> = {}) =>
    ({ id, type, provenance: { providerId, ...extra }, properties: {} }) as never;
  const bySource = new Map([
    ['usgs', 'USGS'],
    ['firms', 'NASA FIRMS'],
    ['nws', 'NWS'],
    ['adsb', 'ADS-B Exchange'],
    ['gfs', 'NOAA GFS'],
  ]);
  const objects = [
    obj('q1', 'earthquake', 'usgs'),
    obj('q2', 'earthquake', 'usgs'),
    obj('f1', 'fire-detection', 'firms'),
    obj('a1', 'weather-alert', 'nws'),
    obj('p1', 'aircraft', 'adsb'),
    obj('w1', 'wind', 'gfs'),
    obj('cam', 'camera', 'cams', { attribution: 'Camera © Hawaii DOT' }),
  ];
  assert.deepEqual(sourceCredits(objects, bySource), [
    'USGS',
    'NASA FIRMS',
    'NWS',
    'ADS-B Exchange',
    'NOAA GFS',
    'Camera © Hawaii DOT',
  ]);
  // A layer switched off is not drawn, so not credited; nor what a per-object switch hides.
  assert.deepEqual(
    sourceCredits(objects, bySource, {
      visibleTypes: new Set(['earthquake', 'aircraft', 'wind', 'fire-detection']),
      keep: (o) => (o as unknown as { type: string }).type !== 'fire-detection',
    }),
    ['USGS', 'ADS-B Exchange', 'NOAA GFS'],
  );
});

test('folded, the full credits are still in the page (hidden), for a saved picture to unfold', () => {
  const g = globalThis as { localStorage?: unknown };
  const before = g.localStorage;
  g.localStorage = { getItem: () => '1', setItem: () => {} };
  try {
    const html = renderToStaticMarkup(
      createElement(MapAttribution, { credits: ['Powered by Esri — Source: Esri', 'NASA FIRMS', 'NOAA GFS'] }),
    );
    assert.match(html, /wv-map__attribution--collapsed/);
    assert.match(html, /Sources \(3\)/);
    assert.match(html, /class="wv-map__attribution-full">Powered by Esri — Source: Esri · NASA FIRMS · NOAA GFS</);
  } finally {
    g.localStorage = before;
  }
});
