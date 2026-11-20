import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTabIndex } from './tabs.js';

const tabs = (pattern: string) => [...pattern].map((c) => ({ disabled: c === 'x' }));

test('nextTabIndex: the next enabled tab in a direction, wrapping round, skipping disabled ones', () => {
  assert.equal(nextTabIndex(tabs('ooo'), 0, 1), 1);
  assert.equal(nextTabIndex(tabs('ooo'), 2, 1), 0);
  assert.equal(nextTabIndex(tabs('ooo'), 0, -1), 2);
  assert.equal(nextTabIndex(tabs('oxo'), 0, 1), 2);
  assert.equal(nextTabIndex(tabs('oxo'), 2, -1), 0);
  assert.equal(nextTabIndex(tabs('xxo'), 2, 1), 2, 'the only enabled tab leads back to itself');
  assert.equal(nextTabIndex(tabs('o'), 0, 1), 0);
});

test('nextTabIndex: no tabs is -1; all disabled stays where it was', () => {
  assert.equal(nextTabIndex([], 0, 1), -1);
  assert.equal(nextTabIndex(tabs('xxx'), 1, 1), 1);
  assert.equal(nextTabIndex(tabs('xxx'), 1, -1), 1);
});

test('nextTabIndex: from every tab, going one way and back the other returns to an enabled start', () => {
  for (const pattern of ['ooooo', 'oxoxo', 'xooxo', 'oxxxx', 'ooxoo']) {
    const items = tabs(pattern);
    items.forEach((item, from) => {
      if (item.disabled) return;
      const there = nextTabIndex(items, from, 1);
      assert.equal(items[there]!.disabled, false);
      assert.equal(nextTabIndex(items, there, -1), from, `${pattern} from ${from}`);
    });
  }
});
