import type { CatalogEntry, LibraryBook, ReferenceDoc } from './command-center.js';

/**
 * Subjects and a starter collection for the built-in library.
 *
 * A shelf by subject (medicine, growing food, keeping food, building, trades, machines,
 * defence, radio and navigation, teaching, science) and a curated list of Kiwix books that
 * covers them, fitted to the space a drive has. The list names books by the start of their
 * file name on download.kiwix.org (`mdwiki_en_all_maxi`, `zimgit-water_en`); each is looked
 * up in the live catalogue when the operator asks, so a book Kiwix has renamed or retired is
 * reported as "not in the catalogue now", never guessed.
 */

export type LibrarySubjectId =
  | 'medical'
  | 'farming'
  | 'food'
  | 'building'
  | 'trades'
  | 'engineering'
  | 'defence'
  | 'comms'
  | 'education'
  | 'science';

export interface LibrarySubject {
  id: LibrarySubjectId;
  title: string;
  /** What it covers, in a few words. */
  blurb: string;
  /** Words that put a book or reference under this subject (lower case, whole words). */
  words: readonly string[];
}

export const LIBRARY_SUBJECTS: readonly LibrarySubject[] = Object.freeze([
  {
    id: 'medical',
    title: 'Medicine and health',
    blurb: 'First aid, trauma, nursing, medicines, dentistry, veterinary care',
    words: [
      'medicine',
      'medical',
      'health',
      'first aid',
      'casualty',
      'wound',
      'trauma',
      'nursing',
      'emergency medicine',
      'wikem',
      'mdwiki',
      'cpr',
      'veterinary',
      'dentistry',
      'anatomy',
      'disease',
    ],
  },
  {
    id: 'farming',
    title: 'Farming and growing',
    blurb: 'Crops, gardens, livestock, bees, forestry',
    words: [
      'farming',
      'farm',
      'agriculture',
      'garden',
      'gardening',
      'gardenology',
      'crop',
      'crops',
      'livestock',
      'beekeeping',
      'forestry',
      'permaculture',
      'soil',
    ],
  },
  {
    id: 'food',
    title: 'Food and water',
    blurb: 'Safe water, cooking, canning, curing, foraging',
    words: [
      'food',
      'cooking',
      'recipe',
      'recipes',
      'canning',
      'preserving',
      'preservation',
      'water',
      'foraging',
      'nutrition',
      'brewing',
    ],
  },
  {
    id: 'building',
    title: 'Building and shelter',
    blurb: 'Carpentry, masonry, concrete, shelter, heating, energy',
    words: [
      'building',
      'construction',
      'carpentry',
      'woodworking',
      'masonry',
      'concrete',
      'shelter',
      'housing',
      'heating',
      'energy',
      'energypedia',
      'solar',
      'appropedia',
      'appropriate technology',
    ],
  },
  {
    id: 'trades',
    title: 'Trades and repair',
    blurb: 'Fixing things, tools, metal, leather, knots, how-to',
    words: [
      'repair',
      'ifixit',
      'how-to',
      'wikihow',
      'diy',
      'welding',
      'smithing',
      'leather',
      'knots',
      'tools',
      'sewing',
      'crafts',
    ],
  },
  {
    id: 'engineering',
    title: 'Engineering and machines',
    blurb: 'Electrical, mechanical, engines, computers',
    words: [
      'engineering',
      'electrical',
      'electronics',
      'mechanical',
      'mechanics',
      'engine',
      'engines',
      'machine',
      'machines',
      'hydraulic',
      'computer',
      'linux',
      'archlinux',
    ],
  },
  {
    id: 'defence',
    title: 'Survival and defence',
    blurb: 'Survival, disasters, hazards, decontamination, security',
    words: [
      'survival',
      'disaster',
      'post-disaster',
      'emergency',
      'preparedness',
      'hazard',
      'hazards',
      'evacuation',
      'military',
      'army',
      'defense',
      'defence',
      'decontamination',
      'cbrn',
    ],
  },
  {
    id: 'comms',
    title: 'Radio and navigation',
    blurb: 'Amateur radio, signals, maps, travel, navigation',
    words: [
      'radio',
      'ham',
      'amateur radio',
      'antenna',
      'signals',
      'signalling',
      'navigation',
      'maps',
      'travel',
      'wikivoyage',
      'compass',
      'telegraph',
    ],
  },
  {
    id: 'education',
    title: 'Teaching and books',
    blurb: 'Lessons, textbooks, literature, dictionaries',
    words: [
      'education',
      'teaching',
      'textbook',
      'textbooks',
      'wikibooks',
      'gutenberg',
      'literature',
      'books',
      'dictionary',
      'wiktionary',
      'khan academy',
      'lessons',
      'wikiversity',
    ],
  },
  {
    id: 'science',
    title: 'Science and reference',
    blurb: 'Encyclopedia, chemistry, botany, astronomy, maths, weather',
    words: [
      'encyclopedia',
      'wikipedia',
      'science',
      'chemistry',
      'physics',
      'biology',
      'botany',
      'astronomy',
      'mathematics',
      'math',
      'meteorology',
      'weather',
      'geography',
      'history',
    ],
  },
]);

const SUBJECT_IDS = new Set<string>(LIBRARY_SUBJECTS.map((s) => s.id));

export function isLibrarySubject(v: unknown): v is LibrarySubjectId {
  return typeof v === 'string' && SUBJECT_IDS.has(v);
}

/** One book of the starter collection: alternatives from the fullest to the smallest. */
export interface CollectionItem {
  id: string;
  title: string;
  subjects: readonly LibrarySubjectId[];
  /** Why it is in the collection, in a few words. */
  why: string;
  /** File-name starts on download.kiwix.org, fullest first (`wikipedia_en_all_maxi`, then `_nopic`, `_mini`). */
  files: readonly string[];
  /** What to ask the catalogue for (its `q`); the answer is matched by file name. */
  query: string;
  /**
   * The catalogue's book names, where they are not the file names with the flavour taken off
   * (Gardenology's book is `gardenology_en_all`, its files `gardenology.org_en_all_…`).
   */
  names?: readonly string[];
  /** Lower comes first when space is short. */
  rank: number;
}

/**
 * The starter collection. Checked 2026-11-22 against the live catalogue (opds.library.kiwix.org,
 * from the browser pane on the operator's computer): every file name below was answered by its
 * catalogue name and by the search words, with these sizes then — post-disaster 0.64 GB, water
 * 0.02, medical library 0.07, military medicine 0.06, mdwiki maxi 2.30, USDA canning 0.02,
 * food preparation 0.10, knots 0.03, outdoors 0.14, amateur radio 0.08, appropedia maxi 0.58,
 * gardenology 0.11, gardening 0.93, cooking 0.24, sustainability 0.03, energypedia 0.80/0.72,
 * mechanics 0.34, wikipedia 127.42/52.69/14.39, home improvement 2.09, ifixit 3.57, wikivoyage
 * 1.07/0.27, wikibooks 4.74/3.54, archlinux 0.04, electronics 4.26, gutenberg 221.25. Not in the
 * catalogue that day and left out: WikEM, mdwiki and appropedia without pictures. Anything the
 * catalogue no longer holds is reported, not fetched.
 */
export const STARTER_COLLECTION: readonly CollectionItem[] = Object.freeze([
  {
    id: 'post-disaster',
    title: 'Post-disaster survival library',
    subjects: ['defence', 'medical', 'food', 'building'],
    why: 'Survival, shelter, sanitation and field medicine manuals in one book',
    files: ['zimgit-post-disaster_en'],
    query: 'post-disaster',
    rank: 1,
  },
  {
    id: 'water',
    title: 'Water',
    subjects: ['food'],
    why: 'Finding, treating and storing safe water',
    files: ['zimgit-water_en'],
    query: 'water',
    rank: 2,
  },
  {
    id: 'medicine-guides',
    title: 'Medical library',
    subjects: ['medical'],
    why: 'Field medicine and first-aid handbooks',
    files: ['zimgit-medicine_en'],
    query: 'medicine',
    rank: 3,
  },
  {
    id: 'military-medicine',
    title: 'Military Medicine (FAS)',
    subjects: ['medical', 'defence'],
    why: 'Army and Navy medical manuals: trauma, field surgery, wilderness and austere care',
    files: ['irp.fas.org_en_military-medicine'],
    query: 'military medicine',
    rank: 4,
  },
  {
    id: 'wikimed',
    title: 'WikiMed (mdwiki)',
    subjects: ['medical'],
    why: 'Medical encyclopedia: conditions, drugs, procedures',
    files: ['mdwiki_en_all_maxi'],
    query: 'mdwiki',
    rank: 5,
  },
  {
    id: 'canning',
    title: 'USDA Guide to Home Canning',
    subjects: ['food'],
    why: 'Safe home canning of fruit, vegetables, meat and pickles',
    files: ['usda-2015_en'],
    query: 'canning',
    rank: 6,
  },
  {
    id: 'food-preparation',
    title: 'Food preparation',
    subjects: ['food'],
    why: 'Cooking, preserving and storing food',
    files: ['zimgit-food-preparation_en'],
    query: 'food preparation',
    rank: 7,
  },
  {
    id: 'knots',
    title: 'Knots',
    subjects: ['trades'],
    why: 'Knots and lashings, illustrated',
    files: ['zimgit-knots_en'],
    query: 'knots',
    rank: 8,
  },
  {
    id: 'outdoors',
    title: 'The Great Outdoors Q&A',
    subjects: ['defence', 'comms'],
    why: 'Camping, bushcraft, navigation and staying alive outside',
    files: ['outdoors.stackexchange.com_en_all'],
    query: 'outdoors',
    rank: 9,
  },
  {
    id: 'ham-radio',
    title: 'Amateur Radio Q&A',
    subjects: ['comms'],
    why: 'Radios, antennas, licensing and getting a signal out',
    files: ['ham.stackexchange.com_en_all'],
    query: 'amateur radio',
    rank: 10,
  },
  {
    id: 'appropedia',
    title: 'Appropedia',
    subjects: ['building', 'farming', 'engineering'],
    why: 'Appropriate technology: water, energy, building, farming',
    files: ['appropedia_en_all_maxi'],
    query: 'appropedia',
    rank: 11,
  },
  {
    id: 'gardenology',
    title: 'Gardenology',
    subjects: ['farming'],
    why: 'Plants, growing and gardening',
    files: ['gardenology.org_en_all'],
    query: 'gardenology',
    names: ['gardenology_en_all'],
    rank: 12,
  },
  {
    id: 'gardening',
    title: 'Gardening & Landscaping Q&A',
    subjects: ['farming'],
    why: 'Answers on growing food, soil, pests and trees',
    files: ['gardening.stackexchange.com_en_all'],
    query: 'gardening',
    rank: 13,
  },
  {
    id: 'cooking',
    title: 'Cooking Q&A',
    subjects: ['food'],
    why: 'Answers on cooking, keeping and preserving food',
    files: ['cooking.stackexchange.com_en_all'],
    query: 'cooking',
    rank: 14,
  },
  {
    id: 'sustainability',
    title: 'Sustainable Living Q&A',
    subjects: ['building', 'farming'],
    why: 'Living on less: water, power, waste, growing',
    files: ['sustainability.stackexchange.com_en_all'],
    query: 'sustainable living',
    rank: 15,
  },
  {
    id: 'energypedia',
    title: 'Energypedia',
    subjects: ['building', 'engineering'],
    why: 'Solar, wind, stoves and small-scale energy',
    files: ['energypedia_en_all_maxi', 'energypedia_en_all_nopic'],
    query: 'energypedia',
    rank: 16,
  },
  {
    id: 'mechanics',
    title: 'Motor Vehicle Mechanics Q&A',
    subjects: ['engineering', 'trades'],
    why: 'Keeping engines and vehicles running',
    files: ['mechanics.stackexchange.com_en_all'],
    query: 'mechanics',
    rank: 17,
  },
  {
    id: 'wikipedia',
    title: 'Wikipedia',
    subjects: ['science', 'education'],
    why: 'All of English Wikipedia; without pictures, or the short version, when space is short',
    files: ['wikipedia_en_all_maxi', 'wikipedia_en_all_nopic', 'wikipedia_en_all_mini'],
    query: 'wikipedia english',
    rank: 18,
  },
  {
    id: 'diy',
    title: 'Home Improvement Q&A',
    subjects: ['building', 'trades'],
    why: 'Answers on wiring, plumbing, carpentry and repair',
    files: ['diy.stackexchange.com_en_all'],
    query: 'home improvement',
    rank: 19,
  },
  {
    id: 'ifixit',
    title: 'iFixit repair guides',
    subjects: ['trades', 'engineering'],
    why: 'Step-by-step repair of devices, vehicles and tools',
    files: ['ifixit_en_all'],
    query: 'ifixit',
    rank: 20,
  },
  {
    id: 'wikivoyage',
    title: 'Wikivoyage',
    subjects: ['comms'],
    why: 'Travel guide: places, routes, getting around',
    files: ['wikivoyage_en_all_maxi', 'wikivoyage_en_all_nopic'],
    query: 'wikivoyage',
    rank: 21,
  },
  {
    id: 'wikibooks',
    title: 'Wikibooks',
    subjects: ['education', 'science'],
    why: 'Open textbooks across every subject',
    files: ['wikibooks_en_all_maxi', 'wikibooks_en_all_nopic'],
    query: 'wikibooks',
    rank: 22,
  },
  {
    id: 'linux',
    title: 'Arch Linux wiki',
    subjects: ['engineering'],
    why: 'Running and repairing Linux computers',
    files: ['archlinux_en_all_maxi'],
    query: 'archlinux',
    rank: 23,
  },
  {
    id: 'electronics',
    title: 'Electronics Q&A',
    subjects: ['engineering'],
    why: 'Circuits, power supplies, repair and building',
    files: ['electronics.stackexchange.com_en_all'],
    query: 'electronics',
    rank: 24,
  },
  {
    id: 'gutenberg',
    title: 'Project Gutenberg',
    subjects: ['education', 'trades', 'farming'],
    why: 'Tens of thousands of public-domain books, old trade and farm manuals among them (over 200 GB)',
    files: ['gutenberg_en_all'],
    query: 'gutenberg',
    rank: 25,
  },
]);

/** The file-name start of a download address (`…/zim/other/zimgit-water_en_2024-08.zim.meta4` → `zimgit-water_en`). */
export function zimFilePrefix(urlOrFile: string): string | undefined {
  const base = urlOrFile.split(/[/\\]/).pop() ?? '';
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,180}?)_(\d{4}-\d{2})\.zim(?:\.meta4)?$/.exec(base);
  return m ? m[1] : undefined;
}

/** The date part of a download's file name (`2024-08`), for picking the newest. */
function zimFileDate(urlOrFile: string): string {
  const base = urlOrFile.split(/[/\\]/).pop() ?? '';
  return /_(\d{4}-\d{2})\.zim(?:\.meta4)?$/.exec(base)?.[1] ?? '';
}

export interface ResolvedChoice {
  file: string;
  entry: CatalogEntry;
}

export interface ResolvedItem {
  item: CollectionItem;
  /** The alternatives the catalogue holds now, in the item's order, newest of each. */
  choices: ResolvedChoice[];
}

/**
 * Matches catalogue entries to an item's file names: for each alternative, the newest entry
 * whose download is exactly that name and a date, with a size. Entries for other files are
 * ignored however their titles read.
 */
export function resolveItem(item: CollectionItem, entries: readonly CatalogEntry[]): ResolvedItem {
  const choices: ResolvedChoice[] = [];
  for (const file of item.files) {
    let best: CatalogEntry | undefined;
    for (const e of entries) {
      if (zimFilePrefix(e.url) !== file || !e.sizeBytes || e.sizeBytes <= 0) continue;
      if (!best || zimFileDate(e.url) > zimFileDate(best.url)) best = e;
    }
    if (best) choices.push({ file, entry: best });
  }
  return { item, choices };
}

export interface CollectionPick {
  item: CollectionItem;
  file: string;
  entry: CatalogEntry;
  /** True when a fuller alternative did not fit and a smaller one was taken. */
  smaller: boolean;
}

export interface CollectionPlan {
  picks: CollectionPick[];
  /** Already in the library (any alternative), by item id. */
  have: string[];
  /** Did not fit in what was left, smallest alternative's size given. */
  tooBig: { item: CollectionItem; smallestBytes: number }[];
  /** Not in the catalogue now. */
  missing: CollectionItem[];
  bytes: number;
  budgetBytes: number;
}

/**
 * The collection fitted to a budget: items by rank, each taking the fullest alternative that
 * still fits, skipping what is already in the library. A budget that is not a positive finite
 * number plans nothing.
 */
export function planCollection(
  resolved: readonly ResolvedItem[],
  budgetBytes: number,
  opts: { haveFiles?: readonly string[]; subjects?: readonly LibrarySubjectId[] } = {},
): CollectionPlan {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? Math.floor(budgetBytes) : 0;
  const have = new Set((opts.haveFiles ?? []).map((f) => zimFilePrefix(f)).filter((x): x is string => !!x));
  const want = opts.subjects?.length ? new Set(opts.subjects) : undefined;
  const plan: CollectionPlan = { picks: [], have: [], tooBig: [], missing: [], bytes: 0, budgetBytes: budget };
  const sorted = [...resolved].sort((a, b) => a.item.rank - b.item.rank || a.item.id.localeCompare(b.item.id, 'en'));
  const seen = new Set<string>();
  for (const r of sorted) {
    if (seen.has(r.item.id)) continue;
    seen.add(r.item.id);
    if (want && !r.item.subjects.some((s) => want.has(s))) continue;
    if (r.item.files.some((f) => have.has(f))) {
      plan.have.push(r.item.id);
      continue;
    }
    if (!r.choices.length) {
      plan.missing.push(r.item);
      continue;
    }
    const left = budget - plan.bytes;
    const fit = r.choices.findIndex((c) => (c.entry.sizeBytes ?? Infinity) <= left);
    if (fit < 0) {
      plan.tooBig.push({
        item: r.item,
        smallestBytes: Math.min(...r.choices.map((c) => c.entry.sizeBytes ?? Infinity)),
      });
      continue;
    }
    const c = r.choices[fit]!;
    plan.picks.push({ item: r.item, file: c.file, entry: c.entry, smaller: fit > 0 });
    plan.bytes += c.entry.sizeBytes ?? 0;
  }
  return plan;
}

// ---- subjects of what is on the shelf ---------------------------------------------------------

function hasWord(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return false;
    const before = i === 0 ? '' : text[i - 1]!;
    const after = text[i + word.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = i + 1;
  }
}

/** Subjects for a piece of text by the subjects' words (whole words, any case). */
export function subjectsOfText(...texts: (string | undefined)[]): LibrarySubjectId[] {
  const t = texts
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .slice(0, 4000)
    .toLowerCase()
    .replace(/[_]+/g, ' ');
  if (!t) return [];
  return LIBRARY_SUBJECTS.filter((s) => s.words.some((w) => hasWord(t, w))).map((s) => s.id);
}

/** A book's subjects: the collection's own for a book it lists, else by its words. */
export function subjectsOfBook(book: Pick<LibraryBook, 'file' | 'title'> & Partial<LibraryBook>): LibrarySubjectId[] {
  const prefix = zimFilePrefix(book.file);
  const item = prefix ? STARTER_COLLECTION.find((i) => i.files.includes(prefix)) : undefined;
  if (item) return [...item.subjects];
  return subjectsOfText(book.title, book.name, book.description, book.file.replace(/\.zim$/i, ''));
}

/** A reference's subjects: its own when it names them, else by its words. */
export function subjectsOfReference(
  ref: Pick<ReferenceDoc, 'title' | 'topic'> & { subjects?: readonly LibrarySubjectId[] },
): LibrarySubjectId[] {
  if (ref.subjects?.length) return [...ref.subjects];
  return subjectsOfText(ref.title, ref.topic);
}

/** How many books and references fall under each subject (a thing may count under several). */
export function subjectCounts(
  books: readonly (Pick<LibraryBook, 'file' | 'title'> & Partial<LibraryBook>)[],
  refs: readonly (Pick<ReferenceDoc, 'title' | 'topic'> & { subjects?: readonly LibrarySubjectId[] })[],
): Record<LibrarySubjectId, number> {
  const out = Object.fromEntries(LIBRARY_SUBJECTS.map((s) => [s.id, 0])) as Record<LibrarySubjectId, number>;
  for (const b of books) for (const s of subjectsOfBook(b)) out[s]++;
  for (const r of refs) for (const s of subjectsOfReference(r)) out[s]++;
  return out;
}

// ---- looking the collection up in the catalogue (`library.collection.lookup`) ------------------

export interface CollectionLookupRequest {
  /** ISO 639-3, as the catalogue uses (`eng`). */
  language?: string;
}

export interface CollectionLookupAnswer {
  ok: boolean;
  /** One per collection item, in the collection's order; `choices` empty when the catalogue lacks it. */
  items: { id: string; choices: ResolvedChoice[] }[];
  /** Catalogue questions that failed, in words. */
  notes: string[];
  message?: string;
}

/** A `library.collection.lookup` request, or undefined. */
export function readCollectionLookupRequest(v: unknown): CollectionLookupRequest | undefined {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== 'language')) return undefined;
  const lang = r['language'];
  if (lang === undefined) return {};
  return typeof lang === 'string' && /^[a-z]{3}$/.test(lang) ? { language: lang } : undefined;
}

/** The catalogue's book name for a file-name start: the flavour (`_maxi`, `_nopic`, `_mini`) taken off. */
export function catalogNameOf(file: string): string {
  return file.replace(/_(maxi|nopic|mini)$/, '');
}

/** The names to ask the catalogue for an item: its own when given, else from its files. */
export function catalogNamesOf(item: CollectionItem): string[] {
  return [...new Set(item.names?.length ? item.names : item.files.map(catalogNameOf))];
}

/** Rebuilds resolved items from an answer, against the collection as this build knows it. */
export function resolvedFromAnswer(answer: CollectionLookupAnswer): ResolvedItem[] {
  const out: ResolvedItem[] = [];
  for (const a of answer.items) {
    const item = STARTER_COLLECTION.find((i) => i.id === a.id);
    if (!item) continue;
    out.push({ item, choices: a.choices.filter((c) => item.files.includes(c.file)) });
  }
  return out;
}

// ---- finding on the shelf ---------------------------------------------------------------------

/** Lower case, accents off, anything not a letter or digit a space. */
function foldText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface ShelfMatch<T> {
  item: T;
  /** Higher is better: a word in the title counts double a word only in the description. */
  score: number;
}

/**
 * Books or references whose title, description or topic hold every word of the query (as word starts, any case, accents ignored). Title matches first, then by title.
 * At most 50; a query with no words, or of more than 200 characters, finds nothing.
 */
export function findOnShelf<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => { title: string; other?: (string | undefined)[] },
): ShelfMatch<T>[] {
  if (typeof query !== 'string' || query.length > 200) return [];
  const words = foldText(query).split(' ').filter(Boolean).slice(0, 12);
  if (!words.length) return [];
  const has = (text: string, w: string) => text.startsWith(w) || text.includes(` ${w}`);
  const out: ShelfMatch<T>[] = [];
  for (const item of items) {
    const t = textOf(item);
    const title = foldText(t.title);
    const rest = foldText(
      (t.other ?? [])
        .filter((x): x is string => typeof x === 'string')
        .join(' ')
        .slice(0, 4000),
    );
    let score = 0;
    let all = true;
    for (const w of words) {
      if (has(title, w)) score += 2;
      else if (has(rest, w)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) out.push({ item, score });
  }
  return out
    .sort((a, b) => b.score - a.score || textOf(a.item).title.localeCompare(textOf(b.item).title, 'en'))
    .slice(0, 50);
}

type ShelfBook = Pick<LibraryBook, 'file' | 'title'> & Partial<LibraryBook>;
type ShelfRef = Pick<ReferenceDoc, 'title' | 'topic'> &
  Partial<ReferenceDoc> & { subjects?: readonly LibrarySubjectId[] };

/**
 * What the By subject card lists: with a search, the matches (within the chosen subject if
 * one is chosen), best first; with only a subject, everything under it; with neither, nothing.
 */
export function shelfView<B extends ShelfBook, R extends ShelfRef>(
  books: readonly B[],
  refs: readonly R[],
  subject: LibrarySubjectId | null,
  query: string,
): { books: B[]; refs: R[]; searched: boolean } {
  const searched = query.trim().length > 0;
  const bs = subject ? books.filter((b) => subjectsOfBook(b).includes(subject)) : [...books];
  const rs = subject ? refs.filter((r) => subjectsOfReference(r).includes(subject)) : [...refs];
  if (!searched) return subject ? { books: bs, refs: rs, searched } : { books: [], refs: [], searched };
  return {
    searched,
    books: findOnShelf(query, bs, (b) => ({
      title: b.title,
      other: [b.name, b.description],
    })).map((m) => m.item),
    refs: findOnShelf(query, rs, (r) => ({
      title: r.title,
      other: [r.topic, r.publisher],
    })).map((m) => m.item),
  };
}
