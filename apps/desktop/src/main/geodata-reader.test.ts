import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { geodataWorkerPath, geodataWorkerReader } from './geodata-reader.js';

const evalWorker = (code: string) => () => new Worker(code, { eval: true });

test('the worker path is read from app.asar.unpacked inside the archive', () => {
  assert.match(
    geodataWorkerPath('C:\\Program Files\\WorldView\\resources\\app.asar'),
    /app\.asar\.unpacked[\\/]dist[\\/]main[\\/]geodata-worker\.cjs$/,
  );
  assert.match(geodataWorkerPath('/repo/apps/desktop'), /apps[\\/]desktop[\\/]dist[\\/]main[\\/]geodata-worker\.cjs$/);
});

test('a dropped file is read on a worker: its answer, the bytes handed over as a copy', async () => {
  const reader = geodataWorkerReader('unused', {
    createWorker: evalWorker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => parentPort.postMessage({ read: { format: 'geojson', features: [], issues: [m.name + ':' + m.bytes.length] } }));
    `),
  });
  const bytes = new Uint8Array([1, 2, 3]);
  const read = await reader('a.geojson', bytes);
  assert.deepEqual(read, { format: 'geojson', features: [], issues: ['a.geojson:3'] });
  assert.equal(bytes.length, 3, 'the caller keeps its bytes (a copy was transferred)');
});

test('a worker that cannot run rejects, so the runtime reads the file itself', async () => {
  const crash = geodataWorkerReader('unused', {
    createWorker: evalWorker(`throw new Error('boom')`),
  });
  await assert.rejects(crash('a.kml', new Uint8Array(1)), /boom/);
  const silent = geodataWorkerReader('unused', {
    timeoutMs: 200,
    createWorker: evalWorker(`setInterval(() => {}, 1000)`),
  });
  await assert.rejects(silent('a.kml', new Uint8Array(1)), /not read within/);
  const missing = geodataWorkerReader('/nowhere/geodata-worker.cjs');
  await assert.rejects(missing('a.kml', new Uint8Array(1)));
});
