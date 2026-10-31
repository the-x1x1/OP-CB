import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkyOverheadAnswer, SkySatellite } from '@opcb/ipc-contract';
import { PLOT_RADIUS, auroraText, lookText, polarXY, skySummary, visibleToEye } from './sky-plot.js';

const sat = (id: string, elevationDeg: number, over: Partial<SkySatellite> = {}): SkySatellite => ({
  id,
  name: id,
  azimuthDeg: 47,
  elevationDeg,
  rangeM: 1_120_000,
  altitudeM: 420_000,
  sunlit: true,
  ...over,
});

test('the sky plot: the zenith in the middle, the horizon round the edge, north up and east right', () => {
  assert.deepEqual(polarXY(123, 90), { x: 0, y: 0 });
  assert.deepEqual(polarXY(0, 0), { x: 0, y: -PLOT_RADIUS });
  assert.deepEqual(polarXY(90, 0), { x: PLOT_RADIUS, y: 0 });
  assert.deepEqual(polarXY(180, 45), { x: 0, y: PLOT_RADIUS / 2 });
  assert.deepEqual(polarXY(270, -3), { x: -PLOT_RADIUS, y: 0 }, 'a little below the horizon: on its edge');
});

test('which could be seen: sunlit, ten degrees up, the Sun six below; the summary counts the runtime gave', () => {
  const answer: SkyOverheadAnswer = {
    at: '2026-10-05T12:00:00.000Z',
    observer: { latitude: 21.3, longitude: -157.85 },
    total: 1_068,
    visible: 41,
    stale: 0,
    sunElevationDeg: -40,
    satellites: [
      sat('ISS (ZARYA)', 62, { category: 'station' }),
      sat('NOAA 19', 30, { sunlit: false, category: 'weather' }),
      sat('LOW ONE', 5),
    ],
  };
  assert.equal(visibleToEye(answer.satellites[0]!, -40), true);
  assert.equal(visibleToEye(answer.satellites[0]!, -3), false, 'twilight: not dark enough');
  assert.equal(visibleToEye(answer.satellites[1]!, -40), false, "in the Earth's shadow");
  assert.equal(visibleToEye(answer.satellites[2]!, -40), false, 'too low');
  assert.equal(skySummary(answer), '1,068 above the horizon · 41 could be seen (sunlit, 10° up or more)');
  assert.equal(
    skySummary({ ...answer, sunElevationDeg: 20 }),
    '1,068 above the horizon · the sky is not dark: none can be seen with the eye',
  );
  assert.equal(lookText(answer.satellites[0]!), '62° up · 047° NE · 1,120 km');
});

test('the aurora line: the band the place is in, the time it is for, and whether the sky is dark', () => {
  const answer: SkyOverheadAnswer = {
    at: '2026-09-23T19:30:00.000Z',
    observer: { latitude: 64.84, longitude: -147.72 },
    total: 0,
    visible: 0,
    stale: 0,
    sunElevationDeg: -20,
    satellites: [],
  };
  assert.equal(auroraText(answer), undefined, 'no aurora source, or outside every area');
  const aurora = { chancePct: 30, belowPct: 50, forecastFor: '2026-09-23T20:08:00.000Z' };
  assert.equal(auroraText({ ...answer, aurora }), 'Aurora: 30–50% chance overhead at 20:08 UTC');
  assert.equal(
    auroraText({ ...answer, aurora: { chancePct: 70 }, sunElevationDeg: 4 }),
    'Aurora: 70% or more chance overhead · the sky is not dark here now',
  );
});
