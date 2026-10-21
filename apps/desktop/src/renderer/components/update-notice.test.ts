import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdaterState } from '@worldview/ipc-contract';
import { updateNoticeModel } from './update-notice.js';

const base: UpdaterState = {
  channel: 'stable',
  automatic: true,
  status: 'idle',
  currentVersion: '0.5.0',
  signed: false,
};

test('update notice: nothing to say until a newer version is known', () => {
  assert.equal(updateNoticeModel(null), null);
  for (const status of ['idle', 'checking', 'up-to-date', 'error', 'disabled'] as const)
    assert.equal(updateNoticeModel({ ...base, status }), null, status);
  assert.equal(updateNoticeModel({ ...base, status: 'available' }), null, 'no version, no card');
});

test('update notice: downloading in the background, then restart to update', () => {
  const downloading = updateNoticeModel({
    ...base,
    status: 'downloading',
    availableVersion: '0.6.0',
    message: 'downloading 40%',
  });
  assert.equal(downloading?.title, 'WorldView 0.6.0 is available');
  assert.match(downloading?.body ?? '', /downloading 40%/);
  assert.equal(downloading?.action, undefined, 'nothing to press while it downloads');

  const ready = updateNoticeModel({ ...base, status: 'downloaded', availableVersion: '0.6.0' });
  assert.equal(ready?.title, 'WorldView 0.6.0 is ready');
  assert.match(ready?.body ?? '', /You are on 0\.5\.0/);
  assert.deepEqual(ready?.action, { label: 'Restart to update', kind: 'restart' });
});

test('update notice: with automatic updates off, the card offers the download', () => {
  const offered = updateNoticeModel({ ...base, automatic: false, status: 'available', availableVersion: '0.6.0' });
  assert.deepEqual(offered?.action, { label: 'Download and restart', kind: 'download' });
});
