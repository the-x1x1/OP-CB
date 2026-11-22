import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileRetrying } from './node.js';

/** A file held for a moment by a virus scanner or OneDrive is read once it is let go. */
const failing = (codes: Array<string | undefined>, text = 'ok') => {
  let calls = 0;
  return {
    read: async () => {
      const code = codes[calls++];
      if (code) throw Object.assign(new Error(code), { code });
      return text;
    },
    calls: () => calls,
  };
};

test('readFileRetrying: on Windows, a held file is read after it is let go', async () => {
  const f = failing(['EBUSY', 'EPERM', undefined]);
  assert.equal(await readFileRetrying('x', { platform: 'win32', read: f.read }), 'ok');
  assert.equal(f.calls(), 3);
});

test('readFileRetrying: a file held throughout fails after a short wait; a missing one at once', async () => {
  const held = failing(Array(10).fill('EBUSY'));
  const t0 = Date.now();
  await assert.rejects(readFileRetrying('x', { platform: 'win32', read: held.read }), /EBUSY/);
  assert.equal(held.calls(), 6, 'five tries after the first');
  assert.ok(Date.now() - t0 < 2000);
  const missing = failing(['ENOENT']);
  await assert.rejects(readFileRetrying('x', { platform: 'win32', read: missing.read }), /ENOENT/);
  assert.equal(missing.calls(), 1);
});

test('readFileRetrying: elsewhere than Windows, no second try', async () => {
  const f = failing(['EACCES', undefined]);
  await assert.rejects(readFileRetrying('x', { platform: 'linux', read: f.read }), /EACCES/);
  assert.equal(f.calls(), 1);
});
