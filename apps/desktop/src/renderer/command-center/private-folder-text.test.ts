import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passphraseHint, requestErrorText } from './private-folder-text.js';

test('requestErrorText: the IPC message as a sentence; nothing else from the error', () => {
  assert.equal(
    requestErrorText({ code: 'DENIED', message: 'that is not the passphrase', channel: 'private.unlock' }),
    'That is not the passphrase.',
  );
  assert.equal(requestErrorText(new Error('the private folder is closed')), 'The private folder is closed.');
  assert.equal(requestErrorText(new Error('Done!')), 'Done!');
  assert.equal(requestErrorText('secret typed text'), 'That did not work.');
  assert.equal(requestErrorText(undefined), 'That did not work.');
});

test('passphraseHint: short, then short and spaceless, then nothing to say', () => {
  assert.equal(passphraseHint(''), undefined);
  assert.equal(passphraseHint('abc'), 'At least 8 characters.');
  assert.match(passphraseHint('abcdefgh') ?? '', /Longer is stronger/);
  assert.equal(passphraseHint('river stone lamp'), undefined);
  assert.equal(passphraseHint('abcdefghijklmnopq'), undefined);
  assert.equal(passphraseHint('😀😀😀😀'), 'At least 8 characters.');
});
