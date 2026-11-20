import type { RenderStyle } from '@opcb/render-core';
import type { GeoBounds, GeoPosition } from '@opcb/world-model';
import type { Cartesian3Like, CesiumLike, RectangleLike } from './cesium-like.js';

/**
 * Geographic → Cesium coordinate helpers. Height handling follows the feature's
 * `heightMode`: absolute uses the object's altitude (aircraft, satellites),
 * clamp draws at 0 and lets the primitive clamp to ground, relative keeps the
 * altitude as a ground offset.
 */
export type HeightMode = NonNullable<RenderStyle['heightMode']>;

/** Height (m) to hand Cesium for a position under a height mode; pure and tested. */
export function heightFor(position: GeoPosition, mode: HeightMode | undefined): number {
  const m = mode ?? 'clamp';
  if (m === 'clamp') return 0;
  const alt = position.altitudeM;
  if (alt === undefined || !Number.isFinite(alt)) return 0;
  return Math.max(0, alt);
}

export function heightReferenceFor(cesium: Pick<CesiumLike, 'HeightReference'>, mode: HeightMode | undefined): number {
  switch (mode ?? 'clamp') {
    case 'absolute':
      return cesium.HeightReference.NONE;
    case 'relative':
      return cesium.HeightReference.RELATIVE_TO_GROUND;
    case 'clamp':
      return cesium.HeightReference.CLAMP_TO_GROUND;
  }
}

export function toCartesian(
  cesium: Pick<CesiumLike, 'Cartesian3'>,
  p: GeoPosition,
  mode: HeightMode | undefined,
): Cartesian3Like {
  return cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, heightFor(p, mode));
}

/** Flattened [lon, lat, height, ...] for `fromDegreesArrayHeights`. */
export function flattenPositions(positions: ReadonlyArray<GeoPosition>, mode: HeightMode | undefined): number[] {
  const out: number[] = [];
  for (const p of positions) out.push(p.longitude, p.latitude, heightFor(p, mode));
  return out;
}

export function toCartesianArray(
  cesium: Pick<CesiumLike, 'Cartesian3'>,
  positions: ReadonlyArray<GeoPosition>,
  mode: HeightMode | undefined,
): Cartesian3Like[] {
  return cesium.Cartesian3.fromDegreesArrayHeights(flattenPositions(positions, mode));
}

export function boundsToRectangle(cesium: Pick<CesiumLike, 'Rectangle'>, b: GeoBounds): RectangleLike {
  return cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
}

/** Every polyline/polygon vertex must be finite; Cesium throws on NaN. */
export function positionsValid(positions: ReadonlyArray<GeoPosition>): boolean {
  return (
    positions.length >= 2 &&
    positions.every(
      (p) =>
        Number.isFinite(p.latitude) &&
        Number.isFinite(p.longitude) &&
        Math.abs(p.latitude) <= 90 &&
        Math.abs(p.longitude) <= 180,
    )
  );
}

const SAME_PLACE_DEG = 1e-9;
const OPPOSITE_DEG = 1e-6;

/** Whether two positions are one place: the same latitude, and longitudes a whole turn apart (or anywhere, at a pole). */
function samePlace(a: GeoPosition, b: GeoPosition): boolean {
  if (Math.abs(a.latitude - b.latitude) > SAME_PLACE_DEG) return false;
  if (Math.abs(Math.abs(a.latitude) - 90) <= SAME_PLACE_DEG) return true;
  const d = Math.abs(a.longitude - b.longitude) % 360;
  return d <= SAME_PLACE_DEG || 360 - d <= SAME_PLACE_DEG;
}

/** Whether two positions are on opposite sides of the globe: no one shortest line joins them. */
function oppositePlaces(a: GeoPosition, b: GeoPosition): boolean {
  if (Math.abs(a.latitude + b.latitude) > OPPOSITE_DEG) return false;
  if (Math.abs(Math.abs(a.latitude) - 90) <= OPPOSITE_DEG) return true;
  return Math.abs((Math.abs(a.longitude - b.longitude) % 360) - 180) <= OPPOSITE_DEG;
}

/**
 * A line's positions as Cesium can draw them on the ground, or undefined when it cannot: the
 * same place written twice running (180° and then -180°, or any two longitudes at a pole) is
 * kept once, and a line that is then one place, or that steps between two places opposite each
 * other on the globe, is not drawn.
 *
 * Cesium drops a repeat only when the numbers repeat. Given [-180, 51] then [180, 51] — one
 * place, as a ring cut at the antimeridian writes its seam — its ground polyline comes out of
 * the antimeridian split with attribute lists of different lengths, the geometry worker throws
 * "All attribute lists must have the same number of attributes", and the globe stops
 * rendering until the app is restarted (seen in the field, 2026-11-14; reproduced against
 * Cesium 1.145 with these positions).
 */
export function groundLinePositions(positions: ReadonlyArray<GeoPosition>): GeoPosition[] | undefined {
  const out: GeoPosition[] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (!last || !samePlace(last, p)) out.push(p);
  }
  if (out.length < 2) return undefined;
  for (let i = 1; i < out.length; i++) if (oppositePlaces(out[i - 1]!, out[i]!)) return undefined;
  return out;
}
