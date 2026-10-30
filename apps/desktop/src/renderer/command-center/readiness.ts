import type { FieldHostStatus, GuideProgress } from '@worldview/ipc-contract';
import { type CheckData, MESH_PROVIDER, RECEIVER_PROVIDERS } from './checks.js';
import { completion, stepVerified } from './guide-engine.js';
import type { GuideDefinition, SectionId } from './guide-types.js';
import { GUIDES } from './guides/index.js';

/**
 * The Command Center's readiness: what will still work if the internet goes, each with the
 * reason. Read from evidence — a pack really active, a service really answering, a final test
 * that really passed — never from a box ticked.
 *
 *  - `ready`                 set up, and its walkthrough's final test passed
 *  - `verification-required` set up, but the final test has not passed (or was skipped)
 *  - `setup-required`        not set up yet
 *  - `degraded`              set up, but not working right now (a drive unplugged, a radio away)
 *  - `unavailable`           cannot be known or used here (this build, this system)
 */
export type ReadinessStatus = 'ready' | 'verification-required' | 'setup-required' | 'degraded' | 'unavailable';

export interface ReadinessItem {
  id: string;
  label: string;
  status: ReadinessStatus;
  reason: string;
  section: SectionId;
  guideId?: string;
  /** Optional capabilities do not make the computer "not ready" by their absence. */
  optional?: boolean;
}

export interface ReadinessInput extends CheckData {
  guides: readonly GuideProgress[];
  field: FieldHostStatus | null;
}

function guide(id: string): GuideDefinition {
  return GUIDES.find((g) => g.id === id)!;
}

function progress(input: ReadinessInput, id: string): GuideProgress | undefined {
  return input.guides.find((g) => g.id === id);
}

/** The final test of a guide, if it passed: its evidence and when. */
function finalPassed(input: ReadinessInput, id: string): string | undefined {
  const def = guide(id);
  const fin = def.steps.find((s) => s.final);
  if (!fin) return undefined;
  const rec = stepVerified(def, progress(input, id), fin.id);
  return rec ? `${rec.evidence ?? 'tested'} (tested ${rec.at.slice(0, 10)})` : undefined;
}

function verifiedOr(input: ReadinessInput, guideId: string, setUp: string): Pick<ReadinessItem, 'status' | 'reason'> {
  const evidence = finalPassed(input, guideId);
  if (evidence) return { status: 'ready', reason: `${setUp} Final test: ${evidence}` };
  const c = completion(guide(guideId), progress(input, guideId));
  return {
    status: 'verification-required',
    reason: `${setUp} ${c === 'unverified' ? 'Its final test was skipped or failed.' : 'Its final test has not been run.'}`,
  };
}

export function evaluateReadiness(input: ReadinessInput): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const offline = input.offline;
  const svc = (id: 'ollama' | 'kiwix' | 'kolibri') => input.services?.find((s) => s.id === id);

  // Offline map.
  {
    const packs = offline?.packs ?? [];
    const active = packs.filter((p) => p.status === 'active');
    const base = { id: 'map', label: 'Offline map', section: 'world' as const, guideId: 'offline-maps' };
    if (!offline) out.push({ ...base, status: 'unavailable', reason: 'The offline status has not been read yet.' });
    else if (offline.capabilities.localMap)
      out.push({
        ...base,
        ...verifiedOr(
          input,
          'offline-maps',
          `${active.length} pack${active.length === 1 ? '' : 's'} active (${active.map((p) => p.name).join(', ')}).`,
        ),
      });
    else if (packs.some((p) => p.status === 'invalid'))
      out.push({
        ...base,
        status: 'degraded',
        reason: `Installed but not usable: ${packs.find((p) => p.status === 'invalid')!.message ?? 'invalid'}. Only the bundled world map is drawn offline.`,
      });
    else
      out.push({
        ...base,
        status: 'setup-required',
        reason: 'No world pack with a map is active. Offline, only the bundled world map and cached tiles are drawn.',
      });
  }

  // Offline place search.
  if (offline)
    out.push({
      id: 'search',
      label: 'Offline place search',
      section: 'world',
      guideId: 'offline-maps',
      ...(offline.capabilities.localSearch
        ? {
            status: 'ready' as const,
            reason: "A pack's place index answers searches offline, with the built-in list of cities.",
          }
        : {
            status: 'setup-required' as const,
            reason: 'Only the built-in list of cities is searchable offline: install a pack with a place index.',
          }),
    });

  // Offline library.
  {
    const s = svc('kiwix');
    const base = { id: 'library', label: 'Offline library', section: 'knowledge' as const, guideId: 'library' };
    if (!input.services)
      out.push({ ...base, status: 'unavailable', reason: 'Local services have not been asked yet.' });
    else if (s?.state === 'running' && s.books?.length)
      out.push({
        ...base,
        ...verifiedOr(input, 'library', `${s.books.length} book${s.books.length === 1 ? '' : 's'} at ${s.endpoint}.`),
      });
    else if (s?.state === 'running')
      out.push({ ...base, status: 'degraded', reason: 'The library server answers but lists no books.' });
    else
      out.push({
        ...base,
        status: 'setup-required',
        reason: `No library server found at ${s?.endpoint ?? 'its port'}.`,
      });
  }

  // Local AI (optional).
  {
    const s = svc('ollama');
    const base = { id: 'ai', label: 'Local AI', section: 'intelligence' as const, guideId: 'local-ai', optional: true };
    if (!input.services)
      out.push({ ...base, status: 'unavailable', reason: 'Local services have not been asked yet.' });
    else if (s?.state === 'running' && s.models?.length)
      out.push({
        ...base,
        ...verifiedOr(
          input,
          'local-ai',
          `Ollama ${s.version ?? ''} with ${s.models.length} model${s.models.length === 1 ? '' : 's'}.`.replace(
            '  ',
            ' ',
          ),
        ),
      });
    else if (s?.state === 'running')
      out.push({ ...base, status: 'setup-required', reason: 'Ollama answers but has no models.' });
    else out.push({ ...base, status: 'setup-required', reason: 'Optional. Ollama was not found on this computer.' });
  }

  // Mesh radio.
  {
    const e = input.sources.find((x) => x.providerId === MESH_PROVIDER);
    const base = {
      id: 'mesh',
      label: 'Meshtastic radio',
      section: 'comms' as const,
      guideId: 'meshtastic',
      optional: true,
    };
    if (!e) out.push({ ...base, status: 'unavailable', reason: 'This build has no Meshtastic source.' });
    else if (!e.enabled) out.push({ ...base, status: 'setup-required', reason: 'The Meshtastic source is off.' });
    else if (e.health.status === 'LIVE')
      out.push({ ...base, ...verifiedOr(input, 'meshtastic', `Connected: ${e.health.message ?? 'live'}.`) });
    else
      out.push({
        ...base,
        status: 'degraded',
        reason: `On, but ${e.health.status.toLowerCase().replace('_', ' ')}${e.health.message ? `: ${e.health.message}` : ''}.`,
      });
  }

  // Own receivers.
  {
    const on = RECEIVER_PROVIDERS.map((id) => input.sources.find((x) => x.providerId === id)).filter((x) => x?.enabled);
    const base = {
      id: 'receiver',
      label: 'Aircraft/ship receiver',
      section: 'comms' as const,
      guideId: 'sdr',
      optional: true,
    };
    const live = on.find((x) => x!.health.status === 'LIVE');
    if (!on.length) out.push({ ...base, status: 'setup-required', reason: 'No receiver source is on.' });
    else if (live) out.push({ ...base, ...verifiedOr(input, 'sdr', `${live.name} connected.`) });
    else
      out.push({
        ...base,
        status: 'degraded',
        reason: `${on[0]!.name}: ${on[0]!.health.message ?? on[0]!.health.status.toLowerCase()}.`,
      });
  }

  // Own GPS (through the radio).
  {
    const own = input.sources.find((x) => x.providerId === MESH_PROVIDER)?.health.ownPosition;
    const base = {
      id: 'gps',
      label: 'Own GPS position',
      section: 'comms' as const,
      guideId: 'meshtastic',
      optional: true,
    };
    if (!own)
      out.push({
        ...base,
        status: 'unavailable',
        reason: 'No GPS on this computer is reporting (a Meshtastic radio with GPS provides one).',
      });
    else if (own.state === 'fix')
      out.push({
        ...base,
        status: 'ready',
        reason: `Fix${own.fixType ? ` ${own.fixType}` : ''}${own.satellites !== undefined ? `, ${own.satellites} satellites` : ''}, from ${own.node ?? 'your radio'}.`,
      });
    else
      out.push({
        ...base,
        status: 'degraded',
        reason:
          own.state === 'stale'
            ? 'The last fix is old.'
            : own.state === 'manual'
              ? 'Position set by hand, not GPS.'
              : 'NO FIX.',
      });
  }

  // External storage (optional).
  {
    const vaults = offline?.vaults ?? [];
    const base = {
      id: 'storage',
      label: 'External storage',
      section: 'resources' as const,
      guideId: 'offline-maps',
      optional: true,
    };
    const ready = vaults.filter((v) => v.state === 'ready');
    const bad = vaults.filter((v) => v.state !== 'ready');
    if (!vaults.length)
      out.push({
        ...base,
        status: 'setup-required',
        reason: 'Optional. No data vault added; everything is on the internal disk.',
      });
    else if (bad.length)
      out.push({
        ...base,
        status: 'degraded',
        reason:
          bad.map((v) => `"${v.label}": ${v.message}`).join(' ') +
          (ready.length ? ` ${ready.length} other vault(s) ready.` : ''),
      });
    else
      out.push({
        ...base,
        status: 'ready',
        reason:
          ready
            .map(
              (v) =>
                `"${v.label}" connected${v.freeBytes !== undefined ? `, ${(v.freeBytes / 1e9).toFixed(0)} GB free` : ''}`,
            )
            .join('; ') + '.',
      });
  }

  // Power and disk.
  {
    const power = input.field?.power;
    const base = { id: 'power', label: 'Battery', section: 'overview' as const };
    if (!power || power.source === 'unknown')
      out.push({ ...base, status: 'unavailable', reason: 'This computer does not report its battery here.' });
    else if (power.noBattery) out.push({ ...base, status: 'ready', reason: 'On mains power (no battery).' });
    else if (power.batteryPct !== undefined && power.batteryPct < 20 && !power.charging)
      out.push({ ...base, status: 'degraded', reason: `Battery ${power.batteryPct}%, not charging.` });
    else
      out.push({
        ...base,
        status: 'ready',
        reason: `${power.source === 'ac' ? 'On mains' : 'On battery'}${power.batteryPct !== undefined ? `, ${power.batteryPct}%` : ''}${power.charging ? ', charging' : ''}.`,
      });
    const disk = input.field?.appDisk;
    if (disk && disk.totalBytes > 0) {
      const share = disk.freeBytes / disk.totalBytes;
      out.push({
        id: 'disk',
        label: 'Disk space',
        section: 'resources',
        status: share < 0.05 ? 'degraded' : 'ready',
        reason: `${(disk.freeBytes / 1e9).toFixed(1)} GB free of ${(disk.totalBytes / 1e9).toFixed(0)} GB on the app's drive.`,
      });
    }
  }

  // Preparedness records.
  {
    const counted = input.prep.filter((r) => r.kind === 'item' && (r.quantity ?? 0) > 0).length;
    const base = { id: 'prep', label: 'Preparedness inventory', section: 'prepare' as const, guideId: 'preparedness' };
    const due = dueItems(input.prep, input.nowMs);
    if (!counted) out.push({ ...base, status: 'setup-required', reason: 'No supplies recorded yet.' });
    else if (due.expired.length)
      out.push({
        ...base,
        status: 'degraded',
        reason: `${due.expired.length} item${due.expired.length === 1 ? '' : 's'} expired: ${due.expired
          .slice(0, 3)
          .map((r) => r.name)
          .join(', ')}.`,
      });
    else
      out.push({
        ...base,
        ...verifiedOr(
          input,
          'preparedness',
          `${counted} item${counted === 1 ? '' : 's'} counted${due.soon.length ? `, ${due.soon.length} due soon` : ''}.`,
        ),
      });
  }

  return out;
}

/** Items past their expiry or check date, and those due within 30 days. */
export function dueItems(
  records: readonly ReadinessInput['prep'][number][],
  nowMs: number,
): { expired: ReadinessInput['prep'][number][]; soon: ReadinessInput['prep'][number][] } {
  const expired: ReadinessInput['prep'][number][] = [];
  const soon: ReadinessInput['prep'][number][] = [];
  const day = 86_400_000;
  for (const r of records) {
    if (r.kind !== 'item') continue;
    const dates: number[] = [];
    if (r.expires) dates.push(Date.parse(`${r.expires}T00:00:00Z`));
    if (r.checkedOn && r.checkEveryDays) dates.push(Date.parse(`${r.checkedOn}T00:00:00Z`) + r.checkEveryDays * day);
    if (!dates.length) continue;
    const first = Math.min(...dates);
    if (first < nowMs) expired.push(r);
    else if (first - nowMs <= 30 * day) soon.push(r);
  }
  return { expired, soon };
}

/** The headline: how many of the non-optional capabilities are ready. */
export function readinessSummary(items: readonly ReadinessItem[]): { ready: number; total: number; attention: number } {
  const core = items.filter((i) => !i.optional && i.status !== 'unavailable');
  return {
    ready: core.filter((i) => i.status === 'ready').length,
    total: core.length,
    attention: items.filter((i) => i.status === 'degraded').length,
  };
}
