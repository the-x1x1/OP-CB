import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isAcceptableUpdate, parseVersion } from './policy.js';

/**
 * Version precedence decides whether an offered build is installed. Over every pair and
 * triple of a list of awkward versions it must be an order (the same both ways round, and
 * through a third), a number every time, and never call something an update that is not
 * strictly newer.
 */
const VERSIONS = [
  '0.0.0',
  '0.7.4',
  '0.7.5',
  '0.7.10',
  '0.10.0',
  '1.0.0',
  '1.0.0-alpha',
  '1.0.0-alpha.1',
  '1.0.0-alpha.beta',
  '1.0.0-beta',
  '1.0.0-beta.2',
  '1.0.0-beta.11',
  '1.0.0-rc.1',
  '1.0.0-0',
  '1.0.0-1',
  '1.0.0-a.b.c.d.e',
  '1.0.0+build.5',
  '1.0.0-rc.1+build.5',
  '2.0.0',
  '10.0.0',
  '999999999999999999999999.0.0',
  `${'9'.repeat(400)}.0.0`,
  `${'9'.repeat(400)}.1.0`,
  ' 1.0.0 ',
  'v1.0.0',
  '1.0',
  '1',
  '',
  'latest',
  '1.0.0-',
  '01.0.0',
  '1.0.0.0',
  '-1.0.0',
  'constructor',
];

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

test('version precedence is an order over awkward versions, and a number every time', () => {
  const problems: string[] = [];
  for (const a of VERSIONS)
    for (const b of VERSIONS) {
      const ab = compareVersions(a, b);
      if (Number.isNaN(ab)) problems.push(`${JSON.stringify(a)} against ${JSON.stringify(b)} is not a number`);
      if (sign(ab) !== -sign(compareVersions(b, a)))
        problems.push(`${JSON.stringify(a)} against ${JSON.stringify(b)} disagrees with itself`);
      // Among versions that parse, the order carries through a third.
      if (parseVersion(a) && parseVersion(b))
        for (const c of VERSIONS)
          if (parseVersion(c) && ab <= 0 && compareVersions(b, c) <= 0 && compareVersions(a, c) > 0)
            problems.push(`${a} ≤ ${b} ≤ ${c} yet ${a} > ${c}`);
    }
  assert.deepEqual(problems.slice(0, 8), []);
});

test('nothing is an update unless it is strictly newer, whatever is offered', () => {
  for (const current of VERSIONS.filter((v) => parseVersion(v)))
    for (const offered of VERSIONS) {
      const verdict = isAcceptableUpdate(current, offered, { allowPrerelease: true });
      if (!verdict.ok) continue;
      assert.ok(parseVersion(offered), `${JSON.stringify(offered)} does not parse and was accepted over ${current}`);
      assert.ok(compareVersions(offered, current) > 0, `${offered} accepted over ${current}`);
      assert.equal(
        isAcceptableUpdate(offered, current, { allowPrerelease: true }).ok,
        false,
        `and ${current} over ${offered} too`,
      );
    }
  // A build never updates to itself, and a prerelease is refused off its channel.
  assert.equal(isAcceptableUpdate('0.7.5', '0.7.5', { allowPrerelease: true }).ok, false);
  assert.equal(isAcceptableUpdate('0.7.5', '0.8.0-rc.1', { allowPrerelease: false }).ok, false);
  assert.equal(isAcceptableUpdate('0.7.5', '0.8.0-rc.1', { allowPrerelease: true }).ok, true);
  assert.equal(isAcceptableUpdate('0.7.5', '0.7.10', { allowPrerelease: false }).ok, true);
});
