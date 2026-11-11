import { FIELD_OBJECT_TYPES, type GeoPosition } from '@opcb/world-model';
import { RANGE_RING_COUNT } from './range-rings.js';

/**
 * Contact sonar (Settings → Rendering, with the HUD): a small scope in the HUD's corner, north
 * up, centred on the selection — or the middle of the view with nothing selected — showing the
 * objects round it as blips at their bearing and range, out to the range rings' outer ring
 * (`ringSpacingM` × 4), with a sweep going round. The map shows where things are; the scope
 * shows what is close to what you are looking at, and from which side, at a glance.
 *
 * Only the nearest `SONAR_MAX_CONTACTS` are drawn, the shown types only, and never the centre
 * itself. A field's points (FIELD_OBJECT_TYPES: wind) and areas without a position are not contacts.
 */
export const SONAR_MAX_CONTACTS = 48;
const EARTH_RADIUS_M = 6_371_008.8;
const rad = Math.PI / 180;

export interface SonarContact {
  id: string;
  type: string;
  /** Clockwise from north, 0–360. */
  bearingDeg: number;
  /** Distance as a share of the scope's range: 0 at the centre, 1 at the edge. */
  range: number;
  /** Seen recently enough to count as live. */
  live: boolean;
}

export interface SonarPicture {
  rangeM: number;
  rings: number;
  /** The centre is the selection (true) or the middle of the view. */
  onSelection: boolean;
  contacts: SonarContact[];
}

interface ObjectLike {
  id: string;
  type: string;
  position?: GeoPosition;
  freshness?: string;
}

/** Great-circle distance (m) and initial bearing (°) from `a` to `b`. */
export function rangeBearing(a: GeoPosition, b: GeoPosition): { distanceM: number; bearingDeg: number } {
  const φ1 = a.latitude * rad,
    φ2 = b.latitude * rad;
  const dφ = φ2 - φ1,
    dλ = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const distanceM = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return { distanceM, bearingDeg: (Math.atan2(y, x) / rad + 360) % 360 };
}

/**
 * The scope's picture: the contacts within `spacingM × RANGE_RING_COUNT` of `center`, nearest
 * first, at most `max`. Undefined without a centre or a spacing.
 */
export function sonarPicture<T extends ObjectLike>(
  objects: Iterable<T>,
  center: GeoPosition | undefined,
  spacingM: number | undefined,
  options: {
    onSelection?: boolean;
    excludeId?: string | null;
    visibleTypes?: ReadonlySet<string>;
    /** A per-object filter the map applies too (layer-tree `objectFilter`). */
    keep?: (o: T) => boolean;
    max?: number;
  } = {},
): SonarPicture | undefined {
  if (!center || !spacingM || !(spacingM > 0)) return undefined;
  const rangeM = spacingM * RANGE_RING_COUNT;
  // A cheap box first: a degree of latitude is at least 110.5 km; longitude widens with latitude.
  const dLat = rangeM / 110_500 + 1e-9;
  const cos = Math.cos(center.latitude * rad);
  const dLon = cos > 0.01 ? dLat / cos : 360;
  const found: Array<SonarContact & { d: number }> = [];
  for (const o of objects) {
    if (!o.position || o.id === options.excludeId || FIELD_OBJECT_TYPES.has(o.type)) continue;
    if (options.visibleTypes && !options.visibleTypes.has(o.type)) continue;
    if (options.keep && !options.keep(o)) continue;
    if (Math.abs(o.position.latitude - center.latitude) > dLat) continue;
    const lonGap = Math.abs(((((o.position.longitude - center.longitude + 540) % 360) + 360) % 360) - 180);
    if (lonGap > dLon) continue;
    const { distanceM, bearingDeg } = rangeBearing(center, o.position);
    if (distanceM > rangeM) continue;
    found.push({
      id: o.id,
      type: o.type,
      bearingDeg,
      range: distanceM / rangeM,
      live: o.freshness === undefined || o.freshness === 'LIVE',
      d: distanceM,
    });
  }
  found.sort((a, b) => a.d - b.d);
  const contacts = found.slice(0, options.max ?? SONAR_MAX_CONTACTS).map(({ d: _d, ...c }) => c);
  return { rangeM, rings: RANGE_RING_COUNT, onSelection: options.onSelection ?? false, contacts };
}
