import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haAddressText, readHaAddress } from './connections-model.js';

test('connections: a Home Assistant address as people type it', () => {
  const ok = (t: string) => {
    const r = readHaAddress(t);
    assert.ok(r.ok, `${t}: ${r.ok ? '' : r.reason}`);
    return r.address;
  };
  assert.deepEqual(ok('homeassistant.local'), { host: 'homeassistant.local', port: 8123, tls: false });
  assert.deepEqual(ok('192.168.1.20:8124'), { host: '192.168.1.20', port: 8124, tls: false });
  assert.deepEqual(ok(' http://HA.lan:8123/ '), { host: 'ha.lan', port: 8123, tls: false });
  assert.deepEqual(ok('https://ha.lan'), { host: 'ha.lan', port: 443, tls: true });
  assert.deepEqual(ok('http://ha.lan'), { host: 'ha.lan', port: 80, tls: false });
  for (const bad of ['', 'ftp://ha.lan', 'http://user:pw@ha.lan', 'http://ha.lan/lovelace', 'http://ha.lan/?x=1'])
    assert.equal(readHaAddress(bad).ok, false, bad);
});

test('connections: the form shows the address back from the settings', () => {
  assert.equal(haAddressText({ host: '192.168.1.20', port: 8123, tls: false }), 'http://192.168.1.20:8123');
  assert.equal(haAddressText({ host: 'ha.lan', tls: true, port: 443 }), 'https://ha.lan:443');
  assert.equal(haAddressText({}), '');
});
