import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { portableZipProblems, zipEntryNames } from './zip-names.js';
import { storedZip } from './stored-zip.js';

test('zip names: every entry name from the central directory, with a trailing comment, nothing inflated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opcb-zip-'));
  try {
    const file = path.join(dir, 'a.zip');
    writeFileSync(
      file,
      storedZip(
        [
          { name: 'OP-CB.exe', data: 'MZ' },
          { name: 'resources/app.asar', data: 'x'.repeat(1000) },
          { name: 'OP-CB-data/' },
          { name: 'OP-CB-data/READ-ME.txt', data: 'note' },
        ],
        'a comment after the end record',
      ),
    );
    assert.deepEqual(zipEntryNames(file), ['OP-CB.exe', 'resources/app.asar', 'OP-CB-data/', 'OP-CB-data/READ-ME.txt']);
    writeFileSync(file, 'not a zip at all, just text long enough to search through');
    assert.throws(() => zipEntryNames(file), /not a zip file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zip names: the portable zip must hold the exe at its root and the data folder beside it', () => {
  assert.deepEqual(portableZipProblems(['OP-CB.exe', 'resources/app.asar', 'OP-CB-data/READ-ME.txt']), []);
  assert.deepEqual(
    portableZipProblems(['OP-CB.exe', 'OP-CB-data\\READ-ME.txt']),
    [],
    'backslashes as 7-Zip on Windows lists them',
  );
  assert.deepEqual(portableZipProblems(['OP-CB.exe', 'resources/app.asar']), [
    'OP-CB-data/READ-ME.txt is not in the zip: the copy would not be portable as unzipped',
  ]);
  assert.deepEqual(portableZipProblems(['win-unpacked/OP-CB.exe', 'win-unpacked/OP-CB-data/READ-ME.txt']), [
    'OP-CB.exe is at win-unpacked/OP-CB.exe, not at the root of the zip',
    'OP-CB-data/READ-ME.txt is not in the zip: the copy would not be portable as unzipped',
  ]);
  assert.match(portableZipProblems([])[0]!, /not in the zip \(0 entries\)/);
});
