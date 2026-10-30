import type { WorldObject } from '@worldview/world-model';
import type {
  AiTestAnswer,
  LocalServiceStatus,
  MeshTestAnswer,
  ModeState,
  OfflineStatus,
  PrepRecord,
} from '@worldview/ipc-contract';
import type { SourceHealthEntry } from '@worldview/source-health';
import type { CheckId, CheckResult } from './guide-types.js';

/**
 * The walkthroughs' checks, as pure functions of what the runtime said (gathered by the store).
 * Each passes only on evidence and says what it saw; "the button was pressed" is never evidence.
 */

export const MESH_PROVIDER = 'meshtastic-local';
export const RECEIVER_PROVIDERS = ['readsb-local', 'ais-local'] as const;
/** A second radio counts as heard if its last packet came within this long. */
export const HEARD_WITHIN_MS = 15 * 60_000;

export interface LastSearch {
  offline: boolean;
  text: string;
  count: number;
  at: number;
}

export interface CheckData {
  nowMs: number;
  mode: ModeState | null;
  offline: OfflineStatus | null;
  sources: readonly SourceHealthEntry[];
  services: readonly LocalServiceStatus[] | null;
  aiModel: string | undefined;
  prep: readonly PrepRecord[];
  /** Mesh nodes in the world now (world.query on the mesh source), when asked for. */
  meshNodes?: readonly WorldObject[];
  /** Objects from the operator's own receivers now, when asked for. */
  receiverObjects?: number;
  lastPlaceSearch?: LastSearch;
  lastLibrarySearch?: LastSearch & { book: string };
  lastAiTest?: { offline: boolean; answer: AiTestAnswer };
  lastMeshTest?: { to: string; name: string; answer: MeshTestAnswer };
}

/** What a check needs fetched beyond the slices the shell already has. */
export function checkNeeds(id: CheckId): { meshNodes?: true; receivers?: true; services?: true } {
  if (id === 'mesh.otherNodeHeard' || id === 'mesh.onMap') return { meshNodes: true };
  if (id === 'sdr.receiving') return { receivers: true };
  if (id.startsWith('ai.') || id.startsWith('library.') || id === 'learning.running') return { services: true };
  return {};
}

const pass = (message: string, evidence?: string): CheckResult => ({
  status: 'pass',
  message,
  evidence: evidence ?? message,
});
const fail = (message: string): CheckResult => ({ status: 'fail', message });

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function entry(d: CheckData, id: string): SourceHealthEntry | undefined {
  return d.sources.find((e) => e.providerId === id);
}

function service(d: CheckData, id: LocalServiceStatus['id']): LocalServiceStatus | undefined {
  return d.services?.find((s) => s.id === id);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** How a mesh node was heard, in words: directly, over n hops, or through the internet. */
export function heardHow(o: WorldObject): string {
  const p = o.properties;
  if (p['viaMqtt'] === true) return 'through the internet (MQTT), not by radio';
  const hops = num(p['hopsAway']);
  const snr = num(p['snrDb']);
  const how =
    hops === undefined
      ? 'by radio'
      : hops === 0
        ? 'directly by radio'
        : `by radio over ${hops} hop${hops === 1 ? '' : 's'}`;
  return snr !== undefined && hops === 0 ? `${how}, SNR ${snr} dB` : how;
}

export function runCheck(id: CheckId, d: CheckData): CheckResult {
  switch (id) {
    case 'mode.offline':
      return d.mode?.chosen === 'offline'
        ? pass('WorldView is in Offline mode: it sends nothing to the internet.')
        : fail('WorldView is in Online mode. Switch to Offline to test.');

    case 'maps.vaultReady': {
      const vaults = d.offline?.vaults ?? [];
      const ready = vaults.find((v) => v.state === 'ready');
      if (ready) return pass(`Data vault "${ready.label}" is connected and writable.`);
      if (!vaults.length) return fail('No data vault added yet.');
      return fail(`Data vault "${vaults[0]!.label}": ${vaults[0]!.message}`);
    }
    case 'maps.packActive': {
      const packs = d.offline?.packs ?? [];
      const active = packs.filter((p) => p.status === 'active');
      if (active.length) {
        const p = active[0]!;
        const signed = p.signature ? `, signature ${p.signature.status}` : '';
        return pass(`${active.length} pack${active.length === 1 ? '' : 's'} active: ${p.name} ${p.version}${signed}.`);
      }
      const invalid = packs.find((p) => p.status === 'invalid');
      if (invalid) return fail(`"${invalid.name}" is installed but not usable: ${invalid.message ?? 'invalid'}.`);
      if (packs.length) return fail('Packs are installed but switched off.');
      return fail('No world pack installed yet.');
    }
    case 'maps.offlineMap': {
      if (d.mode?.chosen !== 'offline') return fail('Switch to Offline mode first, then check again.');
      if (!d.offline?.capabilities.localMap) return fail('Offline, but no active pack holds a map.');
      const p = d.offline.packs.find((x) => x.status === 'active');
      return pass(`Offline, with ${p ? `"${p.name}"` : 'a pack'} as the local map.`);
    }
    case 'maps.searchOffline': {
      const s = d.lastPlaceSearch;
      if (!s) return fail('Search for a place first.');
      if (!s.offline) return fail('That search ran online. Switch to Offline mode and search again.');
      if (!s.count) return fail(`Nothing found for "${s.text}" offline. Try a town inside your pack's area.`);
      return pass(`"${s.text}" found offline (${s.count} result${s.count === 1 ? '' : 's'}).`);
    }

    case 'mesh.sourceOn': {
      const e = entry(d, MESH_PROVIDER);
      if (!e) return { status: 'unavailable', message: 'This build has no Meshtastic source.' };
      return e.enabled ? pass('The Meshtastic source is on.') : fail('The Meshtastic source is off.');
    }
    case 'mesh.nodeConnected': {
      const e = entry(d, MESH_PROVIDER);
      if (!e) return { status: 'unavailable', message: 'This build has no Meshtastic source.' };
      if (!e.enabled) return fail('Switch the Meshtastic source on first.');
      const message = e.health.message ?? '';
      if (e.health.status === 'LIVE' && /node[s]? on the mesh/.test(message))
        return pass(`Connected to your radio: ${message}.`);
      if (e.health.status === 'LIVE') return fail(`Connected, ${message || 'waiting for the node list'}.`);
      return fail(
        `Not connected (${e.health.status.toLowerCase().replace('_', ' ')})${message ? `: ${message}` : ''}.`,
      );
    }
    case 'mesh.ownFix': {
      const own = entry(d, MESH_PROVIDER)?.health.ownPosition;
      if (!own) return fail('Your radio has not reported its own position (no GPS, or not connected).');
      if (own.state === 'fix') {
        const age = own.fixAt ? `, ${ago(d.nowMs - Date.parse(own.fixAt))}` : '';
        const sats = own.satellites !== undefined ? `, ${own.satellites} satellites` : '';
        return pass(`GPS fix${own.fixType ? ` (${own.fixType})` : ''}${sats}${age}.`);
      }
      if (own.state === 'manual') return fail("The radio's position was set by hand, not by GPS.");
      if (own.state === 'stale') return fail('The last GPS fix is old: the radio has lost it.');
      return fail('NO FIX: the GPS has no position yet.');
    }
    case 'mesh.otherNodeHeard': {
      const nodes = (d.meshNodes ?? []).filter((o) => o.properties['thisNode'] !== true);
      const recent = nodes
        .map((o) => ({ o, heard: Date.parse(String(o.properties['lastHeardAt'] ?? '')) }))
        .filter((x) => Number.isFinite(x.heard) && d.nowMs - x.heard <= HEARD_WITHIN_MS)
        .sort((a, b) => b.heard - a.heard);
      const byRadio = recent.filter((x) => x.o.properties['viaMqtt'] !== true);
      if (byRadio.length) {
        const { o, heard } = byRadio[0]!;
        const name = String(o.properties['name'] ?? o.id);
        return pass(
          `Received "${name}" ${heardHow(o)}, ${ago(d.nowMs - heard)}. Your radio hears the other one.`,
          `${name} heard ${heardHow(o)}, ${ago(d.nowMs - heard)}`,
        );
      }
      if (recent.length)
        return fail('Another radio was heard only through the internet (MQTT), which does not prove a radio link.');
      if (nodes.length)
        return fail(
          'Other radios are known, but none was heard in the last 15 minutes. Is the second radio on and in range?',
        );
      return fail(
        'No other radio with a position has been heard. A radio without GPS or a fixed position cannot be placed.',
      );
    }
    case 'mesh.messageAcked': {
      const t = d.lastMeshTest;
      if (!t) return fail('Send a test message first.');
      const a = t.answer;
      if (a.outcome === 'acknowledged')
        return pass(
          `"${t.name}" acknowledged the test message: messages go both ways over the air.`,
          `test message to ${t.name} acknowledged (${a.at.slice(11, 19)} UTC)`,
        );
      if (a.outcome === 'relayed')
        return fail(
          'It went out over the air (another radio repeated it), but the node it was for did not acknowledge it.',
        );
      if (a.outcome === 'accepted') return fail('Your radio queued it, but nothing shows it was heard.');
      return fail(a.message.charAt(0).toUpperCase() + a.message.slice(1) + '.');
    }
    case 'mesh.onMap': {
      const n = (d.meshNodes ?? []).filter((o) => o.position).length;
      return n ? pass(`${n} radio${n === 1 ? '' : 's'} on the map.`) : fail('No radio with a position yet.');
    }

    case 'sdr.sourceOn': {
      const on = RECEIVER_PROVIDERS.map((id) => entry(d, id)).filter((e) => e?.enabled);
      const live = on.find((e) => e!.health.status === 'LIVE');
      if (live) return pass(`${live.name} is connected.`);
      if (on.length) return fail(`${on[0]!.name}: ${on[0]!.health.message ?? on[0]!.health.status.toLowerCase()}.`);
      return fail('Neither receiver source is on.');
    }
    case 'sdr.receiving': {
      const n = d.receiverObjects ?? 0;
      return n
        ? pass(`${n} aircraft or ship${n === 1 ? '' : 's'} heard by your own receiver.`)
        : fail('Nothing heard by your own receiver yet.');
    }

    case 'ai.running': {
      const s = service(d, 'ollama');
      if (s?.state === 'running') return pass(`Ollama ${s.version ?? ''} answers at ${s.endpoint}.`.replace('  ', ' '));
      return fail(s?.detail ? `Ollama: ${s.detail}.` : 'Ollama was not found.');
    }
    case 'ai.modelInstalled': {
      const s = service(d, 'ollama');
      const models = s?.models ?? [];
      if (!models.length) return fail('Ollama lists no models. Download one while online.');
      if (!d.aiModel) return fail('Choose a model in Local Intelligence.');
      if (!models.some((m) => m.name === d.aiModel)) return fail(`"${d.aiModel}" is not among Ollama's models.`);
      return pass(`Model "${d.aiModel}" chosen (${models.length} installed).`);
    }
    case 'ai.inference': {
      const t = d.lastAiTest;
      if (!t) return fail('Run the test first.');
      if (!t.answer.ok) return fail(t.answer.message ?? 'The model did not answer.');
      const speed = t.answer.tokensPerSecond !== undefined ? `, ${t.answer.tokensPerSecond} tokens/s` : '';
      return pass(
        `"${t.answer.model}" answered in ${(t.answer.elapsedMs / 1000).toFixed(1)} s${speed}${t.offline ? ', with WorldView offline' : ''}.`,
      );
    }

    case 'library.running': {
      const s = service(d, 'kiwix');
      if (s?.state === 'running') return pass(`The library server answers at ${s.endpoint}.`);
      return fail(s?.detail ? `Library server: ${s.detail}.` : 'The library server was not found.');
    }
    case 'library.hasBooks': {
      const books = service(d, 'kiwix')?.books ?? [];
      return books.length
        ? pass(
            `${books.length} book${books.length === 1 ? '' : 's'}: ${books
              .slice(0, 3)
              .map((b) => b.title)
              .join(', ')}${books.length > 3 ? '…' : ''}.`,
          )
        : fail('The library lists no books.');
    }
    case 'library.search': {
      const s = d.lastLibrarySearch;
      if (!s) return fail('Search a book first.');
      if (!s.offline) return fail('That search ran with WorldView online. Switch to Offline mode and search again.');
      if (!s.count) return fail(`No pages for "${s.text}" in ${s.book}.`);
      return pass(`"${s.text}" found ${s.count} page${s.count === 1 ? '' : 's'} in ${s.book}, offline.`);
    }
    case 'learning.running': {
      const s = service(d, 'kolibri');
      if (s?.state === 'running')
        return pass(`Kolibri ${s.version ?? ''} answers at ${s.endpoint}.`.replace('  ', ' '));
      return fail(s?.detail ? `Kolibri: ${s.detail}.` : 'Kolibri was not found.');
    }

    case 'prep.hasItems': {
      const counted = d.prep.filter((r) => r.kind === 'item' && r.quantity !== undefined && r.quantity > 0);
      return counted.length
        ? pass(`${counted.length} item${counted.length === 1 ? '' : 's'} counted.`)
        : fail('No item has a quantity yet.');
    }
    case 'prep.hasWaterAndMedical': {
      const has = (c: PrepRecord['category']) =>
        d.prep.some((r) => r.kind === 'item' && r.category === c && (r.quantity ?? 0) > 0);
      const missing = [!has('water') && 'water', !has('medical') && 'first aid / medical'].filter(Boolean);
      return missing.length
        ? fail(`Not counted yet: ${missing.join(' and ')}.`)
        : pass('Water and first aid are counted.');
    }
    case 'prep.hasContact': {
      const n = d.prep.filter((r) => r.kind === 'contact').length;
      return n ? pass(`${n} emergency contact${n === 1 ? '' : 's'}.`) : fail('No emergency contact yet.');
    }
  }
}
