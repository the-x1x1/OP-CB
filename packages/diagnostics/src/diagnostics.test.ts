import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiagnosticsSnapshot } from '@opcb/ipc-contract';
import {
  DiagnosticsCollector,
  buildBundle,
  readLogTail,
  redactStructure,
  redactValueDeep,
  exportBundle,
  fallbackSnapshot,
  redactPathsInText,
  scanText,
  todoReport,
  type DiagnosticsSources,
} from './index.js';

function sources(overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  const base = fallbackSnapshot(() => Date.parse('2026-09-21T10:00:00Z'));
  return {
    app: () => ({ ...base.app, version: '0.1.0-rc.1', channel: 'prerelease', commit: 'abc1234' }),
    runtime: () => ({ ...base.runtime, electron: '33.0.0', chrome: '130.0.0.0' }),
    providers: () => [],
    database: () => ({ status: 'ok', backend: 'duckdb', sizeBytes: 1024, partitions: 3 }),
    offline: () => base.offline,
    renderer: () => ({ active: '3D', webgl2: true, gpu: 'Test GPU' }),
    sidecars: () => [{ id: 'go2rtc', status: 'not-configured' }],
    updater: () => base.updater,
    disk: () => ({ dataDir: '/home/alice/.config/OP-CB', usedBytes: 4096, freeBytes: 1 }),
    logs: () => ({ path: '/home/alice/.config/OP-CB/logs/app.log', sizeBytes: 12 }),
    ...overrides,
  };
}

test('collector: assembles a snapshot from injected sources and degrades failing sources', async () => {
  const collector = new DiagnosticsCollector(
    sources({
      database: async () => {
        throw new Error('duckdb not loadable: /home/alice/x');
      },
    }),
  );
  const { snapshot, problems } = await collector.collect();
  assert.equal(snapshot.app.version, '0.1.0-rc.1');
  assert.equal(snapshot.renderer.active, '3D');
  assert.equal(snapshot.database.status, 'error');
  assert.deepEqual(
    problems.map((p) => p.source),
    ['database'],
  );
  const s2 = await collector.snapshot();
  assert.equal(s2.runtime.electron, '33.0.0');
});

test('bundle export: redacts secrets and user paths in snapshot, findings and log tail', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-diag-'));
  const logFile = path.join(dir, 'app.log');
  const lines = [
    JSON.stringify({
      ts: '2026-09-21T09:00:00Z',
      level: 'info',
      category: 'app',
      message: 'started',
      fields: { dataDir: '/home/alice/.config/OP-CB' },
    }),
    JSON.stringify({
      ts: '2026-09-21T09:00:01Z',
      level: 'warn',
      category: 'provider',
      message: 'fetch https://api.example/x?api_key=SHOULDNOTLEAK failed',
      fields: { url: 'https://user:pw@cam.local/stream' },
    }),
    'torn line without newline',
  ];
  await fs.writeFile(logFile, lines.join('\n'));
  const snapshot: DiagnosticsSnapshot = await new DiagnosticsCollector(sources()).snapshot();
  const { path: file, bundle } = await exportBundle(dir, {
    snapshot,
    logFile,
    homeDir: '/home/alice',
    now: () => Date.parse('2026-09-21T10:00:00Z'),
    findings: [
      {
        area: 'settings',
        message: 'reset from C:\\Users\\alice\\AppData\\Roaming\\OP-CB\\settings.json',
        token: 'abc',
      },
    ],
  });
  assert.equal(path.basename(file), 'opcb-diagnostics-2026-09-21T10-00-00-000Z.json');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('alice'), 'account name never appears in the bundle');
  assert.ok(!text.includes('SHOULDNOTLEAK'));
  assert.ok(!text.includes('user:pw@'));
  assert.equal(bundle.snapshot.disk.dataDir, '~/.config/OP-CB');
  assert.equal(bundle.logTail.length, 2, 'torn line skipped');
  assert.equal(bundle.logTailTruncated, false);
  assert.equal((bundle.findings[0] as { token: string }).token, '<redacted>');
  assert.equal(
    (bundle.findings[0] as { message: string }).message,
    'reset from ~\\AppData\\Roaming\\OP-CB\\settings.json',
  );
  assert.equal(bundle.redaction.homeDir, '~');
});

test('path redaction handles Windows, macOS and Linux user roots', () => {
  assert.equal(redactPathsInText('C:\\Users\\bob\\AppData', { homeDir: '/nonexistent' }), '~\\AppData');
  assert.equal(redactPathsInText('/Users/bob/Library', { homeDir: '/nonexistent' }), '~/Library');
  assert.equal(redactPathsInText('/home/bob/.config and /home/bob/x', { homeDir: '/home/bob' }), '~/.config and ~/x');
  assert.equal(redactPathsInText('no paths here', { homeDir: '/home/bob' }), 'no paths here');
});

test('todo report: finds markers in comments only, skips tests/fixtures/docs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-todo-'));
  await fs.mkdir(path.join(dir, 'packages', 'x', 'src', 'test'), { recursive: true });
  await fs.mkdir(path.join(dir, 'fixtures'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'packages', 'x', 'src', 'a.ts'),
    [
      'const t = process.env.TEMP; // read the temp dir',
      '// ' + 'TO' + 'DO: finish this',
      'export const TEMP = 1;',
      '/* HA' + 'CK around a bug */',
      'const PLACEHOLDER = "x"; // labelled PLACE' + 'HOLDER on purpose',
    ].join('\n'),
  );
  await fs.writeFile(path.join(dir, 'packages', 'x', 'src', 'a.test.ts'), '// TO' + 'DO in a test is fine');
  await fs.writeFile(path.join(dir, 'packages', 'x', 'src', 'test', 'plan.ts'), '// FIX' + 'ME in test dir is fine');
  await fs.writeFile(path.join(dir, 'fixtures', 'f.ts'), '// FIX' + 'ME in fixtures is fine');
  const report = await todoReport(dir);
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(
    report.entries.map((e) => `${e.line}:${e.tag}`),
    ['2:TODO', '4:HACK', '5:PLACEHOLDER'],
  );
  assert.equal(report.count, 3);
  assert.deepEqual(scanText('const x = a * TEMP_FACTOR;'), []);
});

test('todo report: the real production trees are clean', async () => {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const report = await todoReport(root);
  assert.ok(report.filesScanned > 20);
  assert.deepEqual(report.entries, [], JSON.stringify(report.entries, null, 2));
});

test('path redaction: the account folder in any letter case, with a space in the name, or with doubled backslashes', () => {
  const home = { homeDir: 'C:\\Users\\John Smith' };
  const cases: Array<[string, string]> = [
    ['C:\\Users\\John Smith\\AppData\\x.log', '~\\AppData\\x.log'],
    ['c:\\users\\john smith\\AppData\\x.log', '~\\AppData\\x.log'],
    ['C:/Users/John Smith/AppData', '~/AppData'],
    ['{"file":"C:\\\\Users\\\\John Smith\\\\a.json"}', '{"file":"~\\\\a.json"}'],
    ['C:\\Users\\Jane Doe\\Desktop\\a.kml', '~\\Desktop\\a.kml'],
    ['d:\\users\\jane doe\\a', '~\\a'],
    ['C:\\\\Users\\\\Jane Doe\\\\a', '~\\\\a'],
    ['C:\\Users\\JOHNSM~1\\a', '~\\a'],
    ['C:\\Documents and Settings\\Jane\\x', '~\\x'],
    ['file:///C:/Users/John%20Smith/a', 'file:///~/a'],
    ['two: C:\\Users\\a\\x and C:\\Users\\b\\y', 'two: ~\\x and ~\\y'],
  ];
  for (const [text, want] of cases) assert.equal(redactPathsInText(text, home), want, text);
  for (const text of cases.map((c) => c[0])) {
    const out = redactPathsInText(text, home).toLowerCase();
    for (const name of ['john', 'smith', 'jane', 'doe', 'johnsm']) assert.ok(!out.includes(name), `${name} in ${out}`);
  }
  // What is not an account folder is left alone.
  for (const text of ['C:\\Program Files\\OP-CB\\app.exe', 'C:\\Users', 'users of the app', '/usr/home', 'D:\\data\\x'])
    assert.equal(redactPathsInText(text, home), text, text);
  // A custom data folder given as an extra root goes too, in any case on Windows.
  assert.equal(
    redactPathsInText('wrote E:\\OPCB-Data\\history\\x', { ...home, extraRoots: ['E:\\opcb-data'] }),
    'wrote ~\\history\\x',
  );
});

test('redactStructure: values and keys, at any depth, without changing what it was given', () => {
  const home = { homeDir: '/home/alice' };
  const given = {
    files: { '/home/alice/maps/a.kml': { rows: 1 }, '/home/alice/maps/b.kml': { rows: 2 } },
    list: ['/home/alice/x', 5, null, { deep: [{ apiKey: 'SECRET', note: 'at /home/alice/y' }] }],
    url: 'https://user:pw@host/x?token=SECRET',
    missing: undefined,
    count: 3,
  };
  const before = JSON.stringify(given);
  const out = redactStructure(given, home);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('alice') && !text.includes('SECRET') && !text.includes('user:pw'), text);
  assert.deepEqual(Object.keys(out.files), ['~/maps/a.kml', '~/maps/b.kml']);
  assert.equal(out.count, 3);
  assert.equal('missing' in out, false);
  assert.equal(JSON.stringify(given), before);
  // Two keys that become the same text both stay.
  const collide = redactStructure({ '/home/alice': 1, '/home/bob': 2 }, home);
  assert.deepEqual(Object.values(collide).sort(), [1, 2]);
  // Things with no JSON at all, and a key named __proto__.
  assert.equal(redactStructure(undefined), undefined);
  assert.equal(redactStructure(null), null);
  assert.equal(redactStructure(7), 7);
  const odd = redactValueDeep(JSON.parse('{"__proto__":{"path":"/home/alice/z"},"a":1}'), home) as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(odd), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(odd)), { __proto__: { path: '~/z' }, a: 1 });
});

test('readLogTail: the last records of the file; a missing file, blank lines and torn lines are not errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcb-tail-'));
  const file = path.join(dir, 'app.log');
  assert.deepEqual(await readLogTail(file, 10), { records: [], truncated: false });
  const record = (n: number) =>
    JSON.stringify({ ts: '2026-09-21T09:00:00Z', level: 'info', category: 'app', message: `m${n}` });
  await fs.writeFile(
    file,
    [record(1), '', record(2), '   ', '{"no":"message"}', 'null', '5', record(3), '{"message":"to'].join('\n'),
  );
  const all = await readLogTail(file, 100);
  assert.deepEqual(
    all.records.map((r) => r.message),
    ['m1', 'm2', 'm3'],
  );
  assert.equal(all.truncated, false);
  const last = await readLogTail(file, 2);
  assert.deepEqual(
    last.records.map((r) => r.message),
    ['m3'],
    'the last two lines: one record and the torn line',
  );
  assert.equal(last.truncated, true);
  await fs.writeFile(file, '');
  assert.deepEqual(await readLogTail(file, 10), { records: [], truncated: false });
});

test('buildBundle: the format, the time, and everything in it redacted', async () => {
  const snapshot: DiagnosticsSnapshot = await new DiagnosticsCollector(sources()).snapshot();
  const bundle = buildBundle(
    {
      snapshot,
      homeDir: '/home/alice',
      now: () => Date.parse('2026-09-21T10:00:00Z'),
      findings: [{ at: '/home/alice/x' }],
    },
    {
      records: [
        { ts: '2026-09-21T09:00:00Z', level: 'info', category: 'app', message: 'read /home/alice/settings.json' },
      ],
      truncated: true,
    },
  );
  assert.equal(bundle.format, 'opcb/diagnostics-bundle/v1');
  assert.equal(bundle.exportedAt, '2026-09-21T10:00:00.000Z');
  assert.deepEqual(bundle.redaction, { secrets: true, userPaths: true, homeDir: '~' });
  assert.equal(bundle.logTailTruncated, true);
  assert.equal(bundle.logTail[0]!.message, 'read ~/settings.json');
  assert.deepEqual(bundle.findings, [{ at: '~/x' }]);
  assert.ok(!JSON.stringify(bundle).includes('alice'));
  assert.deepEqual(buildBundle({ snapshot }, { records: [], truncated: false }).findings, []);
});
