import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GuideProgress, PrepRecord } from '@opcb/ipc-contract';
import { startRuntime } from '../helpers/harness.js';

const at = '2026-09-21T08:05:00.000Z';

test('mode: chosen, remembered across a restart, approved hosts kept', async () => {
  const h = await startRuntime();
  try {
    const first = await h.client.request('mode.state', undefined);
    assert.equal(first.remembered, null, 'never chosen: nothing to offer first');
    assert.equal(first.enforcement, 'app');
    await h.client.request('settings.set', { network: { workOffline: false, localHosts: ['192.168.1.20'] } });
    const off = await h.client.request('mode.choose', { mode: 'offline' });
    assert.equal(off.chosen, 'offline');
    assert.equal(off.remembered, 'offline');
    assert.deepEqual(off.localHosts, ['192.168.1.20']);
    const settings = await h.client.request('settings.get', undefined);
    assert.equal(settings.network?.workOffline, true);
    assert.equal(settings.network?.chosenAt, at);
    const on = await h.client.request('mode.choose', { mode: 'online' });
    assert.equal(on.chosen, 'online');
    assert.equal((await h.client.request('settings.get', undefined)).network?.workOffline, false);
  } finally {
    await h.runtime.stop();
  }
  // A second start on the same folder remembers the last choice.
  const again = await startRuntime({ dataDir: h.dataDir });
  try {
    assert.equal((await again.client.request('mode.state', undefined)).remembered, 'online');
  } finally {
    await again.dispose();
    await fs.rm(h.dataDir, { recursive: true, force: true });
  }
});

test('settings refuse a public host, a range or a metadata address as an approved local host', async () => {
  const h = await startRuntime();
  try {
    for (const bad of ['example.com', '8.8.8.8', '192.168.1.0/24', '169.254.169.254'])
      await assert.rejects(
        h.client.request('settings.set', { network: { workOffline: true, localHosts: [bad] } }),
        () => true,
        bad,
      );
  } finally {
    await h.dispose();
  }
});

test('guides: progress saved, read back after a restart, reset; a malformed record refused', async () => {
  const h = await startRuntime();
  const progress: GuideProgress = {
    id: 'meshtastic',
    guideVersion: 1,
    currentStepId: 'connect',
    steps: { intro: { outcome: 'done', at }, equipment: { outcome: 'done', at, choice: 't-beam' } },
    startedAt: at,
    updatedAt: at,
  };
  try {
    assert.deepEqual(await h.client.request('guides.save', progress), [progress]);
    await assert.rejects(
      h.client.request('guides.save', {
        ...progress,
        steps: { x: { outcome: 'great', at } },
      } as unknown as GuideProgress),
    );
    const file = JSON.parse(await fs.readFile(path.join(h.dataDir, 'guides.json'), 'utf8')) as { items: unknown[] };
    assert.equal(file.items.length, 1);
  } finally {
    await h.runtime.stop();
  }
  const again = await startRuntime({ dataDir: h.dataDir });
  try {
    assert.deepEqual(await again.client.request('guides.list', undefined), [progress]);
    assert.deepEqual(await again.client.request('guides.reset', { id: 'meshtastic' }), []);
  } finally {
    await again.dispose();
    await fs.rm(h.dataDir, { recursive: true, force: true });
  }
});

test('preparedness: records saved locally; the checklist export writes only where the operator chose', async () => {
  const h = await startRuntime();
  const water: PrepRecord = {
    id: 'water-1',
    kind: 'item',
    category: 'water',
    name: 'Bottled water',
    quantity: 24,
    unit: 'L',
    expires: '2027-06-01',
    updatedAt: at,
  };
  const contact: PrepRecord = {
    id: 'contact-1',
    kind: 'contact',
    category: 'other',
    name: '=HYPERLINK("x")',
    phone: '555-0100',
    notes: 'Neighbour, has a key',
    updatedAt: at,
  };
  try {
    await h.client.request('prep.save', water);
    const list = await h.client.request('prep.save', contact);
    assert.equal(list.length, 2);
    assert.deepEqual(await h.client.request('prep.export', { format: 'csv' }), { cancelled: true });
    const out = path.join(h.dataDir, 'checklist.csv');
    h.host.saveQueue.push(out);
    assert.deepEqual(await h.client.request('prep.export', { format: 'csv' }), { path: out, records: 2 });
    const csv = await fs.readFile(out, 'utf8');
    const lines = csv.trim().split('\n');
    assert.equal(lines[0], 'checked,kind,category,name,quantity,unit,expires,checkedOn,checkEveryDays,phone,notes');
    assert.ok(lines.includes(',item,water,Bottled water,24,L,2027-06-01,,,,'));
    // A name a spreadsheet would run as a formula is written as text.
    assert.ok(
      lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)),
      csv,
    );
    assert.deepEqual(await h.client.request('prep.delete', { id: 'water-1' }), [contact]);
  } finally {
    await h.dispose();
  }
});
