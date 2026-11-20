import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_SCHEMAS, schemaFor } from './ipc-schemas.js';

/**
 * Every request schema, given what a compromised renderer could send (values that survive
 * the structured clone IPC puts them through — no functions, symbols or proxies): none may throw (the
 * router answers INVALID_REQUEST from the issues, it does not catch), none may take longer
 * than a moment, and none may leave anything on Object.prototype.
 */
function hostileValues(): unknown[] {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 2000; i++) {
    const next: Record<string, unknown> = {};
    cursor['a'] = next;
    cursor = next;
  }
  const cyclic: Record<string, unknown> = { kind: 'bounds' };
  cyclic['self'] = cyclic;
  const proto = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"id":"x","kind":"book"}',
  ) as unknown;
  return [
    undefined,
    null,
    true,
    0,
    -1,
    Number.NaN,
    Infinity,
    '',
    'text',
    'x'.repeat(1_000_000),
    `${'a'.repeat(50_000)}!`,
    `${'-'.repeat(50_000)}x`,
    `${'<'.repeat(50_000)}`,
    `2026-${'0'.repeat(50_000)}`,
    [],
    [1, 2, 3],
    new Array(100_000).fill('x'),
    {},
    { id: 'x' },
    { id: 'x'.repeat(100_000) },
    { id: 5, name: 5, kind: 5, url: 5, bounds: 5, range: 5, query: 5, ids: 5, settings: 5 },
    { id: null, name: null, kind: null, url: null, bounds: null, range: null, query: null, ids: null },
    {
      ids: new Array(100_000).fill('x'),
      types: new Array(100_000).fill('x'),
      objectTypes: new Array(100_000).fill('x'),
    },
    { bounds: { west: Number.NaN, south: Infinity, east: -Infinity, north: 1e308 } },
    { range: { start: 'never', end: {} }, start: 'x', end: 'y' },
    { url: 'javascript:alert(1)', href: 'file:///etc/passwd', path: '../../etc/passwd' },
    { length: 1e9 },
    deep,
    cyclic,
    proto,
    new Date(0),
    new Map([['id', 'x']]),
    10n,
  ];
}

test('every request schema refuses hostile payloads without throwing, quickly, and leaves no mark', () => {
  const channels = Object.keys(REQUEST_SCHEMAS);
  assert.ok(channels.length > 100, `${channels.length} channels`);
  const values = hostileValues();
  const slow: string[] = [];
  const threw: string[] = [];
  for (const channel of channels) {
    const schema = schemaFor(channel)!;
    values.forEach((value, i) => {
      const started = performance.now();
      try {
        const result = schema.parse(value, '');
        assert.equal(typeof result.ok, 'boolean', `${channel} #${i}`);
        if (!result.ok)
          assert.ok(
            Array.isArray(result.issues) && result.issues.length > 0,
            `${channel} #${i}: refused with no issue`,
          );
      } catch (err) {
        threw.push(`${channel} #${i}: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
      }
      const took = performance.now() - started;
      if (took > 250) slow.push(`${channel} #${i}: ${Math.round(took)} ms`);
    });
  }
  assert.deepEqual(threw.slice(0, 20), [], `${threw.length} threw`);
  assert.deepEqual(slow.slice(0, 20), [], `${slow.length} slow`);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('schemaFor: a schema for each channel of the contract, and none for a name every object has', () => {
  for (const channel of Object.keys(REQUEST_SCHEMAS))
    assert.equal(typeof schemaFor(channel)?.parse, 'function', channel);
  for (const name of ['', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'no.such.channel', 'WORLD.QUERY'])
    assert.equal(schemaFor(name), undefined, name);
});

test('issues name where the fault is and never repeat a megabyte of what was sent', () => {
  const big = 'x'.repeat(1_000_000);
  for (const channel of Object.keys(REQUEST_SCHEMAS)) {
    const result = schemaFor(channel)!.parse({ id: big, name: big, url: big, kind: big, query: big }, '');
    if (result.ok) continue;
    const text = JSON.stringify(result.issues);
    assert.ok(text.length < 20_000, `${channel}: ${text.length} characters of issues`);
  }
});
