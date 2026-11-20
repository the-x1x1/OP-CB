import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fetchFailure } from './basemaps/martin.js';
import {
  clipFeatureCollection,
  featureTouchesBounds,
  numberProp,
  stringArrayProp,
  stringProp,
  type PackFeature,
} from './geojson.js';
import { isSemver } from './manifest.js';
import { renderNotices } from './notices.js';
import { placeFromFeature } from './place-entries.js';
import { indexedForms, matchEntry, nearestOf, normalizePlaceText, rankHits, type PlaceEntry } from './place-index.js';
import { selectionProblem, selectionTileCount } from './pmtiles-extract.js';
import {
  PM_MAX_ZOOM,
  PmtilesFormatError,
  compressInternal,
  decompressInternal,
  findPmEntry,
  tileIdToZxy,
  zoomStartId,
  zxyToTileId,
} from './pmtiles.js';
import { httpRangeSource } from './protomaps-builds.js';
import { REGION_PRESETS, isRegionPresetId } from './region-presets.js';
import { replacementProblem, signatureSummary } from './registry.js';
import { generatePackKeyPair, publicKeyOf, type PackSignature } from './signature.js';
import { parseVaultMarker, vaultMarkerMatches, vaultSummary } from './vault.js';
import { errorText, formatVerification, signatureLine } from './verify.js';
import { decodeZimEntry, fileZimSource, htmlToText, isArticleMime, readMimeList, ZimError } from './zim.js';
import { crc32, crc32Update } from './zip.js';

// ---- pack features ------------------------------------------------------------------

const point = (lon: number, lat: number, properties: PackFeature['properties'] = {}): PackFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});

test('featureTouchesBounds and clipFeatureCollection: points by position, shapes by their box, across 180° too', () => {
  const box = { west: -10, south: -10, east: 10, north: 10 };
  const line = (a: [number, number], b: [number, number]): PackFeature => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [a, b] },
    properties: {},
  });
  assert.equal(featureTouchesBounds(point(0, 0), box), true);
  assert.equal(featureTouchesBounds(point(10, 10), box), true, 'the edge is inside');
  assert.equal(featureTouchesBounds(point(10.001, 0), box), false);
  assert.equal(featureTouchesBounds(line([-20, 0], [20, 0]), box), true, 'a line through the box');
  assert.equal(featureTouchesBounds(line([20, 20], [30, 30]), box), false);
  const pacific = { west: 170, south: -10, east: -170, north: 10 };
  assert.equal(featureTouchesBounds(point(179, 0), pacific), true);
  assert.equal(featureTouchesBounds(point(-179, 0), pacific), true);
  assert.equal(featureTouchesBounds(point(0, 0), pacific), false);
  assert.equal(featureTouchesBounds(line([175, 0], [-175, 0]), pacific), true);
  const features = [point(0, 0), point(50, 50), line([20, 20], [30, 30]), line([-1, -1], [1, 1])];
  const clipped = clipFeatureCollection({ type: 'FeatureCollection', features }, box);
  assert.deepEqual([clipped.kept, clipped.dropped], [2, 2]);
  assert.deepEqual(clipped.collection.features, [features[0], features[3]]);
  assert.deepEqual(clipFeatureCollection({ type: 'FeatureCollection', features: [] }, box).kept, 0);
});

test('stringProp, numberProp, stringArrayProp: the value when it is of that kind and not empty', () => {
  const props = { name: 'Hilo', empty: '', n: 0, nan: Number.NaN, list: ['a', '', 5, 'b'], text: 'x' };
  assert.equal(stringProp(props, 'name'), 'Hilo');
  assert.equal(stringProp(props, 'empty'), undefined);
  assert.equal(stringProp(props, 'n'), undefined);
  assert.equal(stringProp(props, 'missing'), undefined);
  assert.equal(numberProp(props, 'n'), 0);
  assert.equal(numberProp(props, 'nan'), undefined);
  assert.equal(numberProp(props, 'name'), undefined);
  assert.deepEqual(stringArrayProp(props, 'list'), ['a', 'b']);
  assert.deepEqual(stringArrayProp(props, 'text'), []);
  assert.deepEqual(stringArrayProp(props, 'missing'), []);
});

test('placeFromFeature: a named, placed feature with an id; codes and country only when well formed', () => {
  const full = placeFromFeature(
    point(-155.05, 19.72, {
      id: 'airport:iata:ITO',
      name: 'Hilo International',
      kind: 'airport',
      altNames: ['General Lyman Field', 7],
      iata: 'ito',
      icao: 'PHTO',
      countryCode: 'us',
      importance: 4,
      bounds: [-155.1, 19.7, -155.0, 19.75],
    }),
  )!;
  assert.equal(full.id, 'airport:iata:ITO');
  assert.equal(full.kind, 'airport');
  assert.deepEqual(full.altNames, ['General Lyman Field']);
  assert.deepEqual(full.position, { latitude: 19.72, longitude: -155.05 });
  assert.equal(full.importance, 1, 'importance is held to 0…1');
  assert.deepEqual(full.bounds, { west: -155.1, south: 19.7, east: -155.0, north: 19.75 });
  assert.deepEqual([full.iata, full.icao, full.countryCode], ['ITO', 'PHTO', 'US']);
  const plain = placeFromFeature({ ...point(1, 2, { name: 'Somewhere', kind: 'volcano' }), id: 12 })!;
  assert.equal(plain.id, 'feature:12');
  assert.equal(plain.kind, 'poi', 'an unknown kind is a point of interest');
  assert.equal(plain.importance, 0.3);
  assert.equal(placeFromFeature(point(1, 2, { kind: 'city' })), undefined, 'no name');
  assert.equal(placeFromFeature(point(1, 2, { name: 'No id' })), undefined, 'no id');
  assert.equal(placeFromFeature({ ...point(1, 2, { name: '' }), id: 'x' }), undefined);
});

// ---- place matching -----------------------------------------------------------------

const place = (over: Partial<PlaceEntry> & { id: string; name: string }): PlaceEntry => ({
  altNames: [],
  kind: 'city',
  position: { latitude: 0, longitude: 0 },
  importance: 0.5,
  ...over,
});

test('indexedForms and matchEntry: code, exact name, prefix and token overlap, in that order of worth', () => {
  const hilo = place({ id: 'a', name: 'Hilo', altNames: ['Hilo Town', ''], iata: 'ITO', icao: 'PHTO' });
  const forms = indexedForms(hilo);
  assert.deepEqual(forms.fullNames, ['hilo', 'hilo town']);
  assert.deepEqual([...forms.tokens].sort(), ['hilo', 'town']);
  const match = (q: string, entry = hilo) => {
    const norm = normalizePlaceText(q);
    return matchEntry(entry, indexedForms(entry), norm, norm.split(' ').filter(Boolean));
  };
  assert.equal(match('ITO')!.match, 'code');
  assert.equal(match('phto')!.match, 'code');
  assert.equal(match('Hilo')!.match, 'exact');
  assert.equal(match('HILO town')!.match, 'exact');
  assert.equal(match('hil')!.match, 'prefix');
  assert.equal(match('town')!.match, 'tokens');
  assert.equal(match('town hilo')!.match, 'tokens', 'every word present, in another order');
  assert.equal(match('hilo bay'), undefined, 'a word that matches nothing rules the place out');
  assert.equal(match('h'), undefined, 'one letter is not a prefix');
  assert.ok(match('ITO')!.base > match('Hilo')!.base);
  assert.ok(match('Hilo')!.base > match('hil')!.base);
  assert.ok(match('hil')!.base > match('town')!.base);
  assert.ok(match('hilo')!.base > match('hi')!.base, 'more of the name typed is worth more');
  const accented = place({ id: 'b', name: "Hawai'i Volcanoes — Kīlauea" });
  assert.equal(match('kilauea', accented)!.match, 'tokens');
  assert.equal(match('HAWAII volcanoes kilauea', accented)!.match, 'exact');
});

test('rankHits: importance and nearness add to the match; kinds filter; ties by name then id', () => {
  const near = place({ id: 'near', name: 'Paris', position: { latitude: 48.85, longitude: 2.35 }, importance: 0.2 });
  const far = place({ id: 'far', name: 'Paris', position: { latitude: 33.66, longitude: -95.55 }, importance: 0.2 });
  const big = place({ id: 'big', name: 'Parma', importance: 1 });
  const port = place({ id: 'port', name: 'Paris Port', kind: 'port' });
  const matched = [far, near, big, port].map((entry) => ({ entry, base: 2.5, match: 'exact' as const }));
  assert.deepEqual(
    rankHits(matched, {}, 10).map((h) => h.entry.id),
    ['big', 'port', 'far', 'near'],
  );
  assert.equal(rankHits(matched, { position: { latitude: 48.9, longitude: 2.3 } }, 10)[0]!.entry.id, 'big');
  assert.deepEqual(
    rankHits(matched.slice(0, 2), { position: { latitude: 48.9, longitude: 2.3 } }, 10).map((h) => h.entry.id),
    ['near', 'far'],
  );
  assert.deepEqual(
    rankHits(matched, { kinds: ['port'] }, 10).map((h) => h.entry.id),
    ['port'],
  );
  assert.equal(rankHits(matched, { kinds: [] }, 10).length, 4, 'an empty list of kinds is no restriction');
  assert.equal(rankHits(matched, {}, 2).length, 2);
  assert.deepEqual(rankHits([], {}, 5), []);
  for (const h of rankHits(matched, {}, 10)) assert.equal(h.score, Math.round(h.score * 10_000) / 10_000);
});

test('nearestOf: within the distance, nearest first, of the kinds asked for', () => {
  const at = (id: string, latitude: number, longitude: number, kind: PlaceEntry['kind'] = 'city', importance = 0.5) =>
    place({ id, name: id, kind, importance, position: { latitude, longitude } });
  const here = { latitude: 21.3, longitude: -157.85 };
  const places = [
    at('far', 19.7, -155.08),
    at('close', 21.31, -157.86),
    at('closer', 21.301, -157.851),
    at('airport', 21.32, -157.92, 'airport'),
    at('twin-b', 21.4, -157.85, 'city', 0.2),
    at('twin-a', 21.4, -157.85, 'city', 0.9),
  ];
  assert.deepEqual(
    nearestOf(places, here).map((h) => h.entry.id),
    ['closer'],
    'one, by default',
  );
  assert.deepEqual(
    nearestOf(places, here, { limit: 10 }).map((h) => h.entry.id),
    ['closer', 'close', 'airport', 'twin-a', 'twin-b'],
  );
  assert.deepEqual(
    nearestOf(places, here, { limit: 10, kinds: ['airport'] }).map((h) => h.entry.id),
    ['airport'],
  );
  assert.equal(nearestOf(places, here, { limit: 10, maxDistanceM: 500_000 }).length, 6);
  assert.deepEqual(nearestOf(places, here, { maxDistanceM: 10 }), []);
  assert.deepEqual(nearestOf([], here), []);
  const hits = nearestOf(places, here, { limit: 10 });
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i]!.distanceM >= hits[i - 1]!.distanceM);
});

// ---- PMTiles ---------------------------------------------------------------------------

test('tile ids: every tile of a zoom has its own id inside the zoom, and comes back as it went in', () => {
  assert.equal(zoomStartId(0), 0);
  assert.equal(zoomStartId(1), 1);
  assert.equal(zoomStartId(2), 5);
  assert.equal(zoomStartId(3), 21);
  for (let z = 0; z <= 5; z++) {
    const n = 2 ** z;
    const ids = new Set<number>();
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        const id = zxyToTileId(z, x, y);
        ids.add(id);
        assert.deepEqual(tileIdToZxy(id), [z, x, y]);
      }
    assert.equal(ids.size, n * n);
    assert.equal(Math.min(...ids), zoomStartId(z));
    assert.equal(Math.max(...ids), zoomStartId(z + 1) - 1);
  }
  const n = 2 ** PM_MAX_ZOOM;
  for (const [x, y] of [
    [0, 0],
    [n - 1, n - 1],
    [n - 1, 0],
    [12345, 23456],
  ] as const)
    assert.deepEqual(tileIdToZxy(zxyToTileId(PM_MAX_ZOOM, x, y)), [PM_MAX_ZOOM, x, y]);
  assert.throws(() => zxyToTileId(PM_MAX_ZOOM + 1, 0, 0), RangeError);
  assert.throws(() => zxyToTileId(2, 4, 0), RangeError);
  assert.throws(() => zxyToTileId(2, 0, -1), RangeError);
  assert.throws(() => tileIdToZxy(zoomStartId(PM_MAX_ZOOM + 1)), RangeError);
});

test('findPmEntry: the entry a tile id falls in, by exact id or inside a run; a leaf covers everything after it', () => {
  const entries = [
    { tileId: 5, offset: 0, length: 10, runLength: 1 },
    { tileId: 10, offset: 10, length: 10, runLength: 3 },
    { tileId: 20, offset: 20, length: 10, runLength: 0 },
  ];
  assert.equal(findPmEntry(entries, 4), undefined);
  assert.equal(findPmEntry(entries, 5), entries[0]);
  assert.equal(findPmEntry(entries, 6), undefined, 'past a run of one');
  assert.equal(findPmEntry(entries, 10), entries[1]);
  assert.equal(findPmEntry(entries, 12), entries[1]);
  assert.equal(findPmEntry(entries, 13), undefined);
  assert.equal(findPmEntry(entries, 20), entries[2]);
  assert.equal(findPmEntry(entries, 9999), entries[2], 'a leaf directory holds whatever follows');
  assert.equal(findPmEntry([], 1), undefined);
});

test('compressInternal: none and gzip, read back by decompressInternal; anything else is refused', () => {
  const bytes = new TextEncoder().encode('directory '.repeat(100));
  assert.equal(compressInternal(bytes, 1), bytes, 'uncompressed is the same bytes');
  const zipped = compressInternal(bytes, 2);
  assert.ok(zipped.length < bytes.length);
  assert.deepEqual([...decompressInternal(zipped, 2)], [...bytes]);
  assert.deepEqual([...decompressInternal(gzipSync(bytes), 2)], [...bytes]);
  for (const other of [0, 3, 4, 99]) {
    assert.throws(() => compressInternal(bytes, other), PmtilesFormatError);
    assert.throws(() => decompressInternal(bytes, other), PmtilesFormatError);
  }
  // A small file that unpacks to more than is allowed is stopped, not unpacked.
  assert.throws(() => decompressInternal(gzipSync(new Uint8Array(1_000_000)), 2, 1000));
});

test('selectionTileCount: the whole world to the world zoom, plus the area at each deeper zoom', () => {
  assert.equal(selectionTileCount({ worldMaxZoom: 0, maxZoom: 0 }), 1);
  assert.equal(selectionTileCount({ worldMaxZoom: 2, maxZoom: 2 }), 1 + 4 + 16);
  assert.equal(selectionTileCount({ worldMaxZoom: 2, maxZoom: 9 }), 21, 'no area: the deeper zoom adds nothing');
  const oahu = { west: -158.35, south: 21.2, east: -157.6, north: 21.75 };
  const withArea = selectionTileCount({ worldMaxZoom: 2, maxZoom: 4, bounds: oahu });
  assert.equal(withArea, 21 + 1 + 1, 'a small island is one tile at zooms 3 and 4');
  const deeper = selectionTileCount({ worldMaxZoom: 2, maxZoom: 12, bounds: oahu });
  assert.ok(deeper > withArea && deeper < 500);
  assert.equal(selectionProblem({ worldMaxZoom: 2, maxZoom: 12, bounds: oahu }), undefined);
  assert.match(selectionProblem({ worldMaxZoom: 5, maxZoom: 2 }) ?? '', /at least the world zoom/);
  assert.match(selectionProblem({ worldMaxZoom: 1.5, maxZoom: 2 }) ?? '', /whole numbers/);
  assert.match(selectionProblem({ worldMaxZoom: 0, maxZoom: PM_MAX_ZOOM + 1 }) ?? '', /whole numbers/);
  assert.match(
    selectionProblem({ worldMaxZoom: 0, maxZoom: 5, bounds: { ...oahu, east: -200 } }) ?? '',
    /not on the Earth/,
  );
  assert.match(
    selectionProblem({ worldMaxZoom: 0, maxZoom: 5, bounds: { ...oahu, west: 170, east: -170 } }) ?? '',
    /no size/,
  );
  assert.match(
    selectionProblem({
      worldMaxZoom: 0,
      maxZoom: PM_MAX_ZOOM,
      bounds: { west: -180, south: -85, east: 180, north: 85 },
    }) ?? '',
    /too many tiles/,
  );
});

// ---- small checks ----------------------------------------------------------------------

test('isSemver and isRegionPresetId', () => {
  for (const ok of ['0.7.5', '1.0.0', '10.20.30', '1.2.3-beta.1']) assert.equal(isSemver(ok), true, ok);
  for (const bad of ['', '1', '1.2', 'v1.2.3', '1.2.3.4', '1.2.x', ' 1.2.3', '1.2.3\n'])
    assert.equal(isSemver(bad), false, bad);
  for (const preset of REGION_PRESETS) {
    assert.equal(isRegionPresetId(preset.id), true);
    const b = preset.bounds;
    assert.ok(
      b.west < b.east && b.south < b.north && b.west >= -180 && b.east <= 180 && b.south >= -90 && b.north <= 90,
      preset.id,
    );
  }
  assert.equal(new Set(REGION_PRESETS.map((p) => p.id)).size, REGION_PRESETS.length);
  for (const bad of ['', 'atlantis', 'HAWAII', 'constructor', '__proto__'])
    assert.equal(isRegionPresetId(bad), false, bad);
});

test('crc32: the published check value, and the same whether fed whole or in pieces', () => {
  const text = new TextEncoder().encode('123456789');
  assert.equal(crc32(text), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32Update(0, new Uint8Array()), 0);
  let seed = 9;
  const bytes = Uint8Array.from({ length: 5000 }, () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) & 0xff);
  for (const cut of [0, 1, 7, 2500, 4999, 5000])
    assert.equal(
      crc32Update(crc32Update(0, bytes.subarray(0, cut)), bytes.subarray(cut)),
      crc32(bytes),
      `cut at ${cut}`,
    );
  assert.ok(crc32(bytes) >= 0 && crc32(bytes) <= 0xffff_ffff);
});

test('renderNotices: every source with its licence and attribution, in id order, with the files it supplied', () => {
  const text = renderNotices({
    id: 'oahu',
    name: "O'ahu",
    createdAt: '2026-11-01T00:00:00.000Z',
    bounds: { west: -158.35, south: 21.2, east: -157.6, north: 21.75 },
    sources: [
      { providerId: 'zeta', license: 'CC-BY-4.0', attribution: 'Zeta Org' },
      {
        providerId: 'alpha',
        license: 'ODbL-1.0',
        attribution: '© Alpha contributors',
        termsUrl: 'https://alpha.example/terms',
      },
    ] as never,
    contents: [
      { path: 'layers/alpha.geojson', kind: 'geojson', providerId: 'alpha', rowCount: 12 },
      { path: 'tiles/base.pmtiles', kind: 'pmtiles', providerId: 'alpha' },
    ] as never,
  });
  assert.ok(text.startsWith("# Data notices — O'ahu (oahu)\n"));
  assert.ok(text.indexOf('### alpha') < text.indexOf('### zeta'));
  assert.match(
    text,
    /- Licence: ODbL-1\.0\n- Attribution: © Alpha contributors\n- Terms: https:\/\/alpha\.example\/terms/,
  );
  assert.match(text, /- Files: `layers\/alpha\.geojson` \(12 rows\), `tiles\/base\.pmtiles`/);
  assert.match(text, /### zeta\n\n- Licence: CC-BY-4\.0\n- Attribution: Zeta Org\n\n/);
  assert.match(text, /W -158\.35 · S 21\.20 · E -157\.60 · N 21\.75/);
});

// ---- signatures and replacement --------------------------------------------------------

test('publicKeyOf: the public half of a pack key, and only of an Ed25519 key', () => {
  const pair = generatePackKeyPair();
  assert.equal(publicKeyOf(pair.privateKeyPem), pair.publicKey);
  assert.equal(Buffer.from(pair.publicKey, 'base64').length, 32);
  assert.match(pair.keyId, /^[0-9a-f]{16}$/);
  assert.notEqual(generatePackKeyPair().publicKey, pair.publicKey);
  assert.throws(() => publicKeyOf('not a key'));
  assert.throws(() => publicKeyOf(''));
});

const signed = (keyId: string, over: Partial<Extract<PackSignature, { status: 'signed' }>> = {}): PackSignature => ({
  status: 'signed',
  keyId,
  publicKey: `key-${keyId}`,
  trusted: false,
  ...over,
});

test('signatureSummary: what the page is told, never the public key', () => {
  assert.deepEqual(signatureSummary(undefined), { status: 'unsigned' });
  assert.deepEqual(signatureSummary({ status: 'unsigned' }), { status: 'unsigned' });
  assert.deepEqual(signatureSummary({ status: 'invalid', reason: 'bad' }), { status: 'invalid', reason: 'bad' });
  assert.deepEqual(signatureSummary({ status: 'unchecked', keyId: 'aa', publicKey: 'PK', reason: 'no ed25519' }), {
    status: 'unchecked',
    keyId: 'aa',
    reason: 'no ed25519',
  });
  assert.deepEqual(signatureSummary(signed('aa')), { status: 'signed', keyId: 'aa' });
  assert.deepEqual(signatureSummary(signed('aa', { trusted: true })), { status: 'trusted', keyId: 'aa' });
  assert.deepEqual(signatureSummary(signed('aa', { trusted: true, publisher: 'Acme' })), {
    status: 'trusted',
    keyId: 'aa',
    publisher: 'Acme',
  });
  for (const sig of [
    signed('aa'),
    signed('aa', { trusted: true }),
    { status: 'unchecked', keyId: 'a', publicKey: 'PK', reason: 'r' } as const,
  ])
    assert.ok(
      !JSON.stringify(signatureSummary(sig)).includes('PK') && !JSON.stringify(signatureSummary(sig)).includes('key-'),
    );
});

test('replacementProblem: not by an older pack; a signed pack only by the same key or a trusted publisher', () => {
  const manifest = (createdAt: string) => ({ id: 'oahu', createdAt }) as never;
  const older = manifest('2026-10-01T00:00:00.000Z');
  const newer = manifest('2026-11-01T00:00:00.000Z');
  assert.equal(replacementProblem(older, undefined, newer, undefined), undefined);
  assert.equal(replacementProblem(older, undefined, older, undefined), undefined, 'the same pack again is allowed');
  assert.match(replacementProblem(newer, undefined, older, undefined) ?? '', /older than the installed "oahu" pack/);
  // Signed by A:
  assert.equal(replacementProblem(older, signed('aaaa'), newer, signed('aaaa')), undefined, 'the same key');
  assert.match(
    replacementProblem(older, signed('aaaa'), newer, signed('bbbb')) ?? '',
    /signed with key aaaa; this one is signed with key bbbb/,
  );
  assert.match(replacementProblem(older, signed('aaaa'), newer, undefined) ?? '', /this one is not signed/);
  assert.match(replacementProblem(older, signed('aaaa'), newer, { status: 'unsigned' }) ?? '', /not signed/);
  assert.match(
    replacementProblem(older, signed('aaaa'), newer, { status: 'invalid', reason: 'x' }) ?? '',
    /not signed/,
  );
  assert.equal(
    replacementProblem(older, signed('aaaa'), newer, signed('bbbb', { trusted: true })),
    undefined,
    'one of your publishers',
  );
  // The same key id with another key is another key.
  assert.match(
    replacementProblem(older, signed('aaaa'), newer, signed('aaaa', { publicKey: 'forged' })) ?? '',
    /signed with key/,
  );
  // An unsigned or unverified installed pack can be replaced by anything newer.
  assert.equal(replacementProblem(older, { status: 'unsigned' }, newer, signed('bbbb')), undefined);
  assert.equal(replacementProblem(older, { status: 'invalid', reason: 'x' }, newer, undefined), undefined);
  // Age is checked first, whoever signed it.
  assert.match(replacementProblem(newer, signed('aaaa'), older, signed('aaaa')) ?? '', /older than/);
});

test('signatureLine, formatVerification and errorText', () => {
  assert.match(signatureLine({ status: 'unsigned' }), /^not signed/);
  assert.equal(signatureLine({ status: 'invalid', reason: 'tampered' }), 'signature INVALID — tampered');
  assert.equal(
    signatureLine({ status: 'unchecked', keyId: 'a1b2c3d4e5f60718', publicKey: '', reason: 'no ed25519' }),
    'signed by key a1b2 c3d4 e5f6 0718 — not checked: no ed25519',
  );
  assert.equal(
    signatureLine(signed('a1b2c3d4e5f60718')),
    'signed by key a1b2 c3d4 e5f6 0718 — not one of your trusted publishers',
  );
  assert.equal(
    signatureLine(signed('a1b2c3d4e5f60718', { trusted: true })),
    'signed by a trusted publisher (key a1b2 c3d4 e5f6 0718)',
  );
  assert.equal(
    signatureLine(signed('a1b2c3d4e5f60718', { trusted: true, publisher: 'Acme' })),
    'signed by Acme (key a1b2 c3d4 e5f6 0718)',
  );
  const failed = formatVerification({
    ok: false,
    file: 'oahu.worldpack',
    sizeBytes: 123,
    entries: [],
    issues: ['manifest missing'],
    warnings: ['expired'],
  });
  assert.equal(failed, 'FAIL oahu.worldpack (123 bytes)\n     warning: expired\n     issue: manifest missing');
  const passed = formatVerification({
    ok: true,
    file: 'oahu.worldpack',
    sizeBytes: 456,
    manifest: { id: 'oahu', name: "O'ahu", createdAt: '2026-11-01T00:00:00.000Z', minimumAppVersion: '0.7.0' } as never,
    signature: { status: 'unsigned' },
    update: { baseCreatedAt: '2026-10-01T00:00:00.000Z', baseManifestSha256: 'ab'.repeat(32), reused: ['a', 'b'] },
    entries: [{ path: 'layers/a.geojson', kind: 'geojson', sizeBytes: 10, sha256: 'cd'.repeat(32) } as never],
    issues: [],
    warnings: [],
  });
  const lines = passed.split('\n');
  assert.equal(lines[0], 'OK   oahu.worldpack (456 bytes)');
  assert.match(lines[1]!, /oahu — O'ahu · created 2026-11-01T00:00:00\.000Z · min app 0\.7\.0/);
  assert.match(lines[2]!, /not signed/);
  assert.match(
    lines[3]!,
    /update of the pack created 2026-10-01T00:00:00\.000Z \(manifest abababababab…\): 2 files come from it/,
  );
  assert.match(lines[4]!, /✓ layers\/a\.geojson\s+geojson\s+10 B {2}sha256 cdcdcdcdcdcdcdcd…/);
  assert.equal(errorText(new Error('bad pack')), 'bad pack');
  assert.equal(errorText('text'), 'text');
  assert.equal(errorText(null), 'null');
});

// ---- vaults ----------------------------------------------------------------------------

test('parseVaultMarker, vaultMarkerMatches and vaultSummary', async () => {
  const id = 'ab'.repeat(16);
  const marker = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        app: 'opcb',
        id,
        label: 'Field SSD',
        createdAt: '2026-11-01T00:00:00.000Z',
        ...over,
      }),
    );
  const parsed = parseVaultMarker(marker());
  assert.ok(parsed.ok && parsed.marker.id === id && parsed.marker.label === 'Field SSD');
  const legacy = parseVaultMarker(marker({ app: 'worldview' }));
  assert.ok(legacy.ok && legacy.marker.app === 'opcb', 'a vault from before the rename is still a vault');
  const long = parseVaultMarker(marker({ label: 'L'.repeat(200), createdAt: 5 }));
  assert.ok(long.ok && long.marker.label.length === 80 && long.marker.createdAt === '');
  const why = (bytes: Buffer) => {
    const r = parseVaultMarker(bytes);
    return r.ok ? 'ok' : r.reason;
  };
  assert.match(why(Buffer.from('not json')), /not JSON/);
  assert.match(why(Buffer.from('null')), /not an OP-CB vault marker/);
  assert.match(why(Buffer.from('[]')), /not an OP-CB vault marker/);
  assert.match(why(marker({ formatVersion: 2 })), /not an OP-CB vault marker/);
  assert.match(why(marker({ app: 'other' })), /not an OP-CB vault marker/);
  assert.match(why(marker({ id: 'short' })), /malformed/);
  assert.match(why(marker({ id: 'AB'.repeat(16) })), /malformed/);
  assert.match(why(marker({ id: `${id}\n` })), /malformed/);
  assert.match(why(Buffer.alloc(5000, 0x20)), /too large/);

  const files = (map: Record<string, Buffer>) => ({
    readFile: (p: string) => {
      const name = p.split(/[\\/]/).pop()!;
      const hit = map[name];
      return hit ? Promise.resolve(hit) : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    },
  });
  assert.equal(await vaultMarkerMatches('/vault', id, files({ '.opcb-vault.json': marker() })), true);
  assert.equal(
    await vaultMarkerMatches('/vault', id, files({ '.worldview-vault.json': marker({ app: 'worldview' }) })),
    true,
  );
  assert.equal(
    await vaultMarkerMatches('/vault', 'cd'.repeat(16), files({ '.opcb-vault.json': marker() })),
    false,
    "another vault's marker",
  );
  assert.equal(await vaultMarkerMatches('/vault', id, files({})), false, 'no marker: the drive is not there');
  assert.equal(await vaultMarkerMatches('/vault', id, files({ '.opcb-vault.json': Buffer.from('{') })), false);
  assert.equal(
    await vaultMarkerMatches('/vault', id, {
      readFile: () => Promise.reject(Object.assign(new Error('io'), { code: 'EIO' })),
    }),
    false,
  );

  const health = {
    id,
    label: 'Field SSD',
    path: '/media/ssd',
    state: 'ready' as const,
    message: '',
    checkedAt: '2026-11-19T00:00:00.000Z',
    device: 2049,
  };
  const summary = vaultSummary(health);
  assert.equal('device' in summary, false);
  assert.deepEqual(summary, {
    id,
    label: 'Field SSD',
    path: '/media/ssd',
    state: 'ready',
    message: '',
    checkedAt: '2026-11-19T00:00:00.000Z',
  });
  assert.equal(health.device, 2049, 'what was given is not changed');
});

// ---- ZIM -------------------------------------------------------------------------------

test('readMimeList: zero-terminated names up to an empty one', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.deepEqual(readMimeList(bytes('text/html\0image/png\0\0trailing')), ['text/html', 'image/png']);
  assert.deepEqual(readMimeList(bytes('\0')), []);
  assert.deepEqual(readMimeList(bytes('text/plain; charset=utf-8\0\0')), ['text/plain; charset=utf-8']);
  assert.throws(() => readMimeList(bytes('text/html\0image/png')), ZimError);
  assert.throws(() => readMimeList(new Uint8Array()), ZimError);
  assert.throws(() => readMimeList(bytes('a\0'.repeat(5000))), /too long/);
});

function zimEntry(mime: number, fields: number[], path: string, title: string, params = 0): Uint8Array {
  const text = new TextEncoder().encode(`${path}\0${title}\0`);
  const head = new Uint8Array(8 + fields.length * 4);
  const view = new DataView(head.buffer);
  view.setUint16(0, mime, true);
  head[2] = params;
  head[3] = 'C'.charCodeAt(0);
  fields.forEach((f, i) => view.setUint32(8 + i * 4, f, true));
  const out = new Uint8Array(head.length + text.length + params);
  out.set(head);
  out.set(text, head.length);
  return out;
}

test('decodeZimEntry: an article, a redirect, and nothing when the bytes stop early', () => {
  const mimes = ['text/html', 'image/png'];
  const article = decodeZimEntry(zimEntry(0, [7, 3], 'A/Water', 'Water purification'), 4, mimes)!;
  assert.deepEqual(article, {
    index: 4,
    namespace: 'C',
    path: 'A/Water',
    title: 'Water purification',
    mimeType: 'text/html',
    cluster: 7,
    blob: 3,
  });
  assert.equal(decodeZimEntry(zimEntry(1, [0, 0], 'I/a.png', ''), 0, mimes)!.title, 'I/a.png', 'no title: the path');
  const redirect = decodeZimEntry(zimEntry(0xffff, [42], 'A/H2O', 'H2O'), 1, mimes)!;
  assert.equal(redirect.redirectTo, 42);
  assert.equal(redirect.mimeType, undefined);
  assert.equal(decodeZimEntry(zimEntry(0, [1, 1], 'Kīlauea/日本', 'Tītle'), 0, mimes)!.path, 'Kīlauea/日本');
  assert.throws(() => decodeZimEntry(zimEntry(9, [1, 1], 'A/x', 'x'), 0, mimes), /MIME type 9, which is not listed/);
  const whole = zimEntry(0, [7, 3], 'A/Water', 'Water', 2);
  assert.ok(decodeZimEntry(whole, 0, mimes));
  for (let cut = 0; cut < whole.length; cut++)
    assert.equal(decodeZimEntry(whole.subarray(0, cut), 0, mimes), undefined, `cut at ${cut}`);
});

test('isArticleMime and fileZimSource', async () => {
  for (const mime of [undefined, 'text/html', 'text/html; charset=utf-8', 'text/plain', 'application/pdf'])
    assert.equal(isArticleMime(mime), true, String(mime));
  for (const mime of ['image/png', 'text/css', 'application/javascript', 'text/plainer', ''])
    assert.equal(isArticleMime(mime), false, mime);

  const data = Uint8Array.from({ length: 100 }, (_, i) => i);
  // A file that hands back at most seven bytes a read.
  const handle = {
    read(buf: Uint8Array, off: number, len: number, pos: number) {
      const n = Math.max(0, Math.min(7, len, data.length - pos));
      buf.set(data.subarray(pos, pos + n), off);
      return Promise.resolve({ bytesRead: n });
    },
  };
  const source = fileZimSource(handle, data.length);
  assert.equal(source.size, 100);
  assert.deepEqual([...(await source.read(10, 20))], [...data.subarray(10, 30)]);
  assert.deepEqual([...(await source.read(95, 20))], [95, 96, 97, 98, 99], 'short at the end of the file');
  assert.equal((await source.read(100, 5)).length, 0);
  assert.equal((await source.read(500, 5)).length, 0);
  assert.equal((await source.read(0, 0)).length, 0);
  // A file that turns out shorter than it said gives what there is.
  const short = fileZimSource(handle, 200);
  assert.equal((await short.read(90, 50)).length, 10);
});

test('htmlToText: text as a reader would see it, each entity decoded once', () => {
  const cases: Array<[string, string]> = [
    [
      '<p>Clean <b>wounds</b> &amp; cover.<script>x()</script></p><p>Then&nbsp;rest</p>',
      'Clean wounds & cover.\nThen rest',
    ],
    ['a &amp;lt; b &lt;i&gt; &#38;amp; &#x41;&#65;', 'a &lt; b <i> &amp; AA'],
    ['a < b and c > d', 'a < b and c > d'],
    ['x<!-- a > b --><b>y</b>', 'x y'],
    ['x <!-- never closed <b>y</b>', 'x y'],
    ['<p>a</p><br><br/>b<br class="x">c', 'a\nb\nc'],
    ['<SCRIPT type="x">1 < 2</SCRIPT >z<style>p{}</style>', 'z'],
    ['a<template><p>t</p></template>b<noscript>n</noscript>c', 'a b c'],
    ['  \n\n lead  　 trail \n ', 'lead trail'],
    ['&unknown; &#0; &#xD800; &#x110000; &#x1F30B;', '&unknown; \u{1F30B}'],
    ['<script>never closed <b>bold</b>', 'never closed bold'],
    ['<p>unfinished <a href="x', 'unfinished <a href="x'],
    ['', ''],
  ];
  for (const [html, want] of cases) assert.equal(htmlToText(html), want, html);
  assert.equal(htmlToText('abcdef', 3), 'abc');
  assert.equal(htmlToText('a b c', 0), '');
  assert.equal(htmlToText(`<p>${'word '.repeat(100)}</p>`, 14), 'word word word');
});

test('htmlToText: a megabyte of anything is read in a moment', () => {
  const hostile = [
    '<script>x'.repeat(110_000),
    '<a '.repeat(350_000),
    '<'.repeat(1_000_000),
    '<!--'.repeat(250_000),
    '</script '.repeat(110_000),
    '<script></script'.repeat(60_000),
    '&'.repeat(1_000_000),
    '&#'.repeat(500_000),
    ' \n '.repeat(330_000),
    '<br '.repeat(250_000),
  ];
  for (const html of hostile) {
    const started = Date.now();
    const out = htmlToText(html);
    assert.ok(out.length <= 20_000);
    assert.ok(Date.now() - started < 1500, `${html.slice(0, 12)}… took ${Date.now() - started} ms`);
  }
});

// ---- network helpers -------------------------------------------------------------------

test('fetchFailure: what went wrong in words an operator can act on', () => {
  const failed = (code: string) =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  assert.match(fetchFailure(failed('ECONNREFUSED')), /nothing is listening there/);
  assert.match(fetchFailure(failed('ENOTFOUND')), /host name was not found/);
  assert.match(fetchFailure(failed('EAI_AGAIN')), /host name was not found/);
  assert.match(fetchFailure(failed('ECONNRESET')), /connection was reset/);
  assert.equal(fetchFailure(failed('EPIPE')), 'fetch failed: EPIPE');
  assert.match(
    fetchFailure(new TypeError('fetch failed; redirects are not followed')),
    /redirect, which is not followed/,
  );
  assert.match(
    fetchFailure(Object.assign(new TypeError('fetch failed'), { cause: 'unexpected redirect' })),
    /redirect/,
  );
  assert.equal(fetchFailure(new Error('boom')), 'boom');
  assert.equal(fetchFailure('text'), 'text');
  assert.equal(fetchFailure(undefined), 'undefined');
});

test('httpRangeSource: only a 206 with exactly the bytes asked for is taken', async (t) => {
  const file = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  const asked: string[] = [];
  const server = (answer: (start: number, end: number) => Response): typeof fetch =>
    ((_url: string, init: RequestInit) => {
      const range = String((init.headers as Record<string, string>)['Range']);
      asked.push(range);
      const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      return Promise.resolve(answer(Number(a), Number(b)));
    }) as never;
  const partial = (start: number, end: number, body = file.subarray(start, end + 1), total = file.length) =>
    new Response(body, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${Math.min(end, total - 1)}/${total}` },
    });

  let counted = 0;
  const good = httpRangeSource(
    server((s, e) => partial(s, e)),
    'https://maps.example/x.pmtiles',
    (n) => (counted += n),
  );
  assert.deepEqual([...(await good.read(10, 20))], [...file.subarray(10, 30)]);
  assert.equal(asked.at(-1), 'bytes=10-29');
  assert.equal(counted, 20);
  // Short only at the very end of the file.
  assert.equal((await good.read(990, 100)).length, 10);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(good.read(0, 10, aborted.signal));

  // Each of these is refused, and asked for again before it is given up on. The waits between
  // tries are skipped with the test's own clock.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const refuses = async (fetchImpl: typeof fetch, why: RegExp) => {
    const before = asked.length;
    const pending = httpRangeSource(fetchImpl, 'https://maps.example/x.pmtiles').read(10, 20);
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 200 && !settled; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(10_000);
    }
    await assert.rejects(pending, why);
    assert.equal(asked.length - before, 4, 'tried four times');
  };
  await refuses(
    server(() => new Response(file, { status: 200 })),
    /answered 200 to a byte range/,
  );
  await refuses(
    server(() => new Response('', { status: 416 })),
    /answered 416/,
  );
  await refuses(
    server((s, e) => partial(s + 1, e + 1)),
    /sent another range/,
  );
  await refuses(
    server((s, e) => new Response(file.subarray(s, e + 1), { status: 206 })),
    /sent another range/,
  );
  await refuses(
    server((s, e) => partial(s, e, file.subarray(s, e - 4))),
    /asked for 20 bytes, got 15/,
  );
  await refuses(
    server((s) => partial(s, s + 499, file.subarray(s, s + 500))),
    /offered more/,
  );
});
