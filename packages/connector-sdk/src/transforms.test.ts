import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMapping, mapRecord } from './mapping.js';
import { TRANSFORMS, resolveTransform, transformNames, unambiguousTimestamp } from './transforms.js';

// Transforms promoted into the registry from the connectors that first needed them (the
// refactor pass, docs/roadmap/INTEGRATION.md). The connector's own tests keep covering its
// use of each; these cover the registry side: the name resolves, it is listed, and a mapping
// can name it.

test('unambiguousTimestamp: in the closed registry, listed, and nameable from a mapping', () => {
  assert.equal(TRANSFORMS['unambiguousTimestamp'], resolveTransform('unambiguousTimestamp'));
  assert.ok(transformNames().includes('unambiguousTimestamp'));
  const m = compileMapping({
    externalId: 'id',
    properties: { sent: { path: 'tst', transform: 'unambiguousTimestamp' } },
  });
  const zoned = mapRecord({ id: 'a', tst: '2026-09-23T09:59:30-10:00' }, m);
  const local = mapRecord({ id: 'b', tst: '2026-09-23 09:59:30' }, m);
  assert.ok(zoned.ok && zoned.record.properties['sent'] === '2026-09-23T19:59:30.000Z');
  assert.ok(local.ok && !('sent' in local.record.properties), 'a zone-less local time is not guessed');
});

test('unambiguousTimestamp: Unix seconds or milliseconds between 2000 and 2100, or a date-time with a zone', () => {
  const t = TRANSFORMS['unambiguousTimestamp']!;
  assert.equal(t(1790193570), '2026-09-23T19:59:30.000Z');
  assert.equal(t('1790193570.25'), '2026-09-23T19:59:30.250Z');
  assert.equal(t(1790193570123), '2026-09-23T19:59:30.123Z');
  assert.equal(t('2026-09-23T09:59:30-1000'), '2026-09-23T19:59:30.000Z');
  assert.equal(t('2026-09-23 19:59:30Z'), '2026-09-23T19:59:30.000Z');
  assert.equal(t('2026-09-23T09:59:30.5-10:00'), '2026-09-23T19:59:30.500Z');
  assert.equal(t('2026-09-23 09:59:30'), undefined);
  assert.equal(t(42), undefined, 'a counter, not a clock');
  assert.equal(t(4_200_000_000_000), undefined, 'after 2100');
  assert.equal(t(''), undefined);
  assert.equal(t(null), undefined);
  assert.equal(t(true), undefined);
  assert.equal(t('2026-02-30T09:59:30Z'), undefined, 'a date that does not exist');
  assert.equal(t('2028-02-29T00:00:00Z'), '2028-02-29T00:00:00.000Z');
  assert.equal(unambiguousTimestamp(Number.NaN), undefined);
});

test('isoTimestamp: a date-time with no zone is UTC whether written with T or a space, on any computer', () => {
  const was = process.env['TZ'];
  process.env['TZ'] = 'Pacific/Honolulu';
  try {
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23T10:00:00'), '2026-09-23T10:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23T10:00'), '2026-09-23T10:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23 10:00:00.5'), '2026-09-23T10:00:00.500Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23T10:00:00-10:00'), '2026-09-23T20:00:00.000Z');
    // The looser forms Date.parse takes: UTC when they name no zone, theirs when they do.
    for (const loose of ['2026/09/23 10:00', 'Sep 23 2026 10:00', '23 Sep 2026 10:00:00', '09/23/2026 10:00'])
      assert.equal(TRANSFORMS['isoTimestamp']!(loose), '2026-09-23T10:00:00.000Z', loose);
    assert.equal(TRANSFORMS['isoTimestamp']!('2026/09/23'), '2026-09-23T00:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23'), '2026-09-23T00:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('Wed, 23 Sep 2026 10:00:00 GMT'), '2026-09-23T10:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('Sep 23 2026 10:00 PDT'), '2026-09-23T17:00:00.000Z');
    assert.equal(TRANSFORMS['isoTimestamp']!('2026-09-23 10:00:00 +0200'), '2026-09-23T08:00:00.000Z');
    // And so is an observedAt mapped with no transform at all.
    const m = compileMapping({
      externalId: 'id',
      observedAt: 'at',
      position: { lat: 'la', lon: 'lo' },
    });
    const r = mapRecord({ id: 'a', at: '2026-09-23T10:00:00', la: 1, lo: 2 }, m);
    assert.ok(r.ok);
    assert.equal(r.record.observedAt, '2026-09-23T10:00:00.000Z');
  } finally {
    if (was === undefined) delete process.env['TZ'];
    else process.env['TZ'] = was;
  }
});

test('transforms: a number past what a date or a number holds is no value, never a throw or Infinity', () => {
  assert.equal(TRANSFORMS['isoTimestamp']!(1e20), undefined);
  assert.equal(TRANSFORMS['isoTimestamp']!(-1e20), undefined);
  assert.equal(TRANSFORMS['feetToMeters']!(1e308), undefined);
  assert.equal(resolveTransform('scale:1e300')!(1e300), undefined);
});

test('timestamp:<pattern>: a date or a time of day that does not exist is no time', () => {
  for (const bad of ['2026-02-30T10:00:00Z', '2026-02-31', '2026-04-31 00:00:00', '2026/02/30 10:00'])
    assert.equal(TRANSFORMS['isoTimestamp']!(bad), undefined, bad);
  assert.equal(TRANSFORMS['isoTimestamp']!('2028-02-29T10:00:00Z'), '2028-02-29T10:00:00.000Z');
  const t = resolveTransform('timestamp:YYYY-MM-DD HH:mm:ss')!;
  assert.equal(t('2026-09-23 10:00:00'), '2026-09-23T10:00:00.000Z');
  assert.equal(t('2028-02-29 23:59:59'), '2028-02-29T23:59:59.000Z');
  assert.equal(t('2026-12-31 23:59:60'), '2027-01-01T00:00:00.000Z');
  for (const bad of [
    '2026-02-30 10:00:00',
    '2026-02-29 10:00:00',
    '2026-13-01 10:00:00',
    '2026-00-10 10:00:00',
    '2026-09-23 24:00:00',
    '2026-09-23 25:61:00',
    '2026-09-23 10:60:00',
    '2026-09-00 10:00:00',
  ])
    assert.equal(t(bad), undefined, bad);
});

test('resolveTransform: a name every object has is not a transform', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'])
    assert.equal(resolveTransform(name), undefined, name);
  assert.equal(typeof resolveTransform('number'), 'function');
});
