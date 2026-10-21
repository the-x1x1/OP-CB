import {
  EventTypes,
  ObjectTypes,
  makeEventId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldGeometry,
  type WorldObject,
} from '@worldview/world-model';
import { derivedProvenance, refsOf, type ObjectRule, type RuleContext } from './types.js';

/**
 * gnssInterferenceRule — where aircraft report degraded satellite navigation (GPS jamming or
 * spoofing, as gpsjam.org maps it), from the integrity every ADS-B position carries.
 *
 *   input     airborne aircraft heard in the last ten minutes (GNSS_WINDOW_MS, as the state
 *             expires aircraft; the engine's own memory keeps them longer) that report a
 *             navigation integrity — `navIntegrity` (NIC), `navAccuracy` (NACp) or readsb's
 *             GPS-loss time (`gpsLostAt`), kept by the adsb-lol and readsb-local providers
 *             whatever the position's source but TIS-B. An aircraft that has lost GPS is
 *             placed by MLAT and reports NIC 0, often with no NACp: it counts. ADS-B version 0
 *             aircraft are left out.
 *   degraded  NIC < 7 or NACp < 8 (either, as reported), or readsb's GPS-loss time within ten
 *             minutes of the report: what gpsjam.org counts.
 *   cells     0.5° by 0.5°, by the aircraft's position.
 *   raised    a cell with at least GNSS_MIN_DEGRADED degraded aircraft that are at least 2 %
 *             of the aircraft with integrity in it — MINOR (gpsjam's yellow band, 2–10 %) or
 *             MODERATE (red, above 10 %). One degraded aircraft is a faulty unit, not a jammer.
 *   identity  event:gnss-interference:worldview:<south>_<west>-<start second>: one event per
 *             episode of a cell, so an ended one stays in history when the cell qualifies again.
 *   ends      once the cell has not qualified for GNSS_HOLD_MS: a cell at the threshold (two
 *             degraded aircraft of forty) would otherwise end and be raised again on every
 *             batch as one of them came and went.
 *   geometry  the cell's square.
 *
 * A sign of interference, not proof: an aircraft's receiver can fault, and integrity drops
 * near the poles and in turns for reasons of its own. Stateless and deterministic (ADR-010):
 * the same aircraft give the same cells.
 */
export const GNSS_CELL_DEG = 0.5;
export const GNSS_MIN_DEGRADED = 2;
/** gpsjam.org's bands, as a fraction of the aircraft in the cell. */
export const GNSS_LOW_FRACTION = 0.02;
export const GNSS_HIGH_FRACTION = 0.1;
/** NIC and NACp below these are degraded (gpsjam.org). */
export const GNSS_NIC_DEGRADED_BELOW = 7;
export const GNSS_NACP_DEGRADED_BELOW = 8;
const GPS_LOSS_WINDOW_MS = 10 * 60_000;
/** An open cell that stops qualifying is kept this long before it is ended. */
export const GNSS_HOLD_MS = 10 * 60_000;
/** Aircraft heard longer ago than this are not counted (the state's own aircraft expiry). */
export const GNSS_WINDOW_MS = 10 * 60_000;
/** Degraded aircraft named on one event at most. */
const MAX_LISTED = 32;

interface CellTally {
  south: number;
  west: number;
  total: number;
  degraded: WorldObject[];
}

/** Whether an aircraft reports degraded navigation; undefined when it reports no integrity. */
export function navigationDegraded(o: WorldObject): boolean | undefined {
  const p = o.properties;
  if (p['onGround'] === true) return undefined;
  const version = p['adsbVersion'];
  if (typeof version === 'number' && version < 1) return undefined;
  const nic = typeof p['navIntegrity'] === 'number' ? p['navIntegrity'] : undefined;
  const nacp = typeof p['navAccuracy'] === 'number' ? p['navAccuracy'] : undefined;
  const lost = p['gpsLostAt'];
  const lostMs = typeof lost === 'string' ? Date.parse(lost) : Number.NaN;
  if (nic === undefined && nacp === undefined && !Number.isFinite(lostMs)) return undefined;
  const observedMs = Date.parse(o.observedAt);
  const recentLoss =
    Number.isFinite(lostMs) && Number.isFinite(observedMs) && observedMs - lostMs <= GPS_LOSS_WINDOW_MS;
  return (
    (nic !== undefined && nic < GNSS_NIC_DEGRADED_BELOW) ||
    (nacp !== undefined && nacp < GNSS_NACP_DEGRADED_BELOW) ||
    recentLoss
  );
}

/** The south-west corner of the cell a position falls in. */
export function gnssCellOf(latitude: number, longitude: number): { south: number; west: number } {
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return {
    south: Math.min(90 - GNSS_CELL_DEG, Math.floor(latitude / GNSS_CELL_DEG) * GNSS_CELL_DEG),
    west: Math.min(180 - GNSS_CELL_DEG, Math.floor(lon / GNSS_CELL_DEG) * GNSS_CELL_DEG),
  };
}

export const gnssInterferenceRule: ObjectRule = {
  id: 'gnss-interference',
  objectTypes: [ObjectTypes.Aircraft],
  eventTypes: [EventTypes.GnssInterference],
  scope: 'all',
  evaluate(objects, ctx) {
    const cells = new Map<string, CellTally>();
    for (const o of objects) {
      if (o.type !== ObjectTypes.Aircraft || !o.position) continue;
      // The window: without a world state the engine remembers aircraft for days.
      const age = ctx.now - Date.parse(o.observedAt);
      if (!(age <= GNSS_WINDOW_MS)) continue;
      const degraded = navigationDegraded(o);
      if (degraded === undefined) continue;
      const { south, west } = gnssCellOf(o.position.latitude, o.position.longitude);
      const key = cellKey(south, west);
      let cell = cells.get(key);
      if (!cell) {
        cell = { south, west, total: 0, degraded: [] };
        cells.set(key, cell);
      }
      cell.total++;
      if (degraded) cell.degraded.push(o);
    }
    const out: WorldEvent[] = [];
    const open = new Map<string, WorldEvent>();
    for (const e of ctx.existing(EventTypes.GnssInterference)) {
      const s = e.properties?.['cellSouth'];
      const w = e.properties?.['cellWest'];
      if (!e.endAt && typeof s === 'number' && typeof w === 'number') open.set(cellKey(s, w), e);
    }
    const raised = new Set<string>();
    for (const cell of [...cells.values()].sort((a, b) => a.south - b.south || a.west - b.west)) {
      const severity = cellSeverity(cell.degraded.length, cell.total);
      if (!severity) continue;
      const key = cellKey(cell.south, cell.west);
      const existing = open.get(key);
      const startSec = Math.floor(Date.parse(existing?.startAt ?? ctx.nowIso) / 1000);
      const id = existing?.id ?? makeEventId(EventTypes.GnssInterference, 'worldview', `${key}-${startSec}`);
      raised.add(key);
      const next = cellEvent(id, cell, severity, ctx, existing);
      // Each aircraft batch (every few seconds) would otherwise send the same square again as a
      // change and a feed item: re-sent only when what it says changed, or once a minute to
      // move its hold on (lastQualifiedAt).
      if (existing && sameCell(existing, next) && ctx.now - lastQualified(existing) < GNSS_REFRESH_MS) continue;
      out.push(next);
    }
    // Not qualifying now: kept for GNSS_HOLD_MS after it last did, then ended.
    for (const [key, e] of open) {
      if (raised.has(key)) continue;
      if (ctx.now - lastQualified(e) >= GNSS_HOLD_MS) out.push({ ...e, endAt: ctx.nowIso });
    }
    return out;
  },
};

/** How often an unchanged open square is re-sent, to keep its hold (GNSS_HOLD_MS) current. */
export const GNSS_REFRESH_MS = 60_000;

function lastQualified(e: WorldEvent): number {
  return Date.parse(String(e.properties?.['lastQualifiedAt'] ?? e.startAt));
}

function sameCell(a: WorldEvent, b: WorldEvent): boolean {
  const p = (e: WorldEvent, k: string) => e.properties?.[k];
  return (
    a.severity === b.severity &&
    p(a, 'aircraftCount') === p(b, 'aircraftCount') &&
    p(a, 'degradedCount') === p(b, 'degradedCount') &&
    a.objectIds.length === b.objectIds.length &&
    a.objectIds.every((id, i) => id === b.objectIds[i])
  );
}

/** MINOR or MODERATE for a cell that qualifies; undefined for one that does not. */
export function cellSeverity(degraded: number, total: number): SeverityClass | undefined {
  if (total <= 0 || degraded < GNSS_MIN_DEGRADED) return undefined;
  const fraction = degraded / total;
  if (fraction > GNSS_HIGH_FRACTION) return 'MODERATE';
  if (fraction >= GNSS_LOW_FRACTION) return 'MINOR';
  return undefined;
}

function cellKey(south: number, west: number): string {
  return `${south.toFixed(1)}_${west.toFixed(1)}`;
}

function cellName(south: number, west: number): string {
  const lat = south + GNSS_CELL_DEG / 2;
  const lon = west + GNSS_CELL_DEG / 2;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
}

function cellEvent(
  id: string,
  cell: CellTally,
  severity: SeverityClass,
  ctx: RuleContext,
  existing: WorldEvent | undefined,
): WorldEvent {
  const { south, west } = cell;
  const north = south + GNSS_CELL_DEG;
  const east = west + GNSS_CELL_DEG;
  const geometry: WorldGeometry = {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
  const degraded = [...cell.degraded].sort((a, b) => a.id.localeCompare(b.id));
  const percent = Math.round((degraded.length / cell.total) * 100);
  const properties: Record<string, JsonValue> = {
    aircraftCount: cell.total,
    degradedCount: degraded.length,
    degradedPercent: percent,
    band: severity === 'MODERATE' ? 'high' : 'medium',
    cellSouth: south,
    cellWest: west,
    cellSizeDeg: GNSS_CELL_DEG,
    lastQualifiedAt: ctx.nowIso,
  };
  return {
    id,
    type: EventTypes.GnssInterference,
    title: `GNSS interference likely near ${cellName(south, west)}`,
    // An open cell keeps its start: the first time it qualified.
    startAt: existing?.startAt ?? ctx.nowIso,
    objectIds: degraded.slice(0, MAX_LISTED).map((o) => o.id),
    observationRefs: refsOf(degraded),
    confidence: 'LOW',
    severity,
    summary:
      `${degraded.length} of ${cell.total} aircraft here (${percent} %) report degraded satellite navigation ` +
      `(NIC below ${GNSS_NIC_DEGRADED_BELOW}, NACp below ${GNSS_NACP_DEGRADED_BELOW} or a lost GPS fix) in the last ten minutes. ` +
      'A sign of jamming or spoofing, not proof: a receiver can fault on its own.',
    properties,
    geometry,
    provenance: derivedProvenance(degraded, ctx.nowIso, refsOf(degraded)),
  };
}
