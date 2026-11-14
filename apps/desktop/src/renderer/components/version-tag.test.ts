import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionLabel } from './version-tag.js';

test('version tag: the running build, with its commit so a branch test build is told apart', () => {
  assert.deepEqual(versionLabel({ version: '0.7.4', channel: 'stable', commit: 'f021db718860' }), {
    text: 'v0.7.4 · f021db71',
    title: 'OP-CB 0.7.4, build f021db718860',
  });
  // A prerelease or a development run says so.
  assert.equal(
    versionLabel({ version: '0.8.0-rc.1', channel: 'prerelease', commit: 'abc1234' })?.text,
    'v0.8.0-rc.1 prerelease · abc1234',
  );
  assert.equal(versionLabel({ version: '0.7.4', channel: 'dev', commit: 'unknown' })?.text, 'v0.7.4 dev');
  // Before app.info has arrived there is nothing to show.
  assert.equal(versionLabel(null), null);
  assert.equal(versionLabel({ version: '', channel: 'stable', commit: '' }), null);
});
