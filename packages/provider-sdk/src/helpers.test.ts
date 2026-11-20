import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldProvider } from './provider.js';
import { ProviderError, sanitizeMessage, toProviderError } from './health.js';
import { admitObservations, assertAtomicAdmission } from './helpers.js';
import { extensionOf } from './local-files.js';
import {
  formatIssuesForManifest,
  isCommerciallyDistributable,
  mayExport,
  mayIncludeInWorldpack,
  mayPersistRaw,
  retentionCapSeconds,
  type ProviderDataPolicy,
  type ProviderManifest,
} from './manifest.js';
import { isFlightRouteSource } from './flight-route.js';
import { isObjectDetailsSource } from './object-details.js';
import { isObjectTrackSource } from './object-track.js';
import { isOverlayValueSource } from './overlay-value.js';
import { isTestMessageSource } from './test-message.js';

const policy = (over: Partial<ProviderDataPolicy> = {}): ProviderDataPolicy =>
  ({
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
    ...over,
  }) as ProviderDataPolicy;

test('retentionCapSeconds: nothing when keeping is not allowed, else the smaller of what is asked and the cap', () => {
  assert.equal(retentionCapSeconds(policy({ normalizedRetentionAllowed: false }), 3600), 0);
  assert.equal(
    retentionCapSeconds(policy({ normalizedRetentionAllowed: false, maxRetentionSeconds: 60 }), undefined),
    0,
  );
  assert.equal(retentionCapSeconds(policy(), 3600), 3600);
  assert.equal(retentionCapSeconds(policy(), undefined), undefined, 'no cap and nothing asked: no limit');
  assert.equal(retentionCapSeconds(policy({ maxRetentionSeconds: 600 }), 3600), 600);
  assert.equal(retentionCapSeconds(policy({ maxRetentionSeconds: 600 }), 60), 60);
  assert.equal(retentionCapSeconds(policy({ maxRetentionSeconds: 600 }), undefined), 600);
  assert.equal(retentionCapSeconds(policy({ maxRetentionSeconds: 0 }), 3600), 0);
});

test('the keep, pack and export answers come from the policy alone', () => {
  assert.equal(mayPersistRaw(policy()), true);
  assert.equal(mayPersistRaw(policy({ rawPayloadRetentionAllowed: false })), false);
  assert.equal(mayExport(policy()), true);
  assert.equal(mayExport(policy({ exportAllowed: false })), false);
  // A pack hands the data on, so it needs both permissions.
  assert.equal(mayIncludeInWorldpack(policy()), true);
  assert.equal(mayIncludeInWorldpack(policy({ offlinePackAllowed: false })), false);
  assert.equal(mayIncludeInWorldpack(policy({ redistributionAllowed: false })), false);
  const reviewed = (commercialReview: string) =>
    isCommerciallyDistributable({ commercialReview } as unknown as ProviderManifest);
  assert.equal(reviewed('approved'), true);
  assert.equal(reviewed('conditional'), true);
  for (const other of ['pending', 'rejected', 'unknown', '']) assert.equal(reviewed(other), false, other);
  assert.equal(isCommerciallyDistributable({} as ProviderManifest), false, 'no review is not approval');
});

test('formatIssuesForManifest: path and message, the first six', () => {
  assert.equal(formatIssuesForManifest([]), '');
  assert.equal(formatIssuesForManifest([{ path: '', message: 'expected object' }]), '<root>: expected object');
  const many = Array.from({ length: 9 }, (_, i) => ({ path: `p${i}`, message: 'bad' }));
  assert.equal(formatIssuesForManifest(many), 'p0: bad; p1: bad; p2: bad; p3: bad; p4: bad; p5: bad');
});

test('extensionOf: lower case, no dot, the last one, and none for a dot file or a dotted folder', () => {
  assert.equal(extensionOf('maps/Area.KML'), 'kml');
  assert.equal(extensionOf('a/b/archive.tar.gz'), 'gz');
  assert.equal(extensionOf('plain'), '');
  assert.equal(extensionOf('folder.d/plain'), '');
  assert.equal(extensionOf('.hidden'), '');
  assert.equal(extensionOf('a/.hidden'), '');
  assert.equal(extensionOf('trailing.'), '');
  assert.equal(extensionOf(''), '');
});

test('the optional-capability checks: a provider has one when it has the method', () => {
  const bare = {} as WorldProvider;
  const checks = [
    [isFlightRouteSource, 'flightRoute'],
    [isObjectDetailsSource, 'objectDetails'],
    [isObjectTrackSource, 'objectTrack'],
    [isOverlayValueSource, 'overlayValue'],
    [isTestMessageSource, 'sendTestMessage'],
  ] as const;
  for (const [check, method] of checks) {
    assert.equal(check(bare), false, method);
    assert.equal(check({ [method]: () => undefined } as unknown as WorldProvider), true, method);
    assert.equal(check({ [method]: 'not a function' } as unknown as WorldProvider), false, method);
  }
});

const observation = (over: Record<string, unknown> = {}) => ({
  id: 'p:x:2026-11-19T00:00:00.000Z',
  providerId: 'p',
  externalId: 'x',
  objectType: 'sensor',
  observedAt: '2026-11-19T00:00:00.000Z',
  receivedAt: '2026-11-19T00:00:01.000Z',
  payload: { a: 1 },
  quality: { complete: true, sourceQuality: 'unknown' },
  provenance: { providerId: 'p', sourceName: 'P', origin: 'live', receivedAt: '2026-11-19T00:00:01.000Z' },
  ...over,
});

test('admitObservations: keeps what is valid, says why the rest is not, and never throws', () => {
  const batch = [
    observation(),
    observation({ observedAt: 'yesterday' }),
    null,
    'text',
    observation({ position: { latitude: 95, longitude: 0 } }),
    observation({ payload: undefined }),
    observation({ id: 'p:y:2026-11-19T00:00:00.000Z', externalId: 'y' }),
  ];
  const { accepted, rejected } = admitObservations(batch);
  assert.deepEqual(
    accepted.map((o) => o.externalId),
    ['x', 'y'],
  );
  assert.deepEqual(
    rejected.map((r) => r.index),
    [1, 2, 3, 4, 5],
  );
  for (const r of rejected) assert.ok(r.reason.length > 0 && r.reason.length < 600, r.reason);
  assert.match(rejected[0]!.reason, /observedAt/);
  assert.deepEqual(admitObservations([]), { accepted: [], rejected: [] });
});

test('assertAtomicAdmission: rows with none valid is a malformed feed; an empty feed is not', () => {
  assert.doesNotThrow(() => assertAtomicAdmission(0, 0, 'feed'));
  assert.doesNotThrow(() => assertAtomicAdmission(10, 1, 'feed'));
  assert.throws(
    () => assertAtomicAdmission(10, 0, 'USGS'),
    (e: unknown) => e instanceof ProviderError && e.code === 'MALFORMED' && /USGS: 10 rows, none valid/.test(e.message),
  );
});

test('toProviderError: its own errors pass through; the rest get a code and a message with no secret in it', () => {
  const own = new ProviderError('HTTP_4XX', 'gone');
  assert.equal(toProviderError(own), own);
  const named = (name: string) => Object.assign(new Error('x'), { name });
  assert.equal(toProviderError(named('AbortError')).code, 'CANCELLED');
  assert.equal(toProviderError(named('TimeoutError')).code, 'TIMEOUT');
  assert.equal(toProviderError(new Error('getaddrinfo ENOTFOUND api.example.com')).code, 'DNS');
  assert.equal(toProviderError(new Error('getaddrinfo EAI_AGAIN')).code, 'DNS');
  for (const text of ['connect ECONNREFUSED 1.2.3.4:443', 'read ECONNRESET', 'fetch failed', 'network down'])
    assert.equal(toProviderError(new Error(text)).code, 'NETWORK', text);
  assert.equal(toProviderError(new Error('boom')).code, 'INTERNAL');
  assert.equal(toProviderError('text').message, 'text');
  assert.equal(toProviderError(undefined).code, 'INTERNAL');
  const leaky = toProviderError(new Error('fetch failed https://u:p4ss@h/x?api_key=KEY123 Authorization: Basic dTpw'));
  for (const secret of ['p4ss', 'KEY123', 'dTpw']) assert.ok(!leaky.message.includes(secret), leaky.message);
});

test('sanitizeMessage: every way a credential is written, and nothing else', () => {
  const secrets: Array<[string, string[]]> = [
    ['GET https://api.example.com/v1?api_key=ABC123&x=1', ['ABC123']],
    ['GET https://api.example.com/v1?key=ABC123&token=T0K&MAP_KEY=MK9', ['ABC123', 'T0K', 'MK9']],
    ['Authorization: Bearer abc.def.ghi rejected', ['abc.def.ghi']],
    ['Authorization: Basic dXNlcjpwYXNz rejected', ['dXNlcjpwYXNz']],
    ['{"authorization":"Basic dXNlcjpwYXNz","accept":"*/*"}', ['dXNlcjpwYXNz']],
    ['header x-api-key: SECRET1 rejected', ['SECRET1']],
    ['{"APIKey":"SECRET2","BoundingBoxes":[[1,2]]}', ['SECRET2']],
    ['https://user:pass1@host/x', ['pass1']],
    ['rtsp://user:pass2@host/x mqtt://user:pass3@host:1883 wss://u:pass4@h', ['pass2', 'pass3', 'pass4']],
    ['password=hunter2; secret=s3cr', ['hunter2', 's3cr']],
    ['db_password=hunter3 MQTT_PASSWORD: hunter4 smtp.password="two words"', ['hunter3', 'hunter4', 'two words']],
    ["{'token': 'abc999'}", ['abc999']],
    ['client_secret=XYZ1&refresh_token=RRR1&grant_type=refresh', ['XYZ1', 'RRR1']],
    ['X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA1', ['deadbeef', 'AKIA1']],
    ['cookie: session=abcd1234; theme=dark', ['abcd1234']],
    ['Set-Cookie: sid=zz91; HttpOnly', ['zz91']],
  ];
  for (const [text, hidden] of secrets) {
    const out = sanitizeMessage(text);
    for (const secret of hidden) assert.ok(!out.includes(secret), `${secret} in ${out}`);
    assert.ok(out.includes('<redacted>'), out);
    assert.equal(sanitizeMessage(out), out, 'redacting twice changes nothing more');
  }
  assert.ok(sanitizeMessage('client_secret=XYZ1&grant_type=refresh').includes('grant_type=refresh'));
  for (const plain of [
    'Unexpected token < in JSON at position 0',
    'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
    'sort key: magnitude',
    'http://host:8080/path@x',
    'tokens: 5 parsed',
    'author: Jane',
    'secretary: none',
    'passwordless: yes',
    'the token expired',
    'no api key configured',
    'connect ECONNREFUSED 10.0.0.2:80',
    'HTTP 401 from api.example.com',
    '',
  ])
    assert.equal(sanitizeMessage(plain), plain, plain);
  assert.equal(sanitizeMessage('x'.repeat(600)).length, 501, 'long messages are cut at 500 characters and marked');
});
