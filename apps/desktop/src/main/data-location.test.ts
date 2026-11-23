import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MARKER_FILE,
  POINTER_FILE,
  PORTABLE_DIR_NAME,
  moveDataTo,
  resolveDataLocation,
  backToUsualData,
} from './data-location.js';

// Every folder made here is removed when the file's tests end (left behind, each run added
// to the system's temporary folder).
const madeDirs: string[] = [];
after(async () => {
  for (const dir of madeDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wv-data-'));
  madeDirs.push(dir);
  return dir;
}

test('data location: usual by default; an OP-CB-data folder beside the app wins; never in development', async () => {
  const usual = await tmp();
  const exeDir = await tmp();
  assert.deepEqual(resolveDataLocation({ usualRoot: usual, exeDir, dev: false }), {
    root: usual,
    kind: 'usual',
    usualRoot: usual,
  });
  await fs.mkdir(path.join(exeDir, PORTABLE_DIR_NAME));
  const portable = resolveDataLocation({ usualRoot: usual, exeDir, dev: false });
  assert.equal(portable.kind, 'portable');
  assert.equal(portable.root, path.join(exeDir, PORTABLE_DIR_NAME));
  assert.equal(resolveDataLocation({ usualRoot: usual, exeDir, dev: true }).kind, 'usual');
});

test('moving: the small files are carried, the drive marked, the pointer written; an unplugged drive is never used', async () => {
  const usual = await tmp();
  const exeDir = await tmp();
  await fs.writeFile(path.join(usual, 'settings.json'), '{"schemaVersion":8}');
  await fs.writeFile(path.join(usual, 'collections.json'), '{"version":1,"items":[]}');
  await fs.mkdir(path.join(usual, 'history'));
  const drive = path.join(await tmp(), 'OP-CB');
  const r = await moveDataTo(drive, usual, usual);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.carried, ['settings.json', 'collections.json']);
  assert.equal(r.adopted, false);
  assert.ok((await fs.readdir(drive)).includes(MARKER_FILE));
  assert.ok(!(await fs.readdir(drive)).includes('history'), 'history stays where it was');
  const moved = resolveDataLocation({ usualRoot: usual, exeDir, dev: false });
  assert.deepEqual([moved.kind, moved.root], ['moved', drive]);

  // The drive is out: its mount point is an empty folder. Not used, and said why.
  await fs.rm(drive, { recursive: true });
  await fs.mkdir(drive);
  const out = resolveDataLocation({ usualRoot: usual, exeDir, dev: false });
  assert.equal(out.kind, 'usual');
  assert.equal(out.root, usual);
  assert.match(out.missing?.reason ?? '', /not the one OP-CB marked/);
  await fs.rm(drive, { recursive: true });
  assert.match(resolveDataLocation({ usualRoot: usual, exeDir, dev: false }).missing?.reason ?? '', /not there/);

  assert.deepEqual(await backToUsualData(usual), { ok: true });
  assert.ok(!(await fs.readdir(usual)).includes(POINTER_FILE));
  assert.deepEqual(await backToUsualData(usual), { ok: true }, 'no pointer: nothing to remove');
  assert.equal(resolveDataLocation({ usualRoot: usual, exeDir, dev: false }).missing, undefined);
});

test('moving: a folder OP-CB already uses is adopted as it is; anything else non-empty is refused', async () => {
  const usual = await tmp();
  const used = await tmp();
  await fs.writeFile(path.join(used, MARKER_FILE), '{"kind":"opcb-data"}');
  await fs.writeFile(path.join(used, 'settings.json'), '{"from":"the drive"}');
  await fs.writeFile(path.join(usual, 'settings.json'), '{"from":"this computer"}');
  const r = await moveDataTo(used, usual, usual);
  assert.ok(r.ok && r.adopted);
  assert.equal(
    await fs.readFile(path.join(used, 'settings.json'), 'utf8'),
    '{"from":"the drive"}',
    'nothing overwritten',
  );
  const other = await tmp();
  await fs.writeFile(path.join(other, 'photo.jpg'), 'x');
  const refused = await moveDataTo(other, usual, usual);
  assert.equal(refused.ok, false);
  assert.equal((await moveDataTo(path.join(usual, 'inside'), usual, usual)).ok, false, 'not inside the data folder');
  assert.equal((await moveDataTo('relative/path', usual, usual)).ok, false);
});

test('moving: a file that is there but cannot be copied stops the move; nothing is pointed at', async () => {
  const usual = await tmp();
  await fs.writeFile(path.join(usual, 'credentials.json'), '{"version":1}');
  // settings.json there, but not a file that copies (a full drive or a refused read does the
  // same): the move used to go on without it, and the next start found no settings.
  await fs.mkdir(path.join(usual, 'settings.json'));
  const drive = path.join(await tmp(), 'OP-CB');
  const r = await moveDataTo(drive, usual, usual);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /settings\.json could not be copied/);
  assert.ok(!(await fs.readdir(usual)).includes(POINTER_FILE), 'no pointer: the next start uses the usual folder');
  assert.deepEqual(await fs.readdir(drive), [], 'and the chosen folder is left empty, so it can be chosen again');
});

test('back to the usual folder: a pointer that cannot be removed is said, not answered as done', async () => {
  const usual = await tmp();
  // A folder where the pointer goes: removed without "recursive" it fails, as a held file does.
  await fs.mkdir(path.join(usual, POINTER_FILE));
  await fs.writeFile(path.join(usual, POINTER_FILE, 'x'), 'x');
  const back = await backToUsualData(usual);
  assert.equal(back.ok, false);
  assert.match(
    !back.ok ? back.reason : '',
    /data-location\.json in .* could not be removed \([A-Z_]+\); nothing was changed/,
  );
  assert.ok((await fs.readdir(usual)).includes(POINTER_FILE), 'left as it was');
});

test('moving: a pointer that cannot be written is said; the folder made ready is taken as it is when chosen again', async () => {
  const usual = await tmp();
  const drive = path.join(await tmp(), 'drive');
  await fs.writeFile(path.join(usual, 'settings.json'), '{"from":"this computer"}');
  // Where the pointer goes, a folder: written over it fails, as a held file does.
  await fs.mkdir(path.join(usual, POINTER_FILE));
  const r = await moveDataTo(drive, usual, usual);
  assert.equal(r.ok, false);
  assert.match(
    !r.ok ? r.reason : '',
    /data-location\.json in .* could not be written \([A-Z_]+\); OP-CB stays where it is/,
  );
  assert.equal(resolveDataLocation({ usualRoot: usual, exeDir: await tmp(), dev: false }).kind, 'usual');
  await fs.rm(path.join(usual, POINTER_FILE), { recursive: true });
  const again = await moveDataTo(drive, usual, usual);
  assert.ok(again.ok && again.adopted, 'chosen again, the ready folder is used');
  assert.equal(await fs.readFile(path.join(drive, 'settings.json'), 'utf8'), '{"from":"this computer"}');
});

test("moving: each source's settings and the operator's own source definitions come along", async () => {
  const usual = await tmp();
  await fs.writeFile(path.join(usual, 'settings.json'), '{"schemaVersion":8}');
  await fs.writeFile(
    path.join(usual, 'provider-settings.json'),
    '{"version":1,"providers":{"ha":{"host":"ha.local"}}}',
  );
  await fs.mkdir(path.join(usual, 'connectors', 'nested'), { recursive: true });
  await fs.writeFile(path.join(usual, 'connectors', 'my-bikes.json'), '{"id":"my-bikes"}');
  await fs.writeFile(path.join(usual, 'connectors', 'nested', 'x.json'), '{}');
  const drive = path.join(await tmp(), 'OP-CB');
  const r = await moveDataTo(drive, usual, usual);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.carried, ['settings.json', 'provider-settings.json', 'connectors']);
  assert.equal(
    await fs.readFile(path.join(drive, 'provider-settings.json'), 'utf8'),
    '{"version":1,"providers":{"ha":{"host":"ha.local"}}}',
  );
  assert.equal(await fs.readFile(path.join(drive, 'connectors', 'my-bikes.json'), 'utf8'), '{"id":"my-bikes"}');
  assert.equal(await fs.readFile(path.join(drive, 'connectors', 'nested', 'x.json'), 'utf8'), '{}');
  assert.equal(
    await fs.readFile(path.join(usual, 'connectors', 'my-bikes.json'), 'utf8'),
    '{"id":"my-bikes"}',
    'copied, not moved',
  );

  // No connectors folder: nothing to carry, and no error.
  const plain = await tmp();
  await fs.writeFile(path.join(plain, 'settings.json'), '{}');
  const r2 = await moveDataTo(path.join(await tmp(), 'OP-CB'), plain, plain);
  assert.ok(r2.ok && r2.carried.join() === 'settings.json');
});
