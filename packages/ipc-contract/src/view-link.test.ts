import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatViewLink, isViewLink, linkInArgs, readViewLink, type ViewLink } from './view-link.js';

function ok(text: string): { link: ViewLink; ignored: string[] } {
  const r = readViewLink(text);
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r as { ok: true; link: ViewLink; ignored: string[] };
}
function refused(text: string): string {
  const r = readViewLink(text);
  assert.equal(r.ok, false, `expected ${text} to be refused`);
  return (r as { ok: false; reason: string }).reason;
}

test('view link: a place, how close, the mode, a lens, layers and a selection', () => {
  const { link, ignored } = ok(
    'opcb://view?lat=21.3069&lon=-157.8583&z=11.5&mode=3d&lens=overview&show=aircraft,ships&hide=cameras&select=aircraft:adsb-lol:a1b2c3',
  );
  assert.deepEqual(link, {
    latitude: 21.3069,
    longitude: -157.8583,
    zoom: 11.5,
    mode: '3D',
    lensId: 'overview',
    show: ['aircraft', 'ships'],
    hide: ['cameras'],
    select: 'aircraft:adsb-lol:a1b2c3',
  });
  assert.deepEqual(ignored, []);
});

test('view link: both spellings of the scheme, lng for lon, alt for the globe', () => {
  assert.deepEqual(ok('opcb:view?lat=0&lng=0&alt=2000000').link, {
    latitude: 0,
    longitude: 0,
    altitudeM: 2_000_000,
  });
  assert.deepEqual(ok('  OPCB://VIEW?lat=-90&lon=180  ').link, { latitude: -90, longitude: 180 });
});

test('view link: parameters this version does not read are named, not half read', () => {
  const { link, ignored } = ok('opcb://view?lat=1&lon=2&time=2026-10-20T00:00:00Z&style=night');
  assert.deepEqual(link, { latitude: 1, longitude: 2 });
  assert.deepEqual(ignored, ['time', 'style']);
});

test('view link: refused with the reason', () => {
  assert.match(refused('https://example.com/?lat=1&lon=2'), /not an opcb/);
  assert.match(refused('opcb://run?cmd=calc'), /"run" is not something a link can open/);
  assert.match(refused('opcb://view?lat=1'), /needs lat and lon/);
  assert.match(refused('opcb://view?lat=91&lon=0'), /lat must be/);
  assert.match(refused('opcb://view?lat=0&lon=-181'), /lon must be/);
  assert.match(refused('opcb://view?lat=1e2&lon=0'), /needs lat and lon/);
  assert.match(refused('opcb://view?lat=0x10&lon=0'), /needs lat and lon/);
  assert.match(refused('opcb://view?lat=1&lon=2&z=40'), /zoom from 0 to 22/);
  assert.match(refused('opcb://view?lat=1&lon=2&alt=0'), /camera height/);
  assert.match(refused('opcb://view?lat=1&lon=2&mode=4d'), /2d or 3d/);
  assert.match(refused('opcb://view?lat=1&lon=2&show=<script>'), /not a layer id/);
  assert.match(refused('opcb://view?lat=1&lon=2&select=../../etc'), /not an object or event id/);
  assert.match(
    refused(`opcb://view?lat=1&lon=2&show=${Array.from({ length: 40 }, (_, i) => `l${i}`).join(',')}`),
    /more than 32/,
  );
  assert.match(refused(`opcb://view?lat=1&lon=2&x=${'a'.repeat(3000)}`), /too long/);
});

test('view link: what formatViewLink writes, readViewLink reads back', () => {
  const link: ViewLink = {
    latitude: 21.306944444,
    longitude: -157.858333333,
    zoom: 9.87654,
    altitudeM: 12345.6,
    mode: '2D',
    lensId: 'overview',
    show: ['aircraft'],
    hide: ['cameras', 'ships'],
    select: 'event:usgs:hv74123',
  };
  const url = formatViewLink(link);
  assert.equal(
    url,
    'opcb://view?lat=21.30694&lon=-157.85833&z=9.88&alt=12346&mode=2d&lens=overview&show=aircraft&hide=cameras,ships&select=event%3Ausgs%3Ahv74123',
  );
  assert.deepEqual(ok(url).link, {
    ...link,
    latitude: 21.30694,
    longitude: -157.85833,
    zoom: 9.88,
    altitudeM: 12346,
  });
});

test('view link: found on a command line as Windows and Linux pass it', () => {
  assert.equal(
    linkInArgs(['C:\\OP-CB\\OP-CB.exe', '--allow-file-access', 'opcb://view?lat=1&lon=2']),
    'opcb://view?lat=1&lon=2',
  );
  assert.equal(linkInArgs(['/opt/OP-CB/opcb']), undefined);
  assert.equal(isViewLink('geo:1,2'), false);
});
