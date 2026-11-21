import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRuntime } from '../helpers/harness.js';

/**
 * A file chosen in the save dialog that cannot be written: a folder's name, a folder that is
 * gone, or (on Windows, often) a CSV still open in a spreadsheet. The operator is told the file
 * could not be written and why, in words the window shows; a plain error reached the window as
 * "internal error (details are in the application log)".
 */
const at = '2026-09-21T00:00:00.000Z';

test('integration: an export to a file that cannot be written says so, for every export', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-export-fail-'));
  try {
    const h = await startRuntime({ dataDir, providerInstances: [] });
    try {
      await h.client.request('collections.save', {
        id: 'c1',
        name: 'Places',
        createdAt: at,
        updatedAt: at,
        items: [
          {
            kind: 'location',
            id: 'p1',
            name: 'Here',
            position: { latitude: 21.3, longitude: -157.8 },
            addedAt: at,
          },
        ],
      } as never);
      await h.client.request('prep.save', {
        id: 'water',
        kind: 'item',
        category: 'water',
        name: 'Water',
        updatedAt: at,
      } as never);
      const unwritable = [dataDir, path.join(dataDir, 'gone', 'out.file')];
      const exports: Array<[string, () => Promise<unknown>]> = [
        ['collections.export', () => h.client.request('collections.export', { id: 'c1', format: 'geojson' })],
        ['watchzones.export', () => h.client.request('watchzones.export', { format: 'kml' })],
        ['prep.export', () => h.client.request('prep.export', { format: 'csv' })],
        [
          'export.objects',
          () => h.client.request('export.objects', { query: { objectTypes: ['earthquake'] }, format: 'csv' }),
        ],
        [
          'export.line',
          () =>
            h.client.request('export.line', {
              points: [
                { latitude: 21, longitude: -157 },
                { latitude: 22, longitude: -158 },
              ],
              format: 'gpx',
            }),
        ],
      ];
      for (const [name, run] of exports)
        for (const target of unwritable) {
          h.host.saveQueue.push(target);
          await assert.rejects(
            run(),
            (err: unknown) => {
              assert.equal(
                typeof (err as { ipcCode?: unknown }).ipcCode,
                'string',
                `${name}: an error the window shows`,
              );
              assert.match((err as Error).message, /could not be written/, name);
              return true;
            },
            `${name} → ${path.basename(target)}`,
          );
        }
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('unwritable: each failure of the chosen file is named', async () => {
  const { unwritable } = await import('../../src/handlers.js');
  const named = (code?: string) => unwritable(Object.assign(new Error('x'), code ? { code } : {})).message;
  assert.match(named('EBUSY'), /another program has the file open/);
  assert.match(named('EPERM'), /may not write there/);
  assert.match(named('EACCES'), /may not write there/);
  assert.match(named('ENOSPC'), /the drive is full/);
  assert.match(named('EROFS'), /read-only/);
  assert.match(named('EMFILE'), /EMFILE/);
  assert.match(named(), /unknown error/);
  assert.equal(unwritable(new Error('x')).ipcCode, 'UNAVAILABLE');
});
