import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATIC_EXTERNAL_HOSTS } from '../../src/main/external-links.js';
import { GUIDES } from '../../src/renderer/command-center/guides/index.js';
import { runCheck } from '../../src/renderer/command-center/checks.js';

/**
 * The walkthroughs are data: these hold each one to the engine's rules, so a guide that would
 * strand the operator (a final step with nothing to test, a link the app would refuse to open)
 * fails here rather than on a screen.
 */
test('every guide: unique ids, five questions answered, exactly one final test with a check', () => {
  const ids = new Set<string>();
  for (const g of GUIDES) {
    assert.ok(!ids.has(g.id), `duplicate guide ${g.id}`);
    ids.add(g.id);
    assert.match(g.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(g.version >= 1);
    assert.ok(g.whatItDoes.length > 40, `${g.id}: what does it do`);
    assert.ok(g.steps.length >= 2, `${g.id}: how to set it up`);
    const steps = new Set<string>();
    for (const s of g.steps) {
      assert.ok(!steps.has(s.id), `${g.id}: duplicate step ${s.id}`);
      steps.add(s.id);
      assert.match(s.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
      assert.ok(s.body.length > 0, `${g.id}/${s.id}: no words`);
      if (s.choiceFrom)
        assert.ok(
          g.steps.some((x) => x.id === s.choiceFrom && x.choice),
          `${g.id}/${s.id}: choiceFrom`,
        );
      if (s.byChoice) {
        const from = g.steps.find((x) => x.id === (s.choiceFrom ?? s.id))!;
        for (const k of Object.keys(s.byChoice))
          assert.ok(
            from.choice?.options.some((o) => o.id === k),
            `${g.id}/${s.id}: byChoice ${k} is not an option`,
          );
      }
    }
    const finals = g.steps.filter((s) => s.final);
    assert.equal(finals.length, 1, `${g.id}: one final test`);
    assert.ok(finals[0]!.check, `${g.id}: the final test checks something`);
  }
});

test('every guide link is https on a host the app will open', () => {
  for (const g of GUIDES)
    for (const s of g.steps)
      for (const l of s.links ?? []) {
        const u = new URL(l.url);
        assert.equal(u.protocol, 'https:', l.url);
        assert.ok(STATIC_EXTERNAL_HOSTS.includes(u.hostname), `${g.id}/${s.id}: ${u.hostname} is not allowed`);
      }
});

test('every check a guide names answers (no check throws on empty data)', () => {
  for (const g of GUIDES)
    for (const s of g.steps)
      if (s.check) {
        const r = runCheck(s.check, {
          nowMs: 0,
          mode: null,
          offline: null,
          sources: [],
          services: null,
          aiModel: undefined,
          prep: [],
        });
        assert.notEqual(r.status, 'pass', `${g.id}/${s.id}: ${s.check} passed on no evidence`);
      }
});
