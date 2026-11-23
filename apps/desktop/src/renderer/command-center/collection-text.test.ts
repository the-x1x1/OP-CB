import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_CHOICES, FREE_MARGIN_BYTES, budgetBytes, useText } from './collection-text.js';

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
