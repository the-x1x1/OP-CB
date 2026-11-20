import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { WorldObject } from '@opcb/world-model';
import {
  appUserAgent,
  downloadUserAgent,
  identifiedTileHeaders,
  mergeSecurityHeaders,
  securityHeaders,
} from './main/csp.js';
import { POINTER_FILE, readPointer } from './main/data-location.js';
import { READER_SCHEME, isReaderUrl, parseReaderUrl, readerUrl } from './main/library-reader-pages.js';
import { normaliseQuery } from './renderer/components/search-items.js';
import { bool, displayName, num, safeHttpsUrl, str, strList, yesNo } from './renderer/context/props.js';
import { getByPath, setByPath, zoomForType } from './renderer/store/actions.js';
import { errorEnvelope, isEnvelope } from './shared/ipc-envelope.js';

const object = (
  properties: Record<string, unknown>,
  labels: Record<string, string> = {},
  id = 'p:aircraft:abc123',
): WorldObject => ({ id, type: 'aircraft', properties, labels }) as unknown as WorldObject;

test('property readers: the value when it is of the kind asked for, otherwise nothing', () => {
  const o = object({
    n: 5,
    zero: 0,
    nan: Number.NaN,
    text: 'abc',
    blank: '  ',
    yes: true,
    no: false,
    list: ['a', 5, 'b', null],
    notList: 'a,b',
  });
  assert.deepEqual(
    [num(o, 'n'), num(o, 'zero'), num(o, 'nan'), num(o, 'text'), num(o, 'missing')],
    [5, 0, undefined, undefined, undefined],
  );
  assert.deepEqual(
    [str(o, 'text'), str(o, 'blank'), str(o, 'n'), str(o, 'missing')],
    ['abc', undefined, undefined, undefined],
  );
  assert.deepEqual(
    [bool(o, 'yes'), bool(o, 'no'), bool(o, 'n'), bool(o, 'missing')],
    [true, false, undefined, undefined],
  );
  assert.deepEqual([yesNo(true), yesNo(false), yesNo(undefined)], ['Yes', 'No', undefined]);
  assert.deepEqual(strList(o, 'list'), ['a', 'b']);
  assert.equal(strList(o, 'notList'), undefined);
  assert.equal(strList(o, 'missing'), undefined);
});

test('displayName: the first label that says something, then the id\u2019s own part, and never nothing', () => {
  assert.equal(displayName(object({}, { callsign: 'HAL25', name: 'Hawaiian 25' })), 'HAL25');
  assert.equal(displayName(object({}, { name: 'Hawaiian 25', place: 'Honolulu' })), 'Hawaiian 25');
  assert.equal(displayName(object({}, { title: 'M 5.1', place: 'Hilo' })), 'M 5.1');
  assert.equal(displayName(object({}, { registration: 'N123', place: 'Hilo' })), 'N123');
  assert.equal(displayName(object({}, { place: 'Hilo' })), 'Hilo');
  assert.equal(
    displayName(object({}, { callsign: '', name: '   ', title: 'Named' })),
    'Named',
    'an empty callsign does not hide the name',
  );
  assert.equal(displayName(object({})), 'abc123');
  assert.equal(displayName(object({}, {}, 'p:camera:a:b:c')), 'a:b:c');
  assert.equal(
    displayName(object({}, {}, 'plain-id')),
    'plain-id',
    'an id with no parts before its value is shown whole',
  );
  assert.equal(displayName(object({}, {}, 'p:type')), 'p:type');
  assert.equal(displayName(object({}, { other: 'x' })), 'abc123');
});

test('safeHttpsUrl: https only', () => {
  assert.equal(safeHttpsUrl('https://example.org/a?b=1#c'), 'https://example.org/a?b=1#c');
  assert.equal(safeHttpsUrl('HTTPS://Example.org'), 'https://example.org/');
  for (const bad of [
    undefined,
    '',
    'http://example.org',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///c:/x',
    '//example.org/x',
    'example.org',
    'https://',
    'ftp://example.org',
    ' ',
    'opcb://x',
  ])
    assert.equal(safeHttpsUrl(bad), undefined, String(bad));
});

test('setByPath and getByPath: a copy with the one value changed, emptied branches removed, and no way to the prototype', () => {
  const source = { a: 1, nested: { deep: { x: 1, y: 2 }, keep: true } };
  const frozen = JSON.stringify(source);
  const set = setByPath(source, 'nested.deep.x', 9);
  assert.deepEqual(set, { a: 1, nested: { deep: { x: 9, y: 2 }, keep: true } });
  assert.equal(JSON.stringify(source), frozen, 'the source is not written to');
  assert.deepEqual(setByPath(source, 'b', 'new'), { ...source, b: 'new' });
  assert.deepEqual(setByPath(source, 'new.branch.leaf', true), { ...source, new: { branch: { leaf: true } } });
  assert.deepEqual(
    setByPath(source, 'a.b', 2),
    { ...source, a: { b: 2 } },
    'a value in the way is replaced by the branch',
  );
  assert.deepEqual(setByPath(source, 'a', undefined), { nested: source.nested });
  assert.deepEqual(setByPath({ only: { leaf: 1 } }, 'only.leaf', undefined), {}, 'a branch left empty goes too');
  assert.deepEqual(setByPath(source, 'nested.deep.x', undefined), { a: 1, nested: { deep: { y: 2 }, keep: true } });
  assert.deepEqual(setByPath(source, 'missing.leaf', undefined), source);
  assert.equal(setByPath(source, '', 1), source);
  assert.deepEqual(setByPath(source, 'zero', 0), { ...source, zero: 0 });
  assert.deepEqual(setByPath(source, 'no', false), { ...source, no: false });
  assert.deepEqual(setByPath(source, 'nothing', null), { ...source, nothing: null });

  assert.equal(getByPath(source, 'a'), 1);
  assert.equal(getByPath(source, 'nested.deep.y'), 2);
  assert.deepEqual(getByPath(source, 'nested.deep'), { x: 1, y: 2 });
  for (const path of [
    'missing',
    'a.b',
    'nested.deep.z',
    'nested.keep.more',
    '',
    'constructor',
    'nested.constructor',
    'toString',
    '__proto__',
    'nested.__proto__.x',
    'hasOwnProperty.call',
  ])
    assert.equal(getByPath(source, path), undefined, path);
  assert.equal(getByPath({ list: [1, 2] }, 'list.0'), undefined, 'a list is a value, not a branch');

  for (const path of ['__proto__', '__proto__.polluted', '__proto__.toString']) {
    const out = setByPath(source, path, 'x');
    assert.equal(Object.getPrototypeOf(out), Object.prototype, path);
    assert.equal(JSON.stringify(out), frozen, path);
  }
  const inner = setByPath(source, 'nested.__proto__.polluted', 'x') as { nested: object };
  assert.equal(Object.getPrototypeOf(inner.nested), Object.prototype);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'nothing reached Object.prototype');
  assert.equal(getByPath(inner, 'nested.polluted'), undefined);
});

test('zoomForType and normaliseQuery', () => {
  for (const type of ['aircraft', 'vessel', 'transit-vehicle', 'camera']) assert.equal(zoomForType(type), 10, type);
  assert.equal(zoomForType('satellite'), 3);
  for (const type of ['earthquake', 'fire-detection', 'weather-alert', 'storm'])
    assert.equal(zoomForType(type), 6, type);
  const other = zoomForType('something-new');
  assert.ok(Number.isFinite(other) && other >= 1 && other <= 12);
  assert.equal(zoomForType('constructor'), other);

  assert.equal(normaliseQuery('  fly   to\tHonolulu \n'), 'fly to Honolulu');
  assert.equal(normaliseQuery(''), '');
  assert.equal(normaliseQuery(' \t '), '');
  assert.equal(normaliseQuery('one'), 'one');
});

test('IPC envelopes', () => {
  assert.equal(isEnvelope({ ok: true, value: 1 }), true);
  assert.equal(
    isEnvelope(
      errorEnvelope({ code: 'INVALID_REQUEST', message: 'm', channel: 'c' } as Parameters<typeof errorEnvelope>[0]),
    ),
    true,
  );
  for (const other of [null, undefined, 'ok', 5, [], {}, { ok: 'true' }, { ok: 1 }, { value: 1 }])
    assert.equal(isEnvelope(other), false, JSON.stringify(other));
});

test('security headers: ours replace any of the same name however it is cased; the rest are kept', () => {
  const ours = securityHeaders();
  assert.deepEqual(Object.keys(ours).sort(), [
    'Content-Security-Policy',
    'Cross-Origin-Opener-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'X-Content-Type-Options',
  ]);
  const csp = ours['Content-Security-Policy']![0]!;
  assert.match(csp, /default-src 'none'|default-src 'self'/);
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(csp) || /wasm-unsafe-eval/.test(csp), 'no eval of text as script');
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no inline script');
  assert.deepEqual(ours['X-Content-Type-Options'], ['nosniff']);
  assert.deepEqual(ours['Referrer-Policy'], ['no-referrer']);
  for (const feature of ['camera', 'microphone', 'geolocation', 'usb', 'serial', 'bluetooth', 'payment'])
    assert.ok(ours['Permissions-Policy']![0]!.includes(`${feature}=()`), feature);

  const merged = mergeSecurityHeaders({
    'content-security-policy': ["default-src *; script-src 'unsafe-inline'"],
    'X-CONTENT-TYPE-OPTIONS': ['sniff'],
    'referrer-policy': ['unsafe-url'],
    'Content-Type': ['text/html'],
    ETag: ['"abc"'],
  });
  assert.deepEqual(merged['Content-Type'], ['text/html']);
  assert.deepEqual(merged['ETag'], ['"abc"']);
  const names = Object.keys(merged).map((k) => k.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'no header twice under two casings');
  assert.deepEqual(merged['Content-Security-Policy'], ours['Content-Security-Policy']);
  assert.deepEqual(merged['X-Content-Type-Options'], ['nosniff']);
  assert.deepEqual(mergeSecurityHeaders(undefined), ours);
});

test('user agents: the app named to tile hosts, a browser\u2019s string without Electron for downloads', () => {
  assert.equal(appUserAgent('0.7.5'), 'OP-CB/0.7.5 (+https://github.com/the-x1x1/OP-CB)');
  const electron =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OP-CB/0.7.5 Chrome/142.0.0.0 Electron/44.10.0 Safari/537.36';
  const download = downloadUserAgent(electron, '0.7.5');
  assert.ok(
    !download.includes('Electron') &&
      download.includes('Chrome/142.0.0.0') &&
      download.includes('OP-CB/0.7.5') &&
      download.endsWith('Safari/537.36'),
    download,
  );
  assert.ok(!download.includes('  '));
  const unnamed = downloadUserAgent('Mozilla/5.0 Chrome/142.0.0.0 Electron/44.10.0 Safari/537.36', '0.7.5');
  assert.ok(unnamed.endsWith(' OP-CB/0.7.5') && !unnamed.includes('Electron'), unnamed);
  assert.equal(downloadUserAgent('node', '0.7.5'), appUserAgent('0.7.5'));
  assert.equal(downloadUserAgent('', '0.7.5'), appUserAgent('0.7.5'));

  const headers = identifiedTileHeaders({ 'user-agent': 'Chrome', Accept: 'image/png', 'USER-AGENT': 'x' }, '0.7.5');
  assert.deepEqual(headers, { Accept: 'image/png', 'User-Agent': appUserAgent('0.7.5') });
});

test('reader addresses: a book id and a key, there and back, and nothing else taken for one', () => {
  const bookId = '0123456789abcdef0123456789abcdef';
  for (const key of ['A/Water', 'A/Caf\u00E9 au lait', 'I/m/photo 1.jpg', 'A/100%', 'A/a?b#c', '-/style.css', '']) {
    const url = readerUrl(bookId, key);
    assert.ok(url.startsWith(`${READER_SCHEME}://${bookId}/`), url);
    assert.deepEqual(parseReaderUrl(url), { bookId, key }, key);
    assert.equal(isReaderUrl(url), true);
  }
  for (const bad of [
    '',
    'not a url',
    `https://${bookId}/A/Water`,
    `${READER_SCHEME}://short/A/Water`,
    `${READER_SCHEME}://${bookId.toUpperCase().replace(/[0-9]/g, 'G')}/A`,
    `${READER_SCHEME}://${bookId}x/A`,
    `${READER_SCHEME}://${bookId}/A/%E0%A4%A`,
    `${READER_SCHEME}://${bookId}/A/%00`,
    `${READER_SCHEME}://${bookId}/${'k'.repeat(2001)}`,
    `file:///C:/Windows/win.ini`,
  ])
    assert.equal(isReaderUrl(bad), false, bad.slice(0, 70));
});

test('readPointer: the absolute folder a pointer file names, or nothing', () => {
  const root = path.resolve('/data/usual');
  const elsewhere = path.resolve('/mnt/drive/opcb');
  const fsWith = (content: string | undefined) =>
    ({
      existsSync: (file: string) => content !== undefined && file === path.join(root, POINTER_FILE),
      readFileSync: () => {
        if (content === undefined) throw new Error('ENOENT');
        return content;
      },
      statSync: () => {
        throw new Error('not used');
      },
    }) as unknown as Parameters<typeof readPointer>[0];
  assert.equal(readPointer(fsWith(JSON.stringify({ path: elsewhere })), root), elsewhere);
  for (const content of [
    undefined,
    '',
    '{',
    'null',
    '[]',
    '"text"',
    '{}',
    JSON.stringify({ path: 5 }),
    JSON.stringify({ path: 'relative/folder' }),
    JSON.stringify({ path: '' }),
    JSON.stringify({ path: `${elsewhere}\0x` }),
  ])
    assert.equal(readPointer(fsWith(content), root), undefined, String(content));
});
