import { pointInPolygon, type GeoPosition, type WorldGeometry, type WorldObject } from '@opcb/world-model';
import type { SkyAurora } from '@opcb/ipc-contract';

/**
 * The aurora forecast at a place, for the Sky tab (`sky.overhead`'s `aurora`): of the
 * weather-alert areas that carry `auroraChancePct` (`swpc-aurora`, nested areas of 10, 30, 50
 * and 70 percent read from SWPC's OVATION grid), the highest whose area holds the place —
 * inside an outer ring and outside its holes. Nothing is fetched: these are the areas the
 * world already holds, and with the source off there are none, so no answer.
 */
export function auroraHere(objects: Iterable<WorldObject>, place: GeoPosition): SkyAurora | undefined {
  let best: { o: WorldObject; pct: number } | undefined;
  for (const o of objects) {
    const pct = o.properties['auroraChancePct'];
    if (typeof pct !== 'number' || !o.geometry) continue;
    if (best && pct <= best.pct) continue;
    if (geometryHolds(o.geometry, place)) best = { o, pct };
  }
  if (!best) return undefined;
  const below = best.o.properties['auroraChanceBelowPct'];
  const forecastFor = best.o.properties['forecastFor'];
  const attribution = best.o.provenance.attribution ?? best.o.provenance.sourceName;
  return {
    chancePct: best.pct,
    ...(typeof below === 'number' ? { belowPct: below } : {}),
    ...(typeof forecastFor === 'string' ? { forecastFor } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

/** Inside a Polygon or MultiPolygon: in an outer ring and in none of its holes. */
export function geometryHolds(g: WorldGeometry, p: GeoPosition): boolean {
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const at = { latitude: p.latitude, longitude: ((((p.longitude + 180) % 360) + 360) % 360) - 180 };
  return polygons.some(
    (rings) =>
      rings.length > 0 &&
      pointInPolygon(at, rings[0] as Array<[number, number]>) &&
      !rings.slice(1).some((hole) => pointInPolygon(at, hole as Array<[number, number]>)),
  );
}
