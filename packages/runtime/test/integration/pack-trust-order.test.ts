import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publisherKeyFile } from '@opcb/offline';
import type { OfflineStatus } from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';

/**
 * The pack settings send their changes over IPC without waiting for the last answer: the
 * operator adds publishers, flips "only trusted publishers" and removes a publisher in quick
 * succession. The window shows each answer as it arrives, and each `offline.changed` as it
 * comes; whichever it applied last has to be what the registry holds, or the switch shows on
 * while packs are being accepted from anyone (or the other way round).
 */
function trustOf(s: OfflineStatus): NonNullable<OfflineStatus['trust']> {
  assert.ok(s.trust, 'the status carries the trust settings');
  return s.trust;
}
const view = (s: OfflineStatus) => ({
  requireTrusted: trustOf(s).requireTrusted,
  publishers: trustOf(s)
    .publishers.map((p) => `${p.keyId}:${p.name}`)
    .sort(),
});

test('integration: pack trust changes sent together leave the window showing what the registry holds', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-trust-order-'));
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-trust-keys-'));
  try {
    const h = await startRuntime({ dataDir, providerInstances: [] });
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const keys = keysOf(round);
        // What the window would show: the last status it was handed, by answer or by event.
        let shown: OfflineStatus | undefined;
        const off = h.runtime.on('offline.changed', (s) => (shown = s));
        try {
          const files: string[] = [];
          for (const [i, key] of keys.entries()) {
            const file = path.join(keysDir, `r${round}-k${i}.worldpack-pub`);
            await fs.writeFile(file, publisherKeyFile(`Round ${round} key ${i}`, key));
            files.push(file);
          }
          h.host.openQueue.push(...files);
          const before = trustOf(await h.client.request('offline.status', undefined)).publishers;
          const work: Array<Promise<unknown>> = [];
          for (let i = 0; i < keys.length; i++) {
            work.push(h.client.request('offline.importPublisher', undefined).then((r) => (shown = r.status)));
            work.push(
              h.client
                .request('offline.setRequireTrusted', { required: (i + round) % 2 === 0 })
                .then((s) => (shown = s)),
            );
            const gone = before[i];
            if (gone)
              work.push(h.client.request('offline.removePublisher', { keyId: gone.keyId }).then((s) => (shown = s)));
          }
          await Promise.all(work);
          const held = await h.client.request('offline.status', undefined);
          assert.ok(shown, 'the window was handed a status');
          assert.deepEqual(view(shown), view(held), `round ${round}: the window shows what the registry holds`);
          // The last switch asked for is the one in force; this round's keys are the publishers
          // and the last round's are gone.
          assert.equal(trustOf(held).requireTrusted, (keys.length - 1 + round) % 2 === 0);
          assert.deepEqual(
            trustOf(held)
              .publishers.map((p) => p.name)
              .sort(),
            keys.map((_, i) => `Round ${round} key ${i}`).sort(),
          );
          // A change on its own answers with the state after it, not the one before.
          shown = await h.client.request('offline.setRequireTrusted', { required: !trustOf(held).requireTrusted });
          assert.equal(trustOf(shown).requireTrusted, !trustOf(held).requireTrusted);
          shown = await h.client.request('offline.setRequireTrusted', { required: trustOf(held).requireTrusted });
          assert.deepEqual(view(shown), view(held));
        } finally {
          off();
        }
      }
    } finally {
      await h.dispose();
    }
    // And the same after a restart.
    const again = await startRuntime({ dataDir, providerInstances: [] });
    try {
      const s = await again.client.request('offline.status', undefined);
      assert.equal(trustOf(s).publishers.length, KEYS);
      assert.ok(trustOf(s).publishers.every((p) => p.name.startsWith(`Round ${ROUNDS - 1} `)));
      assert.equal(trustOf(s).requireTrusted, (KEYS - 1 + ROUNDS - 1) % 2 === 0);
    } finally {
      await again.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(keysDir, { recursive: true, force: true });
  }
});

const ROUNDS = 3;
const KEYS = 8;
/** Eight keys of their own for each round. */
function keysOf(round: number): string[] {
  return Array.from({ length: KEYS }, (_, i) => Buffer.alloc(32, round * KEYS + i + 1).toString('base64'));
}
