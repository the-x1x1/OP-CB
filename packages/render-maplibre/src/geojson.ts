import type { RenderFeature } from '@opcb/render-core';
import { resolveStyle, splitAtAntimeridian, type ResolvedStyle, type Theme } from '@opcb/render-core';
import type { GeoBounds, GeoPosition } from '@opcb/world-model';

/**
 * GeoJSON shapes (subset of RFC 7946 / @types/geojson) and the RenderFeature →
 * GeoJSON feature conversion. Properties are flat primitives so MapLibre
 * expressions (`['get', ...]`) can drive paint/layout without feature-state.
 */
export type Position = number[];
export type GeoJsonGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] };

export type FeaturePropertyValue = string | number | boolean | null;

export interface OverlayProperties {
  [name: string]: FeaturePropertyValue;
  id: string;
  objectId: string | null;
  eventId: string | null;
  kind: 'point' | 'line' | 'polygon' | 'circle' | 'cluster' | 'density';
  styleClass: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fillOpacity: number;
  opacity: number;
  size: number;
  icon: string | null;
  rotation: number;
  label: string | null;
  /** MapLibre sorts ascending: lower renders/places first, so this is −priority. */
  sortKey: number;
  priority: number;
  interactive: boolean;
  selected: boolean;
  lineStyle: 'solid' | 'dashed' | 'trail';
  count: number;
  intensity: number;
}

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJsonGeometry;
  properties: OverlayProperties;
}
export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

export const EMPTY_COLLECTION: GeoJsonFeatureCollection = { type: 'FeatureCollection', features: [] };

const toPos = (p: GeoPosition): Position =>
  p.altitudeM !== undefined ? [p.longitude, p.latitude, p.altitudeM] : [p.longitude, p.latitude];

export function boundsToRing(b: GeoBounds): Position[] {
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
}

/** Geodesic circle approximated with `segments` vertices (closed ring). */
/** Web Mercator's last latitude: MapLibre draws nothing past it. */
const MERCATOR_MAX_LAT = 85.051129;

/**
 * A geodesic circle as a GeoJSON ring, its longitudes continuous round the centre (past ±180°
 * where it crosses the antimeridian, which MapLibre draws in the next world copy). A circle
 * that contains a pole (a polar satellite's footprint, range rings near one) cannot close on
 * itself in Web Mercator: until 2026-11-11 such a ring closed with a line straight across the
 * map, leaving the polar cap out (or, south, jumped 320° and drew across the whole map). It is
 * now unwrapped to run once round the world and closed along the map's edge at that pole.
 */
export function circleRing(center: GeoPosition, radiusM: number, segments = 48): Position[] {
  const R = 6_371_008.8;
  const lat = (center.latitude * Math.PI) / 180,
    lon = (center.longitude * Math.PI) / 180,
    d = radiusM / R;
  const ring: Position[] = [];
  for (let i = 0; i <= segments; i++) {
    const brg = (i / segments) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
    const lon2 =
      lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  // Closed exactly: the bearing 2π lands a float's width from 0.
  ring[segments] = ring[0]!;
  // The pole is inside when the circle reaches past it: its angular distance from the centre is
  // 90° − |latitude|.
  const north = center.latitude >= 0;
  const toPole = Math.PI / 2 - Math.abs(lat);
  if (d < toPole) return ring;
  // Unwrap: every step the short way, so the ring runs once round the world without a jump.
  const open = ring.slice(0, -1);
  for (let i = 1; i < open.length; i++) {
    let x = open[i]![0]!;
    const prev = open[i - 1]![0]!;
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    open[i] = [x, open[i]![1]!];
  }
  // Westward or eastward as the bearings ran; close through the pole's edge of the map.
  const first = open[0]!;
  const last = open[open.length - 1]!;
  const end: Position = [first[0]! + (last[0]! > first[0]! ? 360 : -360), first[1]!];
  const edge = north ? MERCATOR_MAX_LAT : -MERCATOR_MAX_LAT;
  return [...open, end, [end[0]!, edge], [first[0]!, edge], first];
}

/**
 * A polygon's ring with its longitudes made continuous: a ring that steps from 179° to −179°
 * (an alert area over the Aleutians or Fiji) would otherwise be drawn the long way, across the
 * whole map; unwrapped, it runs past 180° and MapLibre draws it in the next world copy. A ring
 * that does not cross is returned as it is.
 */
export function unwrapRing(ring: Position[]): Position[] {
  if (!ring.some((p, i) => i > 0 && Math.abs(p[0]! - ring[i - 1]![0]!) > 180)) return ring;
  const out: Position[] = [ring[0]!];
  for (let i = 1; i < ring.length; i++) {
    let x = ring[i]![0]!;
    const prev = out[i - 1]![0]!;
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    out.push([x, ...ring[i]!.slice(1)] as Position);
  }
  return out;
}

export function featureGeometry(f: RenderFeature): GeoJsonGeometry | undefined {
  const g = f.geometry;
  switch (g.kind) {
    case 'point':
      return { type: 'Point', coordinates: toPos(g.position) };
    case 'cluster':
      return { type: 'Point', coordinates: toPos(g.position) };
    case 'line': {
      if (g.positions.length < 2) return undefined;
      // A line that steps across ±180° (a Pacific storm's track, sent as two parts split on the
      // antimeridian) would be drawn the long way, across the whole map: it is cut there.
      const pieces = splitAtAntimeridian(g.positions).filter((piece) => piece.length >= 2);
      if (pieces.length > 1) return { type: 'MultiLineString', coordinates: pieces.map((piece) => piece.map(toPos)) };
      return { type: 'LineString', coordinates: g.positions.map(toPos) };
    }
    case 'polygon':
      return g.rings.length && (g.rings[0]?.length ?? 0) >= 3
        ? { type: 'Polygon', coordinates: g.rings.map((r) => unwrapRing(r.map(toPos))) }
        : undefined;
    case 'circle':
      return Number.isFinite(g.radiusM) && g.radiusM > 0
        ? { type: 'Polygon', coordinates: [circleRing(g.center, g.radiusM)] }
        : undefined;
    case 'density':
      return { type: 'Polygon', coordinates: [boundsToRing(g.bounds)] };
  }
}

/** Icon image id: icon + colour, matching `IconRegistry.ensure`. */
export function iconImageId(icon: string, colorCss: string): string {
  return `wv-icon:${icon}:${colorCss}`;
}

export function toOverlayFeature(f: RenderFeature, theme?: Theme): GeoJsonFeature | undefined {
  const geometry = featureGeometry(f);
  if (!geometry) return undefined;
  const resolved: ResolvedStyle = resolveStyle(f.style, theme);
  const kind = f.geometry.kind;
  const strokeCss = rgba(resolved.outlineColor);
  const properties: OverlayProperties = {
    id: f.id,
    objectId: f.objectId ?? null,
    eventId: f.eventId ?? null,
    kind,
    styleClass: f.style.styleClass,
    color: resolved.colorCss,
    strokeColor: strokeCss,
    // An area's edge is drawn with `strokeWidth` (layers.ts, outline): its class's bold edge
    // (a tornado warning's) when it has one, as on the globe.
    strokeWidth:
      (kind === 'polygon' || kind === 'circle') && resolved.edgeWidthPx !== undefined
        ? Math.max(resolved.edgeWidthPx, resolved.outlineWidthPx)
        : resolved.outlineWidthPx,
    fillOpacity:
      kind === 'density'
        ? 0.12 + 0.6 * clamp01(f.geometry.kind === 'density' ? f.geometry.intensity : 0) * resolved.opacity
        : resolved.fillAlpha,
    opacity: resolved.opacity,
    size: resolved.sizePx,
    icon: resolved.icon ? iconImageId(resolved.icon, resolved.colorCss) : null,
    rotation: resolved.rotationDegrees,
    label: f.style.label ?? null,
    sortKey: -(f.style.labelPriority ?? f.priority),
    priority: f.priority,
    interactive: f.interactive,
    selected: f.style.selected ?? false,
    lineStyle: f.style.lineStyle ?? 'solid',
    count: f.geometry.kind === 'cluster' || f.geometry.kind === 'density' ? f.geometry.count : 1,
    intensity: f.geometry.kind === 'density' ? f.geometry.intensity : 0,
  };
  return { type: 'Feature', id: f.id, geometry, properties };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function rgba(c: { r: number; g: number; b: number; a: number }): string {
  const ch = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${Math.max(0, Math.min(1, c.a)).toFixed(3)})`;
}
