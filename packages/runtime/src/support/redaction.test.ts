import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '@opcb/core';
import { sanitizeMessage } from '@opcb/provider-sdk';

/**
 * The log redactor (@opcb/core) and the provider-error redactor (@opcb/provider-sdk) keep
 * their own copy of the same patterns, because the SDK does not depend on core. This holds
 * them to the same answers.
 */
test('the two redactors give the same answer for every way a credential is written', () => {
  const corpus = [
    'GET https://api.example.com/v1?api_key=ABC123&x=1 failed',
    'GET https://api.example.com/v1?key=ABC&token=T&map_key=M&mapkey=N&pwd=P&pass=Q&sig=S&session=Z',
    'Authorization: Bearer abc.def.ghi',
    'authorization=Basic dXNlcjpwYXNz',
    '{"Authorization":"Digest abc","x-api-key":"K","apiKey":"K2","password":"p w","nested":{"client_secret":"s"}}',
    'https://user:pass@host/x rtsp://user:pass@host/x mqtt://user:pass@host:1883 ftp://u:@h',
    'db_password=hunter2; MQTT_PASSWORD: x; smtp.password="a b"; secret=s3; signature=abc',
    'access_token=A refresh-token=B id_token=C auth_token=D X-Amz-Security-Token=E',
    'cookie: a=b; c=d\r\nSet-Cookie: sid=1; HttpOnly\nnext',
    'Unexpected token < in JSON at position 0',
    'sort key: magnitude; tokens: 5; author: Jane; secretary: none; passwordless: yes',
    'connect ECONNREFUSED 10.0.0.2:80 at http://host:8080/path@x',
    '',
  ];
  for (const text of corpus) assert.equal(sanitizeMessage(text), redactText(text), text);
});
