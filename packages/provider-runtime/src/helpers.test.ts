import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGrantableFolder, pollBudgetMs, viewportPollGapMs } from './index.js';

test('isGrantableFolder: an absolute folder below a root, and never the root itself however it is written', () => {
  for (const ok of [
    'C:\\Users\\me\\Maps',
    'c:/Users/me/Maps',
    'D:\\data',
    'C:\\Users\\me\\.config\\maps',
    'C:\\My Folder\\v1.2',
    '/home/me/maps',
    '/data',
    '/home/me/.local/share',
    '\\\\nas\\share\\maps',
    '\\\\nas\\share\\a\\b',
  ])
    assert.equal(isGrantableFolder(ok), true, ok);
  for (const bad of [
    '',
    'maps',
    'Users\\me',
    './maps',
    '~/maps',
    'C:',
    'C:\\',
    'C:/',
    'C:\\\\',
    'C:\\.',
    'C:\\.\\',
    'C:\\..',
    'C:\\. ',
    'C:\\...',
    'C:\\Users\\..\\..',
    'C:\\Users\\me\\..\\other',
    'C:maps',
    '/',
    '//',
    '/.',
    '/./',
    '/..',
    '/home/../..',
    '\\\\nas',
    '\\\\nas\\share',
    '\\\\nas\\share\\',
    '\\\\nas\\share\\.',
    '\\\\nas\\share\\..\\other',
    '\\\\?\\C:\\',
    '\\\\?\\C:\\Users\\me',
    '\\\\?\\UNC\\nas\\share',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\',
    '\\\\.\\PhysicalDrive0\\x',
    '\\\\.\\C:\\Users',
    '//?/C:/Users',
    '//./C:/Users',
    '/home/me\0/maps',
    'file:///home/me',
    'https://example.com/maps',
    `/${'a'.repeat(1024)}`,
  ])
    assert.equal(isGrantableFolder(bad), false, JSON.stringify(bad));
});

test('viewportPollGapMs and pollBudgetMs', () => {
  const policy = { minIntervalMs: 2000, maxRequestsPerMinute: 30, timeoutMs: 10_000, maxRetries: 2 } as Parameters<
    typeof viewportPollGapMs
  >[0];
  assert.equal(viewportPollGapMs(policy, 1), 5000, 'never under five seconds');
  assert.equal(viewportPollGapMs(policy, 4), 8000, 'four requests of thirty a minute');
  assert.equal(viewportPollGapMs(policy, 7), 14_000);
  assert.equal(viewportPollGapMs(policy, 0), 5000);
  assert.equal(
    viewportPollGapMs({ ...policy, minIntervalMs: 20_000 }, 4),
    20_000,
    'the source\u2019s own floor when it is higher',
  );
  assert.equal(viewportPollGapMs({ ...policy, maxRequestsPerMinute: 0 }, 9), 5000);
  assert.equal(viewportPollGapMs({ ...policy, maxRequestsPerMinute: undefined } as unknown as typeof policy, 9), 5000);
  assert.equal(pollBudgetMs(policy), 35_000, 'every try at its full timeout, and five seconds');
  assert.equal(pollBudgetMs({ ...policy, pollBudgetMs: 1234 } as typeof policy), 1234);
  assert.equal(pollBudgetMs({ ...policy, maxRetries: 0 }), 15_000);
});
