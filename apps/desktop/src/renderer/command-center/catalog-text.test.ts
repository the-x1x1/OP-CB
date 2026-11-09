import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogCountText, flavourText } from './catalog-text.js';

test('catalogue words: an edition says what it holds; an unknown code is shown as it is', () => {
  assert.equal(flavourText('maxi'), 'full, with pictures');
  assert.equal(flavourText('nopic'), 'full text, no pictures');
  assert.equal(flavourText(' Mini '), 'introductions only');
  assert.equal(flavourText('novid'), 'novid');
  assert.equal(flavourText(''), undefined, 'the live catalogue sends <flavour></flavour> for most books');
  assert.equal(flavourText(undefined), undefined);
});

test('catalogue words: more matches than one page says so, otherwise nothing', () => {
  assert.equal(catalogCountText(50, 65), '50 of 65 matches shown — a narrower search finds the rest.');
  assert.equal(catalogCountText(50, 1234), '50 of 1,234 matches shown — a narrower search finds the rest.');
  assert.equal(catalogCountText(9, 9), undefined);
  assert.equal(catalogCountText(9, undefined), undefined);
});
