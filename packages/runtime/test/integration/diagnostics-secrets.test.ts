import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoggerHub } from '@opcb/core';
import { RotatingFileSink } from '@opcb/core/node';
import { createProvider as createUsgs } from '@opcb/provider-usgs';
import { settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * A diagnostics bundle is made to be sent to someone else. This puts a secret everywhere an
 * operator can put one — a stored key, a source's settings under names that say secret and
 * names that do not, addresses with a login or a key in them, a camera's address — runs the
 * app so that those reach its logs and its state, exports the bundle, and looks for each
 * secret in the file.
 */
const KEY = 'Qz7hPk2mVn9sXj4wRt8yBc3dLf6gUa5e';
// With an @ and a colon in it, as typed. (Not a slash: an address with a bare slash in its
// password is not an address, the app refuses it without repeating it, and redaction of text
// takes a login to end at the path.)
const PASSWORD = 'Hv3@tR9:kLm2!pQx';
const LOGIN_TAIL = 'tR9:kLm2';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGNiIn0.Wm4xQ2tQb1ZyN3NYajR3UnQ4eUJj';

test('integration: a diagnostics bundle holds none of the secrets the app was given', async () => {
  const { impl: fetchImpl } = tableFetch({
    // Every poll fails, so that the request and its address reach the error path and the log.
    'https://earthquake.usgs.gov/': () => new Response(`denied for key ${KEY}`, { status: 403 }),
  });
  // The log goes to a file, as in the app (the harness otherwise keeps it in memory, and a
  // bundle made from that has no log in it to look through).
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-diagnostics-'));
  const loggerHub = new LoggerHub({
    level: 'debug',
    sinks: [new RotatingFileSink(path.join(dataDir, 'logs', 'app.log'))],
  });
  const h = await startRuntime({ dataDir, loggerHub, fetchImpl, providerInstances: [createUsgs()] });
  try {
    await h.client.request('credentials.set', { key: 'demo.test.key', value: KEY });
    await h.client.request('sources.settings.set', {
      providerId: 'usgs-earthquakes',
      settings: {
        feed: 'day',
        apiKey: KEY,
        password: PASSWORD,
        brokerUrl: `mqtt://sensor:${PASSWORD}@broker.local:1883`,
        endpoint: `https://api.example.org/v1/data?appid=${KEY}&units=metric`,
        tokenUrl: `https://api.example.org/v1/data?access_token=${TOKEN}`,
        headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Key': KEY },
        nested: { deep: [{ secret: KEY }, `password=${PASSWORD}`] },
      },
    });
    await h.client
      .request('camera.register', {
        name: 'Gate',
        url: `http://admin:${encodeURIComponent(PASSWORD)}@192.168.1.20/mjpg/video.mjpg`,
      })
      .catch(() => undefined);
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' }).catch(() => undefined);
    await settle(8);
    // Lines a source or the shell might write, through the app's own logger.
    h.runtime.core.log.warn(`could not open rtsp://admin:${PASSWORD}@192.168.1.20:554/stream1`, {
      url: `https://api.example.org/v1/data?key=${KEY}`,
      authorization: `Bearer ${TOKEN}`,
      detail: `request failed: https://api.example.org/v1/data?token=${TOKEN}`,
    });
    await settle(4);

    const file = path.join(h.dataDir, 'bundle.json');
    h.host.saveQueue.push(file);
    const result = await h.client.request('diagnostics.export', undefined);
    assert.ok(result && typeof result === 'object' && 'path' in result, JSON.stringify(result));
    const bundle = await fs.readFile(file, 'utf8');
    assert.ok(bundle.length > 500, 'the bundle has something in it');
    JSON.parse(bundle);
    // The lines that held them are there, so it is the secrets that are gone and not the lines.
    assert.ok(bundle.includes('could not open rtsp://'), 'the log line is in the bundle');
    assert.ok(bundle.includes('192.168.1.20'), 'with its host');
    for (const [name, secret] of [
      ['the stored key', KEY],
      ['the password', PASSWORD],
      ['the password, percent-encoded', encodeURIComponent(PASSWORD)],
      ['the end of the password', LOGIN_TAIL],
      ['the token', TOKEN],
      ['the token’s signature', TOKEN.split('.')[2]!],
    ] as const)
      assert.ok(
        !bundle.includes(secret),
        `${name} is in the bundle: …${bundle.slice(Math.max(0, bundle.indexOf(secret) - 160), bundle.indexOf(secret) + 60)}`,
      );
  } finally {
    await h.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
