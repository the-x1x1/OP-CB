import type { GeoPosition } from '@opcb/world-model';

/** A geodesic circle as a closed ring of `segments` + 1 positions (the first repeated last). */
export function geodesicCircle(center: GeoPosition, radiusM: number, segments = 64): GeoPosition[] {
  const R = 6_371_008.8;
  const lat = (center.latitude * Math.PI) / 180;
  const lon = (center.longitude * Math.PI) / 180;
  const d = radiusM / R;
  const ring: GeoPosition[] = [];
  // Fewer than three sides is no ring (and none at all divides by zero below).
  const n = Number.isFinite(segments) ? Math.max(3, Math.floor(segments)) : 64;
  for (let i = 0; i <= n; i++) {
    const brg = ((i % n) / n) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(brg));
    const lon2 =
      lon + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2));
    ring.push({ latitude: (lat2 * 180) / Math.PI, longitude: (((lon2 * 180) / Math.PI + 540) % 360) - 180 });
  }
  return ring;
}
