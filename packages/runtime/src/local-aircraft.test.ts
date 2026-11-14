import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLocalAircraftSource } from './core.js';

const p = (running: boolean, transport: string, objectTypes: string[]) => ({
  running,
  manifest: { transport, objectTypes },
});

test('local aircraft: a running local source of aircraft, not any local source (ingest O1)', () => {
  assert.equal(hasLocalAircraftSource([p(true, 'local-process', ['aircraft'])]), true, 'readsb on the network');
  assert.equal(
    hasLocalAircraftSource([p(true, 'local-process', ['transit-vehicle']), p(true, 'local-process', ['sensor'])]),
    false,
    'a Traccar or ingest source is not aircraft',
  );
  assert.equal(hasLocalAircraftSource([p(false, 'local-process', ['aircraft'])]), false, 'switched off');
  assert.equal(hasLocalAircraftSource([p(true, 'https', ['aircraft'])]), false, 'aircraft from the internet');
});
