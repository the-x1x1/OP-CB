/**
 * The Command Center (2026-10-30): the operating mode chosen at start, the operator's own
 * local services (a local AI runner, an offline library, a learning server), the guided setup
 * walkthroughs' saved progress and the preparedness records. Types and the pure rules every
 * side shares; the runtime and main hold the state, the shell shows it.
 *
 * Nothing here reaches the internet. Local services are asked on this computer only
 * (loopback), on the port the operator gives; nothing on the network is searched for.
 */

/** Online: the internet-backed sources run. Offline: OP-CB asks nothing of the internet. */
export type OperatingMode = 'online' | 'offline';

/**
 * The mode as the start screen and the Command Center show it.
 *
 *  - `chosen` is null until the operator has chosen this session. Until then the desktop app
 *    sends nothing to the internet, whatever was chosen last time, so picking Offline on the
 *    start screen is never preceded by a burst of online requests.
 *  - `remembered` is the last choice (null on the very first start): offered first.
 *  - `osOnline` is the operating system's own word on the network: shown as information, it
 *    never chooses for the operator.
 *  - `enforcement` says what kind of guarantee Offline is: `app` means OP-CB's own requests
 *    are stopped at its doors (network-gate.ts). It is not a firewall: another program, or a
 *    service the operator runs beside OP-CB (a local AI, a library server), is not stopped
 *    by it.
 */
export interface ModeState {
  chosen: OperatingMode | null;
  remembered: OperatingMode | null;
  osOnline: boolean;
  /** Hosts on the operator's own network they approved for offline use (`network.localHosts`). */
  localHosts: string[];
  enforcement: 'app';
}

/** At most this many approved local-network hosts. */
export const MAX_LOCAL_HOSTS = 16;

/**
 * Why a host cannot be approved for offline use, or undefined when it can. Approved hosts are
 * the operator's own devices — a receiver on a Raspberry Pi, a weather station — so only an
 * address that cannot be on the internet is taken: a private or link-local IPv4 address
 * (10/8, 172.16/12, 192.168/16, 169.254/16), a unique-local or link-local IPv6 address
 * (fc00::/7, fe80::/10), or a name in a local-only suffix (`.local`, `.lan`, `.home.arpa`,
 * `.internal`) or with no dot at all. A whole range is never approved: one host each.
 *
 * A name is resolved by the operating system when used, so a `.local` name is trusted to be
 * what the local network says it is; an address is exact.
 */
export function localHostProblem(raw: string): string | undefined {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return 'enter a host name or address';
  if (host.length > 253) return 'that name is too long';
  if (/[/\s@?#]/.test(host)) return 'just the host: no scheme, path or user';
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1')
    return 'this computer is always reachable; no need to approve it';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((p) => Number(p) > 255)) return 'that is not an address';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      if (a === 169 && b === 254 && Number(v4[3]) === 169 && Number(v4[4]) === 254)
        return 'the cloud metadata address is never approved';
      return undefined;
    }
    return 'only a private address on your own network (10.x, 172.16–31.x, 192.168.x, 169.254.x)';
  }
  if (host.includes(':')) {
    if (!/^[0-9a-f:.]+$/.test(host)) return 'that is not an address';
    if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return undefined;
    return 'only a unique-local (fc00::/7) or link-local (fe80::/10) IPv6 address';
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return 'that is not a host name';
  if (!host.includes('.')) return undefined;
  if (['.local', '.lan', '.home.arpa', '.internal'].some((suffix) => host.endsWith(suffix))) return undefined;
  return 'a name on the internet cannot be approved for offline use; use a .local name or a private address';
}

/** The host as it is stored and compared: lower case, no brackets, no trailing dot. */
export function normaliseLocalHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

// ---------------------------------------------------------------------------------------------
// Local services
// ---------------------------------------------------------------------------------------------

/**
 * The local services OP-CB knows how to find on this computer. Each is the operator's own
 * install, run by them: OP-CB asks it questions over loopback and never installs, starts or
 * stops it.
 *
 *  - `ollama`  a local AI model runner (ollama.com), port 11434 by default
 *  - `kiwix`   kiwix-serve, an offline library of ZIM files (Wikipedia, manuals, books)
 *  - `kolibri` Kolibri, an offline learning platform (learningequality.org)
 */
export type LocalServiceId = 'ollama' | 'kiwix' | 'kolibri';

export const LOCAL_SERVICE_IDS: readonly LocalServiceId[] = Object.freeze(['ollama', 'kiwix', 'kolibri']);

/** Each service's usual port; the operator can name another (`AppSettings.services`). */
export const DEFAULT_SERVICE_PORTS: Readonly<Record<LocalServiceId, number>> = Object.freeze({
  ollama: 11434,
  // kiwix-serve listens on 80 unless told otherwise (kiwix-serve.rst); 80 needs privileges on
  // Linux, so its own examples use 8080, and so does OP-CB's walkthrough.
  kiwix: 8080,
  kolibri: 8080,
});

/**
 * One service as OP-CB found it, just now.
 *
 *  - `running`    it answered as itself
 *  - `not-found`  nothing answered on that port
 *  - `other`      something answered, but not this service (another program on the port)
 *  - `error`      it answered with an error
 */
export interface LocalServiceStatus {
  id: LocalServiceId;
  name: string;
  /** Where it was asked: always `http://127.0.0.1:<port>`. */
  endpoint: string;
  state: 'running' | 'not-found' | 'other' | 'error';
  version?: string;
  /** One line on what was found ("3 models", "12 books"). */
  detail?: string;
  /** Ollama: the models it has, as it lists them. */
  models?: Array<{ name: string; sizeBytes?: number; parameterSize?: string; family?: string }>;
  /** kiwix-serve: the books in its library, as its catalogue lists them. */
  books?: Array<{ id: string; title: string; name?: string; language?: string }>;
  checkedAt: string;
}

/** One hit of a library search: a page in one of the operator's books. */
export interface LibraryHit {
  title: string;
  /** Its path on the library server (`/content/<book>/…`), opened with `services.open`. */
  path: string;
  snippet?: string;
  /** The book's title. */
  book?: string;
}

export interface LibrarySearchAnswer {
  ok: boolean;
  book: string;
  pattern: string;
  hits: LibraryHit[];
  message?: string;
}

/**
 * The offline inference test: one short prompt to one installed model, with nothing from
 * OP-CB's own data in it, and an answer that says it is the model's own words. `grounded`
 * is always false here: no document was given to the model.
 */
export interface AiTestRequest {
  model: string;
  /** At most 2,000 characters. */
  prompt: string;
}

export interface AiTestAnswer {
  ok: boolean;
  model: string;
  /** The model's words (at most 4,000 characters kept), when it answered. */
  text?: string;
  /** Why not, when it did not. */
  message?: string;
  /** Wall time from asking to the answer. */
  elapsedMs: number;
  /** Tokens per second, from the runner's own counts, when it gives them. */
  tokensPerSecond?: number;
  /** Always false: the answer came from the model alone, not from installed references. */
  grounded: false;
  at: string;
}

// ---------------------------------------------------------------------------------------------
// Guided setup: saved progress
// ---------------------------------------------------------------------------------------------

/**
 * How one step of a walkthrough ended.
 *
 *  - `verified`  its check ran and passed; `evidence` says what was seen
 *  - `done`      a step with nothing to check (reading, choosing) was finished
 *  - `skipped`   the operator moved on without it; a skipped check leaves the guide unverified
 *  - `failed`    its check ran and failed (the latest attempt)
 */
export type GuideStepOutcome = 'verified' | 'done' | 'skipped' | 'failed';

export interface GuideStepRecord {
  outcome: GuideStepOutcome;
  at: string;
  /** What the check saw, in words ("node !a1b2c3d4 heard 40 s ago, SNR 6.5 dB"). */
  evidence?: string;
  /** The option the operator chose, for a choice step. */
  choice?: string;
}

/** One walkthrough's saved progress (guides.json). The id is the guide's. */
export interface GuideProgress {
  id: string;
  /** The guide version this progress was made against; a newer guide starts again. */
  guideVersion: number;
  /** Where the operator is. */
  currentStepId: string;
  steps: Record<string, GuideStepRecord>;
  startedAt: string;
  updatedAt: string;
  /** Set when the last step is reached and finished. */
  completedAt?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A saved guide record read back from disk, or undefined when it is not one (dropped, never trusted). */
export function readGuideProgress(value: unknown): GuideProgress | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || !GUIDE_ID.test(v['id'])) return undefined;
  if (typeof v['guideVersion'] !== 'number' || !Number.isInteger(v['guideVersion']) || v['guideVersion'] < 1)
    return undefined;
  if (typeof v['currentStepId'] !== 'string' || !GUIDE_ID.test(v['currentStepId'])) return undefined;
  for (const k of ['startedAt', 'updatedAt'] as const)
    if (typeof v[k] !== 'string' || !ISO.test(v[k] as string)) return undefined;
  if (v['completedAt'] !== undefined && (typeof v['completedAt'] !== 'string' || !ISO.test(v['completedAt'])))
    return undefined;
  const raw = v['steps'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const steps: Record<string, GuideStepRecord> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 64) return undefined;
  for (const [stepId, rec] of entries) {
    if (!GUIDE_ID.test(stepId) || typeof rec !== 'object' || rec === null) return undefined;
    const r = rec as Record<string, unknown>;
    if (!['verified', 'done', 'skipped', 'failed'].includes(r['outcome'] as string)) return undefined;
    if (typeof r['at'] !== 'string' || !ISO.test(r['at'])) return undefined;
    if (r['evidence'] !== undefined && (typeof r['evidence'] !== 'string' || r['evidence'].length > 500))
      return undefined;
    if (r['choice'] !== undefined && (typeof r['choice'] !== 'string' || r['choice'].length > 64)) return undefined;
    steps[stepId] = {
      outcome: r['outcome'] as GuideStepOutcome,
      at: r['at'],
      ...(r['evidence'] !== undefined ? { evidence: r['evidence'] as string } : {}),
      ...(r['choice'] !== undefined ? { choice: r['choice'] as string } : {}),
    };
  }
  return {
    id: v['id'],
    guideVersion: v['guideVersion'],
    currentStepId: v['currentStepId'],
    steps,
    startedAt: v['startedAt'] as string,
    updatedAt: v['updatedAt'] as string,
    ...(v['completedAt'] !== undefined ? { completedAt: v['completedAt'] as string } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Preparedness records
// ---------------------------------------------------------------------------------------------

export type PrepCategory =
  'water' | 'food' | 'medical' | 'power' | 'communications' | 'tools' | 'shelter' | 'documents' | 'other';

export const PREP_CATEGORIES: readonly PrepCategory[] = Object.freeze([
  'water',
  'food',
  'medical',
  'power',
  'communications',
  'tools',
  'shelter',
  'documents',
  'other',
]);

/**
 * One record in the operator's own preparedness inventory (preparedness.json, on this computer
 * only). `kind: 'item'` is a supply or piece of equipment; `contact` an emergency contact;
 * `note` a plan or reference note. Nothing here is ever sent anywhere, and it leaves the
 * computer only through an export the operator asks for.
 */
export interface PrepRecord {
  id: string;
  kind: 'item' | 'contact' | 'note';
  category: PrepCategory;
  name: string;
  /** item: how many, in `unit`. */
  quantity?: number;
  unit?: string;
  /** item: when it expires or must be replaced (YYYY-MM-DD). */
  expires?: string;
  /** item: when it was last checked (YYYY-MM-DD) and how often it should be (days). */
  checkedOn?: string;
  checkEveryDays?: number;
  /** contact: a phone number or call sign, as the operator writes it. */
  phone?: string;
  /** Free text: where it is kept, a plan, a contact's relation. */
  notes?: string;
  updatedAt: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function optString(v: unknown, max: number): string | undefined | false {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) return false;
  return v;
}

/** A preparedness record read back from disk or from the shell, or undefined when it is not one. */
export function readPrepRecord(value: unknown): PrepRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || !RECORD_ID.test(v['id'])) return undefined;
  if (!['item', 'contact', 'note'].includes(v['kind'] as string)) return undefined;
  if (!PREP_CATEGORIES.includes(v['category'] as PrepCategory)) return undefined;
  if (typeof v['name'] !== 'string' || !v['name'].trim() || v['name'].length > 120) return undefined;
  if (typeof v['updatedAt'] !== 'string' || !ISO.test(v['updatedAt'])) return undefined;
  const out: PrepRecord = {
    id: v['id'],
    kind: v['kind'] as PrepRecord['kind'],
    category: v['category'] as PrepCategory,
    name: v['name'],
    updatedAt: v['updatedAt'],
  };
  if (v['quantity'] !== undefined) {
    if (typeof v['quantity'] !== 'number' || !Number.isFinite(v['quantity']) || v['quantity'] < 0) return undefined;
    out.quantity = v['quantity'];
  }
  if (v['checkEveryDays'] !== undefined) {
    const d = v['checkEveryDays'];
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 3650) return undefined;
    out.checkEveryDays = d;
  }
  for (const k of ['expires', 'checkedOn'] as const) {
    const d = v[k];
    if (d === undefined) continue;
    if (typeof d !== 'string' || !DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) return undefined;
    out[k] = d;
  }
  const unit = optString(v['unit'], 24);
  const phone = optString(v['phone'], 64);
  const notes = optString(v['notes'], 2000);
  if (unit === false || phone === false || notes === false) return undefined;
  if (unit !== undefined) out.unit = unit;
  if (phone !== undefined) out.phone = phone;
  if (notes !== undefined) out.notes = notes;
  return out;
}

// ---------------------------------------------------------------------------------------------
// A Meshtastic test message
// ---------------------------------------------------------------------------------------------

/**
 * One short test message from the operator's own Meshtastic radio to one node, on their press
 * (the operator's decision of 2026-10-30: mesh may send; a receiver such as an RTL-SDR never
 * does). The answer keeps apart: connected to the radio; accepted into its queue; relayed
 * (another radio repeated it, so it went out over the air); acknowledged by the node it was for.
 */
export interface MeshTestRequest {
  /** `!a1b2c3d4`. */
  to: string;
  /** At most 200 bytes of UTF-8. */
  text: string;
}

export interface MeshTestAnswer {
  outcome: 'acknowledged' | 'relayed' | 'accepted' | 'not-acknowledged' | 'refused' | 'not-connected';
  evidence: { connected: boolean; accepted: boolean; relayed: boolean; acknowledged: boolean };
  message: string;
  packetId?: number;
  routingError?: string;
  at: string;
}

// ---------------------------------------------------------------------------------------------
// Offline maps downloaded in the app
// ---------------------------------------------------------------------------------------------

/** One Protomaps daily build, as its build list names it. */
export interface MapBuildInfo {
  /** `20261029.pmtiles`. */
  key: string;
  /** `2026-10-29`: the OpenStreetMap data's date. */
  date: string;
  sizeBytes: number;
  version: string;
  /** Base64 MD5 of the whole file, from the build list. */
  md5?: string;
}

/**
 * What to download. `extract`: the whole world from zoom 0 to `worldMaxZoom`, plus, with
 * `bounds`, more detail inside them down to `maxZoom`. `planet`: the whole build file, every
 * zoom everywhere (well over 100 GB). Onto a data vault with `vaultId`, else the app's folder.
 */
export interface MapDownloadRequest {
  kind: 'extract' | 'planet';
  worldMaxZoom: number;
  maxZoom: number;
  bounds?: { west: number; south: number; east: number; north: number };
  /** A name for an area ("O'ahu"); the pack is named after it. */
  name?: string;
  vaultId?: string;
}

export interface MapDownloadStatus {
  phase: 'idle' | 'planning' | 'planned' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled';
  request?: MapDownloadRequest;
  build?: MapBuildInfo;
  /** Exact size of the file to be written (known once planned). */
  sizeBytes?: number;
  tiles?: number;
  /** Where it goes, and the room there. */
  target?: { label: string; freeBytes?: number };
  progress?: { bytesDone: number; bytesTotal: number; startedAt: string; bytesPerSecond?: number };
  installed?: { id: string; name: string };
  /** Whole planet: bytes already on disk from an unfinished download of the same build. */
  resumedFrom?: number;
  message?: string;
}

// ---------------------------------------------------------------------------------------------
// Where OP-CB keeps its data
// ---------------------------------------------------------------------------------------------

/**
 * The data folder: `usual` (the system's application-data folder), `portable` (a
 * `OP-CB-data` folder next to the app, which travels with the drive) or `moved` (a folder
 * the operator chose, on an external drive say). `missing` when the moved folder could not be
 * used at start and this computer's own data was used instead.
 */
export interface DataLocationInfo {
  root: string;
  kind: 'usual' | 'portable' | 'moved';
  usualRoot: string;
  missing?: { path: string; reason: string };
  freeBytes?: number;
  totalBytes?: number;
}

export interface DataMoveAnswer {
  ok: boolean;
  message: string;
  /** The change takes effect at the next start. */
  restartNeeded: boolean;
}

// ---------------------------------------------------------------------------------------------
// The built-in library: ZIM files read by OP-CB itself, Kiwix catalogue downloads, and the
// emergency references (2026-10-30)
// ---------------------------------------------------------------------------------------------

/** One ZIM file in the library folder. */
export interface LibraryBook {
  /** The file's own UUID (hex). */
  id: string;
  /** File name only. */
  file: string;
  title: string;
  description?: string;
  language?: string;
  date?: string;
  creator?: string;
  publisher?: string;
  /** Kiwix book name (`wikipedia_en_all`) and flavour (`maxi`), when the file says. */
  name?: string;
  flavour?: string;
  sizeBytes: number;
  entryCount: number;
  /** False when OP-CB cannot show it (older xz compression, damaged); `problem` says why. */
  readable: boolean;
  problem?: string;
  /** Whether the file carries a title list (title search). */
  titleSearch: boolean;
}

/** A public-domain emergency reference OP-CB knows how to fetch. */
export interface ReferenceDoc {
  id: string;
  title: string;
  publisher: string;
  /** What it covers, in a few words. */
  topic: string;
  /** Edition or date as the document gives it. */
  edition?: string;
  licence: string;
  /** Where it is fetched from (first that answers with a PDF). */
  urls: string[];
  installed?: { sizeBytes: number; sha256: string; downloadedAt: string; from: string };
}

export interface LibraryShelf {
  /** The library folder (inside OP-CB's data folder). */
  folder: string;
  books: LibraryBook[];
  references: ReferenceDoc[];
  freeBytes?: number;
}

export interface LibraryFindRequest {
  query: string;
  /** One book, or every readable book. */
  bookId?: string;
  limit?: number;
  /** Add the start of each article's text (for answers grounded in the library). */
  withText?: boolean;
}

export interface LibraryFindHit {
  bookId: string;
  bookTitle: string;
  /** The entry's path in the book, as the reader opens it. */
  key: string;
  title: string;
  /** Plain text from the start of the article (with `withText`). */
  text?: string;
}

export interface LibraryFindAnswer {
  hits: LibraryFindHit[];
  /** How many books were searched. */
  searched: number;
  notes: string[];
}

export type LibraryOpenRequest =
  { kind: 'book'; bookId: string; key?: string } | { kind: 'reference'; id: string } | { kind: 'folder' };

/** One book in the Kiwix catalogue (library.kiwix.org). */
export interface CatalogEntry {
  id: string;
  name: string;
  title: string;
  summary?: string;
  language?: string;
  flavour?: string;
  category?: string;
  articleCount?: number;
  mediaCount?: number;
  issued?: string;
  sizeBytes?: number;
  /** The acquisition link as the catalogue gives it (a `.meta4` on download.kiwix.org). */
  url: string;
}

export interface CatalogRequest {
  query?: string;
  /** ISO 639-3, as the catalogue uses (`eng`). */
  language?: string;
  count?: number;
}

export interface CatalogAnswer {
  ok: boolean;
  entries: CatalogEntry[];
  total?: number;
  message?: string;
}

export type LibraryDownloadRequest = { kind: 'zim'; entry: CatalogEntry } | { kind: 'references'; ids?: string[] };

export interface LibraryDownloadStatus {
  phase: 'idle' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';
  /** What is being fetched now. */
  item?: string;
  /** Queue position, for the references: done of total. */
  step?: { done: number; total: number };
  progress?: { bytesDone: number; bytesTotal: number; bytesPerSecond?: number };
  /** Bytes already on disk from an earlier, unfinished download of the same file. */
  resumedFrom?: number;
  message?: string;
  /** References that could not be fetched, with why. */
  problems?: string[];
}

/** A `library.open` request, or undefined. */
export function readLibraryOpenRequest(v: unknown): LibraryOpenRequest | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r['kind'] === 'folder') return keys.length === 1 ? { kind: 'folder' } : undefined;
  if (r['kind'] === 'reference')
    return keys.length === 2 && typeof r['id'] === 'string' && /^[a-z0-9-]{1,64}$/.test(r['id'])
      ? { kind: 'reference', id: r['id'] }
      : undefined;
  if (r['kind'] !== 'book' || typeof r['bookId'] !== 'string' || !/^[0-9a-f]{32}$/.test(r['bookId'])) return undefined;
  if (keys.some((k) => k !== 'kind' && k !== 'bookId' && k !== 'key')) return undefined;
  const key = r['key'];
  if (key !== undefined && (typeof key !== 'string' || key.length > 2000 || key.includes('\0'))) return undefined;
  return { kind: 'book', bookId: r['bookId'], ...(typeof key === 'string' ? { key } : {}) };
}

/** A `library.download.start` request, or undefined. A catalogue entry keeps only what a download needs. */
export function readLibraryDownloadRequest(v: unknown): LibraryDownloadRequest | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (r['kind'] === 'references') {
    const ids = r['ids'];
    if (ids === undefined) return { kind: 'references' };
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      ids.some((i) => typeof i !== 'string' || !/^[a-z0-9-]{1,64}$/.test(i))
    )
      return undefined;
    return { kind: 'references', ids: ids as string[] };
  }
  if (r['kind'] !== 'zim' || typeof r['entry'] !== 'object' || r['entry'] === null) return undefined;
  const e = r['entry'] as Record<string, unknown>;
  const str = (k: string, max: number) =>
    typeof e[k] === 'string' && (e[k] as string).length >= 1 && (e[k] as string).length <= max;
  if (!str('id', 100) || !str('name', 200) || !str('title', 300) || !str('url', 1000)) return undefined;
  const size = e['sizeBytes'];
  if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) return undefined;
  return {
    kind: 'zim',
    entry: {
      id: e['id'] as string,
      name: e['name'] as string,
      title: e['title'] as string,
      url: e['url'] as string,
      ...(typeof size === 'number' ? { sizeBytes: size } : {}),
    },
  };
}

/**
 * Public-domain emergency references OP-CB fetches in one go and keeps in the library
 * (operator decision 2026-10-30). Works of the U.S. federal government are not under copyright
 * (17 U.S.C. § 105); the two Army manuals also carry "Approved for public release; distribution
 * is unlimited."
 *
 * Every address below was opened on 2026-10-30 and answered with the document named, except
 * where "not opened" is noted (found in a search result; the next address is the fallback).
 * Nothing is bundled: the bytes come from these addresses on the operator's computer, each
 * checked to be a PDF, and its SHA-256 recorded when it arrives.
 *
 * The Army manuals are fetched from the Federation of American Scientists' document archive,
 * which keeps copies of public-release military publications; the Army's own library does not
 * list superseded or older public-release manuals.
 */
export const PUBLIC_DOMAIN_US = 'U.S. Government work — public domain (17 U.S.C. § 105)';

export const EMERGENCY_REFERENCES: readonly Omit<ReferenceDoc, 'installed'>[] = Object.freeze([
  {
    id: 'fema-are-you-ready',
    title: 'Are You Ready? A Guide to Citizen Preparedness',
    publisher: 'FEMA',
    topic: 'Every hazard: plans, kits, shelter, evacuation, recovery',
    licence: PUBLIC_DOMAIN_US,
    urls: [
      // From a search result; not opened (the site refused the reading tool).
      'https://www.ready.gov/sites/default/files/2021-03/are-you-ready-guide.pdf',
      // A State of New Jersey copy of the FEMA guide; opened.
      'https://www.nj.gov/njoem/pdf/areyouready.pdf',
    ],
  },
  {
    id: 'army-atp-3-50-21',
    title: 'ATP 3-50.21 Survival',
    publisher: 'U.S. Army',
    topic: 'Water, fire, shelter, food, navigation, signalling, first aid in the field',
    edition: 'September 2018',
    licence: `${PUBLIC_DOMAIN_US}; approved for public release, distribution unlimited`,
    urls: ['https://irp.fas.org/doddir/army/atp3-50-21.pdf'],
  },
  {
    id: 'army-fm-4-25-11',
    title: 'FM 4-25.11 First Aid',
    publisher: 'U.S. Army',
    topic: 'Bleeding, fractures, burns, shock, breathing, heat and cold injuries',
    edition: '23 December 2002',
    licence: `${PUBLIC_DOMAIN_US}; approved for public release, distribution unlimited`,
    urls: ['https://irp.fas.org/doddir/milmed/first.pdf'],
  },
  {
    id: 'cdc-practical-skills',
    title: 'Prepare Your Health: Practical Skills',
    publisher: 'CDC',
    topic: 'CPR, choking, seizures, safe water, wound care, generators',
    licence: PUBLIC_DOMAIN_US,
    urls: ['https://stacks.cdc.gov/view/cdc/79987/cdc_79987_DS1.pdf'],
  },
  {
    id: 'cdc-make-water-safe',
    title: 'Make Water Safe During an Emergency',
    publisher: 'CDC',
    topic: 'Boiling, disinfecting with bleach, storing water',
    licence: PUBLIC_DOMAIN_US,
    urls: ['https://www.cdc.gov/natural-disasters/media/pdfs/2025/02/make-water-safe-during-emergency-p.pdf'],
  },
  {
    id: 'cdc-wound-care',
    title: 'Emergency Wound Care After a Natural Disaster',
    publisher: 'CDC',
    topic: 'Cleaning and covering wounds, signs of infection, tetanus',
    edition: '26 October 2017',
    licence: PUBLIC_DOMAIN_US,
    urls: [
      'https://www.cdc.gov/disasters/hurricanes/pdf/woundcare.pdf',
      // CDC Stacks record 49402's file; named on the record page, not opened itself.
      'https://stacks.cdc.gov/view/cdc/49402/cdc_49402_DS1.pdf',
    ],
  },
]);
