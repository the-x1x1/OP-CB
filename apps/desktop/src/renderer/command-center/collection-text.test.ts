import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_CHOICES,
  FREE_MARGIN_BYTES,
  budgetBytes,
  planSummary,
  shareMinutesText,
  shareUntilText,
  useText,
} from './collection-text.js';

test('budgetBytes: a sized drive keeps a tenth back; free space keeps a margin', () => {
  assert.equal(budgetBytes('256', undefined), 230_400_000_000);
  assert.equal(budgetBytes('2000', 5), 1_800_000_000_000);
  assert.equal(budgetBytes('free', 10 * 1024 ** 3), 10 * 1024 ** 3 - FREE_MARGIN_BYTES);
  assert.equal(budgetBytes('free', 1), 0);
  assert.equal(budgetBytes('free', undefined), undefined);
  assert.equal(budgetBytes('free', NaN), undefined);
  for (const c of BUDGET_CHOICES) if (c.id !== 'free') assert.ok(budgetBytes(c.id, undefined)! > 0, c.id);
  // Larger drives, larger budgets.
  const sized = BUDGET_CHOICES.filter((c) => c.id !== 'free').map((c) => budgetBytes(c.id, undefined)!);
  assert.deepEqual(
    sized,
    [...sized].sort((a, b) => a - b),
  );
});

test('useText: share of the budget, capped at 100%; no budget is no room', () => {
  const t = (n: number) => `${n}B`;
  assert.equal(useText(25, 100, t), '25B of 100B (25%)');
  assert.equal(useText(150, 100, t), '150B of 100B (100%)');
  assert.equal(useText(0, 0, t), 'no room');
});

test('planSummary: says why nothing is planned', () => {
  const t = (n: number) => `${Math.round(n / 1e6)} MB`;
  const base = {
    picks: [] as unknown[],
    have: [] as string[],
    tooBig: [] as unknown[],
    missing: [] as unknown[],
    bytes: 0,
  };
  // No room at all: the margin, not each book, is the reason; the "too big" list is not shown.
  const none = planSummary({ ...base, tooBig: [1, 2], budgetBytes: 0 }, 'free', t);
  assert.match(none.line, /^No room: this drive has less than 2000 MB free/);
  assert.equal(none.listTooBig, false);
  assert.equal(planSummary({ ...base, budgetBytes: 0 }, '32', t).line, 'No room.');
  assert.deepEqual(planSummary({ ...base, picks: [1, 2], bytes: 25e6, budgetBytes: 100e6 }, 'free', t), {
    line: '2 books, 25 MB of 100 MB (25%).',
    listTooBig: true,
  });
  assert.equal(
    planSummary({ ...base, tooBig: [1], budgetBytes: 5 }, 'free', t).line,
    'Nothing left to fetch fits in this room.',
  );
  assert.equal(
    planSummary({ ...base, have: ['a'], budgetBytes: 5 }, 'free', t).line,
    'Everything chosen is already in the library.',
  );
  assert.equal(
    planSummary({ ...base, missing: [1], budgetBytes: 5 }, 'free', t).line,
    'Nothing chosen is in the catalogue now.',
  );
  assert.equal(planSummary({ ...base, budgetBytes: 5 }, 'free', t).line, 'Nothing to fetch.');
});

test('share words: lengths and the end time', () => {
  assert.equal(shareMinutesText(30), '30 minutes');
  assert.equal(shareMinutesText(60), '1 hour');
  assert.equal(shareMinutesText(120), '2 hours');
  assert.equal(shareMinutesText(90), '1.5 hours');
  assert.match(shareUntilText('2026-11-22T21:30:00.000Z'), /^Until \d{2}:\d{2}$/);
  assert.equal(shareUntilText(undefined), 'Until it is stopped');
  assert.equal(shareUntilText('not a time'), 'Until it is stopped');
});
