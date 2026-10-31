import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { geodataWorkerPath, geodataWorkerReader } from './geodata-reader.js';

const evalWorker = (code: string) => () => new Worker(code, { eval: true });

test('the worker path is read from app.asar.unpacked inside the archive', () => {
  assert.match(
    geodataWorkerPath('C:\\Program Files\\OP-CB\\resources\\app.asar'),
    /app\.asar\.unpacked[\\/]dist[\\/]main[\\/]geodata-worker\.cjs$/,
  );
  assert.match(geodataWorkerPath('/repo/apps/desktop'), /apps[\\/]desktop[\\/]dist[\\/]main[\\/]geodata-worker\.cjs$/);
});

test('a dropped file is read on a worker: its answer, the bytes handed over as a copy', async () => {
  const reader = geodataWorkerReader('unused', {
    createWorker: evalWorker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => parentPort.postMessage({ read: { format: 'geojson', features: [], issues: [m.name + ':' + m.bytes.length] } }));
      parentPort.postMessage({ ready: true });
    `),
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const read = await reader('a.geojson', bytes);
  assert.deepEqual(read, { format: 'geojson', features: [], issues: ['a.geojson:3'] });
  assert.equal(bytes.length, 3, 'the caller keeps its bytes (a copy was transferred)');
});

test('a worker that never runs rejects (read in-process); one that ran answers, a failure included', async () => {
  const missing = geodataWorkerReader('/nowhere/geodata-worker.cjs');
  await assert.rejects(missing('a.kml', new Uint8Array(1)), 'no script: the runtime reads it itself');
  const neverReady = geodataWorkerReader('unused', { createWorker: evalWorker(`throw new Error('load failed')`) });
  await assert.rejects(neverReady('a.kml', new Uint8Array(1)), /load failed/);
  const crash = geodataWorkerReader('unused', {
    createWorker: evalWorker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', () => { throw new Error('boom'); });
      parentPort.postMessage({ ready: true });
    `),
  });
  assert.deepEqual(await crash('a.kml', new Uint8Array(1)), { features: [], issues: ['could not be read: boom'] });
  const silent = geodataWorkerReader('unused', {
    timeoutMs: 300,
    createWorker: evalWorker(`
      require('node:worker_threads').parentPort.postMessage({ ready: true });
      setInterval(() => {}, 1000);
    `),
  });
  const slow = await silent('a.kml', new Uint8Array(1));
  assert.match(slow.issues[0] ?? '', /not read within/, 'not parsed again on the main thread');
  const refused = geodataWorkerReader('unused', {
    createWorker: evalWorker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', () => parentPort.postMessage({ error: 'bad file' }));
      parentPort.postMessage({ ready: true });
    `),
  });
  assert.deepEqual(await refused('a.kml', new Uint8Array(1)), {
    features: [],
    issues: ['could not be read: bad file'],
  });
});
