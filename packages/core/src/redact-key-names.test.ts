import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyParamsIn } from '@opcb/world-model';
import { sanitizeMessage } from '@opcb/provider-sdk';
import { redactText } from './logger.js';

/**
 * The names a drafted address's key is moved to the key store under (`keyParamsIn`) are names
 * the logs redact as well: an address logged before the move, or in an error, carries no key.
 */
const NAMES = [
  'key',
  'apikey',
  'api_key',
  'api-key',
  'appid',
  'app_id',
  'app-key',
  'token',
  'access_token',
  'access-token',
  'auth',
  'auth_key',
  'auth_token',
  'map_key',
  'mapkey',
  'subscription-key',
  'subscription_key',
  'ocp-apim-subscription-key',
  'x-api-key',
  'user_key',
  'private_token',
  'license_key',
  'licence-key',
  'jwt',
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'client_secret',
  'sig',
  'signature',
  'session',
];

test('every query name drafting treats as a key is one the logs redact', () => {
  const secret = 'Zq7xTestValue42';
  for (const base of NAMES)
    for (const name of [base, base.toUpperCase()]) {
      const url = `https://api.example.org/v1/data?format=json&${name}=${secret}&q=1`;
      assert.deepEqual(keyParamsIn(url), [name], `${name} is a key name`);
      // Both copies of the patterns: the log's and a source's health message's.
      for (const redact of [redactText, sanitizeMessage]) {
        const logged = redact(`fetch failed: ${url}`);
        assert.ok(!logged.includes(secret), `${name}: ${logged}`);
        assert.ok(logged.includes('format=json'), `${name}: the rest is kept (${logged})`);
      }
    }
});
