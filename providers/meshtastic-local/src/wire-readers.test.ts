import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeviceMetrics, readEnvironment, readRoutingError, readUser } from './wire.js';
import { ageText, hardwareName } from './nodes.js';
import { deviceMetrics, environment, pb } from '../test/encode.js';

const bytes = (p: number[]) => Uint8Array.from(p);

test('readUser: each field by its number (meshtastic User), unknown and deprecated ones skipped', () => {
  const u = readUser(
    bytes(
      pb.msg(
        pb.string(1, '!a1b2c3d4'),
        pb.string(2, 'Base camp'),
        pb.string(3, 'BC'),
        pb.bytes(4, [0xde, 0xad, 0xbe, 0xef, 0, 1]),
        pb.varint(5, 4),
        pb.varint(6, true),
        pb.varint(7, 2),
        pb.string(99, 'later field'),
      ),
    ),
  );
  assert.deepEqual(u, {
    id: '!a1b2c3d4',
    longName: 'Base camp',
    shortName: 'BC',
    hwModel: 4,
    isLicensed: true,
    role: 2,
  });
  assert.deepEqual(readUser(new Uint8Array(0)), {});
  // A repeated field: the last one counts, as protobuf reads it.
  assert.equal(readUser(bytes(pb.msg(pb.string(2, 'Old'), pb.string(2, 'New')))).longName, 'New');
});

test('readDeviceMetrics and readEnvironment: numbers as sent; a float that is not finite left unset', () => {
  assert.deepEqual(
    readDeviceMetrics(bytes(deviceMetrics({ battery: 101, voltage: 4.25, chUtil: 12.5, airTx: 0.5, uptime: 3600 }))),
    {
      batteryLevel: 101,
      voltage: 4.25,
      channelUtilization: 12.5,
      airUtilTx: 0.5,
      uptimeSeconds: 3600,
    },
  );
  assert.deepEqual(readDeviceMetrics(bytes(deviceMetrics({ battery: 50, voltage: Number.NaN, chUtil: Infinity }))), {
    batteryLevel: 50,
  });
  assert.deepEqual(readEnvironment(bytes(environment({ temperature: -12.5, humidity: 80, pressure: 1013.25 }))), {
    temperatureC: -12.5,
    relativeHumidity: 80,
    barometricPressureHpa: 1013.25,
  });
  assert.deepEqual(readEnvironment(bytes(environment({ temperature: -Infinity, humidity: Number.NaN }))), {});
  assert.deepEqual(readEnvironment(bytes(pb.msg(pb.float(4, 3), pb.varint(9, 1)))), {}, 'fields it does not read');
});

test('readRoutingError: the error reason (field 3), 0 when none; route request and reply skipped', () => {
  assert.equal(readRoutingError(new Uint8Array(0)), 0);
  assert.equal(readRoutingError(bytes(pb.varint(3, 5))), 5);
  assert.equal(readRoutingError(bytes(pb.msg(pb.bytes(1, [8, 1]), pb.bytes(2, [8, 2]), pb.varint(3, 8)))), 8);
});

test('hardwareName and ageText', () => {
  assert.equal(hardwareName(4), 'LilyGO T-Beam');
  assert.equal(hardwareName(12), 'LilyGO T-Beam S3');
  assert.equal(hardwareName(9999), undefined);
  assert.equal(hardwareName(undefined), undefined);
  assert.equal(hardwareName('constructor' as never), undefined);
  assert.deepEqual([0, 40, 89, 120, 89 * 60, 5 * 3600, 47 * 3600, 3 * 86400].map(ageText), [
    '0 s',
    '40 s',
    '89 s',
    '2 min',
    '89 min',
    '5 h',
    '47 h',
    '3 days',
  ]);
});
