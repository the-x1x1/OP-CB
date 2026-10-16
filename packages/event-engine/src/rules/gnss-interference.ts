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
 *             expires aircraft; the engine's own memory keeps them longer) whose position the aircraft
 *             broadcast with a navigation integrity: `navIntegrity` (NIC) and `navAccuracy`
 *             (NACp), kept by the adsb-lol and readsb-local providers. ADS-B version 0
 *             aircraft carry no NACp and are left out; so are MLAT and TIS-B positions, which
 *             carry none.
 *   degraded  NIC < 7 or NACp < 8, or readsb's GPS-loss time (`gpsLostAt`) within ten minutes
 *             of the report: what gpsjam.org counts.
 *   cells     0.5° by 0.5°, by the aircraft's position.
 *   raised    a cell with at least GNSS_MIN_DEGRADED degraded aircraft that are at least 2 %
 *             of the aircraft with integrity in it — MINOR (gpsjam's yellow band, 2–10 %) or
 *             MODERATE (red, above 10 %). One degraded aircraft is a faulty unit, not a jammer.
 *   identity  event:gnss-interference:worldview:<south>_<west> of the cell; ended when the cell
 *             no longer qualifies.
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
  const nic = p['navIntegrity'];
  const nacp = p['navAccuracy'];
  if (typeof nic !== 'number' || typeof nacp !== 'number') return undefined;
  const lost = p['gpsLostAt'];
  const lostMs = typeof lost === 'string' ? Date.parse(lost) : Number.NaN;
  const observedMs = Date.parse(o.observedAt);
  const recentLoss =
    Number.isFinite(lostMs) && Number.isFinite(observedMs) && observedMs - lostMs <= GPS_LOSS_WINDOW_MS;
  return nic < GNSS_NIC_DEGRADED_BELOW || nacp < GNSS_NACP_DEGRADED_BELOW || recentLoss;
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
    const raised = new Set<string>();
    for (const cell of [...cells.values()].sort((a, b) => a.south - b.south || a.west - b.west)) {
      const severity = cellSeverity(cell.degraded.length, cell.total);
      if (!severity) continue;
      const id = makeEventId(EventTypes.GnssInterference, 'worldview', cellKey(cell.south, cell.west));
      raised.add(id);
      const existing = ctx.existing(EventTypes.GnssInterference).find((e) => e.id === id && !e.endAt);
      out.push(cellEvent(id, cell, severity, ctx, existing));
    }
    for (const e of ctx.existing(EventTypes.GnssInterference))
      if (!e.endAt && !raised.has(e.id)) out.push({ ...e, endAt: ctx.nowIso });
    return out;
  },
};

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
