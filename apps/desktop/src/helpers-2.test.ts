import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { WorldObject } from '@opcb/world-model';
import { holdsOwnData } from './main/legacy-data.js';
import { zoomForKind } from './main/place-search.js';
import { checkNeeds, heardHow } from './renderer/command-center/checks.js';
import { bytesText, etaText } from './renderer/command-center/map-download-panel.js';
import { overGround } from './renderer/context/cpa.js';
import { airportCode } from './renderer/context/flight.js';
import { cameraIdOf, cycloneRows } from './renderer/context/sections.js';
import { isMilitary } from './renderer/layer-tree.js';
import { noteDecode, takeDecodeMax } from './renderer/map/delta-marks.js';
import { kpText } from './renderer/panels/sky-plot.js';
import { errorRateRow, providerErrors, waitingFor } from './renderer/source-errors.js';
import { describeError } from './renderer/store/sync.js';

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): WorldObject =>
  ({ id: 'p:vessel:1', type: 'vessel', properties, labels: {}, ...extra }) as unknown as WorldObject;

test('bytesText and etaText: sizes a person reads, and no time left when there is none to give', () => {
  assert.equal(bytesText(0), '1 kB');
  assert.equal(bytesText(1500), '2 kB');
  assert.equal(bytesText(999_499), '999 kB');
  assert.equal(bytesText(1_000_000), '1 MB');
  assert.equal(bytesText(250_400_000), '250 MB');
  assert.equal(bytesText(999_400_000), '999 MB');
  assert.equal(bytesText(999_600_000), '1.0 GB', 'never "1000 MB"');
  assert.equal(bytesText(1_500_000_000), '1.5 GB');
  assert.equal(bytesText(9_960_000_000), '10 GB', 'never "10.0 GB"');
  assert.equal(bytesText(120_000_000_000), '120 GB');

  assert.equal(etaText(0, 1000, 100), ' · about 10 s left');
  assert.equal(etaText(0, 8950, 100), ' · about 90 s left');
  assert.equal(etaText(0, 9000, 100), ' · about 2 min left');
  assert.equal(etaText(0, 539_900, 100), ' · about 90 min left');
  assert.equal(etaText(0, 720_000, 100), ' · about 2.0 h left');
  for (const [done, total, rate] of [
    [0, 1000, undefined],
    [0, 1000, 0],
    [0, 1000, -5],
    [1000, 1000, 100],
    [1200, 1000, 100],
    [500, 0, 100],
    [0, Number.NaN, 100],
    [0, Infinity, 100],
  ] as Array<[number, number, number | undefined]>)
    assert.equal(etaText(done, total, rate), '', `${done}/${total} at ${rate}`);
});

test('kpText: the index, its word and the hours it is for; a time that is not one is left out, not thrown on', () => {
  type Answer = Parameters<typeof kpText>[0];
  const answer = (kp: unknown) => ({ kp }) as unknown as Answer;
  assert.equal(kpText(answer(undefined)), undefined);
  assert.equal(
    kpText(answer({ kp: 3.33, at: '2026-11-19T21:00:00Z' })),
    'Kp 3.3 (unsettled) · the three hours from 21:00 UTC, whole Earth',
  );
  assert.equal(
    kpText(answer({ kp: 0, at: '2026-11-19T00:00:00Z' })),
    'Kp 0 (quiet) · the three hours from 00:00 UTC, whole Earth',
  );
  assert.match(kpText(answer({ kp: 4, at: '2026-11-19T03:00:00Z' }))!, /^Kp 4 \(active\)/);
  assert.match(kpText(answer({ kp: 7, storm: 'G3', at: '2026-11-19T03:00:00Z' }))!, /^Kp 7 \(geomagnetic storm G3\)/);
  assert.match(kpText(answer({ kp: 9, at: '2026-11-19T03:00:00Z' }))!, /\(active\)/);
  assert.equal(kpText(answer({ kp: 2, at: 'not a time' })), 'Kp 2 (quiet) · whole Earth');
  assert.equal(kpText(answer({ kp: 2 })), 'Kp 2 (quiet) · whole Earth');
  for (const kp of [Number.NaN, -1, Infinity])
    assert.equal(kpText(answer({ kp, at: '2026-11-19T03:00:00Z' })), undefined, String(kp));
});

test('airportCode, zoomForKind, isMilitary, cameraIdOf', () => {
  type Airport = Parameters<typeof airportCode>[0];
  assert.equal(airportCode({ code: 'PHNL', icao: 'PHNL', iata: 'HNL' } as Airport), 'HNL');
  assert.equal(airportCode({ code: 'PHNL', icao: 'PHNL' } as Airport), 'PHNL');
  assert.equal(airportCode({ code: 'HI01' } as Airport), 'HI01');
  assert.equal(airportCode({ code: 'HI01', icao: '', iata: '' } as Airport), 'HI01', 'an empty code is not a label');

  assert.equal(zoomForKind('country'), 4);
  assert.ok(
    zoomForKind('state') < zoomForKind('county') &&
      zoomForKind('county') < zoomForKind('city') &&
      zoomForKind('city') <= zoomForKind('village'),
  );
  for (const kind of ['', 'constructor', 'unheard-of'])
    assert.ok(Number.isFinite(zoomForKind(kind)) && zoomForKind(kind) >= 4 && zoomForKind(kind) <= 18, kind);

  assert.equal(isMilitary(object({ military: true })), true);
  assert.equal(isMilitary(object({ military: 'true' })), true);
  for (const v of [false, 'false', 1, 'yes', undefined, null])
    assert.equal(isMilitary(object({ military: v })), false, String(v));

  assert.equal(cameraIdOf(object({ cameraId: 'abc' }, { id: 'p:camera:zzz' })), 'abc');
  assert.equal(
    cameraIdOf(
      object(
        {},
        {
          id: 'p:camera:zzz',
          media: [
            { kind: 'link', ref: 'x' },
            { kind: 'snapshot', ref: 'snap-1' },
          ],
        },
      ),
    ),
    'snap-1',
  );
  assert.equal(cameraIdOf(object({}, { id: 'p:camera:a:b' })), 'a:b');
});

test('cycloneRows: a forecast point, a piece of past track, and nothing for a type name every object has', () => {
  const rows = (properties: Record<string, unknown>) =>
    Object.fromEntries(cycloneRows(object(properties)).map((r) => [r.label, r.value]));
  const forecast = rows({
    cycloneLayer: 'forecast-point',
    forecastDate: 'Tue 8 AM HST',
    forecastHours: 24,
    forecastPressureMb: 9999,
    gustKt: 100,
    stormType: 'HU',
    intensityKt: 85,
  });
  assert.equal(forecast['Forecast for'], 'Tue 8 AM HST (+24 h)');
  assert.equal(forecast['Gusts'], '100 kt (115 mph)');
  assert.equal(forecast['Pressure'], undefined, '9999 is "not forecast"');
  assert.equal(typeof forecast['Expected as'], 'string');
  assert.equal(rows({ cycloneLayer: 'forecast-point', forecastPressureMb: 965 })['Pressure'], '965 mb');
  assert.equal(rows({ cycloneLayer: 'forecast-point' })['Forecast for'], undefined);
  for (const stormType of ['constructor', 'toString', '__proto__', 'no-such-type']) {
    assert.equal(rows({ cycloneLayer: 'forecast-point', stormType })['Expected as'], undefined, stormType);
    assert.equal(rows({ cycloneLayer: 'past-track', stormType })['Strength here'], undefined, stormType);
  }
  assert.match(
    String(rows({ cycloneLayer: 'past-track', trackCategory: '3', stormType: 'HU' })['Strength here']),
    /^Hurricane, /,
  );
  assert.equal(
    rows({ cycloneLayer: 'past-track', trackCategory: '9', stormType: 'no-such-type' })['Strength here'],
    undefined,
  );
  for (const row of cycloneRows(object({ cycloneLayer: 'forecast-point', stormType: 'constructor' })))
    assert.ok(row.value === undefined || typeof row.value === 'string');
});

test('overGround: where a vessel goes over the ground, from its own report first', () => {
  const at = { position: { latitude: 21, longitude: -158 } };
  assert.deepEqual(overGround(object({ speedMps: 5, courseDegrees: 90 }, at)), {
    latitude: 21,
    longitude: -158,
    courseDeg: 90,
    speedMps: 5,
  });
  assert.deepEqual(
    overGround(object({ courseDegrees: 45 }, { ...at, motion: { speedMps: 3 } }))!.speedMps,
    3,
    'the motion’s speed when the report has none',
  );
  assert.deepEqual(
    overGround(object({ speedMps: 0 }, at)),
    { latitude: 21, longitude: -158, courseDeg: 0, speedMps: 0 },
    'at rest needs no course',
  );
  assert.equal(overGround(object({ speedMps: 5 }, at)), undefined, 'moving with no course is not known');
  assert.equal(overGround(object({ speedMps: 5, courseDegrees: 90 })), undefined, 'no position');
  assert.equal(overGround(object({ courseDegrees: 90 }, at)), undefined, 'no speed');
  assert.equal(overGround(object({ speedMps: -1, courseDegrees: 90 }, at)), undefined);
  assert.equal(overGround(object({ speedMps: Number.NaN, courseDegrees: 90 }, at)), undefined);
  assert.equal(overGround(object({ speedMps: 5, courseDegrees: Number.NaN }, at)), undefined);
});

test('checks: what each needs fetched, and how a mesh node was heard', () => {
  type Id = Parameters<typeof checkNeeds>[0];
  assert.deepEqual(checkNeeds('mesh.otherNodeHeard' as Id), { meshNodes: true });
  assert.deepEqual(checkNeeds('mesh.onMap' as Id), { meshNodes: true });
  assert.deepEqual(checkNeeds('library.references' as Id), { shelf: true });
  assert.deepEqual(checkNeeds('sdr.receiving' as Id), { receivers: true });
  assert.deepEqual(checkNeeds('learning.running' as Id), { services: true });
  assert.deepEqual(checkNeeds('mode.offline' as Id), {});
  assert.deepEqual(checkNeeds('maps.packActive' as Id), {});

  assert.equal(heardHow(object({ viaMqtt: true, hopsAway: 0, snrDb: 5 })), 'through the internet (MQTT), not by radio');
  assert.equal(heardHow(object({ hopsAway: 0, snrDb: 6.5 })), 'directly by radio, SNR 6.5 dB');
  assert.equal(heardHow(object({ hopsAway: 0 })), 'directly by radio');
  assert.equal(
    heardHow(object({ hopsAway: 1, snrDb: 6.5 })),
    'by radio over 1 hop',
    'the SNR of a relayed packet is the last hop’s, so it is not given',
  );
  assert.equal(heardHow(object({ hopsAway: 3 })), 'by radio over 3 hops');
  assert.equal(heardHow(object({})), 'by radio');
  assert.equal(heardHow(object({ viaMqtt: 'true', hopsAway: '2' })), 'by radio');
});

test('source errors: a source waiting for the operator is not a source failing', () => {
  type Health = Parameters<typeof waitingFor>[0];
  const health = (h: Record<string, unknown>) => ({ errorRate: 0, ...h }) as unknown as Health;
  assert.equal(waitingFor(health({ status: 'NEEDS_SETUP' })), 'setup');
  assert.equal(waitingFor(health({ status: 'AUTH_REQUIRED', credentialState: 'missing' })), 'a key');
  assert.equal(
    waitingFor(health({ status: 'AUTH_REQUIRED', credentialState: 'present' })),
    undefined,
    'a key that was refused is an error',
  );
  assert.equal(waitingFor(health({ status: 'ERROR' })), undefined);
  assert.equal(
    providerErrors(health({ status: 'NEEDS_SETUP', errorRate: 1, lastError: { code: 'HOST_NOT_ALLOWED' } })),
    'waiting for setup',
  );
  assert.equal(
    providerErrors(health({ status: 'ERROR', errorRate: 0.256, lastError: { code: 'TIMEOUT' } })),
    '26% · TIMEOUT',
  );
  assert.equal(providerErrors(health({ status: 'OK', errorRate: 0 })), '0%');
  assert.equal(errorRateRow(health({ status: 'NEEDS_SETUP', errorRate: 1 })), undefined);
  assert.equal(errorRateRow(health({ status: 'OK', errorRate: 0 })), undefined);
  assert.equal(errorRateRow(health({ status: 'OK', errorRate: Number.NaN })), undefined);
  assert.equal(errorRateRow(health({ status: 'ERROR', errorRate: 0.5 })), '50%');
});

test('describeError, the decode mark, and whether a folder holds the app’s own data', () => {
  assert.equal(describeError(new Error('x'.repeat(500))).length, 200);
  assert.equal(describeError('text'), 'Request failed');
  assert.equal(describeError(null), 'Request failed');
  assert.equal(describeError({ message: 'looks like one' }), 'Request failed');
  const stack = describeError(new Error('boom'));
  assert.ok(!stack.includes('\n') && !stack.includes(' at '), 'never a stack');

  takeDecodeMax();
  noteDecode(3);
  noteDecode(12);
  noteDecode(7);
  assert.equal(takeDecodeMax(), 12);
  assert.equal(takeDecodeMax(), 0, 'taking it starts the next window');

  const dir = path.resolve('/data/opcb');
  const seen: string[] = [];
  const fsWith = (names: string[]) =>
    ({
      existsSync: (file: string) => (seen.push(file), names.some((n) => file === path.join(dir, n))),
    }) as unknown as Parameters<typeof holdsOwnData>[0];
  assert.equal(holdsOwnData(fsWith([]), dir), false);
  assert.ok(
    seen.length > 0 && seen.every((file) => path.dirname(file) === dir),
    'only names directly in the folder are looked for',
  );
  const first = path.basename(seen[0]!);
  assert.equal(holdsOwnData(fsWith([first]), dir), true);
  assert.equal(
    holdsOwnData(fsWith(['Cache', 'GPUCache', 'Local Storage']), dir),
    false,
    'Chromium’s own folders are not the app’s data',
  );
});
