import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTANCES_URL,
  KARTAVIEW_HOST,
  MIN_GAP_MS,
  PANORAMAX_HOST,
  StreetLevel,
  kartaviewUrl,
  panoramaxUrl,
  readInstanceHosts,
  readKartaView,
  readPanoramax,
} from './street-level.js';

/** The shape api.panoramax.xyz/api/search answered on 2026-10-20 near Notre-Dame (one feature, cut down). */
const ANSWER = {
  features: [
    {
      id: '9cc38bf6-6a40-4adf-b2be-4447eb361202',
      geometry: { type: 'Point', coordinates: [2.351779, 48.856489] },
      properties: {
        datetime: '2023-05-20T17:55:28+00:00',
        license: 'CC-BY-SA-4.0',
        'view:azimuth': 81,
        'geovisio:producer': 'mapcomplete',
      },
      providers: [
        { name: 'mapcomplete', roles: ['producer'] },
        { name: 'pyrog', roles: ['producer'] },
      ],
      assets: {
        hd: { href: 'https://panoramax.mapcomplete.org/derivatives/9c/c3/8b/f6/6a40-4adf-b2be-4447eb361202/hd.jpg' },
        sd: { href: 'https://panoramax.mapcomplete.org/derivatives/9c/c3/8b/f6/6a40-4adf-b2be-4447eb361202/sd.jpg' },
        thumb: {
          href: 'https://panoramax.mapcomplete.org/derivatives/9c/c3/8b/f6/6a40-4adf-b2be-4447eb361202/thumb.jpg',
        },
      },
    },
    // Not pictures: no licence; a thumbnail over http; a bad id; off the Earth; a thumbnail on a host that is no Panoramax instance.
    {
      id: 'jkl',
      geometry: { coordinates: [2.35, 48.85] },
      properties: { license: 'CC-BY-SA-4.0' },
      assets: { thumb: { href: 'https://evil.example/t.jpg' } },
    },
    {
      id: 'abc',
      geometry: { coordinates: [2.35, 48.85] },
      properties: {},
      assets: { thumb: { href: 'https://x/t.jpg' } },
    },
    {
      id: 'def',
      geometry: { coordinates: [2.35, 48.85] },
      properties: { license: 'CC-BY-SA-4.0' },
      assets: { thumb: { href: 'http://x/t.jpg' } },
    },
    {
      id: '../x',
      geometry: { coordinates: [2.35, 48.85] },
      properties: { license: 'x' },
      assets: { thumb: { href: 'https://x/t' } },
    },
    {
      id: 'ghi',
      geometry: { coordinates: [200, 48.85] },
      properties: { license: 'x' },
      assets: { thumb: { href: 'https://x/t' } },
    },
  ],
  links: [],
};
const AT = { latitude: 48.8566, longitude: 2.3522 };
/** Two of the 25 instances api.panoramax.xyz/api/instances listed on 2026-10-20. */
const INSTANCES = {
  instances: [
    { url: 'https://panoramax.mapcomplete.org', name: 'MapComplete' },
    { url: 'https://panoramax.ign.fr', name: 'IGN' },
    { url: 'ftp://nope', name: 'not https' },
  ],
};
const HOSTS = new Set(readInstanceHosts(INSTANCES));

/** What api.kartaview.org/2.0/photo/ answered on 2026-11-08 near Honolulu (one record, cut to the fields read; the others as served). */
const HONOLULU = { latitude: 21.3069, longitude: -157.8583 };
const KARTAVIEW_ANSWER = {
  status: { apiCode: 600, apiMessage: 'The request has been processed without incidents', httpCode: 200 },
  result: {
    data: [
      {
        id: '421496730',
        distance: '13.45',
        fileurlTh: 'https://storage11.openstreetcam.org/files/photo/2019/5/29/th/1461954_994e6_5334.jpg',
        heading: '229',
        imageThUrl:
          'https://cdn.kartaview.org/pr:sharp/aHR0cHM6Ly9zdG9yYWdlMTEub3BlbnN0cmVldGNhbS5vcmcvZmlsZXMvcGhvdG8vMjAxOS81LzI5L3RoLzE0NjE5NTRfOTk0ZTZfNTMzNC5qcGc',
        lat: '21.30566',
        lng: '-157.857315',
        orgCode: 'CMNT',
        projection: 'PLANE',
        sequenceId: '1461954',
        sequenceIndex: '5334',
        shotDate: '2019-05-29 04:31:28.000',
        status: 'active',
        user: null,
        visibility: 'public',
      },
      {
        id: '1590404585',
        distance: '0.00',
        fileurlTh: 'https://storage13.openstreetcam.org/files/photo/2022/8/29/th/5993641_x_103.jpg',
        heading: '126.42',
        lat: '21.305743',
        lng: '-157.859162',
        sequenceId: '5993641',
        sequenceIndex: '103',
        shotDate: '2022-08-29 21:49:53.000',
        status: 'active',
        // The `user` object `join=user` gave on 2026-11-08 for a picture near the Eiffel Tower,
        // set on this Honolulu record for the test (this record's own user was asked without the join).
        user: {
          id: '53',
          username: 'telenavdrives',
          fullName: 'telenavdrives',
          category: 'INTERNAL',
          driverType: 'DEDICATED',
        },
        visibility: 'public',
      },
      // Not shown: a private one (seen in Paris), one with a thumbnail off KartaView's hosts, one with no place.
      {
        id: '20282272',
        fileurlTh: 'https://storage1.openstreetcam.org/x.jpg',
        lat: '21.3',
        lng: '-157.85',
        status: 'active',
        visibility: 'private',
      },
      {
        id: '7',
        imageThUrl: 'https://evil.example/t.jpg',
        lat: '21.3',
        lng: '-157.85',
        status: 'active',
        visibility: 'public',
      },
      {
        id: '8',
        imageThUrl: 'https://cdn.kartaview.org/t.jpg',
        lat: 'x',
        lng: '-157.85',
        status: 'active',
        visibility: 'public',
      },
    ],
    hasMoreData: false,
  },
};

test('street level: the URL asks Panoramax for the point, lon,lat, within the radius, and nothing else', () => {
  assert.equal(
    panoramaxUrl(AT, 150, 6),
    `https://${PANORAMAX_HOST}/api/search?place_position=2.352200%2C48.856600&place_distance=0-150&limit=6`,
  );
});

test('street level: a picture with its place, heading, time, licence, author and https thumbnail; the rest left out', () => {
  assert.deepEqual([...HOSTS], ['panoramax.mapcomplete.org', 'panoramax.ign.fr']);
  const pics = readPanoramax(ANSWER, AT, 6, HOSTS);
  assert.equal(pics.length, 1);
  const [p] = pics;
  assert.equal(p!.id, '9cc38bf6-6a40-4adf-b2be-4447eb361202');
  assert.deepEqual(p!.position, { latitude: 48.856489, longitude: 2.351779 });
  assert.ok(p!.distanceM > 25 && p!.distanceM < 45, String(p!.distanceM));
  assert.equal(p!.headingDeg, 81);
  assert.equal(p!.takenAt, '2023-05-20T17:55:28.000Z');
  assert.equal(p!.license, 'CC-BY-SA-4.0');
  assert.equal(p!.author, 'mapcomplete');
  assert.match(p!.thumbUrl, /^https:\/\/panoramax\.mapcomplete\.org\/.*thumb\.jpg$/);
  assert.equal(p!.pageUrl, `https://${PANORAMAX_HOST}/#focus=pic&pic=9cc38bf6-6a40-4adf-b2be-4447eb361202`);
  assert.deepEqual(readPanoramax({ features: [], links: [] }, AT, 6), []);
  assert.deepEqual(readPanoramax('nonsense', AT, 6), []);
  assert.deepEqual(readPanoramax(ANSWER, AT, 6), [], 'no instance list read yet: no picture host is trusted');
});

test('street level: one request a second, cached an hour, nothing sent offline or when switched off', async () => {
  let now = 1_000_000;
  let online = true;
  let enabled = true;
  const sent: string[] = [];
  const sleeps: number[] = [];
  const sl = new StreetLevel({
    fetchImpl: (async (url: string) => {
      if (url === INSTANCES_URL) return new Response(JSON.stringify(INSTANCES), { status: 200 });
      sent.push(url);
      return new Response(JSON.stringify(ANSWER), { status: 200 });
    }) as unknown as typeof fetch,
    userAgent: 'OP-CB test',
    isOnline: () => online,
    enabled: () => enabled,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const first = await sl.near({ position: AT });
  assert.equal(first.status, 'ok');
  assert.equal(first.pictures.length, 1);
  assert.match(first.attribution, /Panoramax contributors/);
  const again = await sl.near({ position: { latitude: 48.85661, longitude: 2.35221 } });
  assert.equal(again, first, 'about ten metres away: the cached answer');
  assert.equal(sent.length, 1);
  await sl.near({ position: { latitude: 48.9, longitude: 2.4 } });
  assert.equal(sent.length, 2);
  assert.deepEqual(sleeps, [MIN_GAP_MS], 'the second request waited its turn');
  assert.equal(sl.stats.instances, 1, 'the federation list was read once for both');
  online = false;
  assert.equal((await sl.near({ position: { latitude: 49, longitude: 2 } })).status, 'offline');
  online = true;
  enabled = false;
  assert.equal((await sl.near({ position: { latitude: 49, longitude: 2 } })).status, 'disabled');
  assert.equal(sent.length, 2, 'nothing sent offline or switched off');
});

test('street level: a service that fails is said, and asked again after two minutes', async () => {
  let now = 0;
  let status = 503;
  const sl = new StreetLevel({
    fetchImpl: (async (url: string) =>
      new Response(
        url === INSTANCES_URL
          ? JSON.stringify(INSTANCES)
          : status === 200
            ? JSON.stringify({ features: [], links: [] })
            : 'busy',
        { status: url === INSTANCES_URL ? 200 : status },
      )) as unknown as typeof fetch,
    userAgent: 'OP-CB test',
    isOnline: () => true,
    enabled: () => true,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const r = await sl.near({ position: AT });
  assert.equal(r.status, 'unavailable');
  assert.match(r.message ?? '', /HTTP 503/);
  status = 200;
  assert.equal((await sl.near({ position: AT })).status, 'unavailable', 'the failure is remembered for two minutes');
  now += 2 * 60_000 + 1;
  assert.equal((await sl.near({ position: AT })).status, 'ok');
});

test('street level: KartaView — the URL (radius in metres, at most 500) and the pictures of its live answer', () => {
  assert.equal(
    kartaviewUrl(HONOLULU, 150, 6),
    `https://${KARTAVIEW_HOST}/2.0/photo/?lat=21.306900&lng=-157.858300&radius=150&itemsPerPage=6&join=user`,
  );
  assert.match(kartaviewUrl(HONOLULU, 2000, 6), /radius=500&/, 'the API refuses more than 500');
  const pics = readKartaView(KARTAVIEW_ANSWER, HONOLULU, 6);
  assert.deepEqual(
    pics.map((p) => p.id),
    ['1590404585', '421496730'],
    'nearest first, by the computed distance (the answer said 0.00 for the second)',
  );
  const [near, far] = pics;
  assert.ok(near!.distanceM > 100 && near!.distanceM < 200, String(near!.distanceM));
  assert.equal(near!.author, 'telenavdrives');
  assert.match(near!.thumbUrl, /^https:\/\/storage13\.openstreetcam\.org\//, 'no CDN address: the storage one');
  assert.equal(far!.headingDeg, 229);
  assert.equal(far!.takenAt, '2019-05-29T04:31:28.000Z');
  assert.equal(far!.license, 'CC-BY-SA-4.0');
  assert.equal(far!.service, 'kartaview');
  assert.equal(far!.author, undefined);
  assert.match(far!.thumbUrl, /^https:\/\/cdn\.kartaview\.org\//);
  assert.equal(far!.pageUrl, 'https://kartaview.org/details/1461954/5334');
  assert.deepEqual(readKartaView({ code: 400, reason: 'VALIDATOR', message: 'invalid' }, HONOLULU, 6), []);
  assert.deepEqual(readKartaView('nonsense', HONOLULU, 6), []);
});

test('street level: KartaView is asked only when Panoramax has nothing within reach, and under the same gap', async () => {
  let now = 0;
  const sent: string[] = [];
  const sleeps: number[] = [];
  let panoramax: unknown = { features: [], links: [] };
  const sl = new StreetLevel({
    fetchImpl: (async (url: string) => {
      if (url === INSTANCES_URL) return new Response(JSON.stringify(INSTANCES), { status: 200 });
      sent.push(url);
      if (url.startsWith(`https://${PANORAMAX_HOST}/`)) return new Response(JSON.stringify(panoramax), { status: 200 });
      return new Response(JSON.stringify(KARTAVIEW_ANSWER), { status: 200 });
    }) as unknown as typeof fetch,
    userAgent: 'OP-CB test',
    isOnline: () => true,
    enabled: () => true,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  const a = await sl.near({ position: HONOLULU });
  assert.equal(a.status, 'ok');
  assert.equal(a.pictures.length, 2);
  assert.equal(a.pictures[0]!.service, 'kartaview');
  assert.match(a.attribution, /KartaView contributors, CC BY-SA 4\.0/);
  assert.equal(sent.length, 2, 'Panoramax first, then KartaView');
  assert.ok(sent[1]!.startsWith(`https://${KARTAVIEW_HOST}/2.0/photo/`));
  assert.deepEqual(sleeps, [MIN_GAP_MS], 'the second request waited its turn');
  // With Panoramax pictures, KartaView is not asked.
  panoramax = ANSWER;
  now += 60 * 60_000 + 1;
  const b = await sl.near({ position: AT });
  assert.equal(b.pictures[0]!.service, 'panoramax');
  assert.equal(sent.length, 3);
});
