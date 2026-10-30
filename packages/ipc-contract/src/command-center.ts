/**
 * The Command Center (2026-10-30): the operating mode chosen at start, the operator's own
 * local services (a local AI runner, an offline library, a learning server), the guided setup
 * walkthroughs' saved progress and the preparedness records. Types and the pure rules every
 * side shares; the runtime and main hold the state, the shell shows it.
 *
 * Nothing here reaches the internet. Local services are asked on this computer only
 * (loopback), on the port the operator gives; nothing on the network is searched for.
 */

/** Online: the internet-backed sources run. Offline: WorldView asks nothing of the internet. */
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
 *  - `enforcement` says what kind of guarantee Offline is: `app` means WorldView's own requests
 *    are stopped at its doors (network-gate.ts). It is not a firewall: another program, or a
 *    service the operator runs beside WorldView (a local AI, a library server), is not stopped
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
 * The local services WorldView knows how to find on this computer. Each is the operator's own
 * install, run by them: WorldView asks it questions over loopback and never installs, starts or
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
  // Linux, so its own examples use 8080, and so does WorldView's walkthrough.
  kiwix: 8080,
  kolibri: 8080,
});

/**
 * One service as WorldView found it, just now.
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
 * WorldView's own data in it, and an answer that says it is the model's own words. `grounded`
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
  | 'water'
  | 'food'
  | 'medical'
  | 'power'
  | 'communications'
  | 'tools'
  | 'shelter'
  | 'documents'
  | 'other';

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
  message?: string;
}
