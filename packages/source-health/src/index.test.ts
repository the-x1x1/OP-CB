import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing, type ProviderHealth, type ProviderManifest } from '@opcb/provider-sdk';
import { SourceHealthRegistry, describeStatus } from './index.js';

function manifest(id: string, required = false): ProviderManifest {
  return {
    id,
    name: id,
    categories: ['test'],
    transport: 'http',
    credentials: required ? [{ key: `${id}.key`, label: 'Key', required: true }] : [],
    attribution: { text: id },
    dataPolicy: { cacheAllowed: true },
    refreshPolicy: { intervalMs: 60_000 },
    commercialReview: 'not-required',
  } as unknown as ProviderManifest;
}

function health(providerId: string, patch: Partial<ProviderHealth>): ProviderHealth {
  return {
    providerId,
    status: 'LIVE',
    errorRate: 0,
    rateLimitState: { limited: false },
    credentialState: 'not-required',
    ...patch,
  };
}

test('connection: a source waiting for a key nobody entered does not make the app DEGRADED', () => {
  const r = new SourceHealthRegistry(new testing.VirtualClock(0));
  r.register(manifest('usgs'), { enabled: true, locality: 'remote' });
  r.register(manifest('ais', true), { enabled: true, locality: 'remote' });
  r.update(health('usgs', {}));
  r.update(health('ais', { status: 'AUTH_REQUIRED', credentialState: 'missing' }));
  assert.equal(r.connection().state, 'CONNECTED');
  assert.equal(r.connection().remoteTotal, 1);

  // A key that was entered and refused is a failure the badge should show — and is told, though
  // the source's status did not change.
  const heard: string[] = [];
  r.on('connection', (c) => heard.push(c.state));
  r.update(health('ais', { status: 'AUTH_REQUIRED', credentialState: 'invalid' }));
  assert.equal(r.connection().state, 'DEGRADED');
  assert.deepEqual(heard, ['DEGRADED']);
  r.update(health('usgs', { lastSuccess: '1970-01-01T00:01:00.000Z' }));
  assert.deepEqual(heard, ['DEGRADED'], 'an unchanged state is not told again');
});

test('describeStatus: words for every status a source can have', () => {
  const words: Record<string, string> = {
    LIVE: 'Live',
    DEGRADED: 'Degraded',
    STALE: 'Stale',
    RATE_LIMITED: 'Rate limited',
    AUTH_REQUIRED: 'Needs a key',
    NEEDS_SETUP: 'Needs setup',
    OFFLINE: 'Offline',
    ERROR: 'Error',
    STARTING: 'Starting',
    DISABLED: 'Disabled',
  };
  for (const [status, text] of Object.entries(words)) assert.equal(describeStatus(status as never), text);
  assert.equal(new Set(Object.values(words)).size, Object.keys(words).length, 'no two statuses read the same');
});
