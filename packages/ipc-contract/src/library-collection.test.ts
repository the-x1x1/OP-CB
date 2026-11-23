import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogEntry } from './command-center.js';
import { EMERGENCY_REFERENCES } from './command-center.js';
import {
  LIBRARY_SUBJECTS,
  STARTER_COLLECTION,
  catalogNamesOf,
  isLibrarySubject,
  planCollection,
  resolveItem,
  subjectCounts,
  subjectsOfBook,
  subjectsOfReference,
  subjectsOfText,
  findOnShelf,
  shelfView,
  zimFilePrefix,
  type CollectionItem,
} from './library-collection.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function entry(file: string, sizeBytes: number | undefined, folder = 'other'): CatalogEntry {
  return {
    id: `${file}-id`,
    name: file.replace(/_\d{4}-\d{2}\.zim$/, ''),
    title: file,
    url: `https://download.kiwix.org/zim/${folder}/${file}.meta4`,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

const item = (id: string, rank: number, files: string[], subjects: CollectionItem['subjects'] = ['science']) =>
  ({ id, title: id, subjects, why: id, files, query: id, rank }) as CollectionItem;

test('zimFilePrefix: the name before the date, from an address or a file name', () => {
  assert.equal(
    zimFilePrefix('https://download.kiwix.org/zim/other/zimgit-water_en_2024-08.zim.meta4'),
    'zimgit-water_en',
  );
  assert.equal(zimFilePrefix('wikipedia_en_all_maxi_2026-02.zim'), 'wikipedia_en_all_maxi');
  assert.equal(zimFilePrefix('C:\\lib\\gardenology.org_en_all_2025-01.zim'), 'gardenology.org_en_all');
  for (const bad of [
    '',
    'x.zim',
    'wikipedia_en_all_maxi.zim',
    'a_2024-8.zim',
    '_2024-08.zim',
    'a_2024-08.zim.part',
    '../a_2024-08.pdf',
  ])
    assert.equal(zimFilePrefix(bad), undefined, bad);
});

test('the starter collection is well formed: unique ids and files, known subjects, ranks in order', () => {
  const ids = new Set<string>();
  const files = new Set<string>();
  const ranks = new Set<number>();
  for (const i of STARTER_COLLECTION) {
    assert.ok(!ids.has(i.id), i.id);
    ids.add(i.id);
    assert.ok(!ranks.has(i.rank), `rank ${i.rank}`);
    ranks.add(i.rank);
    assert.ok(i.files.length >= 1 && i.subjects.length >= 1 && i.query.trim() && i.why.trim(), i.id);
    for (const s of i.subjects) assert.ok(isLibrarySubject(s), `${i.id}: ${s}`);
    for (const f of i.files) {
      assert.ok(!files.has(f), f);
      files.add(f);
      // Each name is what zimFilePrefix gives back for its own dated file.
      assert.equal(zimFilePrefix(`${f}_2026-01.zim`), f);
    }
  }
  // Every subject has at least one book in the collection.
  for (const s of LIBRARY_SUBJECTS)
    assert.ok(
      STARTER_COLLECTION.some((i) => i.subjects.includes(s.id)),
      s.id,
    );
});

test('catalogNamesOf: flavours taken off and merged; the item names win where given', () => {
  const wp = STARTER_COLLECTION.find((i) => i.id === 'wikipedia')!;
  assert.deepEqual(catalogNamesOf(wp), ['wikipedia_en_all']);
  const g = STARTER_COLLECTION.find((i) => i.id === 'gardenology')!;
  assert.deepEqual(catalogNamesOf(g), ['gardenology_en_all']);
  assert.deepEqual(catalogNamesOf(item('x', 1, ['a_en_all_maxi', 'a_en_all_mini', 'b_x'])), ['a_en_all', 'b_x']);
  // Every name is a plain catalogue name, as library.catalog accepts.
  for (const i of STARTER_COLLECTION)
    for (const n of catalogNamesOf(i)) assert.match(n, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, i.id);
  // The whole collection fits one collection download.
  assert.ok(STARTER_COLLECTION.length <= 30);
});

test('resolveItem: newest dated file of each alternative, matched by file name only', () => {
  const wp = STARTER_COLLECTION.find((i) => i.id === 'wikipedia')!;
  const r = resolveItem(wp, [
    entry('wikipedia_en_all_maxi_2025-08.zim', 110 * GB, 'wikipedia'),
    entry('wikipedia_en_all_maxi_2026-02.zim', 115 * GB, 'wikipedia'),
    entry('wikipedia_en_all_nopic_2026-01.zim', 48 * GB, 'wikipedia'),
    // Looks like Wikipedia but is another book.
    entry('wikipedia_en_medicine_maxi_2026-01.zim', 2 * GB, 'wikipedia'),
    // No size: cannot be planned.
    entry('wikipedia_en_all_mini_2026-01.zim', undefined, 'wikipedia'),
  ]);
  assert.deepEqual(
    r.choices.map((c) => [c.file, c.entry.sizeBytes]),
    [
      ['wikipedia_en_all_maxi', 115 * GB],
      ['wikipedia_en_all_nopic', 48 * GB],
    ],
  );
  assert.deepEqual(resolveItem(wp, []).choices, []);
});

test('planCollection: by rank, fullest alternative that fits, smaller when the full one does not', () => {
  const a = item('a', 1, ['a_x']);
  const b = item('b', 2, ['b_maxi', 'b_nopic']);
  const c = item('c', 3, ['c_x']);
  const resolved = [
    resolveItem(c, [entry('c_x_2026-01.zim', 5 * GB)]),
    resolveItem(a, [entry('a_x_2026-01.zim', 1 * GB)]),
    resolveItem(b, [entry('b_maxi_2026-01.zim', 100 * GB), entry('b_nopic_2026-01.zim', 40 * GB)]),
  ];
  const p = planCollection(resolved, 50 * GB);
  assert.deepEqual(
    p.picks.map((x) => [x.item.id, x.file, x.smaller]),
    [
      ['a', 'a_x', false],
      ['b', 'b_nopic', true],
      ['c', 'c_x', false],
    ],
  );
  assert.equal(p.bytes, 46 * GB);
  assert.ok(p.bytes <= p.budgetBytes);
  // Room for the full one.
  assert.equal(planCollection(resolved, 200 * GB).picks[1]!.file, 'b_maxi');
  // Too little for b at all, c still fits after it.
  const tight = planCollection(resolved, 7 * GB);
  assert.deepEqual(
    tight.picks.map((x) => x.item.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    tight.tooBig.map((x) => [x.item.id, x.smallestBytes]),
    [['b', 40 * GB]],
  );
});

test('planCollection: what the library holds is skipped; missing items reported; subject filter', () => {
  const a = item('a', 1, ['a_x'], ['medical']);
  const b = item('b', 2, ['b_maxi', 'b_nopic'], ['science']);
  const m = item('m', 3, ['m_x'], ['medical']);
  const resolved = [
    resolveItem(a, [entry('a_x_2026-01.zim', GB)]),
    resolveItem(b, [entry('b_maxi_2026-01.zim', GB)]),
    resolveItem(m, []),
  ];
  const p = planCollection(resolved, 10 * GB, { haveFiles: ['b_nopic_2025-01.zim', 'junk.zim'] });
  assert.deepEqual(
    p.picks.map((x) => x.item.id),
    ['a'],
  );
  assert.deepEqual(p.have, ['b']);
  assert.deepEqual(
    p.missing.map((x) => x.id),
    ['m'],
  );
  const med = planCollection(resolved, 10 * GB, { subjects: ['medical'] });
  assert.deepEqual(
    med.picks.map((x) => x.item.id),
    ['a'],
  );
  assert.deepEqual(
    med.missing.map((x) => x.id),
    ['m'],
  );
  assert.deepEqual(med.have, []);
});

test('planCollection: a budget that is not a positive number plans nothing; duplicates count once', () => {
  const a = item('a', 1, ['a_x']);
  const r = resolveItem(a, [entry('a_x_2026-01.zim', MB)]);
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    const p = planCollection([r], bad);
    assert.equal(p.picks.length, 0, String(bad));
    assert.equal(p.budgetBytes, 0);
  }
  assert.equal(planCollection([r, r], 10 * MB).picks.length, 1);
});

test('planCollection property: never over budget, picks unique, each the fullest that fit then', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let run = 0; run < 400; run++) {
    const items = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) =>
      item(
        `i${i}`,
        Math.floor(rnd() * 20),
        Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => `i${i}_v${k}`),
      ),
    );
    const resolved = items.map((it) =>
      resolveItem(
        it,
        it.files
          .filter(() => rnd() > 0.2)
          .map((f) => entry(`${f}_2026-0${1 + Math.floor(rnd() * 9)}.zim`, 1 + Math.floor(rnd() * 50 * GB))),
      ),
    );
    const budget = Math.floor(rnd() * 120 * GB);
    const p = planCollection(resolved, budget);
    assert.ok(p.bytes <= budget, `run ${run}`);
    assert.equal(
      p.bytes,
      p.picks.reduce((s, x) => s + (x.entry.sizeBytes ?? 0), 0),
    );
    assert.equal(new Set(p.picks.map((x) => x.item.id)).size, p.picks.length);
    assert.equal(
      p.picks.length + p.tooBig.length + p.missing.length + p.have.length,
      new Set(items.map((i) => i.id)).size,
    );
    // Replaying in rank order: each pick is the first alternative that fit what was left.
    let used = 0;
    const byId = new Map(resolved.map((r) => [r.item.id, r]));
    for (const pick of p.picks) {
      const r = byId.get(pick.item.id)!;
      const first = r.choices.find((c) => (c.entry.sizeBytes ?? Infinity) <= budget - used);
      assert.equal(first?.file, pick.file);
      used += pick.entry.sizeBytes ?? 0;
    }
  }
});

test('subjectsOfText: whole words only, any case, underscores as spaces', () => {
  assert.deepEqual(subjectsOfText('Make Water Safe During an Emergency'), ['food', 'defence']);
  assert.deepEqual(subjectsOfText('hamichlol_he_all'), []);
  assert.deepEqual(subjectsOfText('Amateur RADIO handbook'), ['comms']);
  assert.deepEqual(subjectsOfText('beekeeping_en'), ['farming']);
  assert.deepEqual(subjectsOfText(undefined, ''), []);
  assert.deepEqual(subjectsOfText('constructor __proto__ toString'), []);
});

test('subjectsOfBook: the collection decides for its own books; others by their words', () => {
  assert.deepEqual(subjectsOfBook({ file: 'zimgit-water_en_2024-08.zim', title: 'Water' }), ['food']);
  assert.deepEqual(subjectsOfBook({ file: 'mdwiki_en_all_nopic_2025-01.zim', title: 'x' }), ['medical']);
  assert.deepEqual(
    subjectsOfBook({ file: 'ham.stackexchange.com_en_all_2025-01.zim', title: 'Amateur Radio Stack Exchange' }),
    ['comms'],
  );
  assert.deepEqual(subjectsOfBook({ file: 'mystery.zim', title: 'Mystery' }), []);
});

test('every emergency reference falls under at least one subject', () => {
  for (const r of EMERGENCY_REFERENCES) assert.ok(subjectsOfReference(r).length > 0, r.id);
  assert.deepEqual(subjectsOfReference({ title: 'x', topic: 'y', subjects: ['comms'] }), ['comms']);
});

test('subjectCounts: every subject present; a book counts under each of its subjects', () => {
  const c = subjectCounts(
    [{ file: 'zimgit-post-disaster_en_2024-05.zim', title: 'Post-disaster' }],
    [{ title: 'Carpentry', topic: 'building frames' }],
  );
  assert.deepEqual(Object.keys(c).sort(), LIBRARY_SUBJECTS.map((s) => s.id).sort());
  assert.equal(c.defence, 1);
  assert.equal(c.medical, 1);
  assert.equal(c.building, 2);
  assert.equal(c.comms, 0);
});

test('findOnShelf: every word, as word starts; title words first; accents and case ignored', () => {
  const refs = [
    { title: 'Complete Guide to Home Canning, Guide 4', topic: 'Pressure canning beans, corn' },
    { title: 'FM 5-426 Carpentry', topic: 'Framing, roofs' },
    { title: 'Make Water Safe During an Emergency', topic: 'Boiling and disinfecting water' },
    { title: 'Café Médical', topic: 'Notes' },
  ];
  const text = (r: (typeof refs)[number]) => ({ title: r.title, other: [r.topic] });
  const t = (q: string) => findOnShelf(q, refs, text).map((m) => m.item.title);
  assert.deepEqual(t('canning'), ['Complete Guide to Home Canning, Guide 4']);
  assert.deepEqual(t('CORN pressure'), ['Complete Guide to Home Canning, Guide 4']);
  assert.deepEqual(t('roof'), ['FM 5-426 Carpentry']);
  assert.deepEqual(t('oofs'), [], 'inside a word is not a match');
  assert.deepEqual(t('medical cafe'), ['Café Médical']);
  // A subject's name is not searched (the subject buttons do that): "water" is not canning.
  assert.deepEqual(t('shelter'), []);
  // Title words outrank topic words.
  const water = findOnShelf('water', refs, text);
  assert.equal(water[0]!.item.title, 'Make Water Safe During an Emergency');
  assert.deepEqual(t('canning carpentry'), [], 'every word must match');
  for (const q of ['', '   ', '!!!', 'x'.repeat(201)]) assert.deepEqual(t(q), [], JSON.stringify(q));
  // Hostile text does not throw and finds nothing odd.
  assert.deepEqual(t('constructor __proto__'), []);
  assert.deepEqual(t('(.*)+$'), []);
});

test('findOnShelf: at most 50, and fast on a large shelf with long text', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ title: `Book ${i} water`, other: ['x '.repeat(3000)] }));
  const started = performance.now();
  const r = findOnShelf('water book', many, (b) => ({ title: b.title, other: b.other }));
  assert.equal(r.length, 50);
  assert.ok(performance.now() - started < 2000);
});

test('shelfView: nothing chosen lists nothing; a subject lists its own; a search looks through all or the subject', () => {
  const books = [
    { file: 'zimgit-water_en_2024-08.zim', title: 'Water' },
    { file: 'mdwiki_en_all_maxi_2025-11.zim', title: 'WikiMed' },
  ];
  const refs = [
    { title: 'Complete Guide to Home Canning, Guide 1', topic: 'Jars, altitude, botulism' },
    { title: 'ATP 4-02.11 Army First Aid', topic: 'Bleeding, splints, burns' },
  ];
  const v = (s: Parameters<typeof shelfView>[2], q: string) => {
    const r = shelfView(books, refs, s, q);
    return [...r.books.map((b) => b.title), ...r.refs.map((x) => x.title)];
  };
  assert.deepEqual(v(null, ''), []);
  assert.deepEqual(v('food', ''), ['Water', 'Complete Guide to Home Canning, Guide 1']);
  assert.deepEqual(v('medical', ''), ['WikiMed', 'ATP 4-02.11 Army First Aid']);
  assert.deepEqual(v(null, 'splint'), ['ATP 4-02.11 Army First Aid']);
  assert.deepEqual(v('food', 'splint'), [], 'a search inside a subject stays inside it');
  assert.deepEqual(v(null, 'water'), ['Water']);
  assert.equal(shelfView(books, refs, null, '  ').searched, false);
});
