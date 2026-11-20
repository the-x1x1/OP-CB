import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Collection, PrepRecord } from '@opcb/ipc-contract';
import { importedCollection, modeState, prepCsv, readLibraryOpen, readMapDownloadRequest } from './handlers.js';
import { InvalidRequestError } from './validate.js';
import { parseCsvRows } from '@opcb/connector-runtime';

const T = '2026-11-19T10:00:00.000Z';

test('readLibraryOpen: a book, a reference or the folder, with nothing else in the request', () => {
  const bookId = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(readLibraryOpen({ kind: 'folder' }), { kind: 'folder' });
  assert.deepEqual(readLibraryOpen({ kind: 'reference', id: 'first-aid' }), { kind: 'reference', id: 'first-aid' });
  assert.deepEqual(readLibraryOpen({ kind: 'book', bookId }), { kind: 'book', bookId });
  assert.deepEqual(readLibraryOpen({ kind: 'book', bookId, key: 'A/Water' }), { kind: 'book', bookId, key: 'A/Water' });
  for (const bad of [
    null,
    'folder',
    {},
    { kind: 'folder', path: 'C:\\' },
    { kind: 'reference' },
    { kind: 'reference', id: '../x' },
    { kind: 'reference', id: 'ok', extra: 1 },
    { kind: 'book' },
    { kind: 'book', bookId: bookId.toUpperCase() },
    { kind: 'book', bookId: bookId.slice(1) },
    { kind: 'book', bookId, key: 5 },
    { kind: 'book', bookId, key: 'a\0b' },
    { kind: 'book', bookId, key: 'k'.repeat(2001) },
    { kind: 'book', bookId, path: 'x' },
    { kind: 'file', path: '/etc/passwd' },
  ])
    assert.throws(
      () => readLibraryOpen(bad),
      (e: unknown) => e instanceof InvalidRequestError && e.ipcCode === 'INVALID_REQUEST',
      JSON.stringify(bad),
    );
});

test('readMapDownloadRequest: the request, or what is wrong with it in words', () => {
  const bounds = { west: -161, south: 18, east: -154, north: 23 };
  const base = { kind: 'extract', worldMaxZoom: 5, maxZoom: 12 };
  assert.deepEqual(readMapDownloadRequest(base), base);
  assert.deepEqual(readMapDownloadRequest({ ...base, kind: 'planet', junk: 1 }), { ...base, kind: 'planet' });
  const vaultId = 'ab'.repeat(16);
  assert.deepEqual(readMapDownloadRequest({ ...base, bounds: { ...bounds, junk: 1 }, name: 'Hawaii', vaultId }), {
    ...base,
    bounds,
    name: 'Hawaii',
    vaultId,
  });
  assert.deepEqual(readMapDownloadRequest({ ...base, worldMaxZoom: 0, maxZoom: 15 }), {
    ...base,
    worldMaxZoom: 0,
    maxZoom: 15,
  });
  const problems: Array<[unknown, RegExp]> = [
    [null, /not a map download request/],
    ['extract', /not a map download request/],
    [{ ...base, kind: 'region' }, /kind must be/],
    [{ ...base, maxZoom: 16 }, /zooms/],
    [{ ...base, worldMaxZoom: -1 }, /zooms/],
    [{ ...base, maxZoom: 7.5 }, /zooms/],
    [{ ...base, maxZoom: '7' }, /zooms/],
    [{ kind: 'extract', maxZoom: 7 }, /zooms/],
    [{ ...base, bounds: null }, /bounds are degrees/],
    [{ ...base, bounds: 'hawaii' }, /bounds are degrees/],
    [{ ...base, bounds: { ...bounds, west: -181 } }, /bounds are degrees/],
    [{ ...base, bounds: { ...bounds, north: 90.5 } }, /bounds are degrees/],
    [{ ...base, bounds: { ...bounds, south: Number.NaN } }, /bounds are degrees/],
    [{ ...base, bounds: { ...bounds, east: '1' } }, /bounds are degrees/],
    [{ ...base, bounds: { west: 1, south: 1, east: 2 } }, /bounds are degrees/],
    [{ ...base, name: 'n'.repeat(61) }, /60 characters/],
    [{ ...base, name: 5 }, /60 characters/],
    [{ ...base, vaultId: 'AB'.repeat(16) }, /vault id/],
    [{ ...base, vaultId: '../../x' }, /vault id/],
  ];
  for (const [request, message] of problems) {
    const answer = readMapDownloadRequest(request);
    assert.ok(
      typeof answer === 'string' && message.test(answer),
      `${JSON.stringify(request)} -> ${JSON.stringify(answer)}`,
    );
  }
});

test('modeState: the mode from settings; chosen only once chosen this session, remembered only once ever chosen', () => {
  const core = (network: unknown, osOnline = true) =>
    ({ settings: { get: () => ({ network }) }, osOnline }) as unknown as Parameters<typeof modeState>[0];
  assert.deepEqual(modeState(core(undefined), false), {
    chosen: null,
    remembered: null,
    osOnline: true,
    localHosts: [],
    enforcement: 'app',
  });
  assert.deepEqual(modeState(core({ workOffline: true }), false), {
    chosen: null,
    remembered: null,
    osOnline: true,
    localHosts: [],
    enforcement: 'app',
  });
  const hosts = ['192.168.1.10'];
  const offline = modeState(core({ workOffline: true, chosenAt: T, localHosts: hosts }, false), true);
  assert.deepEqual(offline, {
    chosen: 'offline',
    remembered: 'offline',
    osOnline: false,
    localHosts: hosts,
    enforcement: 'app',
  });
  assert.notEqual(offline.localHosts, hosts, 'a copy: the settings\u2019 own list is not handed out');
  assert.deepEqual(modeState(core({ workOffline: false, chosenAt: T }), false), {
    chosen: null,
    remembered: 'online',
    osOnline: true,
    localHosts: [],
    enforcement: 'app',
  });
  assert.equal(modeState(core({}), true).chosen, 'online');
});

test('prepCsv: a checklist that reads back as the same records, with nothing a spreadsheet would run', () => {
  const records = [
    { id: '3', kind: 'note', category: 'plans', name: 'Meet at "the gate", north side', notes: 'line one\nline two' },
    {
      id: '2',
      kind: 'item',
      category: 'water',
      name: 'Jugs',
      quantity: 6,
      unit: 'x 20 L',
      expires: '2027-01-01',
      checkedOn: '2026-11-01',
      checkEveryDays: 90,
    },
    { id: '1', kind: 'item', category: 'food', name: '=HYPERLINK("http://x","rice")', quantity: 0 },
    {
      id: '4',
      kind: 'contact',
      category: 'people',
      name: '@neighbour',
      phone: '+1 808 555 0100',
      notes: '-call first',
    },
    { id: '5', kind: 'item', category: 'food', name: 'Beans' },
  ] as unknown as PrepRecord[];
  const before = JSON.stringify(records);
  const text = prepCsv(records);
  assert.equal(JSON.stringify(records), before, 'the list given is not reordered');
  assert.ok(text.endsWith('\n'));
  const rows = parseCsvRows(text);
  assert.deepEqual(rows[0], [
    'checked',
    'kind',
    'category',
    'name',
    'quantity',
    'unit',
    'expires',
    'checkedOn',
    'checkEveryDays',
    'phone',
    'notes',
  ]);
  assert.ok(rows.every((r) => r.length === 11));
  assert.deepEqual(
    rows.slice(1).map((r) => r[3]),
    ['@neighbour', '=HYPERLINK("http://x","rice")', 'Beans', 'Jugs', 'Meet at "the gate", north side'].map((n) =>
      /^[=@]/.test(n) ? `'${n}` : n,
    ),
    'by kind, then category, then name',
  );
  assert.ok(
    rows.slice(1).every((r) => r[0] === ''),
    'the first column is left empty to tick',
  );
  const contact = rows[1]!;
  assert.deepEqual([contact[9], contact[10]], ["'+1 808 555 0100", "'-call first"]);
  assert.deepEqual(rows[4]!.slice(4, 9), ['6', 'x 20 L', '2027-01-01', '2026-11-01', '90']);
  assert.equal(rows[2]![4], '0', 'none left is a number, not a blank');
  assert.equal(rows[5]![10], 'line one\nline two');
  for (const row of rows.slice(1)) for (const value of row) assert.ok(!/^[=+\-@\t\r]/.test(value), value);
  assert.equal(
    prepCsv([]),
    'checked,kind,category,name,quantity,unit,expires,checkedOn,checkEveryDays,phone,notes\n\n',
  );
});

test('importedCollection: new as it is, the same again unchanged, a different one of the same id as a numbered copy', async () => {
  const item = (id: string) => ({ id, kind: 'location' as const, title: id, createdAt: T, updatedAt: T });
  const incoming: Collection = { id: 'c1', name: 'Places', createdAt: T, updatedAt: T, items: [item('a'), item('b')] };
  const store = new Map<string, Collection>();
  const get = async (id: string) => store.get(id);

  assert.deepEqual(await importedCollection(incoming, get), { collection: incoming, unchanged: false });
  store.set('c1', { ...incoming, updatedAt: '2026-11-20T00:00:00.000Z' });
  const same = await importedCollection(incoming, get);
  assert.equal(same.unchanged, true);
  assert.equal(same.collection, store.get('c1'), 'what is kept is what is returned');

  store.set('c1', { ...incoming, items: [item('a')] });
  const copy = await importedCollection(incoming, get);
  assert.deepEqual(
    [copy.unchanged, copy.collection.id, copy.collection.name],
    [false, 'c1-imported', 'Places (imported)'],
  );
  assert.deepEqual(copy.collection.items, incoming.items);
  store.set(copy.collection.id, copy.collection);
  const again = await importedCollection(incoming, get);
  assert.deepEqual(
    [again.unchanged, again.collection.id],
    [true, 'c1-imported'],
    'the same file a second time makes no second copy',
  );

  const third: Collection = { ...incoming, items: [item('z')] };
  const next = await importedCollection(third, get);
  assert.deepEqual(
    [next.unchanged, next.collection.id, next.collection.name],
    [false, 'c1-imported-2', 'Places (imported 2)'],
  );

  const renamed = await importedCollection({ ...store.get('c1')!, name: 'Renamed' }, get);
  assert.equal(renamed.unchanged, false, 'a new name is a different collection');

  const long: Collection = { ...incoming, id: 'x'.repeat(128), name: 'n'.repeat(200) };
  store.set(long.id, { ...long, items: [] });
  const cut = await importedCollection(long, get);
  assert.ok(
    cut.collection.id.length <= 128 && cut.collection.name.length <= 200,
    `${cut.collection.id.length} ${cut.collection.name.length}`,
  );

  await assert.rejects(
    importedCollection(incoming, async (id) => ({ ...incoming, id, items: [] })),
    /too many imported copies/,
  );
});
