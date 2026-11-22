import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validationOk } from './connector.js';
import {
  LOCAL_SOCKET_ORIGIN,
  checkUrl,
  defaultDataPolicy,
  definitionHosts,
  definitionToManifest,
  isLocalSocketPlaceholder,
  keyParamsIn,
  parseDefinition,
  resolveDataPolicy,
  type ConnectorProviderDefinition,
} from './definition.js';
import { compileMapping, FieldMissing, readField, readGeometry } from './mapping.js';
import { checkMqttDefinition } from './mqtt.js';
import { formatPath, parsePath, readPath } from './path.js';
import { bodyToObservations } from './records.js';
import { patternTimestamp } from './transforms.js';

const HTTPS = ['https:'];

test('checkUrl: a public https host, and nothing that could be this computer or its network', () => {
  for (const ok of [
    'https://api.example.com/x',
    'https://API.Example.COM/x',
    'https://example.com:8443/x?y=1',
    'https://example.com/{TOKEN}/x',
    'https://1.1.1.1/',
    'https://172.15.0.1/',
    'https://172.32.0.1/',
    'https://xn--bcher-kva.example/',
  ])
    assert.equal(checkUrl(ok, HTTPS), undefined, ok);
  const refused: Array<[string, RegExp]> = [
    ['not a url', /not a URL/],
    ['https://exa mple.com/', /not a URL/],
    ['http://example.com/', /must be https:/],
    ['ftp://example.com/', /must be https:/],
    ['https://user:pw@example.com/', /credentials/],
    ['https://user@example.com/', /credentials/],
    // This computer, by every spelling of it.
    ['https://localhost/', /public host/],
    ['https://LOCALHOST./', /public host/],
    ['https://app.localhost/', /public host/],
    ['https://127.0.0.1/', /private, loopback/],
    ['https://127.1/', /private, loopback/],
    ['https://2130706433/', /private, loopback/],
    ['https://0x7f.1/', /private, loopback/],
    ['https://017700000001/', /private, loopback/],
    ['https://0/', /private, loopback/],
    ['https://[::1]/', /DNS name or an IPv4/],
    ['https://[::ffff:127.0.0.1]/', /DNS name or an IPv4/],
    // The local network and the cloud metadata address.
    ['https://10.0.0.1/', /private, loopback/],
    ['https://172.16.0.1/', /private, loopback/],
    ['https://172.31.255.255/', /private, loopback/],
    ['https://192.168.1.1/', /private, loopback/],
    ['https://192.168.1.1./', /private, loopback/],
    ['https://169.254.169.254/', /private, loopback/],
    ['https://100.64.0.1/', /private, loopback/],
    ['https://[fe80::1]/', /DNS name or an IPv4/],
    ['https://[fd00::1]/', /DNS name or an IPv4/],
    ['https://[::ffff:10.0.0.1]/', /DNS name or an IPv4/],
    // Not a public service at all.
    ['https://198.18.0.1/', /private, loopback/],
    ['https://224.0.0.1/', /private, loopback/],
    ['https://255.255.255.255/', /private, loopback/],
    // Names only the local network answers.
    ['https://printer/', /public host/],
    ['https://printer.local/', /public host/],
    ['https://nas.lan/', /public host/],
    ['https://metadata.google.internal/', /public host/],
    ['https://a.b.home.arpa/', /public host/],
    ['https://wiki.corp/', /public host/],
    // A secret belongs in the path, never in a name that is looked up.
    ['https://{TOKEN}.example.com/', /\{TOKEN\} placeholder in its host/],
    ['https://example.com:{TOKEN}/', /\{TOKEN\} placeholder in its host/],
    ['https://{TOKEN}/x', /\{TOKEN\} placeholder in its host/],
  ];
  for (const [url, why] of refused) assert.match(checkUrl(url, HTTPS) ?? 'accepted', why, url);
  assert.equal(checkUrl('wss://stream.example.com/v1', ['wss:']), undefined);
  assert.match(checkUrl('https://stream.example.com/v1', ['wss:']) ?? '', /must be wss:/);
  assert.equal(checkUrl('https://example.com/', ['https:', 'wss:']), undefined);
});

test('isLocalSocketPlaceholder: ws://localhost with a path and nothing else', () => {
  assert.equal(LOCAL_SOCKET_ORIGIN, 'ws://localhost');
  for (const ok of ['ws://localhost/', 'ws://localhost/v0/stream', 'ws://localhost/a/b/c'])
    assert.equal(isLocalSocketPlaceholder(ok), true, ok);
  for (const bad of [
    'ws://localhost',
    'ws://localhost:8080/x',
    'wss://localhost/x',
    'ws://localhost.example.com/x',
    'ws://localhost/x?y=1',
    'ws://localhost/x#f',
    'ws://user@localhost/x',
    'ws://127.0.0.1/x',
    'http://localhost/x',
    '',
  ])
    assert.equal(isLocalSocketPlaceholder(bad), false, bad);
});

function definition(over: Record<string, unknown> = {}): ConnectorProviderDefinition {
  const r = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'xy',
    name: 'X',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/x' },
    mapping: { externalId: 'id', position: { lat: 'lat', lon: 'lon' } },
    attribution: { text: 'Example Org' },
    ...over,
  });
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r));
  if (!r.ok) throw new Error('not a definition');
  return r.definition;
}

test('resolveDataPolicy: the fail-closed defaults, what the definition opens, and its own attribution', () => {
  const plain = resolveDataPolicy(definition());
  assert.deepEqual(plain, { ...defaultDataPolicy, attributionText: 'Example Org' });
  assert.equal(plain.redistributionAllowed, false);
  assert.equal(plain.exportAllowed, false);
  assert.equal(plain.rawPayloadRetentionAllowed, false);
  assert.equal(plain.maxRetentionSeconds, 7 * 86_400);
  // Only a reviewed definition may open anything; one a user wrote is refused outright.
  const refused = parseDefinition({
    schema: 'oneview.connector.v1',
    id: 'xy',
    name: 'X',
    connector: 'rest-json',
    objectType: 'sensor',
    endpoint: { url: 'https://api.example.com/x' },
    mapping: { externalId: 'id', position: { lat: 'lat', lon: 'lon' } },
    attribution: { text: 'Example Org' },
    dataPolicy: { exportAllowed: true },
  });
  assert.equal(refused.ok, false);
  const opened = resolveDataPolicy(
    definition({
      review: 'bundled',
      dataPolicy: { exportAllowed: true, maxRetentionSeconds: 3600 },
      termsUrl: 'https://example.com/terms',
    }),
  );
  assert.equal(opened.exportAllowed, true);
  assert.equal(opened.maxRetentionSeconds, 3600);
  assert.equal(opened.termsUrl, 'https://example.com/terms');
  assert.equal(opened.redistributionAllowed, false, 'what is not named stays closed');
  const uncapped = resolveDataPolicy(definition({ review: 'bundled', dataPolicy: { maxRetentionSeconds: null } }));
  assert.equal('maxRetentionSeconds' in uncapped, false, 'null means no cap');
  // The shared default is not changed by any of this.
  assert.equal(defaultDataPolicy.maxRetentionSeconds, 7 * 86_400);
  assert.equal(defaultDataPolicy.exportAllowed, false);
  assert.equal('attributionText' in defaultDataPolicy, false);
});

test('definitionHosts: the hosts a definition asks, lower case, each once', () => {
  assert.deepEqual(definitionHosts(definition()), ['api.example.com']);
  assert.deepEqual(definitionHosts(definition({ endpoint: { url: 'https://API.Example.com/{TOKEN}/x' } })), [
    'api.example.com',
  ]);
  assert.deepEqual(definitionHosts({ endpoint: { url: 'not a url' } } as never), []);
  assert.deepEqual(definitionHosts({} as never), []);
  assert.deepEqual(
    definitionHosts({ endpoint: { url: 'https://b.example/x' }, websocket: { url: 'wss://a.example/y' } } as never),
    ['a.example', 'b.example'],
  );
  assert.deepEqual(definitionToManifest(definition(), 'REST JSON').allowedHosts, ['api.example.com']);
});

test('validationOk and checkMqttDefinition', () => {
  assert.deepEqual(validationOk(), { ok: true, errors: [], warnings: [] });
  assert.deepEqual(validationOk(['slow']), { ok: true, errors: [], warnings: ['slow'] });
  const mqtt = { topics: ['a/#'] } as never;
  assert.equal(checkMqttDefinition({}), undefined);
  assert.equal(checkMqttDefinition({ mqtt }), undefined);
  assert.equal(
    checkMqttDefinition({
      mqtt: { ...(mqtt as object), credential: { name: 'broker' } } as never,
      credentials: { broker: {} },
    }),
    undefined,
  );
  assert.match(
    checkMqttDefinition({
      mqtt: { ...(mqtt as object), credential: { name: 'broker' } } as never,
      credentials: { other: {} },
    }) ?? '',
    /names "broker"/,
  );
  // A name every object has is not a declared credential.
  assert.match(
    checkMqttDefinition({
      mqtt: { ...(mqtt as object), credential: { name: 'constructor' } } as never,
      credentials: {},
    }) ?? '',
    /constructor/,
  );
  for (const also of ['endpoint', 'websocket', 'file'])
    assert.match(checkMqttDefinition({ mqtt, [also]: {} }) ?? '', /no endpoint, websocket or file/, also);
});

test('readField: the first path with a value, then transforms, the lookup table and the default, in that order', () => {
  const m = compileMapping({
    externalId: 'id',
    properties: {
      first: { path: 'a', fallback: ['b', 'c'] },
      speed: { path: 'kt', transform: 'knotsToMps' },
      state: { path: 'code', map: { '1': 'open', '2': 'closed' }, default: 'unknown' },
      fixed: { literal: 'yes' },
      zero: { literal: 0 },
      joined: { concat: ['slot', ['hour', 'tau']], separator: '-' },
      needed: { path: 'must', required: true },
    },
  } as never);
  const field = (name: string) => m.properties.find(([key]) => key === name)![1];
  assert.equal(readField({ a: null, c: 3 }, field('first')), 3, 'null is passed over like a missing value');
  assert.equal(readField({ a: 0, b: 2 }, field('first')), 0, 'zero is a value');
  assert.equal(readField({ a: '', b: 2 }, field('first')), '', 'an empty string is a value');
  assert.equal(readField({}, field('first')), undefined);
  assert.equal(readField({ kt: 10 }, field('speed')), 5.144);
  assert.equal(
    readField({ kt: 'fast' }, field('speed')),
    undefined,
    'a transform that cannot read its input gives nothing',
  );
  assert.equal(readField({ code: 2 }, field('state')), 'closed', 'the table is keyed by the value as text');
  assert.equal(readField({ code: 9 }, field('state')), 'unknown');
  assert.equal(readField({ code: 'constructor' }, field('state')), 'unknown', "only the table's own entries");
  assert.equal(readField({ code: { x: 1 } }, field('state')), 'unknown');
  assert.equal(readField({}, field('fixed')), 'yes');
  assert.equal(readField({}, field('zero')), 0);
  assert.equal(readField({ slot: 'AL01', tau: 12 }, field('joined')), 'AL01-12');
  assert.equal(readField({ slot: 'AL01', hour: 0, tau: 12 }, field('joined')), 'AL01-0');
  assert.equal(readField({ slot: 'AL01' }, field('joined')), undefined, 'every part or nothing');
  assert.equal(readField({ slot: { nested: 1 }, hour: 1 }, field('joined')), undefined);
  assert.throws(() => readField({}, field('needed')), FieldMissing);
  assert.equal(readField({ must: false }, field('needed')), false);
  for (const record of [null, undefined, 5, 'text', []]) assert.equal(readField(record, field('first')), undefined);
});

test('readGeometry: one of the six GeoJSON types, shaped as its type is, or nothing', () => {
  const m = compileMapping({ externalId: 'id', geometry: 'g' } as never);
  const read = (g: unknown) => readGeometry({ g }, m.geometry!);
  const line = {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  };
  assert.deepEqual(read(line), line);
  assert.deepEqual(read({ ...line, bbox: [0, 0, 1, 1], extra: 'dropped' }), line);
  const shapes: Record<string, unknown> = {
    Point: [1, 2],
    MultiPoint: [[1, 2]],
    LineString: line.coordinates,
    MultiLineString: [line.coordinates],
    Polygon: [[...line.coordinates, [1, 0], [0, 0]]],
    MultiPolygon: [[[...line.coordinates, [1, 0], [0, 0]]]],
  };
  for (const [type, coordinates] of Object.entries(shapes)) assert.equal(read({ type, coordinates })?.type, type);
  // The type's name over another type's coordinates is not that type.
  for (const type of ['MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])
    assert.equal(read({ type, coordinates: [1, 2] }), undefined, type);
  for (const bad of [
    undefined,
    null,
    'POINT (1 2)',
    [1, 2],
    {},
    { type: 'Point' },
    { type: 'GeometryCollection', coordinates: [] },
    { type: 'Feature', coordinates: [1, 2] },
    { type: 'constructor', coordinates: [1, 2] },
    { type: 'Point', coordinates: '1,2' },
    { type: 'Point', coordinates: [1, '2'] },
    { type: 'Point', coordinates: [1, null] },
    { type: 'Point', coordinates: [1, Number.NaN] },
    {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, Number.POSITIVE_INFINITY],
      ],
    },
    { type: 'Point', coordinates: [[[[[[[[1]]]]]]]] },
  ])
    assert.equal(read(bad), undefined, JSON.stringify(bad));
});

test('paths: a quoted key may hold a bracket or a dot, and prints back as it was written', () => {
  const record = {
    'a]b': { c: 1 },
    'a.b': { 'c[0]': 3 },
    a: { 'x"y': 2 },
    list: [
      [1, 2],
      [3, 4],
    ],
  };
  assert.equal(readPath(record, '["a]b"].c'), 1);
  assert.equal(readPath(record, '["a.b"]["c[0]"]'), 3);
  assert.equal(readPath(record, 'a["x\\"y"]'), 2);
  assert.equal(readPath(record, 'list[-1][0]'), 3);
  assert.equal(readPath(record, 'list[5]'), undefined);
  assert.equal(readPath(record, 'list[-5]'), undefined);
  for (const path of ['["a]b"].c', '["a.b"]["c[0]"]', 'a["x\\"y"]', 'list[-1][0]', '$'])
    assert.equal(formatPath(parsePath(path)), path);
  for (const bad of ['["unclosed]', '["a"', '["a"x]', '[""a"]', 'a["b"]c'])
    assert.throws(() => parsePath(bad), Error, bad);
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(readPath({}, name), undefined, name);
});

test('patternTimestamp: reads the tokens where the pattern has them, UTC unless the value says otherwise', () => {
  const day = patternTimestamp('YYYYMMDD HHmm');
  assert.equal(day('20260923 1005'), '2026-09-23T10:05:00.000Z');
  assert.equal(day('2026-09-23 10:05'), undefined, 'the rest of the pattern must match exactly');
  assert.equal(day(20260923), undefined);
  assert.equal(day(null), undefined);
  const slashed = patternTimestamp('DD/MM/YYYY HH:mm:ss');
  assert.equal(slashed('23/09/2026 10:05:07'), '2026-09-23T10:05:07.000Z');
  assert.equal(slashed('23/09/2026 10:05:07Z'), '2026-09-23T10:05:07.000Z');
  assert.equal(slashed('23/09/2026 10:05:07+02:00'), '2026-09-23T08:05:07.000Z');
  assert.equal(slashed('31/02/2026 10:05:07'), undefined, 'a day that does not exist');
  assert.equal(slashed('23/13/2026 10:05:07'), undefined);
  assert.equal(slashed('23/09/2026 25:05:07'), undefined);
  assert.equal(patternTimestamp('YYYY.MM.DD')('2026.09.23'), '2026-09-23T00:00:00.000Z');
  assert.equal(patternTimestamp('YYYY.MM.DD')('2026x09x23'), undefined, 'a dot in the pattern is a dot');
});

test('bodyToObservations: finds the records and maps them; a body with none where they should be is malformed', () => {
  const d = definition({ response: { itemsPath: 'data.items' } });
  const opts = {
    manifest: definitionToManifest(d, 'REST JSON'),
    definition: d,
    mapping: compileMapping(d.mapping),
    receivedAt: '2026-09-23T20:00:00.000Z',
    origin: 'live' as const,
    sourceRef: 'https://api.example.com/x',
  };
  const out = bodyToObservations({ data: { items: [{ id: 'a', lat: 1, lon: 2 }, { id: 'b' }, 'junk'] } }, opts);
  assert.equal(out.total, 3);
  assert.deepEqual(
    out.observations.map((o) => o.externalId),
    ['a'],
  );
  assert.equal(out.observations[0]!.providerId, 'xy');
  assert.equal(out.observations[0]!.receivedAt, '2026-09-23T20:00:00.000Z');
  assert.equal(out.rejected.length, 2);
  assert.deepEqual(bodyToObservations({ data: { items: [] } }, opts).observations, []);
  for (const body of [{}, { data: {} }, { data: { items: 'none' } }, null, 'text', 5]) {
    const bad = bodyToObservations(body, opts);
    assert.ok(bad.malformed, JSON.stringify(body));
    assert.deepEqual([bad.total, bad.observations.length], [0, 0]);
  }
});

test('keyParamsIn: the query names a key goes under, in any case and spelling; nothing else', () => {
  assert.deepEqual(keyParamsIn('https://api.example.org/x?apikey=A&format=json'), ['apikey']);
  assert.deepEqual(keyParamsIn('https://api.example.org/x?API_KEY=A&appid=B&Subscription-Key=C&access_token=D&q=key'), [
    'API_KEY',
    'appid',
    'Subscription-Key',
    'access_token',
  ]);
  assert.deepEqual(keyParamsIn('https://api.example.org/x?key=A&key=B'), ['key'], 'once each');
  assert.deepEqual(keyParamsIn('https://api.example.org/{TOKEN}/x?token=A'), ['token'], 'with the path placeholder');
  assert.deepEqual(
    keyParamsIn('https://api.example.org/x?keyword=A&monkey=B&tokens=C&apikeys=D'),
    [],
    'whole names only',
  );
  assert.deepEqual(keyParamsIn('https://api.example.org/apikey/x#key=A'), [], 'not the path or the fragment');
  assert.deepEqual(keyParamsIn('not a url'), []);
});
