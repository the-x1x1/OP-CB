import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorldObject } from '@worldview/world-model';
import {
  aqhiText,
  aqiCategory,
  feelsLike,
  formatTemperature,
  stationPressure,
  stationRain,
  stationWaves,
  stationWind,
} from './sections.js';

const station = (properties: Record<string, number>) => ({ properties }) as unknown as WorldObject;

test('a local station reads in SI with the US figure beside it', () => {
  assert.equal(formatTemperature(29), '29.0 °C (84.2 °F)');
  assert.equal(formatTemperature(-40), '-40.0 °C (-40.0 °F)');
  assert.equal(formatTemperature(undefined), undefined);
  assert.equal(stationWind(5, 71), '5.0 m/s (11 mph) from ENE (71°)');
  assert.equal(stationWind(9.4, undefined), '9.4 m/s (21 mph)');
  assert.equal(stationWind(0, 180), 'Calm');
  assert.equal(stationPressure(1014.8, -1), '1014.8 hPa · falling 1.0 hPa in 3 h');
  assert.equal(stationPressure(1014.8, 0.2), '1014.8 hPa · steady in 3 h');
  assert.equal(stationPressure(1014.8, undefined), '1014.8 hPa');
  assert.equal(stationRain(0, 1, 5.8), '0.0 mm/h · 1.0 mm today · 5.8 mm in 24 h');
  assert.equal(stationRain(undefined, undefined, undefined), undefined);
});

test('"feels like" only when it differs by a degree or more', () => {
  assert.equal(feelsLike(station({ temperatureC: 29, heatIndexC: 31.6, windChillC: 29 })), '31.6 °C (88.9 °F)');
  assert.equal(feelsLike(station({ temperatureC: 5, heatIndexC: 5, windChillC: 1.5 })), '1.5 °C (34.7 °F)');
  assert.equal(feelsLike(station({ temperatureC: 20, heatIndexC: 20.4, windChillC: 20 })), undefined);
  assert.equal(feelsLike(station({})), undefined);
});

test('an AQI is named by the U.S. EPA category it falls in', () => {
  assert.equal(aqiCategory(20), 'Good');
  assert.equal(aqiCategory(50), 'Good');
  assert.equal(aqiCategory(51), 'Moderate');
  assert.equal(aqiCategory(154), 'Unhealthy');
  assert.equal(aqiCategory(420), 'Hazardous');
  assert.equal(aqiCategory(undefined), undefined);
});

test('a buoy: waves by height, period and the direction they come from, whatever part it reports', () => {
  assert.equal(stationWaves(1.8, undefined, 6.4, 342), '1.8 m (5.9 ft) · 6.4 s average period · from NNW (342°)');
  assert.equal(stationWaves(1.7, 6, 5.6, 69), '1.7 m (5.6 ft) · every 6 s (5.6 s average) · from ENE (69°)');
  assert.equal(stationWaves(undefined, 13, undefined, undefined), 'every 13 s');
  assert.equal(stationWaves(undefined, undefined, undefined, undefined), undefined);
  // NDBC 22101 sends DPD 0: no period measured, not waves every 0 s.
  assert.equal(stationWaves(0.5, 0, undefined, undefined), '0.5 m (1.6 ft)');
  assert.equal(stationWaves(0.5, 0, 0, undefined), '0.5 m (1.6 ft)');
});

test('AQHI reads with its risk category and its scale, never as an AQI', () => {
  assert.equal(aqhiText(1.76), '1.8 · low risk (1–10+ scale)');
  assert.equal(aqhiText(4), '4 · moderate risk (1–10+ scale)');
  assert.equal(aqhiText(7.4), '7.4 · high risk (1–10+ scale)');
  assert.equal(aqhiText(11), '11 · very high risk (1–10+ scale)');
});
